// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Integration Test
// End-to-end flow: market scanning → matching → arb detection → execution
// Uses mocked connectors (no real network calls)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  NormalizedMarket,
  OrderBook,
  ArbitrageOpportunity,
  OrderResult,
  Platform,
  OrderStatus,
  OrderRequest,
  Position,
} from '../types';
import { MarketConnector, FetchMarketsOptions } from '../types/connector';
import { CrossPlatformArbStrategy } from '../strategies/cross-platform-arb';
import { ExecutionEngine } from '../engine/execution-engine';
import { RiskManager } from '../engine/risk-manager';

// ─── Module Mocks ──────────────────────────────────────────────────────────

vi.mock('../db/database', () => ({
  insertOpportunity: vi.fn(),
  insertTrade: vi.fn(),
  updateTradeStatus: vi.fn(),
  markOpportunityExecuted: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../utils/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../utils/config', () => ({
  config: {
    polymarket: {
      apiKey: 'mock-key',
      apiSecret: 'mock-secret',
      apiPassphrase: 'mock-pass',
      gammaUrl: 'https://gamma-api.polymarket.com',
      clobUrl: 'https://clob.polymarket.com',
      wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    },
    predictfun: {
      apiKey: 'mock-key',
      apiUrl: 'https://api.predict.fun',
      useTestnet: false,
    },
    bot: {
      minProfitBps: 100, // 1% for testing
      maxPositionUsd: 1000,
      scanIntervalMs: 10000,
      maxTotalExposureUsd: 5000,
    },
    dashboard: { port: 3847, apiPort: 3848 },
    db: { path: './data/pred-arb.db' },
    logging: { level: 'info' },
  },
}));

import {
  insertOpportunity,
  insertTrade,
  updateTradeStatus,
  markOpportunityExecuted,
} from '../db/database';
import { eventBus } from '../utils/event-bus';

// ─── Mock Connector Implementation ──────────────────────────────────────────

class MockMarketConnector implements MarketConnector {
  readonly platform: Platform;
  readonly name: string;
  isConnected = true;
  isWsConnected = true;

  private markets: NormalizedMarket[] = [];
  private orderBooks = new Map<string, OrderBook>();
  private openOrders: OrderResult[] = [];
  private positions: Position[] = [];
  private balance = 10000; // $10k balance per platform
  private eventHandlers = new Map<string, Set<Function>>();

  constructor(platform: Platform, markets: NormalizedMarket[], orderBooks: Map<string, OrderBook>) {
    this.platform = platform;
    this.name = `MockConnector-${platform}`;
    this.markets = markets;
    this.orderBooks = orderBooks;
  }

  async connect(): Promise<void> {
    this.isConnected = true;
    this.isWsConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.isWsConnected = false;
  }

  async fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]> {
    let result = [...this.markets];
    if (options?.activeOnly) {
      result = result.filter(m => m.active);
    }
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    return this.markets.find(m => m.id === marketId) || null;
  }

  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> {
    const key = `${marketId}:${outcomeIndex}`;
    const book = this.orderBooks.get(key);
    if (!book) {
      throw new Error(`Order book not found: ${key}`);
    }
    return { ...book };
  }

  subscribeOrderBooks(markets: NormalizedMarket[]): void {
    // No-op for mock
  }

  unsubscribeOrderBooks(marketIds: string[]): void {
    // No-op for mock
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // Simulate instant fill for testing
    const fees = order.size * order.price * 0.0005; // 0.05% fees
    const result: OrderResult = {
      id: uuid(),
      platform: order.platform,
      marketId: order.marketId,
      outcomeIndex: order.outcomeIndex,
      side: order.side,
      type: order.type,
      price: order.price,
      size: order.size,
      filledSize: order.size,
      avgFillPrice: order.price,
      status: 'FILLED',
      timestamp: new Date(),
      fees,
    };

    this.openOrders.push(result);
    this.balance -= order.size * order.price + fees;
    return result;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const idx = this.openOrders.findIndex(o => o.id === orderId);
    if (idx >= 0) {
      const order = this.openOrders[idx];
      this.balance += order.size * order.price; // Refund
      this.openOrders.splice(idx, 1);
      return true;
    }
    return false;
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    return [...this.openOrders];
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions];
  }

  async getBalance(): Promise<number> {
    return this.balance;
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: Function): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emitEvent(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach(h => h(event, data));
  }
}

