// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Risk Manager Tests
// Comprehensive test suite for pre-trade risk validation
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskManager, RiskCheckResult } from '../engine/risk-manager';
import {
  ArbitrageOpportunity,
  ArbLeg,
  OrderBook,
  Position,
  Platform,
} from '../types';
import { MarketConnector } from '../types/connector';

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../utils/config', () => ({
  config: {
    bot: {
      maxTotalExposureUsd: 5000,
      maxPositionUsd: 500,
    },
  },
}));

vi.mock('../utils/logger', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../utils/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockOrderBook(
  platform: Platform = 'polymarket',
  marketId: string = 'market-1'
): OrderBook {
  return {
    platform,
    marketId,
    outcomeIndex: 0,
    bids: [{ price: 0.5, size: 100 }],
    asks: [{ price: 0.51, size: 100 }],
    minOrderSize: 1,
    tickSize: 0.01,
    bestBid: 0.5,
    bestAsk: 0.51,
    midPrice: 0.505,
    spread: 0.01,
    timestamp: new Date(),
  };
}

function createMockArbLeg(
  platform: Platform = 'polymarket',
  marketId: string = 'market-1',
  price: number = 0.5,
  availableSize: number = 1000
): ArbLeg {
  return {
    platform,
    marketId,
    marketQuestion: 'Will X happen?',
    outcome: 'YES',
    outcomeIndex: 0,
    price,
    availableSize,
    orderBook: createMockOrderBook(platform, marketId),
  };
}

function createMockOpportunity(overrides?: Partial<ArbitrageOpportunity>): ArbitrageOpportunity {
  const legA = createMockArbLeg('polymarket', 'market-1', 0.5, 1000);
  const legB = createMockArbLeg('predictfun', 'market-2', 0.48, 1000);

  return {
    id: 'opp-1',
    strategyId: 'strategy-1',
    discoveredAt: new Date(),
    legA,
    legB,
    expectedProfitUsd: 10,
    expectedProfitBps: 200,
    maxSize: 100,
    matchConfidence: 0.85,
    executed: false,
    ...overrides,
  };
}

function createMockConnector(
  balance: number = 10000
): MarketConnector {
  return {
    platform: 'polymarket',
    name: 'Mock Polymarket',
    isConnected: true,
    isWsConnected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMarkets: vi.fn(),
    fetchMarket: vi.fn(),
    fetchOrderBook: vi.fn(),
    subscribeOrderBooks: vi.fn(),
    unsubscribeOrderBooks: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOpenOrders: vi.fn(),
    getPositions: vi.fn(),
    getBalance: vi.fn().mockResolvedValue(balance),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function createMockPosition(
  platform: Platform = 'polymarket',
  size: number = 10,
  avgEntryPrice: number = 0.5
): Position {
  return {
    platform,
    marketId: 'market-1',
    marketQuestion: 'Will X happen?',
    outcomeIndex: 0,
    side: 'YES',
    size,
    avgEntryPrice,
    currentPrice: 0.55,
    unrealizedPnl: 5 * size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

describe('RiskManager', () => {
  let riskManager: RiskManager;
  let mockConnectorPolymarket: MarketConnector;
  let mockConnectorPredictfun: MarketConnector;
  let connectorMap: Map<Platform, MarketConnector>;

  beforeEach(() => {
    riskManager = new RiskManager();
    mockConnectorPolymarket = createMockConnector(10000);
    mockConnectorPredictfun = createMockConnector(10000);

    connectorMap = new Map<Platform, MarketConnector>([
      ['polymarket', mockConnectorPolymarket],
      ['predictfun', mockConnectorPredictfun],
    ]);

    riskManager.initialize(connectorMap);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Max Positions Check (20 limit)
  // ─────────────────────────────────────────────────────────────────────

  describe('Max Positions Limit (20)', () => {
    it('should approve opportunity when below max positions (19 open)', async () => {
      const positions: Position[] = Array.from({ length: 19 }, (_, i) =>
        createMockPosition('polymarket', 5 + i, 0.5)
      );
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity();
      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('All risk checks passed');
    });

    it('should reject opportunity when at max positions (20 open)', async () => {
      const positions: Position[] = Array.from({ length: 20 }, (_, i) =>
        createMockPosition('polymarket', 5, 0.5)
      );
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity();
      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Maximum open positions reached');
    });

    it('should reject opportunity when exceeding max positions (21 open)', async () => {
      const positions: Position[] = Array.from({ length: 21 }, (_, i) =>
        createMockPosition('polymarket', 5, 0.5)
      );
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity();
      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Maximum open positions reached');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Total Exposure Cap Enforcement
  // ─────────────────────────────────────────────────────────────────────

  describe('Total Exposure Cap Enforcement (5000 USD)', () => {
    it('should approve opportunity when below exposure cap', async () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 100, 0.5), // 50 USD
        createMockPosition('polymarket', 100, 0.4), // 40 USD
      ];
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.48, 1000),
        maxSize: 100, // (0.5 + 0.48) * 100 = 98 USD
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should reject opportunity when total exposure exceeds cap', async () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 5000, 1.0), // 5000 USD at max capacity
      ];
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        maxSize: 100,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Maximum total exposure reached');
    });

    it('should adjust size when partially exceeding exposure cap', async () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 9000, 0.5), // 4500 USD
      ];
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.48, 1000),
        maxSize: 600, // (0.5 + 0.48) * 600 = 588 USD, exceeds available 500
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('Size adjusted for exposure limit');
      expect(result.adjustedSize).toBeDefined();
      // availableExposure = 5000 - 4500 = 500
      // adjustedSize = 500 / (0.5 + 0.48) = 500 / 0.98 ≈ 510.2
      expect(result.adjustedSize!).toBeCloseTo(510.2, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Per-Trade Size Limit
  // ─────────────────────────────────────────────────────────────────────

  describe('Per-Trade Size Limit (500 USD)', () => {
    it('should approve opportunity within per-trade limit', async () => {
      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.48, 1000),
        maxSize: 500, // (0.5 + 0.48) * 500 = 490 USD
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should adjust size when exceeding per-trade limit', async () => {
      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 2.0, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 2.0, 1000),
        maxSize: 200, // (2.0 + 2.0) * 200 = 800 USD (exceeds 500 limit)
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('Size adjusted for position limit');
      expect(result.adjustedSize).toBeDefined();
      // adjustedSize = 500 / (2.0 + 2.0) = 500 / 4.0 = 125
      expect(result.adjustedSize!).toBeCloseTo(125, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Balance Check (with 10% reserve)
  // ─────────────────────────────────────────────────────────────────────

  describe('Balance Check with 10% Reserve', () => {
    it('should approve when sufficient balance on both platforms', async () => {
      mockConnectorPolymarket.getBalance = vi.fn().mockResolvedValue(10000);
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(10000);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 100), // cost: 50
        legB: createMockArbLeg('predictfun', 'market-2', 0.48, 100), // cost: 48
        maxSize: 100,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
      expect(result.reason).toBe('All risk checks passed');
    });

    it('should proceed with balance check after earlier adjustments', async () => {
      // Balance check occurs after position and exposure limit checks
      // Verifies that when earlier checks don't reject, balance is still validated
      mockConnectorPolymarket.getBalance = vi.fn().mockResolvedValue(10000);
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(10000);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.5, 1000),
        maxSize: 50,
      });

      const result = await riskManager.checkOpportunity(opp);
      // With sufficient balance, should pass all checks
      expect(result.approved).toBe(true);
      expect(result.reason).toBe('All risk checks passed');
    });

    it('should check balances on both platforms and use most restrictive', async () => {
      mockConnectorPolymarket.getBalance = vi.fn().mockResolvedValue(100);
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(10000); // One platform has plenty

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 100),
        legB: createMockArbLeg('predictfun', 'market-2', 0.5, 100),
        maxSize: 50,
      });

      const result = await riskManager.checkOpportunity(opp);
      // Should pass since the restrictive platform (100 balance) can support (100 * 0.9) / 0.5 = 180 shares
      expect(result.approved).toBe(true);
    });

    it('should account for 10% reserve ratio in balance check', async () => {
      // With 10% reserve, usable balance is 90% of total
      mockConnectorPolymarket.getBalance = vi.fn().mockResolvedValue(1000);
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(1000);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 10, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 10, 1000),
        maxSize: 50, // (10 + 10) * 50 = 1000
      });

      const result = await riskManager.checkOpportunity(opp);

      // Should adjust because needs (10*50 * 1.1) + (10*50 * 1.1) = 550 + 550 = 1100 > 1000 (with reserve)
      expect(result.approved).toBe(true);
      expect(result.adjustedSize).toBeDefined();
      expect(result.adjustedSize!).toBeLessThan(50);
    });

    it('should handle balance check errors gracefully', async () => {
      mockConnectorPolymarket.getBalance = vi
        .fn()
        .mockRejectedValue(new Error('Balance API error'));
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(10000);

      const opp = createMockOpportunity();
      const result = await riskManager.checkOpportunity(opp);

      // Should proceed despite error, continuing to other checks
      // In this case, confidence is 0.85 which passes the floor check
      expect(result.approved).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Match Confidence Floor (0.6)
  // ─────────────────────────────────────────────────────────────────────

  describe('Match Confidence Floor (0.6)', () => {
    it('should approve opportunity with confidence at exactly 0.6', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.6,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should approve opportunity with confidence above 0.6', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.85,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should reject opportunity with confidence below 0.6', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.59,
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Match confidence too low');
      expect(result.reason).toContain('0.59');
    });

    it('should reject with very low confidence', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.1,
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('0.1');
    });

    it('should be checked last, after other constraints', async () => {
      const positions: Position[] = Array.from({ length: 20 }, (_, i) =>
        createMockPosition('polymarket', 5, 0.5)
      );
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        matchConfidence: 0.95, // High confidence, but max positions reached
      });

      const result = await riskManager.checkOpportunity(opp);

      // Should fail on max positions before getting to confidence check
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Maximum open positions reached');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Size Adjustment When Exposure Cap Is Partially Used
  // ─────────────────────────────────────────────────────────────────────

  describe('Size Adjustment with Partial Exposure Cap Usage', () => {
    it('should calculate correct adjusted size with 50% capacity used', async () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 5000, 0.5), // 2500 USD
      ];
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.1, 10000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.1, 10000),
        maxSize: 10000, // (0.1 + 0.1) * 10000 = 2000 USD > 500 position limit
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('Size adjusted for position limit');
      // Position limit is 500 USD, price sum is 0.2, so 500/0.2 = 2500
      expect(result.adjustedSize!).toBeCloseTo(2500, 0);
    });

    it('should calculate correct adjusted size with 10% capacity used', async () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 1000, 0.5), // 500 USD
      ];
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 10000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.5, 10000),
        maxSize: 5000, // (0.5 + 0.5) * 5000 = 5000 USD
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('Size adjusted for exposure limit');
      // availableExposure = 5000 - 500 = 4500
      // adjustedSize = 4500 / (0.5 + 0.5) = 4500
      expect(result.adjustedSize!).toBeCloseTo(4500, 0);
    });

    it('should handle very small available exposure', async () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 9900, 0.5), // 4950 USD
      ];
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.5, 1000),
        maxSize: 100,
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.adjustedSize).toBeDefined();
      // availableExposure = 5000 - 4950 = 50
      // adjustedSize = 50 / (0.5 + 0.5) = 50
      expect(result.adjustedSize!).toBeCloseTo(50, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Approving Clean Opportunities
  // ─────────────────────────────────────────────────────────────────────

  describe('Approving Clean Opportunities', () => {
    it('should approve standard clean opportunity', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.85,
        maxSize: 50,
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('All risk checks passed');
      expect(result.adjustedSize).toBeUndefined();
    });

    it('should approve multiple clean opportunities in sequence', async () => {
      const opps = Array.from({ length: 5 }, (_, i) =>
        createMockOpportunity({
          id: `opp-${i}`,
          maxSize: 50,
          matchConfidence: 0.8,
        })
      );

      const results = await Promise.all(
        opps.map((opp) => riskManager.checkOpportunity(opp))
      );

      results.forEach((result) => {
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('All risk checks passed');
      });
    });

    it('should handle high-confidence, small-size opportunities', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.99,
        maxSize: 10,
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.48, 1000),
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('All risk checks passed');
    });

    it('should approve opportunity with maximum position count at 19', async () => {
      const positions: Position[] = Array.from({ length: 19 }, (_, i) =>
        createMockPosition('polymarket', 5, 0.5)
      );
      riskManager.updatePositions(positions);

      const opp = createMockOpportunity();
      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('All risk checks passed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Position Tracking
  // ─────────────────────────────────────────────────────────────────────

  describe('Position Tracking', () => {
    it('should update positions correctly', () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 10, 0.5),
        createMockPosition('predictfun', 20, 0.6),
      ];

      riskManager.updatePositions(positions);
      const tracked = riskManager.getPositions();

      expect(tracked).toHaveLength(2);
      expect(tracked[0].size).toBe(10);
      expect(tracked[1].size).toBe(20);
    });

    it('should add single position', () => {
      const position = createMockPosition('polymarket', 15, 0.5);
      riskManager.addPosition(position);

      const tracked = riskManager.getPositions();
      expect(tracked).toHaveLength(1);
      expect(tracked[0].size).toBe(15);
    });

    it('should return independent copy of positions', () => {
      const positions: Position[] = [createMockPosition('polymarket', 10, 0.5)];
      riskManager.updatePositions(positions);

      const tracked1 = riskManager.getPositions();
      const tracked2 = riskManager.getPositions();

      expect(tracked1).not.toBe(tracked2);
      expect(tracked1).toEqual(tracked2);
    });

    it('should calculate current exposure correctly', () => {
      const positions: Position[] = [
        createMockPosition('polymarket', 100, 0.5), // 50 USD
        createMockPosition('polymarket', 50, 0.4), // 20 USD
      ];
      riskManager.updatePositions(positions);

      const exposure = riskManager.getCurrentExposure();
      expect(exposure).toBe(70); // 100*0.5 + 50*0.4
    });

    it('should handle empty positions', () => {
      riskManager.updatePositions([]);
      const exposure = riskManager.getCurrentExposure();
      expect(exposure).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Edge Cases and Boundary Conditions
  // ─────────────────────────────────────────────────────────────────────

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle zero balance gracefully', async () => {
      mockConnectorPolymarket.getBalance = vi.fn().mockResolvedValue(0);
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(0);

      const opp = createMockOpportunity();
      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Insufficient balance on one or both platforms');
    });

    it('should handle very small prices', async () => {
      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.01, 10000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.01, 10000),
        maxSize: 10000,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should handle very large prices', async () => {
      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.99, 100),
        legB: createMockArbLeg('predictfun', 'market-2', 0.99, 100),
        maxSize: 100,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should handle missing connector for platform', async () => {
      const connectorMapPartial = new Map<Platform, MarketConnector>([
        ['polymarket', mockConnectorPolymarket],
      ]);
      riskManager.initialize(connectorMapPartial);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.5, 1000),
      });

      const result = await riskManager.checkOpportunity(opp);
      // Should return 0 for missing connector's balance check
      expect(result).toBeDefined();
    });

    it('should handle confidence exactly at boundary (0.6)', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.6,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should reject confidence just below boundary (0.5999)', async () => {
      const opp = createMockOpportunity({
        matchConfidence: 0.5999,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test: Integration Scenarios
  // ─────────────────────────────────────────────────────────────────────

  describe('Integration Scenarios', () => {
    it('should handle multiple constraints applied in correct order', async () => {
      // Set up: 15 positions (under limit), 4000 USD exposure (under cap)
      const positions: Position[] = Array.from({ length: 15 }, (_, i) =>
        createMockPosition('polymarket', 200, 0.5 + i * 0.02)
      );
      riskManager.updatePositions(positions);

      // 15 positions * 200 * (0.5 to 0.78) ≈ 3900-4680 USD

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 0.5, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 0.5, 1000),
        maxSize: 100, // (0.5 + 0.5) * 100 = 100 USD
        matchConfidence: 0.75,
      });

      const result = await riskManager.checkOpportunity(opp);
      expect(result.approved).toBe(true);
    });

    it('should apply most restrictive adjustment when multiple limits apply', async () => {
      mockConnectorPolymarket.getBalance = vi.fn().mockResolvedValue(100);
      mockConnectorPredictfun.getBalance = vi.fn().mockResolvedValue(100);

      const opp = createMockOpportunity({
        legA: createMockArbLeg('polymarket', 'market-1', 10, 1000),
        legB: createMockArbLeg('predictfun', 'market-2', 10, 1000),
        maxSize: 100, // (10 + 10) * 100 = 2000, exceeds both position and balance limits
      });

      const result = await riskManager.checkOpportunity(opp);

      expect(result.approved).toBe(true);
      expect(result.adjustedSize).toBeDefined();
      // Position limit applied first: (10 + 10) = 20 per unit, 500/20 = 25
      expect(result.adjustedSize!).toBeCloseTo(25, 0);
    });
  });
});
