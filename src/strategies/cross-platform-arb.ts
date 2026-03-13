// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Cross-Platform Arbitrage Strategy
// Core strategy: find matched markets across platforms, identify price
// discrepancies in order books, and generate arb opportunities.
//
// Scanning is event-driven: triggered by WebSocket order book updates.
// When a book updates on one platform, we immediately check the cross-
// platform pair for arbitrage instead of polling on a timer.
// ═══════════════════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import {
  Strategy,
  StrategyConfig,
  StrategyMetrics,
  StrategyState,
  Platform,
  ArbitrageOpportunity,
  NormalizedMarket,
  OrderBook,
  ArbLeg,
} from '../types';
import { MarketConnector } from '../types/connector';
import { MarketMatcher, MarketPair, PairStatus } from '../matcher/market-matcher';
import { LLMVerifier } from '../matcher/llm-verifier';
import { upsertMarketPair, getAllMarketPairs, updatePairStatus as dbUpdatePairStatus } from '../db/database';
import { config } from '../utils/config';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';

const log = createChildLogger('strategy:xplatform-arb');

export class CrossPlatformArbStrategy implements Strategy {
  readonly id = 'cross-platform-arb';
  readonly name = 'Cross-Platform Arbitrage';
  readonly description =
    'Finds equivalent markets across platforms and exploits price discrepancies in order books';
  readonly platforms: Platform[] = ['polymarket', 'predictfun'];

  private _state: StrategyState = 'IDLE';
  private connectors = new Map<Platform, MarketConnector>();
  private llmVerifier = new LLMVerifier();
  private matcher = new MarketMatcher(this.llmVerifier);
  private cachedPairs: MarketPair[] = [];
  private lastPairRefresh = 0;
  private pairRefreshIntervalMs = config.bot.pairRefreshIntervalMs;

  /** Last fetched markets per platform (for dashboard display) */
  private lastFetchedMarkets = new Map<Platform, NormalizedMarket[]>();

  /** Reverse index: marketId → MarketPair[] for O(1) lookup on book updates */
  private marketToPairs = new Map<string, MarketPair[]>();

  /** Throttle: don't re-analyze the same pair more than once per N ms */
  private lastPairAnalysis = new Map<string, number>();
  private readonly pairAnalysisCooldownMs = 200; // 200ms debounce per pair

  /** Bound handler reference so we can remove the listener on shutdown */
  private bookUpdateHandler: ((data: { platform: string; marketId: string; outcomeIndex: number }) => void) | null = null;

  // Metrics
  private _metrics: StrategyMetrics = {
    strategyId: 'cross-platform-arb',
    scansCompleted: 0,
    opportunitiesFound: 0,
    opportunitiesExecuted: 0,
    totalProfitUsd: 0,
    avgProfitPerTrade: 0,
    winRate: 0,
    lastScanDurationMs: 0,
    lastScanAt: null,
    marketsTracked: 0,
  };

  readonly config: StrategyConfig = {
    enabled: true,
    minProfitBps: config.bot.minProfitBps,
    maxPositionUsd: config.bot.maxPositionUsd,
    minMatchConfidence: 0.6,
    params: {
      minDepthUsd: config.bot.minDepthUsd,
      maxBookAgeMs: 5000,
    },
  };

  get state(): StrategyState {
    return this._state;
  }

  async initialize(connectors: Map<Platform, MarketConnector>): Promise<void> {
    this.connectors = connectors;
    this._state = 'IDLE';
    log.info('Cross-platform arbitrage strategy initialized', {
      platforms: Array.from(connectors.keys()),
      minProfitBps: this.config.minProfitBps,
      minDepthUsd: this.config.params.minDepthUsd,
    });
  }

  // ─── WebSocket-Driven Scanning ────────────────────────────────────────

  /**
   * Start listening for order book update events.
   * When any book changes, we immediately check the cross-platform pair
   * for arbitrage instead of waiting for the next poll interval.
   */
  startEventDrivenScanning(): void {
    if (this.bookUpdateHandler) return; // already listening

    this.bookUpdateHandler = (data) => {
      this.onBookUpdate(data.platform as Platform, data.marketId).catch(err => {
        log.warn('Error in event-driven scan', { error: (err as Error).message });
      });
    };

    eventBus.on('book:update', this.bookUpdateHandler);
    log.info('Event-driven scanning enabled — arb checks triggered by WS book updates');
  }

