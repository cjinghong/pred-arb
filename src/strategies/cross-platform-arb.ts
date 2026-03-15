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
  PriceLevel,
  ArbLeg,
} from '../types';
import { MarketConnector } from '../types/connector';
import { MarketMatcher, MarketPair, PairStatus } from '../matcher/market-matcher';
import { SportsMatcher } from '../matcher/sports-matcher';
import { LLMVerifier } from '../matcher/llm-verifier';
import { SportsDiscovery } from '../discovery/sports-discovery';
import { DiscoveredMarket, MarketCategory, SportsLeague } from '../discovery/types';
import { PredictFunConnector } from '../connectors/predictfun';
import { KalshiConnector } from '../connectors/kalshi';
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
  readonly platforms: Platform[] = ['polymarket', 'predictfun', 'kalshi'];

  private _state: StrategyState = 'IDLE';
  private connectors = new Map<Platform, MarketConnector>();
  private llmVerifier = new LLMVerifier();
  private matcher = new MarketMatcher(this.llmVerifier);
  private sportsMatcher = new SportsMatcher();
  private sportsDiscovery = new SportsDiscovery();
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

  /**
   * Dynamic profit threshold: adjusts minProfitBps based on execution risk.
   * Higher risk factors → higher required profit to compensate.
   *
   * Risk factors:
   * - Match confidence: lower confidence → higher threshold (risk of wrong match)
   * - Book spread: wider spread → higher threshold (harder to fill at expected price)
   * - Cross-platform execution: always adds base premium for timing risk
   * - Size relative to depth: larger % of book → higher threshold (slippage risk)
   */
  private getDynamicMinProfitBps(
    matchConfidence: number,
    spreadA: number | null,
    spreadB: number | null,
    size: number,
    depthA: number,
    depthB: number,
  ): number {
    const base = this.config.minProfitBps;

    // 1. Match confidence penalty: 0 at 1.0, up to +25bps at 0.6
    const confidencePenalty = Math.max(0, (1 - matchConfidence) * 62.5);

    // 2. Spread penalty: wider spreads = harder to fill at expected price
    // Only penalize unusually wide spreads (>3% combined)
    const totalSpread = (spreadA ?? 0.01) + (spreadB ?? 0.01);
    const spreadPenalty = totalSpread > 0.03 ? (totalSpread - 0.03) * 1000 : 0;

    // 3. Size-to-depth penalty: if taking >70% of available depth, add buffer
    const minDepth = Math.min(depthA || Infinity, depthB || Infinity);
    const sizeRatio = minDepth > 0 ? size / minDepth : 1;
    const depthPenalty = sizeRatio > 0.7 ? (sizeRatio - 0.7) * 50 : 0;

    const adjusted = base + confidencePenalty + spreadPenalty + depthPenalty;

    // Cap at 2x the base to avoid being overly conservative
    return Math.min(adjusted, base * 2);
  }

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

      // Check if the combined cost is still < $1 (profitable arb) including fees
      const costA = bookA.bestAsk ?? 1;
      const costB = bookB.bestAsk ?? 1;
      const totalCost = costA + costB;

      // Include estimated fees in the profitability check
      const feesPerShare = this.estimateFees(opportunity.legA.platform, costA, 1)
                         + this.estimateFees(opportunity.legB.platform, costB, 1);
      const profitPerShare = 1 - totalCost - feesPerShare;
      const profitBps = totalCost > 0 ? (profitPerShare / totalCost) * 10000 : 0;

      return profitBps >= this.config.minProfitBps;
    } catch (err) {
      log.warn('Validation failed', { error: (err as Error).message });
      return false;
    }
  }

  /**
   * Estimate taker fees per share for a platform.
   * - Polymarket: 0 (no fees)
   * - predict.fun: 2% × min(price, 1 - price) per share
   */
  private estimateFees(platform: Platform, price: number, shares: number): number {
    if (platform === 'predictfun') {
      return PredictFunConnector.calculateTakerFee(price, shares);
    }
    if (platform === 'kalshi') {
      return KalshiConnector.calculateTakerFee(price, shares);
    }
    // Polymarket has no fees
    return 0;
  }

  // ─── Book Walking ─────────────────────────────────────────────────────

  /**
   * Walk through multiple price levels on both order books to find the
   * maximum profitable size. Instead of only looking at top-of-book,
   * we accumulate size across levels until the marginal cost exceeds $1
   * (minus fees and profit threshold).
   *
   * Returns the optimal { size, avgPriceA, avgPriceB, profitBps }.
   */
  private walkBooksForOptimalSize(
    platformA: Platform,
    platformB: Platform,
    levelsA: PriceLevel[],  // asks for the "buy" side
    levelsB: PriceLevel[],  // asks or inverted bids for the "buy" side
    minProfitBps: number,
    maxPositionUsd: number,
  ): { size: number; avgPriceA: number; avgPriceB: number; profitPerShare: number; profitBps: number } | null {
    if (levelsA.length === 0 || levelsB.length === 0) return null;

    let idxA = 0, idxB = 0;
    let remainA = levelsA[0].size, remainB = levelsB[0].size;
    let totalSize = 0;
    let totalCostA = 0, totalCostB = 0;
    let totalFees = 0;

    while (idxA < levelsA.length && idxB < levelsB.length) {
      const priceA = levelsA[idxA].price;
      const priceB = levelsB[idxB].price;

      // Fee per share at these price levels
      const feePerShare = this.estimateFees(platformA, priceA, 1)
                         + this.estimateFees(platformB, priceB, 1);

      // Check if this level is still profitable
      const totalCostPerShare = priceA + priceB;
      const profitPerShare = 1 - totalCostPerShare - feePerShare;
      const profitBps = totalCostPerShare > 0 ? (profitPerShare / totalCostPerShare) * 10000 : 0;

      if (profitBps < minProfitBps) break; // Stop walking — no longer profitable

      // Take the minimum available at this price level
      const chunk = Math.min(remainA, remainB);

      // Check position size limit
      const chunkCost = (priceA + priceB) * chunk;
      const totalCostSoFar = (totalCostA + totalCostB);
      if (totalCostSoFar + chunkCost > maxPositionUsd) {
        // Partial fill to hit the limit
        const remainingBudget = maxPositionUsd - totalCostSoFar;
        const partialChunk = remainingBudget / (priceA + priceB);
        if (partialChunk > 0) {
          totalSize += partialChunk;
          totalCostA += priceA * partialChunk;
          totalCostB += priceB * partialChunk;
          totalFees += feePerShare * partialChunk;
        }
        break;
      }

      totalSize += chunk;
      totalCostA += priceA * chunk;
      totalCostB += priceB * chunk;
      totalFees += feePerShare * chunk;

      remainA -= chunk;
      remainB -= chunk;

      // Advance to next level if exhausted
      if (remainA <= 0) {
        idxA++;
        if (idxA < levelsA.length) remainA = levelsA[idxA].size;
      }
      if (remainB <= 0) {
        idxB++;
        if (idxB < levelsB.length) remainB = levelsB[idxB].size;
      }
    }

    if (totalSize <= 0) return null;

    const avgPriceA = totalCostA / totalSize;
    const avgPriceB = totalCostB / totalSize;
    const netProfit = totalSize - totalCostA - totalCostB - totalFees;
    const avgProfitPerShare = netProfit / totalSize;
    const avgProfitBps = (totalCostA + totalCostB) > 0
      ? (avgProfitPerShare / ((totalCostA + totalCostB) / totalSize)) * 10000
      : 0;

    return {
      size: totalSize,
      avgPriceA,
      avgPriceB,
      profitPerShare: avgProfitPerShare,
      profitBps: avgProfitBps,
    };
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

  /** Runtime category override (dashboard can change this without restart) */
  private runtimeCategory: string | null = null;

  /** Get the effective category (runtime override > env var) */
  getCategory(): string {
    return this.runtimeCategory ?? config.bot.marketCategory;
  }

  /** Set category at runtime (from dashboard). Pass '' to clear. */
  setCategory(category: string): void {
    this.runtimeCategory = category || null;
    log.info('Market category updated at runtime', { category: this.getCategory() });
  }

  /**
   * Force a refresh of market pairs — bypasses the time check.
   * Called from dashboard "Refresh Markets" button.
   */
  async forceRefreshPairs(): Promise<void> {
    this.lastPairRefresh = 0; // Reset the timer so refreshPairsIfNeeded actually runs
    await this.refreshPairsIfNeeded();
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
    this.sportsMatcher.reset();
    log.info('Strategy state reset');
  }

  /** Load persisted pairs from DB at startup.
   *  Reconstructs full MarketPair objects so that previously matched pairs
   *  don't need to be re-matched. Also loads statuses into the matcher. */
  loadPersistedPairs(): void {
    try {
      const rows = getAllMarketPairs();
      const statuses = new Map<string, PairStatus>();
      const loadedPairs: MarketPair[] = [];

      for (const row of rows) {
        const pairId = row.pair_id as string;
        const status = row.status as PairStatus;
        statuses.set(pairId, status);

        // Skip rejected pairs — they won't be used for scanning
        if (status === 'rejected') continue;

        // Reconstruct a lightweight MarketPair from DB columns
        const marketA: NormalizedMarket = {
          id: row.market_a_id as string,
          platform: row.market_a_platform as Platform,
          question: row.market_a_question as string,
          slug: '',
          category: '',
          outcomes: ['Yes', 'No'],
          outcomeTokenIds: [],
          outcomePrices: [0, 0],
          volume: 0,
          liquidity: 0,
          active: true,
          endDate: null,
          lastUpdated: new Date(),
          raw: {},
        };

        const marketB: NormalizedMarket = {
          id: row.market_b_id as string,
          platform: row.market_b_platform as Platform,
          question: row.market_b_question as string,
          slug: '',
          category: '',
          outcomes: ['Yes', 'No'],
          outcomeTokenIds: [],
          outcomePrices: [0, 0],
          volume: 0,
          liquidity: 0,
          active: true,
          endDate: null,
          lastUpdated: new Date(),
          raw: {},
        };

        const pair: MarketPair = {
          pairId,
          marketA,
          marketB,
          confidence: row.confidence as number,
          matchMethod: row.match_method as MarketPair['matchMethod'],
          status,
        };

        // Attach LLM verification if present
        if (row.llm_reasoning) {
          pair.llmVerification = {
            marketA: { id: marketA.id, platform: marketA.platform, question: marketA.question },
            marketB: { id: marketB.id, platform: marketB.platform, question: marketB.question },
            isSameMarket: (row.llm_is_same_market as number) === 1,
            confidence: (row.llm_confidence as number) || 0,
            reasoning: row.llm_reasoning as string,
          };
        }

        loadedPairs.push(pair);
      }

      this.matcher.loadPairStatuses(statuses);
      this.sportsMatcher.loadPairStatuses(statuses);

      if (loadedPairs.length > 0) {
        this.cachedPairs = loadedPairs;
        this.rebuildMarketIndex();
        log.info('Loaded persisted pairs from DB', {
          total: loadedPairs.length,
          approved: loadedPairs.filter(p => p.status === 'approved').length,
          pending: loadedPairs.filter(p => p.status === 'pending').length,
        });
      }
    } catch (err) {
      log.warn('Failed to load persisted pairs', { error: (err as Error).message });
    }
  }

  /** Expose market/pair data for the dashboard */
  getMarketsSummary(): {
    platforms: Record<string, { total: number; markets: Array<{ id: string; question: string; category: string; slug: string; eventSlug?: string; matched: boolean }> }>;
    matchedPairs: Array<{
      pairId: string;
      marketA: { id: string; platform: string; question: string; slug: string; eventSlug?: string };
      marketB: { id: string; platform: string; question: string; slug: string; eventSlug?: string };
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

    const platforms: Record<string, { total: number; markets: Array<{ id: string; question: string; category: string; slug: string; eventSlug?: string; matched: boolean }> }> = {};
    for (const [platform, markets] of this.lastFetchedMarkets.entries()) {
      const pMatched = matchedIds.get(platform) || new Set();
      platforms[platform] = {
        total: markets.length,
        markets: markets.map(m => ({
          id: m.id,
          question: m.question,
          category: m.category,
          slug: m.slug,
          eventSlug: m.eventSlug,
          matched: pMatched.has(m.id),
        })),
      };
    }

    const matchedPairs = this.cachedPairs.map(p => ({
      pairId: p.pairId,
      marketA: { id: p.marketA.id, platform: p.marketA.platform, question: p.marketA.question, slug: p.marketA.slug || '', eventSlug: p.marketA.eventSlug },
      marketB: { id: p.marketB.id, platform: p.marketB.platform, question: p.marketB.question, slug: p.marketB.slug || '', eventSlug: p.marketB.eventSlug },
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

    // Get all connected platforms
    const activePlatforms: Platform[] = [];
    for (const [platform, conn] of this.connectors) {
      if (conn.isConnected) activePlatforms.push(platform);
    }

    if (activePlatforms.length < 2) {
      log.warn('Need at least 2 connected platforms for arbitrage', { activePlatforms });
      return;
    }

    const category = this.getCategory() || undefined;

    // ── Route to category-specific discovery + matching ────────────────────
    // Each category (sports, politics, crypto) has its own optimized
    // discovery and matching pipeline for higher quality results.
    const isSportsCategory = this.isSportsCategory(category);

    if (isSportsCategory) {
      await this.refreshSportsPairs(activePlatforms, category);
    } else {
      await this.refreshGenericPairs(activePlatforms, category);
    }
  }

  /**
   * Check if a category string maps to the sports category.
   * Handles all sports sub-categories (nba, nfl, etc.).
   */
  private isSportsCategory(category?: string): boolean {
    if (!category) return false;
    const sportsCats = [
      'sports', 'nba', 'nfl', 'mlb', 'nhl', 'mls', 'mma', 'ufc',
      'basketball', 'football', 'baseball', 'hockey', 'soccer',
      'tennis', 'golf', 'motorsports', 'f1', 'boxing', 'cricket',
      'ncaa', 'ncaab', 'ncaaf', 'epl',
    ];
    return sportsCats.includes(category.toLowerCase());
  }

  /**
   * Sports-specific refresh: uses SportsDiscovery + SportsMatcher.
   * - Fetches from each platform using optimized sports APIs
   *   (series_ticker for Kalshi, sports_market_types for Polymarket, etc.)
   * - Matches deterministically by team names + game date (no LLM needed)
   * - Time-bounded: only looks at upcoming events (default 3 days)
   */
  private async refreshSportsPairs(activePlatforms: Platform[], category?: string): Promise<void> {
    log.info('Using sports-specific discovery + matching pipeline', { category });

    // Map category to a sports league hint
    const leagueMap: Record<string, string> = {
      nba: 'NBA', basketball: 'NBA',
      nfl: 'NFL', football: 'NFL',
      mlb: 'MLB', baseball: 'MLB',
      nhl: 'NHL', hockey: 'NHL',
      mls: 'MLS', soccer: 'MLS',
      ufc: 'UFC', mma: 'UFC',
      ncaa: 'NCAAB', ncaab: 'NCAAB', ncaaf: 'NCAAF',
      tennis: 'TENNIS', golf: 'GOLF',
      f1: 'F1', motorsports: 'F1',
      boxing: 'BOXING', cricket: 'CRICKET',
    };
    const league = category ? leagueMap[category.toLowerCase()] : undefined;

    // ── Step 1: Sports-specific discovery ──────────────────────────────────
    const result = await this.sportsDiscovery.discover(this.connectors, {
      league: league as SportsLeague | undefined,
      lookAheadDays: 3,
      maxResults: 1000,
    });

    // Cache for dashboard visibility
    const platformMarkets = new Map<Platform, NormalizedMarket[]>();
    for (const [platform, markets] of result.markets) {
      this.lastFetchedMarkets.set(platform, markets);
      platformMarkets.set(platform, markets);
    }

    // ── Step 2: Incremental matching ──────────────────────────────────────
    const existingMatchedIds = new Set<string>();
    for (const pair of this.cachedPairs) {
      existingMatchedIds.add(pair.marketA.id);
      existingMatchedIds.add(pair.marketB.id);
    }

    // Update existing pairs' market data with fresh fetched data
    const freshMarketIndex = new Map<string, NormalizedMarket>();
    for (const markets of platformMarkets.values()) {
      for (const m of markets) freshMarketIndex.set(m.id, m);
    }
    for (const pair of this.cachedPairs) {
      const freshA = freshMarketIndex.get(pair.marketA.id);
      if (freshA) pair.marketA = freshA;
      const freshB = freshMarketIndex.get(pair.marketB.id);
      if (freshB) pair.marketB = freshB;
    }

    // ── Step 3: Sports-specific matching (deterministic, O(n+m)) ─────────
    const oldPairIds = new Set(this.cachedPairs.map(p => `${p.marketA.id}:${p.marketB.id}`));
    const newPairs: MarketPair[] = [];

    for (let i = 0; i < activePlatforms.length; i++) {
      for (let j = i + 1; j < activePlatforms.length; j++) {
        const platA = activePlatforms[i];
        const platB = activePlatforms[j];
        const allMarketsA = (result.markets.get(platA) || []) as DiscoveredMarket[];
        const allMarketsB = (result.markets.get(platB) || []) as DiscoveredMarket[];

        const unmatchedA = allMarketsA.filter(m => !existingMatchedIds.has(m.id));
        const unmatchedB = allMarketsB.filter(m => !existingMatchedIds.has(m.id));

        if (unmatchedA.length === 0 && unmatchedB.length === 0) {
          log.info(`Skipping ${platA} ↔ ${platB}: no new unmatched sports markets`);
          continue;
        }

        // Sports matcher: deterministic team+date matching
        const pairsSeen = new Set<string>();

        if (unmatchedA.length > 0) {
          log.info(`Sports matching NEW ${platA} (${unmatchedA.length}) ↔ ${platB} (${allMarketsB.length})`);
          const pairs = this.sportsMatcher.match(unmatchedA, allMarketsB);
          for (const p of pairs) {
            if (!pairsSeen.has(p.pairId)) {
              pairsSeen.add(p.pairId);
              newPairs.push(p);
            }
          }
        }

        if (unmatchedB.length > 0) {
          log.info(`Sports matching ${platA} (${allMarketsA.length}) ↔ NEW ${platB} (${unmatchedB.length})`);
          const pairs = this.sportsMatcher.match(allMarketsA, unmatchedB);
          for (const p of pairs) {
            if (!pairsSeen.has(p.pairId)) {
              pairsSeen.add(p.pairId);
              newPairs.push(p);
            }
          }
        }
      }
    }

    // ── Step 4: Also try cross-reference matching from predict.fun ────────
    // predict.fun markets often have polymarketConditionIds and kalshiMarketTicker
    // which give us guaranteed matches regardless of question text parsing.
    this.applyCrossReferenceMatches(result.markets, existingMatchedIds, newPairs);

    // ── Finalize ──────────────────────────────────────────────────────────
    this.finalizeRefresh(newPairs, oldPairIds);
  }

  /**
   * Generic refresh: uses the original generic MarketMatcher pipeline.
   * Used for non-sports categories or when no category is set.
   */
  private async refreshGenericPairs(activePlatforms: Platform[], category?: string): Promise<void> {
    const isCategoryFiltered = !!category;

    // Fetch markets from ALL active platforms in parallel
    const baseOpts = {
      activeOnly: true,
      limit: isCategoryFiltered ? 100 : 200,
      sortBy: 'volume' as const,
      sortDirection: 'desc' as const,
      category,
    };

    const fetchPromises = activePlatforms.map(async (platform) => {
      const conn = this.connectors.get(platform)!;
      const opts = platform === 'polymarket'
        ? { ...baseOpts, minLiquidity: isCategoryFiltered ? 0 : 100 }
        : baseOpts;
      const markets = await conn.fetchMarkets(opts);
      return { platform, markets };
    });

    const fetchResults = await Promise.all(fetchPromises);

    // Cache for dashboard visibility
    const platformMarkets = new Map<Platform, NormalizedMarket[]>();
    for (const { platform, markets } of fetchResults) {
      this.lastFetchedMarkets.set(platform, markets);
      platformMarkets.set(platform, markets);
      log.info(`Markets fetched from ${platform}`, { count: markets.length });
    }

    // ── Incremental matching ──────────────────────────────────────────────
    const existingMatchedIds = new Set<string>();
    for (const pair of this.cachedPairs) {
      existingMatchedIds.add(pair.marketA.id);
      existingMatchedIds.add(pair.marketB.id);
    }

    // Update existing pairs' market data with fresh fetched data
    const freshMarketIndex = new Map<string, NormalizedMarket>();
    for (const markets of platformMarkets.values()) {
      for (const m of markets) freshMarketIndex.set(m.id, m);
    }
    for (const pair of this.cachedPairs) {
      const freshA = freshMarketIndex.get(pair.marketA.id);
      if (freshA) pair.marketA = freshA;
      const freshB = freshMarketIndex.get(pair.marketB.id);
      if (freshB) pair.marketB = freshB;
    }

    // Pairwise matching using generic 5-pass pipeline
    const oldPairIds = new Set(this.cachedPairs.map(p => `${p.marketA.id}:${p.marketB.id}`));
    const newPairs: MarketPair[] = [];

    for (let i = 0; i < activePlatforms.length; i++) {
      for (let j = i + 1; j < activePlatforms.length; j++) {
        const platA = activePlatforms[i];
        const platB = activePlatforms[j];
        const allMarketsA = platformMarkets.get(platA) || [];
        const allMarketsB = platformMarkets.get(platB) || [];

        const unmatchedA = allMarketsA.filter(m => !existingMatchedIds.has(m.id));
        const unmatchedB = allMarketsB.filter(m => !existingMatchedIds.has(m.id));

        if (unmatchedA.length === 0 && unmatchedB.length === 0) {
          log.info(`Skipping ${platA} ↔ ${platB}: no new unmatched markets`);
          continue;
        }

        const pairsSeen = new Set<string>();

        if (unmatchedA.length > 0) {
          log.info(`Matching NEW ${platA} (${unmatchedA.length}) ↔ ${platB} (${allMarketsB.length})`);
          const pairs = await this.matcher.findPairs(unmatchedA, allMarketsB);
          for (const p of pairs) {
            if (!pairsSeen.has(p.pairId)) {
              pairsSeen.add(p.pairId);
              newPairs.push(p);
            }
          }
        }

        if (unmatchedB.length > 0) {
          log.info(`Matching ${platA} (${allMarketsA.length}) ↔ NEW ${platB} (${unmatchedB.length})`);
          const pairs = await this.matcher.findPairs(allMarketsA, unmatchedB);
          for (const p of pairs) {
            if (!pairsSeen.has(p.pairId)) {
              pairsSeen.add(p.pairId);
              newPairs.push(p);
            }
          }
        }
      }
    }

    this.finalizeRefresh(newPairs, oldPairIds);
  }

  /**
   * Apply cross-reference matches from predict.fun's built-in fields.
   * predict.fun markets often have `polymarketConditionIds` and `kalshiMarketTicker`
   * which provide guaranteed 1:1 matches regardless of question text parsing.
   */
  private applyCrossReferenceMatches(
    discoveredMarkets: Map<Platform, DiscoveredMarket[]>,
    existingMatchedIds: Set<string>,
    newPairs: MarketPair[],
  ): void {
    const predictFunMarkets = discoveredMarkets.get('predictfun') || [];
    if (predictFunMarkets.length === 0) return;

    const newPairIds = new Set(newPairs.map(p => p.pairId));

    // Build indexes for Polymarket and Kalshi markets by their IDs
    const polymarketById = new Map<string, DiscoveredMarket>();
    for (const m of (discoveredMarkets.get('polymarket') || [])) {
      polymarketById.set(m.id, m);
    }
    const kalshiById = new Map<string, DiscoveredMarket>();
    for (const m of (discoveredMarkets.get('kalshi') || [])) {
      kalshiById.set(m.id, m);
    }

    // Also index Polymarket by conditionId for cross-reference matching
    const polymarketByConditionId = new Map<string, DiscoveredMarket>();
    for (const m of (discoveredMarkets.get('polymarket') || [])) {
      const raw = m.raw as Record<string, unknown> | undefined;
      const conditionId = raw?.conditionId as string;
      if (conditionId) polymarketByConditionId.set(conditionId, m);
    }

    let crossRefMatches = 0;

    for (const pfMarket of predictFunMarkets) {
      const raw = pfMarket.raw as Record<string, unknown> | undefined;
      if (!raw) continue;

      // predict.fun → Polymarket via polymarketConditionIds
      const pmConditionIds = (raw.polymarketConditionIds as string[]) || [];
      for (const condId of pmConditionIds) {
        if (!condId) continue;
        const pmMarket = polymarketByConditionId.get(condId);
        if (!pmMarket) continue;
        if (existingMatchedIds.has(pfMarket.id) && existingMatchedIds.has(pmMarket.id)) continue;

        const pairId = MarketMatcher.pairId(pmMarket.id, pfMarket.id);
        if (newPairIds.has(pairId)) continue; // Already matched by sports matcher

        newPairs.push({
          pairId,
          marketA: pmMarket,
          marketB: pfMarket,
          confidence: 1.0,
          matchMethod: 'cross_reference',
          status: 'approved',
        });
        newPairIds.add(pairId);
        crossRefMatches++;
      }

      // predict.fun → Kalshi via kalshiMarketTicker
      const kalshiTicker = raw.kalshiMarketTicker as string;
      if (kalshiTicker) {
        const kalshiMarket = kalshiById.get(kalshiTicker);
        if (kalshiMarket) {
          if (existingMatchedIds.has(pfMarket.id) && existingMatchedIds.has(kalshiMarket.id)) continue;

          const pairId = MarketMatcher.pairId(kalshiMarket.id, pfMarket.id);
          if (newPairIds.has(pairId)) continue;

          newPairs.push({
            pairId,
            marketA: kalshiMarket,
            marketB: pfMarket,
            confidence: 1.0,
            matchMethod: 'cross_reference',
            status: 'approved',
          });
          newPairIds.add(pairId);
          crossRefMatches++;
        }
      }
    }

    if (crossRefMatches > 0) {
      log.info('Cross-reference matches found', { count: crossRefMatches });
    }
  }

  /**
   * Shared finalization: merge new pairs, persist, rebuild index, subscribe WS.
   */
  private finalizeRefresh(newPairs: MarketPair[], oldPairIds: Set<string>): void {
    if (newPairs.length > 0) {
      log.info('New pairs discovered', { count: newPairs.length });
      this.cachedPairs.push(...newPairs);
    } else {
      log.info('No new pairs found');
    }

    this.lastPairRefresh = Date.now();
    this.rebuildMarketIndex();

    // Persist only NEW pairs to DB
    for (const pair of newPairs) {
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
    this.subscribeToMatchedPairsMultiPlatform(oldPairIds);
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
   * Groups new markets by platform and subscribes each connector.
   */
  private subscribeToMatchedPairsMultiPlatform(oldPairIds: Set<string>): void {
    // Group new markets by platform
    const newMarketsByPlatform = new Map<Platform, NormalizedMarket[]>();

    for (const pair of this.cachedPairs) {
      const pairId = `${pair.marketA.id}:${pair.marketB.id}`;
      if (!oldPairIds.has(pairId)) {
        // Add market A
        const listA = newMarketsByPlatform.get(pair.marketA.platform) ?? [];
        listA.push(pair.marketA);
        newMarketsByPlatform.set(pair.marketA.platform, listA);

        // Add market B
        const listB = newMarketsByPlatform.get(pair.marketB.platform) ?? [];
        listB.push(pair.marketB);
        newMarketsByPlatform.set(pair.marketB.platform, listB);
      }
    }

    for (const [platform, markets] of newMarketsByPlatform) {
      if (markets.length === 0) continue;
      const conn = this.connectors.get(platform);
      if (!conn) continue;

      try {
        conn.subscribeOrderBooks(markets);
        log.info(`Subscribed ${markets.length} new markets on ${platform} for WS books`);
      } catch (err) {
        log.warn(`Failed to subscribe WS books on ${platform}`, { error: (err as Error).message });
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
    // To buy NO on B, we use B's YES bids inverted: cost_NO = 1 - bid_price
    if (bookAYes.bestAsk !== null && bookBYes.bestBid !== null) {
      // Invert B's bids into "NO ask levels": price = 1 - bid, size = bid size
      // Sorted lowest price first (like an ask book)
      const noBLevels: PriceLevel[] = bookBYes.bids.map(b => ({
        price: 1 - b.price,
        size: b.size,
      })).sort((a, b) => a.price - b.price);

      // Dynamic profit threshold based on execution risk
      const depthA = bookAYes.asks.reduce((s, l) => s + l.size, 0);
      const depthB = bookBYes.bids.reduce((s, l) => s + l.size, 0);
      const dynamicMinBps = this.getDynamicMinProfitBps(
        pair.confidence, bookAYes.spread, bookBYes.spread,
        Math.min(depthA, depthB), depthA, depthB,
      );

      // Walk both books for optimal size
      const walkResult = this.walkBooksForOptimalSize(
        pair.marketA.platform,
        pair.marketB.platform,
        bookAYes.asks,   // buy YES on A at ask levels
        noBLevels,        // buy NO on B (inverted bid levels)
        dynamicMinBps,
        this.config.maxPositionUsd,
      );

      if (walkResult && walkResult.size > 0) {
        const totalValue = walkResult.size * (walkResult.avgPriceA + walkResult.avgPriceB);
        if (minDepthUsd <= 0 || totalValue >= minDepthUsd) {
          opportunities.push(this.createOpportunity(
            pair,
            'YES', walkResult.avgPriceA, bookAYes, walkResult.size,
            'NO', walkResult.avgPriceB, bookBYes, walkResult.size,
            walkResult.profitPerShare * walkResult.size, walkResult.profitBps, walkResult.size,
          ));
        } else {
          onSkip('below_depth');
        }
      } else {
        // Check if it was a book issue or a profit issue
        const topCost = bookAYes.bestAsk + (1 - bookBYes.bestBid);
        if (topCost >= 1.0) onSkip('below_profit');
        else onSkip('below_profit');
      }
    } else {
      onSkip('null_book');
    }

    // Direction 2: Buy NO on A, Buy YES on B
    // To buy NO on A, we use A's YES bids inverted: cost_NO = 1 - bid_price
    if (bookAYes.bestBid !== null && bookBYes.bestAsk !== null) {
      // Invert A's bids into "NO ask levels"
      const noALevels: PriceLevel[] = bookAYes.bids.map(b => ({
        price: 1 - b.price,
        size: b.size,
      })).sort((a, b) => a.price - b.price);

      // Dynamic profit threshold based on execution risk
      const depthA2 = bookAYes.bids.reduce((s, l) => s + l.size, 0);
      const depthB2 = bookBYes.asks.reduce((s, l) => s + l.size, 0);
      const dynamicMinBps2 = this.getDynamicMinProfitBps(
        pair.confidence, bookAYes.spread, bookBYes.spread,
        Math.min(depthA2, depthB2), depthA2, depthB2,
      );

      const walkResult = this.walkBooksForOptimalSize(
        pair.marketA.platform,
        pair.marketB.platform,
        noALevels,        // buy NO on A (inverted bid levels)
        bookBYes.asks,    // buy YES on B at ask levels
        dynamicMinBps2,
        this.config.maxPositionUsd,
      );

      if (walkResult && walkResult.size > 0) {
        const totalValue = walkResult.size * (walkResult.avgPriceA + walkResult.avgPriceB);
        if (minDepthUsd <= 0 || totalValue >= minDepthUsd) {
          opportunities.push(this.createOpportunity(
            pair,
            'NO', walkResult.avgPriceA, bookAYes, walkResult.size,
            'YES', walkResult.avgPriceB, bookBYes, walkResult.size,
            walkResult.profitPerShare * walkResult.size, walkResult.profitBps, walkResult.size,
          ));
        } else {
          onSkip('below_depth');
        }
      } else {
        const topCost = (1 - bookAYes.bestBid) + bookBYes.bestAsk;
        if (topCost >= 1.0) onSkip('below_profit');
        else onSkip('below_profit');
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
