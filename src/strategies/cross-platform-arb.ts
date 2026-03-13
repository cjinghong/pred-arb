// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Cross-Platform Arbitrage Strategy
// Core strategy: find matched markets across platforms, identify price
// discrepancies in order books, and generate arb opportunities
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
  private pairRefreshIntervalMs = 5 * 60 * 1000; // Refresh pairs every 5 minutes

  /** Last fetched markets per platform (for dashboard display) */
  private lastFetchedMarkets = new Map<Platform, NormalizedMarket[]>();

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
      /** Minimum order book depth (USD) to consider an opportunity executable */
      minDepthUsd: 50,
      /** Maximum staleness of order book data in ms */
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
    });
  }

  async shutdown(): Promise<void> {
    this._state = 'IDLE';
    this.cachedPairs = [];
    log.info('Strategy shut down');
  }

  // ─── Core Scan Logic ───────────────────────────────────────────────────

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

      // Step 2: For each APPROVED pair, fetch order books and look for arb
      for (const pair of this.cachedPairs) {
        if (pair.status !== 'approved') continue;
        if (pair.confidence < this.config.minMatchConfidence) continue;

        try {
          const opps = await this.analyzePair(pair);
          opportunities.push(...opps);
        } catch (err) {
          log.warn('Error analyzing pair', {
            marketA: pair.marketA.question.slice(0, 50),
            marketB: pair.marketB.question.slice(0, 50),
            error: (err as Error).message,
          });
        }
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
      const costA = opportunity.legA.outcome === 'YES'
        ? (bookA.bestAsk ?? 1)
        : (bookA.bestAsk ?? 1);
      const costB = opportunity.legB.outcome === 'YES'
        ? (bookB.bestAsk ?? 1)
        : (bookB.bestAsk ?? 1);

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

  private async refreshPairsIfNeeded(): Promise<void> {
    if (Date.now() - this.lastPairRefresh < this.pairRefreshIntervalMs) return;

    log.info('Refreshing market pairs...');

    const connA = this.connectors.get('polymarket');
    const connB = this.connectors.get('predictfun');
    if (!connA || !connB) {
      log.warn('Missing connectors — cannot refresh pairs');
      return;
    }

    // Push filtering to the API wherever possible:
    // - Polymarket: activeOnly, minLiquidity, sortBy all handled server-side via Gamma API
    // - predict.fun: status=OPEN + sort=VOLUME_TOTAL_DESC handled server-side;
    //                no liquidity field exposed so we skip that filter for pfun
    const baseOpts = { activeOnly: true, limit: 200, sortBy: 'volume' as const, sortDirection: 'desc' as const };

    const [marketsA, marketsB] = await Promise.all([
      connA.fetchMarkets({ ...baseOpts, minLiquidity: 100 }),  // Polymarket supports server-side liquidity filter
      connB.fetchMarkets(baseOpts),                             // predict.fun: no liquidity field
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
   * Subscribe connectors to WebSocket order book feeds for all matched pairs.
   * This ensures we get real-time book updates for markets we're actively
   * monitoring, rather than polling REST on every scan.
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
   * Analyze a matched pair for arbitrage.
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
  private async analyzePair(pair: MarketPair): Promise<ArbitrageOpportunity[]> {
    const connA = this.connectors.get(pair.marketA.platform);
    const connB = this.connectors.get(pair.marketB.platform);
    if (!connA || !connB) return [];

    // Fetch YES order books for both markets
    const [bookAYes, bookBYes] = await Promise.all([
      connA.fetchOrderBook(pair.marketA.id, 0), // index 0 = YES
      connB.fetchOrderBook(pair.marketB.id, 0), // index 0 = YES
    ]);

    const opportunities: ArbitrageOpportunity[] = [];

    // Direction 1: Buy YES on A, Buy NO on B
    // Cost = bestAsk(A, YES) + (1 - bestBid(B, YES))
    // Because buying NO is equivalent to selling YES at the complement
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

        if (maxSize * totalCost >= (this.config.params.minDepthUsd as number)) {
          const opp = this.createOpportunity(
            pair, 'YES', costYesA, bookAYes, maxSizeA,
            'NO', costNoB, bookBYes, maxSizeB,
            profitPerShare * maxSize, profitBps, maxSize,
          );
          opportunities.push(opp);
        }
      }
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

        if (maxSize * totalCost >= (this.config.params.minDepthUsd as number)) {
          const opp = this.createOpportunity(
            pair, 'NO', costNoA, bookAYes, maxSizeA,
            'YES', costYesB, bookBYes, maxSizeB,
            profitPerShare * maxSize, profitBps, maxSize,
          );
          opportunities.push(opp);
        }
      }
    }

    return opportunities;
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