  /**
   * Stop listening for order book update events.
   */
  stopEventDrivenScanning(): void {
    if (this.bookUpdateHandler) {
      eventBus.off('book:update', this.bookUpdateHandler);
      this.bookUpdateHandler = null;
      log.info('Event-driven scanning disabled');
    }
  }

  /**
   * Called when a WebSocket book update arrives for a specific market.
   * Finds the cross-platform pair(s) containing that market and immediately
   * checks for arbitrage.
   */
  private async onBookUpdate(platform: Platform, marketId: string): Promise<void> {
    if (this._state !== 'IDLE' && this._state !== 'SCANNING') return;

    const pairs = this.marketToPairs.get(marketId);
    if (!pairs || pairs.length === 0) return;

    for (const pair of pairs) {
      if (pair.status !== 'approved') continue;
      if (pair.confidence < this.config.minMatchConfidence) continue;

      // Throttle: don't re-check the same pair too frequently
      const lastCheck = this.lastPairAnalysis.get(pair.pairId) ?? 0;
      if (Date.now() - lastCheck < this.pairAnalysisCooldownMs) continue;
      this.lastPairAnalysis.set(pair.pairId, Date.now());

      try {
        const opps = await this.analyzePair(pair);
        if (opps.length > 0) {
          this._metrics.opportunitiesFound += opps.length;
          this._metrics.lastScanAt = new Date();
          for (const opp of opps) {
            eventBus.emit('opportunity:found', opp);
          }
          log.info('Arb opportunity detected via WS trigger', {
            pairId: pair.pairId,
            platform,
            marketId,
            opps: opps.length,
            profitBps: opps[0].expectedProfitBps.toFixed(0),
          });
        }
      } catch (err) {
        log.warn('Error analyzing pair on book update', {
          pairId: pair.pairId,
          error: (err as Error).message,
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopEventDrivenScanning();
    this._state = 'IDLE';
    this.cachedPairs = [];
    this.marketToPairs.clear();
    this.lastPairAnalysis.clear();
    log.info('Strategy shut down');
  }

  // ─── Core Scan Logic (also usable as a fallback / manual trigger) ─────

  async scan(): Promise<ArbitrageOpportunity[]> {
    this._state = 'SCANNING';
    const startTime = Date.now();
    const opportunities: ArbitrageOpportunity[] = [];

    try {
      // Step 1: Refresh market pairs if stale
      await this.refreshPairsIfNeeded();

      if (this.cachedPairs.length === 0) {
        log.warn('No market pairs found — skipping scan');
        return [];
      }

      // Log pair status breakdown for debugging
      const statusCounts = { approved: 0, pending: 0, paused: 0, rejected: 0, unknown: 0 };
      for (const pair of this.cachedPairs) {
        const s = pair.status as keyof typeof statusCounts;
        if (s in statusCounts) statusCounts[s]++;
        else statusCounts.unknown++;
      }
      log.info('Pair status breakdown', statusCounts);

      if (statusCounts.approved === 0) {
        log.warn('No approved pairs — approve pairs via dashboard or set ANTHROPIC_API_KEY for auto-approval');
      }

      // Step 2: For each APPROVED pair, fetch order books and look for arb
      let pairsChecked = 0;
      let nullBookCount = 0;
      let belowDepthCount = 0;
      let belowProfitCount = 0;

      for (const pair of this.cachedPairs) {
        if (pair.status !== 'approved') continue;
        if (pair.confidence < this.config.minMatchConfidence) continue;
        pairsChecked++;

        try {
          const opps = await this.analyzePairWithDiagnostics(pair, (reason) => {
            if (reason === 'null_book') nullBookCount++;
            else if (reason === 'below_depth') belowDepthCount++;
            else if (reason === 'below_profit') belowProfitCount++;
          });
          opportunities.push(...opps);
        } catch (err) {
          log.warn('Error analyzing pair', {
            marketA: pair.marketA.question.slice(0, 50),
            marketB: pair.marketB.question.slice(0, 50),
            error: (err as Error).message,
          });
        }
      }

      // Diagnostic summary
      if (pairsChecked > 0 && opportunities.length === 0) {
        log.info('Scan diagnostics — 0 opportunities because:', {
          pairsChecked,
          nullBooks: nullBookCount,
          belowDepth: belowDepthCount,
          belowProfit: belowProfitCount,
          minProfitBps: this.config.minProfitBps,
          minDepthUsd: this.config.params.minDepthUsd,
        });
      }

      // Emit found opportunities
      for (const opp of opportunities) {
        eventBus.emit('opportunity:found', opp);
      }
    } catch (err) {
      log.error('Scan failed', { error: (err as Error).message });
      this._state = 'ERROR';
    } finally {
      const duration = Date.now() - startTime;
      this._metrics.scansCompleted++;
      this._metrics.opportunitiesFound += opportunities.length;
      this._metrics.lastScanDurationMs = duration;
      this._metrics.lastScanAt = new Date();
      this._state = 'IDLE';

      log.info(`Scan complete`, {
        duration: `${duration}ms`,
        pairsChecked: this.cachedPairs.length,
        opportunitiesFound: opportunities.length,
      });
    }

    return opportunities;
  }

  async validate(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      // Re-fetch order books to confirm the opportunity still exists
      const connA = this.connectors.get(opportunity.legA.platform);
      const connB = this.connectors.get(opportunity.legB.platform);
      if (!connA || !connB) return false;

      const [bookA, bookB] = await Promise.all([
        connA.fetchOrderBook(opportunity.legA.marketId, opportunity.legA.outcomeIndex),
        connB.fetchOrderBook(opportunity.legB.marketId, opportunity.legB.outcomeIndex),
      ]);

      // Check if the combined cost is still < $1 (profitable arb)
      const costA = bookA.bestAsk ?? 1;
      const costB = bookB.bestAsk ?? 1;

      const totalCost = costA + costB;
      const profitBps = ((1 - totalCost) / totalCost) * 10000;

      return profitBps >= this.config.minProfitBps;
    } catch (err) {
      log.warn('Validation failed', { error: (err as Error).message });
      return false;
    }
  }

  getMetrics(): StrategyMetrics {
    return { ...this._metrics, marketsTracked: this.cachedPairs.length };
  }

  /** Update a pair's status (from dashboard/API) */
  setPairStatus(pairId: string, status: PairStatus): void {
    this.matcher.setPairStatus(pairId, status);
    dbUpdatePairStatus(pairId, status);
    // Update cached pair
    const pair = this.cachedPairs.find(p => p.pairId === pairId);
    if (pair) pair.status = status;
    log.info(`Pair status updated`, { pairId, status });
  }

  /** Manually match two markets (from dashboard) */
  addManualPair(marketAId: string, marketBId: string): string | null {
    // Find the markets in our cached data
    const allMarkets = new Map<string, NormalizedMarket>();
    for (const [, markets] of this.lastFetchedMarkets) {
      for (const m of markets) allMarkets.set(m.id, m);
    }

    const mA = allMarkets.get(marketAId);
    const mB = allMarkets.get(marketBId);
    if (!mA || !mB) {
      log.warn('Manual pair failed — market not found', { marketAId, marketBId });
      return null;
    }

    const pairId = this.matcher.addManualPair(marketAId, marketBId);

    // Add to cached pairs immediately
    const pair: MarketPair = {
      pairId,
      marketA: mA,
      marketB: mB,
      confidence: 1.0,
      matchMethod: 'manual',
      status: 'approved',
    };
    this.cachedPairs.push(pair);

    // Update reverse index
    const listA = this.marketToPairs.get(mA.id) ?? [];
    listA.push(pair);
    this.marketToPairs.set(mA.id, listA);
    const listB = this.marketToPairs.get(mB.id) ?? [];
    listB.push(pair);
    this.marketToPairs.set(mB.id, listB);

    // Persist to DB
    try {
      upsertMarketPair({
        pairId,
        marketAId: mA.id,
        marketAPlatform: mA.platform,
        marketAQuestion: mA.question,
        marketBId: mB.id,
        marketBPlatform: mB.platform,
        marketBQuestion: mB.question,
        status: 'approved',
        confidence: 1.0,
        matchMethod: 'manual',
      });
    } catch (err) {
      log.warn('Failed to persist manual pair', { pairId, error: (err as Error).message });
    }

    log.info('Manual pair created', { pairId, marketA: mA.question.slice(0, 50), marketB: mB.question.slice(0, 50) });
    return pairId;
  }

  /** Reset all in-memory state (called from dashboard reset) */
  reset(): void {
    this.stopEventDrivenScanning();
    this.cachedPairs = [];
    this.lastPairRefresh = 0;
    this.lastFetchedMarkets.clear();
    this.marketToPairs.clear();
    this.lastPairAnalysis.clear();
    this.matcher.reset();
    log.info('Strategy state reset');
  }

  /** Load persisted pair statuses from DB at startup */
  loadPersistedPairs(): void {
    try {
      const rows = getAllMarketPairs();
      const statuses = new Map<string, PairStatus>();
      for (const row of rows) {
        statuses.set(row.pair_id as string, row.status as PairStatus);
      }
      this.matcher.loadPairStatuses(statuses);
    } catch (err) {
      log.warn('Failed to load persisted pairs', { error: (err as Error).message });
    }
  }

  /** Expose market/pair data for the dashboard */
  getMarketsSummary(): {
    platforms: Record<string, { total: number; markets: Array<{ id: string; question: string; category: string; matched: boolean }> }>;
    matchedPairs: Array<{
      pairId: string;
      marketA: { id: string; platform: string; question: string };
      marketB: { id: string; platform: string; question: string };
      confidence: number;
      matchMethod: string;
      status: string;
      llmReasoning?: string;
    }>;
  } {
    // Build set of matched market IDs per platform
    const matchedIds = new Map<string, Set<string>>();
    for (const pair of this.cachedPairs) {
      if (!matchedIds.has(pair.marketA.platform)) matchedIds.set(pair.marketA.platform, new Set());
      if (!matchedIds.has(pair.marketB.platform)) matchedIds.set(pair.marketB.platform, new Set());
      matchedIds.get(pair.marketA.platform)!.add(pair.marketA.id);
      matchedIds.get(pair.marketB.platform)!.add(pair.marketB.id);
    }

    const platforms: Record<string, { total: number; markets: Array<{ id: string; question: string; category: string; matched: boolean }> }> = {};
    for (const [platform, markets] of this.lastFetchedMarkets.entries()) {
      const pMatched = matchedIds.get(platform) || new Set();
      platforms[platform] = {
        total: markets.length,
        markets: markets.map(m => ({
          id: m.id,
          question: m.question,
          category: m.category,
          matched: pMatched.has(m.id),
        })),
      };
    }

    const matchedPairs = this.cachedPairs.map(p => ({
      pairId: p.pairId,
      marketA: { id: p.marketA.id, platform: p.marketA.platform, question: p.marketA.question },
      marketB: { id: p.marketB.id, platform: p.marketB.platform, question: p.marketB.question },
      confidence: p.confidence,
      matchMethod: p.matchMethod,
      status: p.status,
      llmReasoning: p.llmVerification?.reasoning,
    }));

    return { platforms, matchedPairs };
  }

  // ─── Internal Logic ────────────────────────────────────────────────────

  /** Refresh pairs (call periodically or manually, NOT on every book update) */
  async refreshPairsIfNeeded(): Promise<void> {
    if (Date.now() - this.lastPairRefresh < this.pairRefreshIntervalMs) return;

    log.info('Refreshing market pairs...');

    const connA = this.connectors.get('polymarket');
    const connB = this.connectors.get('predictfun');
    if (!connA || !connB) {
      log.warn('Missing connectors — cannot refresh pairs');
      return;
    }

    const baseOpts = { activeOnly: true, limit: 200, sortBy: 'volume' as const, sortDirection: 'desc' as const };

    const [marketsA, marketsB] = await Promise.all([
      connA.fetchMarkets({ ...baseOpts, minLiquidity: 100 }),
      connB.fetchMarkets(baseOpts),
    ]);

    // Cache for dashboard visibility
    this.lastFetchedMarkets.set('polymarket', marketsA);
    this.lastFetchedMarkets.set('predictfun', marketsB);

    log.info('Markets fetched', {
      polymarket: marketsA.length,
      predictfun: marketsB.length,
    });

    const oldPairIds = new Set(this.cachedPairs.map(p => `${p.marketA.id}:${p.marketB.id}`));
    this.cachedPairs = await this.matcher.findPairs(marketsA, marketsB);
    this.lastPairRefresh = Date.now();

    // Rebuild the reverse index: marketId → pairs
    this.rebuildMarketIndex();

    // Persist pairs to DB
    for (const pair of this.cachedPairs) {
      try {
        upsertMarketPair({
          pairId: pair.pairId,
          marketAId: pair.marketA.id,
          marketAPlatform: pair.marketA.platform,
          marketAQuestion: pair.marketA.question,
          marketBId: pair.marketB.id,
          marketBPlatform: pair.marketB.platform,
          marketBQuestion: pair.marketB.question,
          status: pair.status,
          confidence: pair.confidence,
          matchMethod: pair.matchMethod,
          llmIsSameMarket: pair.llmVerification?.isSameMarket,
          llmConfidence: pair.llmVerification?.confidence,
          llmReasoning: pair.llmVerification?.reasoning,
        });
      } catch (err) {
        log.warn('Failed to persist pair', { pairId: pair.pairId, error: (err as Error).message });
      }
    }

    // Subscribe to WebSocket order book updates for newly matched pairs
    this.subscribeToMatchedPairs(connA, connB, oldPairIds);
  }

  /**
   * Build a reverse lookup from marketId → MarketPair[] so that when a
   * book update arrives for a specific market, we can O(1) find which
   * pairs need re-analysis.
   */
  private rebuildMarketIndex(): void {
    this.marketToPairs.clear();
    for (const pair of this.cachedPairs) {
      // Index by market A's ID
      const listA = this.marketToPairs.get(pair.marketA.id) ?? [];
      listA.push(pair);
      this.marketToPairs.set(pair.marketA.id, listA);

      // Index by market B's ID
      const listB = this.marketToPairs.get(pair.marketB.id) ?? [];
      listB.push(pair);
      this.marketToPairs.set(pair.marketB.id, listB);
    }
    log.info('Market index rebuilt', {
      uniqueMarkets: this.marketToPairs.size,
      pairs: this.cachedPairs.length,
    });
  }

  /**
   * Subscribe connectors to WebSocket order book feeds for all matched pairs.
   */
  private subscribeToMatchedPairs(
    connA: MarketConnector,
    connB: MarketConnector,
    oldPairIds: Set<string>,
  ): void {
    const newMarketsA: NormalizedMarket[] = [];
    const newMarketsB: NormalizedMarket[] = [];

    for (const pair of this.cachedPairs) {
      const pairId = `${pair.marketA.id}:${pair.marketB.id}`;
      if (!oldPairIds.has(pairId)) {
        newMarketsA.push(pair.marketA);
        newMarketsB.push(pair.marketB);
      }
    }

    if (newMarketsA.length > 0) {
      try {
        connA.subscribeOrderBooks(newMarketsA);
        log.info(`Subscribed ${newMarketsA.length} new markets on ${connA.platform} for WS books`);
      } catch (err) {
        log.warn('Failed to subscribe WS books on platform A', { error: (err as Error).message });
      }
    }

    if (newMarketsB.length > 0) {
      try {
        connB.subscribeOrderBooks(newMarketsB);
        log.info(`Subscribed ${newMarketsB.length} new markets on ${connB.platform} for WS books`);
      } catch (err) {
        log.warn('Failed to subscribe WS books on platform B', { error: (err as Error).message });
      }
    }
  }

  /**
   * Analyze a matched pair for arbitrage — with diagnostics callback.
   *
   * The core arb logic for binary prediction markets:
   *
   * If Market A has YES at ask price pA, and Market B has NO at ask price pB,
   * then buying YES on A and NO on B guarantees a payout of $1 regardless of outcome.
   * Profit = $1 - pA - pB (minus fees).
   *
   * We check both directions:
   *  1. Buy YES on A + Buy NO on B
   *  2. Buy NO on A + Buy YES on B
   */
  private async analyzePairWithDiagnostics(
    pair: MarketPair,
    onSkip: (reason: 'null_book' | 'below_depth' | 'below_profit') => void,
  ): Promise<ArbitrageOpportunity[]> {
    const connA = this.connectors.get(pair.marketA.platform);
    const connB = this.connectors.get(pair.marketB.platform);
    if (!connA || !connB) return [];

    const [bookAYes, bookBYes] = await Promise.all([
      connA.fetchOrderBook(pair.marketA.id, 0),
      connB.fetchOrderBook(pair.marketB.id, 0),
    ]);

    // Log book state for debugging empty-book issues
    if (bookAYes.bestAsk === null || bookAYes.bestBid === null ||
        bookBYes.bestAsk === null || bookBYes.bestBid === null) {
      log.debug('Order book prices for pair', {
        pairId: pair.pairId,
        [`${pair.marketA.platform}_bestBid`]: bookAYes.bestBid,
        [`${pair.marketA.platform}_bestAsk`]: bookAYes.bestAsk,
        [`${pair.marketA.platform}_bids`]: bookAYes.bids.length,
        [`${pair.marketA.platform}_asks`]: bookAYes.asks.length,
        [`${pair.marketB.platform}_bestBid`]: bookBYes.bestBid,
        [`${pair.marketB.platform}_bestAsk`]: bookBYes.bestAsk,
        [`${pair.marketB.platform}_bids`]: bookBYes.bids.length,
        [`${pair.marketB.platform}_asks`]: bookBYes.asks.length,
      });
    }

    const opportunities: ArbitrageOpportunity[] = [];
    const minDepthUsd = this.config.params.minDepthUsd as number;

    // Direction 1: Buy YES on A, Buy NO on B
    if (bookAYes.bestAsk !== null && bookBYes.bestBid !== null) {
      const costYesA = bookAYes.bestAsk;
      const costNoB = 1 - bookBYes.bestBid;
      const totalCost = costYesA + costNoB;
      const profitPerShare = 1 - totalCost;
      const profitBps = totalCost > 0 ? (profitPerShare / totalCost) * 10000 : 0;

      if (profitBps >= this.config.minProfitBps) {
        const maxSizeA = bookAYes.asks[0]?.size ?? 0;
        const maxSizeB = bookBYes.bids[0]?.size ?? 0;
        const maxSize = Math.min(maxSizeA, maxSizeB, this.config.maxPositionUsd / totalCost);

        if (minDepthUsd <= 0 || maxSize * totalCost >= minDepthUsd) {
          opportunities.push(this.createOpportunity(
            pair, 'YES', costYesA, bookAYes, maxSizeA,
            'NO', costNoB, bookBYes, maxSizeB,
            profitPerShare * maxSize, profitBps, maxSize,
          ));
        } else {
          onSkip('below_depth');
        }
      } else {
        onSkip('below_profit');
      }
    } else {
      onSkip('null_book');
    }

    // Direction 2: Buy NO on A, Buy YES on B
    if (bookAYes.bestBid !== null && bookBYes.bestAsk !== null) {
      const costNoA = 1 - bookAYes.bestBid;
      const costYesB = bookBYes.bestAsk;
      const totalCost = costNoA + costYesB;
      const profitPerShare = 1 - totalCost;
      const profitBps = totalCost > 0 ? (profitPerShare / totalCost) * 10000 : 0;

      if (profitBps >= this.config.minProfitBps) {
        const maxSizeA = bookAYes.bids[0]?.size ?? 0;
        const maxSizeB = bookBYes.asks[0]?.size ?? 0;
        const maxSize = Math.min(maxSizeA, maxSizeB, this.config.maxPositionUsd / totalCost);

        if (minDepthUsd <= 0 || maxSize * totalCost >= minDepthUsd) {
          opportunities.push(this.createOpportunity(
            pair, 'NO', costNoA, bookAYes, maxSizeA,
            'YES', costYesB, bookBYes, maxSizeB,
            profitPerShare * maxSize, profitBps, maxSize,
          ));
        } else {
          onSkip('below_depth');
        }
      } else {
        onSkip('below_profit');
      }
    } else {
      onSkip('null_book');
    }

    return opportunities;
  }

  /**
   * Lightweight version for WS-triggered analysis (no diagnostics callback).
   */
  private async analyzePair(pair: MarketPair): Promise<ArbitrageOpportunity[]> {
    return this.analyzePairWithDiagnostics(pair, () => {});
  }

  private createOpportunity(
    pair: MarketPair,
    outcomeA: 'YES' | 'NO', priceA: number, bookA: OrderBook, sizeA: number,
    outcomeB: 'YES' | 'NO', priceB: number, bookB: OrderBook, sizeB: number,
    expectedProfitUsd: number, expectedProfitBps: number, maxSize: number,
  ): ArbitrageOpportunity {
    const legA: ArbLeg = {
      platform: pair.marketA.platform,
      marketId: pair.marketA.id,
      marketQuestion: pair.marketA.question,
      outcome: outcomeA,
      outcomeIndex: outcomeA === 'YES' ? 0 : 1,
      price: priceA,
      availableSize: sizeA,
      orderBook: bookA,
    };

    const legB: ArbLeg = {
      platform: pair.marketB.platform,
      marketId: pair.marketB.id,
      marketQuestion: pair.marketB.question,
      outcome: outcomeB,
      outcomeIndex: outcomeB === 'YES' ? 0 : 1,
      price: priceB,
      availableSize: sizeB,
      orderBook: bookB,
    };

    return {
      id: uuid(),
      strategyId: this.id,
      discoveredAt: new Date(),
      legA,
      legB,
      expectedProfitUsd,
      expectedProfitBps,
      maxSize,
      matchConfidence: pair.confidence,
      executed: false,
    };
  }
}
