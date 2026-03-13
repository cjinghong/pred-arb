// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Backtest Data Fetcher
// Fetches historical market data from Polymarket & predict.fun for backtesting
// ═══════════════════════════════════════════════════════════════════════════

import { NormalizedMarket, Platform, OrderBook, PriceLevel } from '../types';
import { createChildLogger } from '../utils/logger';
import { config } from '../utils/config';

const log = createChildLogger('backtest:data');

export interface HistoricalSnapshot {
  timestamp: Date;
  markets: Map<string, NormalizedMarket>;
  orderBooks: Map<string, OrderBook>; // key: `${marketId}:${outcomeIndex}`
}

export interface BacktestDataset {
  polymarketMarkets: NormalizedMarket[];
  predictfunMarkets: NormalizedMarket[];
  /** Time-series of order book snapshots */
  snapshots: HistoricalSnapshot[];
  /** Start time of the dataset */
  startTime: Date;
  /** End time of the dataset */
  endTime: Date;
  /** Number of data points */
  dataPoints: number;
}

/**
 * Fetch current live market data from both platforms for backtesting.
 * Since historical order book data isn't available via public APIs,
 * we simulate historical price movement from current market state
 * using a realistic stochastic model.
 */
export class BacktestDataFetcher {
  private gammaUrl: string;
  private predictfunUrl: string;

  constructor() {
    this.gammaUrl = config.polymarket.gammaUrl;
    this.predictfunUrl = config.predictfun.useTestnet
      ? config.predictfun.testnetUrl
      : config.predictfun.apiUrl;
  }

  /**
   * Fetch live market data and generate a simulated historical dataset.
   * Uses real market states + Monte Carlo price simulation.
   */
  async fetchAndBuild(options: {
    /** Number of simulated time steps */
    numSnapshots?: number;
    /** Interval between snapshots in ms */
    intervalMs?: number;
    /** Maximum markets per platform */
    maxMarkets?: number;
  } = {}): Promise<BacktestDataset> {
    const {
      numSnapshots = 500,
      intervalMs = 30_000, // 30 seconds between snapshots
      maxMarkets = 100,
    } = options;

    log.info('Fetching live market data for backtesting...', { maxMarkets });

    // Fetch markets from both platforms
    let polymarkets: NormalizedMarket[] = [];
    let predictfunMarkets: NormalizedMarket[] = [];

    try {
      polymarkets = await this.fetchPolymarketMarkets(maxMarkets);
      log.info(`Fetched ${polymarkets.length} Polymarket markets`);
    } catch (err) {
      log.warn('Failed to fetch Polymarket markets, using synthetic data', {
        error: (err as Error).message,
      });
      polymarkets = this.generateSyntheticMarkets('polymarket', 50);
    }

    try {
      predictfunMarkets = await this.fetchPredictFunMarkets(maxMarkets);
      log.info(`Fetched ${predictfunMarkets.length} predict.fun markets`);
    } catch (err) {
      log.warn('Failed to fetch predict.fun markets, using synthetic data', {
        error: (err as Error).message,
      });
      predictfunMarkets = this.generateSyntheticMarkets('predictfun', 50);
    }

    // If we got no data at all, generate everything synthetically
    if (polymarkets.length === 0 && predictfunMarkets.length === 0) {
      polymarkets = this.generateSyntheticMarkets('polymarket', 50);
      predictfunMarkets = this.generateSyntheticMarkets('predictfun', 50);
    }

    // Generate simulated historical snapshots
    const snapshots = this.generateSimulatedHistory(
      polymarkets, predictfunMarkets, numSnapshots, intervalMs,
    );

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - numSnapshots * intervalMs);

    log.info('Backtest dataset built', {
      polymarkets: polymarkets.length,
      predictfunMarkets: predictfunMarkets.length,
      snapshots: snapshots.length,
      timeSpan: `${((endTime.getTime() - startTime.getTime()) / 3600000).toFixed(1)}h`,
    });

