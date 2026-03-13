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
import { MarketMatcher, MarketPair } from '../matcher/market-matcher';
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
  private matcher = new MarketMatcher();
  private cachedPairs: MarketPair[] = [];
  private lastPairRefresh = 0;
  private pairRefreshIntervalMs = 5 * 60 * 1000; // Refresh pairs every 5 minutes

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

      // Step 2: For each pair, fetch order books and look for arb
      for (const pair of this.cachedPairs) {
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
    // - Polymarket: activeOnly, minLiquidity, sortBy all handled server-side
    // - predict.fun: activeOnly (status=active) handled server-side;
    //                minLiquidity falls back to client-side filtering
    const fetchOpts = {
      activeOnly: true,
      limit: 200,
      minLiquidity: 100,               // skip illiquid markets that can't fill
      sortBy: 'liquidity' as const,    // best arb candidates first
      sortDirection: 'desc' as const,
    };

    const [marketsA, marketsB] = await Promise.all([
      connA.fetchMarkets(fetchOpts),
      connB.fetchMarkets(fetchOpts),
    ]);

    log.info('Markets fetched', {
      polymarket: marketsA.length,
      predictfun: marketsB.length,
    });

    const oldPairIds = new Set(this.cachedPairs.map(p => `${p.marketA.id}:${p.marketB.id}`));
    this.cachedPairs = this.matcher.findPairs(marketsA, marketsB);
    this.lastPairRefresh = Date.now();

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