// ─── Test Fixtures ────────────────────────────────────────────────────────

/**
 * Create a normalized market with reasonable defaults
 */
function createMockMarket(
  id: string,
  platform: Platform,
  question: string,
  slug: string,
  prices: [number, number] = [0.5, 0.5],
): NormalizedMarket {
  return {
    id,
    platform,
    question,
    slug,
    category: 'Politics',
    outcomes: ['Yes', 'No'],
    outcomeTokenIds: ['token-yes', 'token-no'],
    outcomePrices: prices,
    volume: 10000,
    liquidity: 5000,
    active: true,
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
    lastUpdated: new Date(),
  };
}

/**
 * Create an order book with specified bid/ask prices
 */
function createMockOrderBook(
  platform: Platform,
  marketId: string,
  outcomeIndex: number,
  bestBid: number,
  bestAsk: number,
): OrderBook {
  return {
    platform,
    marketId,
    outcomeIndex,
    bids: [{ price: bestBid, size: 1000 }],
    asks: [{ price: bestAsk, size: 1000 }],
    minOrderSize: 1,
    tickSize: 0.01,
    bestBid,
    bestAsk,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    timestamp: new Date(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Arbitrage Bot Integration', () => {
  let polymarketConnector: MockMarketConnector;
  let predictfunConnector: MockMarketConnector;
  let strategy: CrossPlatformArbStrategy;
  let riskManager: RiskManager;
  let executionEngine: ExecutionEngine;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create test markets with 3% arb opportunity:
    // - Polymarket: YES = 0.48, NO = 0.52
    // - PredictFun: YES = 0.51, NO = 0.49
    // Combined: YES on Poly (0.48) + NO on PredictFun (0.49) = 0.97 cost, $0.03 profit (3%)

    const polymarketMarkets = [
      createMockMarket(
        'poly-market-1',
        'polymarket',
        'Will the economy grow in 2026?',
        'economy-growth-2026',
        [0.48, 0.52],
      ),
    ];

    const predictfunMarkets = [
      createMockMarket(
        'predictfun-market-1',
        'predictfun',
        'Will the economy grow in 2026?',
        'economy-growth-2026',
        [0.51, 0.49],
      ),
    ];

    // Set up order books for arb:
    // Poly: YES can be bought at 0.48 (ask), NO at 0.52 (ask)
    const polyOrderBooks = new Map<string, OrderBook>();
    polyOrderBooks.set(
      'poly-market-1:0',
      createMockOrderBook('polymarket', 'poly-market-1', 0, 0.47, 0.48),
    );
    polyOrderBooks.set(
      'poly-market-1:1',
      createMockOrderBook('polymarket', 'poly-market-1', 1, 0.51, 0.52),
    );

    // PredictFun: YES can be bought at 0.51 (ask), NO at 0.49 (ask)
    const predictfunOrderBooks = new Map<string, OrderBook>();
    predictfunOrderBooks.set(
      'predictfun-market-1:0',
      createMockOrderBook('predictfun', 'predictfun-market-1', 0, 0.50, 0.51),
    );
    predictfunOrderBooks.set(
      'predictfun-market-1:1',
      createMockOrderBook('predictfun', 'predictfun-market-1', 1, 0.48, 0.49),
    );

    polymarketConnector = new MockMarketConnector('polymarket', polymarketMarkets, polyOrderBooks);
    predictfunConnector = new MockMarketConnector('predictfun', predictfunMarkets, predictfunOrderBooks);

    await polymarketConnector.connect();
    await predictfunConnector.connect();

    // Initialize strategy and engine
    strategy = new CrossPlatformArbStrategy();
    riskManager = new RiskManager();
    executionEngine = new ExecutionEngine(riskManager, true); // dryRun = true

    const connectorMap = new Map<Platform, MarketConnector>([
      ['polymarket', polymarketConnector],
      ['predictfun', predictfunConnector],
    ]);

    await strategy.initialize(connectorMap);
    riskManager.initialize(connectorMap);
    executionEngine.initialize(connectorMap, new Map([['cross-platform-arb', strategy]]));
  });

  afterEach(async () => {
    await polymarketConnector.disconnect();
    await predictfunConnector.disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('1. Full Scan Cycle', () => {
    it('should fetch markets from both connectors', async () => {
      const polymarkets = await polymarketConnector.fetchMarkets({ activeOnly: true, limit: 200 });
      const predictfunmarkets = await predictfunConnector.fetchMarkets({ activeOnly: true, limit: 200 });

      expect(polymarkets).toHaveLength(1);
      expect(predictfunmarkets).toHaveLength(1);
      expect(polymarkets[0].question).toContain('economy');
      expect(predictfunmarkets[0].question).toContain('economy');
    });

    it('should find matched market pairs', async () => {
      const polymarkets = await polymarketConnector.fetchMarkets({ activeOnly: true });
      const predictfunmarkets = await predictfunConnector.fetchMarkets({ activeOnly: true });

      // Manually run the matcher logic that the strategy uses
      const pairs = (strategy as any).matcher.findPairs(polymarkets, predictfunmarkets);

      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs[0].marketA.platform).toBe('polymarket');
      expect(pairs[0].marketB.platform).toBe('predictfun');
      expect(pairs[0].confidence).toBeGreaterThan(0.5);
    });

    it('should analyze pairs and detect arbitrage opportunities', async () => {
      const opportunities = await strategy.scan();

      expect(opportunities.length).toBeGreaterThan(0);
      const opp = opportunities[0];

      expect(opp.id).toBeDefined();
      expect(opp.strategyId).toBe('cross-platform-arb');
      expect(opp.legA.platform).toBe('polymarket');
      expect(opp.legB.platform).toBe('predictfun');
      expect(opp.expectedProfitUsd).toBeGreaterThan(0);
      expect(opp.expectedProfitBps).toBeGreaterThan(0);
      expect(opp.matchConfidence).toBeGreaterThan(0.5);
      expect(opp.executed).toBe(false);
    });

    it('should emit opportunity:found events', async () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      await strategy.scan();

      const opportunityEvents = emitSpy.mock.calls.filter(
        call => call[0] === 'opportunity:found',
      );
      expect(opportunityEvents.length).toBeGreaterThan(0);
    });

    it('should verify correct profit calculation with profitable margin', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];

      // Should have positive profit in basis points
      expect(opp.expectedProfitBps).toBeGreaterThan(0);
      // Expected profit USD should be positive
      expect(opp.expectedProfitUsd).toBeGreaterThan(0);
      // Total cost should be less than $1 (profitable arb)
      const totalCost = opp.legA.price + opp.legB.price;
      expect(totalCost).toBeLessThan(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('2. Market Matching + Arb Detection', () => {
    it('should match similar markets across platforms', async () => {
      const polyMarket = await polymarketConnector.fetchMarket('poly-market-1');
      const predictfunMarket = await predictfunConnector.fetchMarket('predictfun-market-1');

      expect(polyMarket).not.toBeNull();
      expect(predictfunMarket).not.toBeNull();
      expect(polyMarket!.question).toContain('economy');
      expect(predictfunMarket!.question).toContain('economy');
    });

    it('should calculate profit correctly for complementary legs', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      const totalCost = opp.legA.price + opp.legB.price;

      // Cost should be < $1 for a profitable arb
      expect(totalCost).toBeLessThan(1);
      // Total cost should be close to 0.97 (0.48 + 0.49)
      expect(totalCost).toBeGreaterThan(0.95);
      expect(totalCost).toBeLessThan(0.99);

      // Profit per share: $1 - totalCost
      const profitPerShare = 1 - totalCost;
      expect(profitPerShare).toBeGreaterThan(0.01); // > 1¢ per share
    });

    it('should verify maxSize is limited by book depth', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      // Mock books have 1000 shares at each level
      // maxSize should be limited by the thinnest side
      expect(opp.maxSize).toBeGreaterThan(0);
      expect(opp.maxSize).toBeLessThanOrEqual(1000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('3. Execution Pipeline (Dry Run)', () => {
    it('should accept opportunity for execution', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      const insertSpy = vi.spyOn({ insertOpportunity }, 'insertOpportunity');

      await executionEngine.submit(opp);

      expect(insertSpy).toHaveBeenCalledWith(opp);
    });

    it('should pass risk check for valid opportunity', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      const riskResult = await riskManager.checkOpportunity(opp);

      expect(riskResult.approved).toBe(true);
      expect(riskResult.reason).toContain('passed');
    });

    it('should execute trade in dry-run mode', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      const updateSpy = vi.spyOn({ updateTradeStatus }, 'updateTradeStatus');

      await executionEngine.submit(opp);

      // In dry-run mode, trade should be marked EXECUTED
      const executedCalls = updateSpy.mock.calls.filter(
        call => call[1] === 'EXECUTED',
      );
      expect(executedCalls.length).toBeGreaterThan(0);
    });

    it('should mark opportunity as executed after dry-run trade', async () => {
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      const markSpy = vi.spyOn({ markOpportunityExecuted }, 'markOpportunityExecuted');

      await executionEngine.submit(opp);

      expect(markSpy).toHaveBeenCalledWith(opp.id);
    });

    it('should emit trade:executed event in dry-run', async () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');
      const opportunities = await strategy.scan();
      const opp = opportunities[0];

      await executionEngine.submit(opp);

      const executedEvents = emitSpy.mock.calls.filter(
        call => call[0] === 'trade:executed',
      );
      expect(executedEvents.length).toBeGreaterThan(0);
    });

    it('should calculate expected profit correctly in trade record', async () => {
      const opportunities = await strategy.scan();
      const opp = opportunities[0];

      const insertTradeSpy = vi.spyOn({ insertTrade }, 'insertTrade');
      await executionEngine.submit(opp);

      const tradeCall = insertTradeSpy.mock.calls[0];
      expect(tradeCall).toBeDefined();
      // Trade object should have expectedProfitUsd > 0
      const trade = tradeCall[0];
      expect(trade.expectedProfitUsd).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('4. Risk Rejection Flow', () => {
    it('should reject opportunity with low match confidence', async () => {
      // Manually create an opportunity with low confidence
      const lowConfidenceOpp: ArbitrageOpportunity = {
        id: uuid(),
        strategyId: 'cross-platform-arb',
        discoveredAt: new Date(),
        legA: {
          platform: 'polymarket',
          marketId: 'poly-market-1',
          marketQuestion: 'Unrelated question 1',
          outcome: 'YES',
          outcomeIndex: 0,
          price: 0.48,
          availableSize: 100,
          orderBook: (await polymarketConnector.fetchOrderBook('poly-market-1', 0))!,
        },
        legB: {
          platform: 'predictfun',
          marketId: 'predictfun-market-1',
          marketQuestion: 'Unrelated question 2',
          outcome: 'NO',
          outcomeIndex: 1,
          price: 0.49,
          availableSize: 100,
          orderBook: (await predictfunConnector.fetchOrderBook('predictfun-market-1', 1))!,
        },
        expectedProfitUsd: 10,
        expectedProfitBps: 300,
        maxSize: 100,
        matchConfidence: 0.45, // Below minimum of 0.6
        executed: false,
      };

      const riskResult = await riskManager.checkOpportunity(lowConfidenceOpp);

      expect(riskResult.approved).toBe(false);
      expect(riskResult.reason).toContain('Match confidence');
    });

    it('should approve opportunity with sufficient confidence', async () => {
      const opportunities = await strategy.scan();
      const opp = opportunities[0];

      expect(opp.matchConfidence).toBeGreaterThanOrEqual(0.6);

      const riskResult = await riskManager.checkOpportunity(opp);
      expect(riskResult.approved).toBe(true);
    });

    it('should reject opportunity if position limit exceeded', async () => {
      const opportunities = await strategy.scan();
      const opp = opportunities[0];

      // Simulate a scenario where max positions is reached
      const maxPositions = 20;
      const dummyPositions = Array.from({ length: maxPositions }, (_, i) => ({
        platform: 'polymarket' as Platform,
        marketId: `market-${i}`,
        marketQuestion: `Market ${i}`,
        outcomeIndex: 0,
        side: 'YES' as const,
        size: 10,
        avgEntryPrice: 0.5,
        currentPrice: 0.5,
        unrealizedPnl: 0,
      }));

      riskManager.updatePositions(dummyPositions);

      const riskResult = await riskManager.checkOpportunity(opp);
      expect(riskResult.approved).toBe(false);
      expect(riskResult.reason).toContain('position');
    });

    it('should handle exposure limit checks correctly', async () => {
      const opportunities = await strategy.scan();
      const opp = opportunities[0];

      // Create a position that consumes most of the exposure limit
      const bigPosition: Position = {
        platform: 'polymarket',
        marketId: 'big-market',
        marketQuestion: 'Big position',
        outcomeIndex: 0,
        side: 'YES',
        size: 4800, // Use up most of $5000 limit at 0.5 price
        avgEntryPrice: 0.5,
        currentPrice: 0.5,
        unrealizedPnl: 0,
      };

      riskManager.updatePositions([bigPosition]);

      const riskResult = await riskManager.checkOpportunity(opp);

      // Risk manager should either approve with adjustment or reject
      if (riskResult.approved) {
        expect(riskResult.reason).toBeDefined();
        // If there's an adjustedSize, it should be less than or equal to maxSize
        if (riskResult.adjustedSize !== undefined) {
          expect(riskResult.adjustedSize).toBeLessThanOrEqual(opp.maxSize);
        }
      } else {
        expect(riskResult.reason).toBeDefined();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('5. End-to-End Happy Path', () => {
    it('should complete full cycle: scan → detect → risk check → execute', async () => {
      // Step 1: Scan for opportunities
      const opportunities = await strategy.scan();
      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      expect(opp.expectedProfitBps).toBeGreaterThan(100); // Profitable

      // Step 2: Risk check
      const riskResult = await riskManager.checkOpportunity(opp);
      expect(riskResult.approved).toBe(true);

      // Step 3: Submit to execution engine
      const insertSpy = vi.spyOn({ insertOpportunity }, 'insertOpportunity');
      const insertTradeSpy = vi.spyOn({ insertTrade }, 'insertTrade');
      const updateSpy = vi.spyOn({ updateTradeStatus }, 'updateTradeStatus');
      const markSpy = vi.spyOn({ markOpportunityExecuted }, 'markOpportunityExecuted');

      await executionEngine.submit(opp);

      // Step 4: Verify all steps completed
      expect(insertSpy).toHaveBeenCalledWith(opp);
      expect(insertTradeSpy).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.any(String),
        'EXECUTED',
        expect.objectContaining({ realizedProfitUsd: expect.any(Number) }),
      );
      expect(markSpy).toHaveBeenCalledWith(opp.id);
    });

    it('should track metrics through the scan cycle', async () => {
      const metricsBeforeScan = strategy.getMetrics();
      expect(metricsBeforeScan.scansCompleted).toBe(0);
      expect(metricsBeforeScan.opportunitiesFound).toBe(0);

      await strategy.scan();

      const metricsAfterScan = strategy.getMetrics();
      expect(metricsAfterScan.scansCompleted).toBeGreaterThan(metricsBeforeScan.scansCompleted);
      expect(metricsAfterScan.opportunitiesFound).toBeGreaterThan(metricsBeforeScan.opportunitiesFound);
      expect(metricsAfterScan.lastScanAt).not.toBeNull();
      expect(metricsAfterScan.lastScanDurationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