    return {
      polymarketMarkets: polymarkets,
      predictfunMarkets: predictfunMarkets,
      snapshots,
      startTime,
      endTime,
      dataPoints: snapshots.length,
    };
  }

  private async fetchPolymarketMarkets(limit: number): Promise<NormalizedMarket[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      active: 'true',
      closed: 'false',
      order: 'liquidity',
      ascending: 'false',
      liquidity_num_min: '100',
    });

    const resp = await fetch(`${this.gammaUrl}/markets?${params}`);
    if (!resp.ok) throw new Error(`Polymarket API error: ${resp.status}`);
    const raw = await resp.json() as Array<Record<string, unknown>>;

    return raw
      .filter(m => {
        try {
          const outcomes = JSON.parse(m.outcomes as string || '[]');
          return outcomes.length === 2;
        } catch { return false; }
      })
      .map(m => this.normalizePolymarket(m));
  }

  private normalizePolymarket(raw: Record<string, unknown>): NormalizedMarket {
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    let tokenIds: string[] = [];
    try { outcomes = JSON.parse(raw.outcomes as string || '[]'); } catch { /* */ }
    try { outcomePrices = JSON.parse(raw.outcomePrices as string || '[]').map(Number); } catch { /* */ }
    try { tokenIds = JSON.parse(raw.clobTokenIds as string || '[]'); } catch { /* */ }

    return {
      id: (raw.id || raw.conditionId) as string,
      platform: 'polymarket',
      question: raw.question as string,
      slug: raw.slug as string || '',
      category: raw.category as string || '',
      outcomes,
      outcomeTokenIds: tokenIds,
      outcomePrices,
      volume: (raw.volume as number) || 0,
      liquidity: (raw.liquidity as number) || 0,
      active: true,
      endDate: raw.endDate ? new Date(raw.endDate as string) : null,
      lastUpdated: new Date(),
      raw,
    };
  }

  private async fetchPredictFunMarkets(limit: number): Promise<NormalizedMarket[]> {
    const params = new URLSearchParams({
      first: String(limit),
      status: 'OPEN',
      sort: 'VOLUME_TOTAL_DESC',
    });

    const resp = await fetch(`${this.predictfunUrl}/v1/markets?${params}`);
    if (!resp.ok) throw new Error(`predict.fun API error: ${resp.status}`);
    const body = await resp.json() as { data: Array<Record<string, unknown>> };
    const markets = body.data || [];

    return markets
      .filter(m => {
        const outcomes = m.outcomes as Array<{ name: string }> || [];
        return outcomes.length === 2 && m.tradingStatus === 'OPEN';
      })
      .map(m => this.normalizePredictFun(m));
  }

  private normalizePredictFun(raw: Record<string, unknown>): NormalizedMarket {
    const rawOutcomes = (raw.outcomes as Array<{ name: string; onChainId: string }>) || [];
    return {
      id: String(raw.id),
      platform: 'predictfun',
      question: (raw.question || raw.title) as string,
      slug: (raw.conditionId as string) || '',
      category: (raw.categorySlug as string) || '',
      outcomes: rawOutcomes.map(o => o.name || 'Unknown'),
      outcomeTokenIds: rawOutcomes.map(o => o.onChainId || ''),
      outcomePrices: rawOutcomes.map(() => 0),
      volume: 0,
      liquidity: 0,
      active: true,
      endDate: null,
      lastUpdated: new Date(),
      raw,
    };
  }

  /**
   * Generate synthetic markets for testing when APIs are unavailable.
   * Creates realistic-looking prediction markets with correlated pairs.
   */
  private generateSyntheticMarkets(platform: Platform, count: number): NormalizedMarket[] {
    const topics = [
      { q: 'Will Bitcoin exceed $100,000 by end of 2026?', cat: 'crypto', slug: 'btc-100k-2026' },
      { q: 'Will the Fed cut rates in Q2 2026?', cat: 'economics', slug: 'fed-cut-q2-2026' },
      { q: 'Will SpaceX land on Mars by 2028?', cat: 'science', slug: 'spacex-mars-2028' },
      { q: 'Will the US enter a recession in 2026?', cat: 'economics', slug: 'us-recession-2026' },
      { q: 'Will Ethereum surpass $10,000 in 2026?', cat: 'crypto', slug: 'eth-10k-2026' },
      { q: 'Will Donald Trump win the 2028 election?', cat: 'politics', slug: 'trump-2028' },
      { q: 'Will Tesla stock reach $400 in 2026?', cat: 'finance', slug: 'tsla-400-2026' },
      { q: 'Will a nuclear fusion reactor achieve net energy by 2030?', cat: 'science', slug: 'fusion-net-energy-2030' },
      { q: 'Will global GDP grow more than 3% in 2026?', cat: 'economics', slug: 'gdp-growth-3pct-2026' },
      { q: 'Will Apple release AR glasses by end of 2026?', cat: 'tech', slug: 'apple-ar-glasses-2026' },
      { q: 'Will the S&P 500 close above 6000 in 2026?', cat: 'finance', slug: 'sp500-6000-2026' },
      { q: 'Will there be a ceasefire in Ukraine by end of 2026?', cat: 'politics', slug: 'ukraine-ceasefire-2026' },
      { q: 'Will OpenAI release GPT-5 by June 2026?', cat: 'tech', slug: 'openai-gpt5-2026' },
      { q: 'Will the UK rejoin the EU by 2030?', cat: 'politics', slug: 'uk-eu-2030' },
      { q: 'Will a quantum computer break RSA-2048 by 2028?', cat: 'tech', slug: 'quantum-rsa-2028' },
      { q: 'Will gold exceed $3,000/oz in 2026?', cat: 'finance', slug: 'gold-3000-2026' },
      { q: 'Will Solana price reach $500?', cat: 'crypto', slug: 'sol-500-2026' },
      { q: 'Will TikTok be banned in the US?', cat: 'politics', slug: 'tiktok-ban-us' },
      { q: 'Will the next pandemic occur before 2028?', cat: 'science', slug: 'next-pandemic-2028' },
      { q: 'Will autonomous vehicles be legal in all US states by 2028?', cat: 'tech', slug: 'av-legal-2028' },
      { q: 'Will China invade Taiwan before 2030?', cat: 'politics', slug: 'china-taiwan-2030' },
      { q: 'Will India become the third largest economy by 2027?', cat: 'economics', slug: 'india-3rd-economy-2027' },
      { q: 'Will Dogecoin reach $1?', cat: 'crypto', slug: 'doge-1-dollar' },
      { q: 'Will AGI be achieved by 2030?', cat: 'tech', slug: 'agi-2030' },
      { q: 'Will the US national debt exceed $40 trillion by 2026?', cat: 'economics', slug: 'us-debt-40t' },
    ];

    const markets: NormalizedMarket[] = [];
    for (let i = 0; i < Math.min(count, topics.length); i++) {
      const t = topics[i];
      // Slight variation in question for cross-platform
      const question = platform === 'predictfun'
        ? t.q.replace('Will', 'Will').replace('?', ' ?') // subtle variation
        : t.q;

      const yesPrice = 0.15 + Math.random() * 0.7; // 0.15 - 0.85
      markets.push({
        id: `${platform}-${i}`,
        platform,
        question,
        slug: t.slug,
        category: t.cat,
        outcomes: ['Yes', 'No'],
        outcomeTokenIds: [`${platform}-yes-${i}`, `${platform}-no-${i}`],
        outcomePrices: [yesPrice, 1 - yesPrice],
        volume: 10000 + Math.random() * 990000,
        liquidity: 5000 + Math.random() * 495000,
        active: true,
        endDate: new Date(Date.now() + (30 + Math.random() * 365) * 86400000),
        lastUpdated: new Date(),
      });
    }

    return markets;
  }

  /**
   * Generate simulated historical order book snapshots.
   * Uses a mean-reverting stochastic process for realistic price dynamics.
   *
   * Key assumptions:
   * - Prices follow Ornstein-Uhlenbeck process (mean-reverting)
   * - Cross-platform prices are correlated but not identical (the arb signal)
   * - Spreads widen during volatile periods
   * - Liquidity varies by market
   */
  private generateSimulatedHistory(
    polymarkets: NormalizedMarket[],
    predictfunMarkets: NormalizedMarket[],
    numSnapshots: number,
    intervalMs: number,
  ): HistoricalSnapshot[] {
    const snapshots: HistoricalSnapshot[] = [];
    const now = Date.now();

    // Find matched pairs by slug for realistic cross-platform simulation
    const matchedPairs: Array<{ poly: NormalizedMarket; pfun: NormalizedMarket }> = [];
    for (const poly of polymarkets) {
      const pfun = predictfunMarkets.find(m =>
        this.slugsMatch(poly.slug, m.slug) ||
        this.questionsClose(poly.question, m.question)
      );
      if (pfun) {
        matchedPairs.push({ poly, pfun });
      }
    }

    // Initialize price state for each market
    const priceState = new Map<string, number>();
    for (const m of [...polymarkets, ...predictfunMarkets]) {
      priceState.set(m.id, m.outcomePrices[0] || 0.5);
    }

    for (let step = 0; step < numSnapshots; step++) {
      const timestamp = new Date(now - (numSnapshots - step) * intervalMs);
      const markets = new Map<string, NormalizedMarket>();
      const orderBooks = new Map<string, OrderBook>();

      // Update prices with correlated Ornstein-Uhlenbeck process
      for (const pair of matchedPairs) {
        const priceA = priceState.get(pair.poly.id) || 0.5;
        const priceB = priceState.get(pair.pfun.id) || 0.5;

        // Mean-reversion to "true" value (average of both)
        const trueValue = (priceA + priceB) / 2;
        const meanRevSpeed = 0.05;
        const volatility = 0.008; // ~0.8% per step
        const crossCorrelation = 0.85; // High but not perfect correlation

        // Shared market shock
        const commonShock = this.gaussianRandom() * volatility;
        // Idiosyncratic shocks (platform-specific)
        const shockA = commonShock * crossCorrelation + this.gaussianRandom() * volatility * Math.sqrt(1 - crossCorrelation ** 2);
        const shockB = commonShock * crossCorrelation + this.gaussianRandom() * volatility * Math.sqrt(1 - crossCorrelation ** 2);

        const newPriceA = this.clamp(
          priceA + meanRevSpeed * (trueValue - priceA) + shockA,
          0.02, 0.98,
        );
        const newPriceB = this.clamp(
          priceB + meanRevSpeed * (trueValue - priceB) + shockB,
          0.02, 0.98,
        );

        priceState.set(pair.poly.id, newPriceA);
        priceState.set(pair.pfun.id, newPriceB);

        // Build market snapshots
        const polyMarket = { ...pair.poly, outcomePrices: [newPriceA, 1 - newPriceA], lastUpdated: timestamp };
        const pfunMarket = { ...pair.pfun, outcomePrices: [newPriceB, 1 - newPriceB], lastUpdated: timestamp };
        markets.set(pair.poly.id, polyMarket);
        markets.set(pair.pfun.id, pfunMarket);

        // Generate order books
        orderBooks.set(`${pair.poly.id}:0`, this.generateOrderBook('polymarket', pair.poly.id, 0, newPriceA, timestamp));
        orderBooks.set(`${pair.pfun.id}:0`, this.generateOrderBook('predictfun', pair.pfun.id, 0, newPriceB, timestamp));
      }

      // Also update unmatched markets (for completeness)
      for (const m of [...polymarkets, ...predictfunMarkets]) {
        if (!markets.has(m.id)) {
          const price = priceState.get(m.id) || 0.5;
          const newPrice = this.clamp(price + this.gaussianRandom() * 0.005, 0.02, 0.98);
          priceState.set(m.id, newPrice);
          markets.set(m.id, { ...m, outcomePrices: [newPrice, 1 - newPrice], lastUpdated: timestamp });
        }
      }

      snapshots.push({ timestamp, markets, orderBooks });
    }

    return snapshots;
  }

  /** Generate a realistic order book around a mid price */
  private generateOrderBook(
    platform: Platform,
    marketId: string,
    outcomeIndex: number,
    midPrice: number,
    timestamp: Date,
  ): OrderBook {
    const spread = 0.01 + Math.random() * 0.03; // 1-4 cent spread
    const halfSpread = spread / 2;
    const levels = 5 + Math.floor(Math.random() * 5); // 5-10 levels

    const bids: PriceLevel[] = [];
    const asks: PriceLevel[] = [];

    for (let i = 0; i < levels; i++) {
      const decay = 1 / (1 + i * 0.5);
      bids.push({
        price: Math.max(0.01, midPrice - halfSpread - i * 0.01),
        size: Math.floor((50 + Math.random() * 200) * decay),
      });
      asks.push({
        price: Math.min(0.99, midPrice + halfSpread + i * 0.01),
        size: Math.floor((50 + Math.random() * 200) * decay),
      });
    }

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;

    return {
      platform,
      marketId,
      outcomeIndex,
      bids,
      asks,
      minOrderSize: 1,
      tickSize: 0.01,
      bestBid,
      bestAsk,
      midPrice,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp,
    };
  }

  private gaussianRandom(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  private slugsMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return norm(a) === norm(b);
  }

  private questionsClose(a: string, b: string): boolean {
    if (!a || !b) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    return norm(a) === norm(b);
  }
}
