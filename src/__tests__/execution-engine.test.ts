// ═══════════════════════════════════════════════════════════════════════════
// Comprehensive vitest suite for ExecutionEngine
// Tests dry-run, queue processing, validation, risk checks, and recovery flows
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ExecutionEngine } from '../engine/execution-engine';
import { RiskManager } from '../engine/risk-manager';
import {
  ArbitrageOpportunity,
  OrderResult,
  OrderRequest,
  OrderBook,
  TradeRecord,
  Platform,
} from '../types';
import { MarketConnector } from '../types/connector';
import { Strategy } from '../types/strategy';

// ─── Mocks ────────────────────────────────────────────────────────────────

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
  },
}));

import {
  insertOpportunity,
  insertTrade,
  updateTradeStatus,
  markOpportunityExecuted,
} from '../db/database';
import { eventBus } from '../utils/event-bus';

// ─── Test Fixtures ────────────────────────────────────────────────────────

function createMockOrderBook(bestBid = 0.45, bestAsk = 0.55): OrderBook {
  return {
    platform: 'polymarket',
    marketId: 'market-123',
    outcomeIndex: 0,
    bids: [{ price: bestBid, size: 100 }],
    asks: [{ price: bestAsk, size: 100 }],
    minOrderSize: 1,
    tickSize: 0.01,
    bestBid,
    bestAsk,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    timestamp: new Date(),
  };
}

function createMockArbitrageOpportunity(overrides = {}): ArbitrageOpportunity {
  const baseOpp: ArbitrageOpportunity = {
    id: 'opp-123',
    strategyId: 'strategy-1',
    discoveredAt: new Date(),
    legA: {
      platform: 'polymarket',
      marketId: 'market-a',
      marketQuestion: 'Will it rain?',
      outcome: 'YES',
      outcomeIndex: 0,
      price: 0.40,
      availableSize: 1000,
      orderBook: createMockOrderBook(0.39, 0.41),
    },
    legB: {
      platform: 'predictfun',
      marketId: 'market-b',
      marketQuestion: 'Will it rain?',
      outcome: 'NO',
      outcomeIndex: 1,
      price: 0.55,
      availableSize: 1000,
      orderBook: createMockOrderBook(0.54, 0.56),
    },
    expectedProfitUsd: 50,
    expectedProfitBps: 50,
    maxSize: 100,
    matchConfidence: 0.95,
    executed: false,
    ...overrides,
  };
  return baseOpp;
}

function createMockOrderResult(
  id: string,
  status: string = 'FILLED',
  filledSize: number = 100,
  avgFillPrice: number = 0.4,
): OrderResult {
  return {
    id,
    platform: 'polymarket',
    marketId: 'market-123',
    outcomeIndex: 0,
    side: 'BUY',
    type: 'LIMIT',
    price: avgFillPrice,
    size: filledSize,
    filledSize,
    avgFillPrice,
    status: status as any,
    timestamp: new Date(),
    fees: 0.5,
  };
}

function createMockConnector(platform: Platform): MarketConnector {
  return {
    platform,
    name: `Mock ${platform}`,
    isConnected: true,
    isWsConnected: true,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fetchMarkets: vi.fn().mockResolvedValue([]),
    fetchMarket: vi.fn().mockResolvedValue(null),
    fetchOrderBook: vi.fn().mockResolvedValue(createMockOrderBook()),
    subscribeOrderBooks: vi.fn(),
    unsubscribeOrderBooks: vi.fn(),
    placeOrder: vi.fn().mockResolvedValue(createMockOrderResult('order-1')),
    cancelOrder: vi.fn().mockResolvedValue(true),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn().mockResolvedValue(null),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(10000),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function createMockStrategy(): Strategy {
  return {
    id: 'strategy-1',
    name: 'Test Strategy',
    description: 'Test',
    state: 'IDLE',
    platforms: ['polymarket', 'predictfun'],
    config: {
      enabled: true,
      minProfitBps: 50,
      maxPositionUsd: 10000,
      minMatchConfidence: 0.8,
      params: {},
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    scan: vi.fn().mockResolvedValue([]),
    validate: vi.fn().mockResolvedValue(true),
    getMetrics: vi.fn().mockReturnValue({
      strategyId: 'strategy-1',
      scansCompleted: 0,
      opportunitiesFound: 0,
      opportunitiesExecuted: 0,
      totalProfitUsd: 0,
      avgProfitPerTrade: 0,
      winRate: 0,
      lastScanDurationMs: 0,
      lastScanAt: null,
      marketsTracked: 0,
    }),
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;
  let riskManager: any;
  let connectorA: MarketConnector;
  let connectorB: MarketConnector;
  let strategy: Strategy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    riskManager = {
      checkOpportunity: vi.fn().mockResolvedValue({
        approved: true,
        reason: 'OK',
      }),
    };

    connectorA = createMockConnector('polymarket');
    connectorB = createMockConnector('predictfun');
    strategy = createMockStrategy();

    engine = new ExecutionEngine(riskManager, false);
    engine.initialize(
      new Map([
        ['polymarket', connectorA],
        ['predictfun', connectorB],
      ]),
      new Map([['strategy-1', strategy]]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── DRY-RUN MODE TESTS ───────────────────────────────────────────────

  describe('Dry-run mode', () => {
    beforeEach(() => {
      engine = new ExecutionEngine(riskManager, true);
      engine.initialize(
        new Map([
          ['polymarket', connectorA],
          ['predictfun', connectorB],
        ]),
        new Map([['strategy-1', strategy]]),
      );
    });

    it('should log and mark opportunities EXECUTED without placing real trades', async () => {
      const opp = createMockArbitrageOpportunity();

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(insertOpportunity).toHaveBeenCalledWith(opp);
      expect(insertTrade).toHaveBeenCalled();

      const updateCall = (updateTradeStatus as any).mock.calls[0];
      expect(updateCall[1]).toBe('EXECUTED');
      expect(updateCall[2].notes).toContain('DRY RUN');

      expect(markOpportunityExecuted).toHaveBeenCalledWith(opp.id);
      expect(connectorA.placeOrder).not.toHaveBeenCalled();
      expect(connectorB.placeOrder).not.toHaveBeenCalled();
    });

    it('should emit trade:executed event in dry-run mode', async () => {
      const opp = createMockArbitrageOpportunity();

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      const emitCalls = (eventBus.emit as any).mock.calls;
      const executedEvent = emitCalls.find((call: any) => call[0] === 'trade:executed');
      expect(executedEvent).toBeDefined();
    });
  });

  // ─── QUEUE PROCESSING TESTS ────────────────────────────────────────────

  describe('Queue processing', () => {
    it('should process multiple opportunities sequentially', async () => {
      const opp1 = createMockArbitrageOpportunity({ id: 'opp-1' });
      const opp2 = createMockArbitrageOpportunity({ id: 'opp-2' });

      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', 100, 0.40),
      );
      connectorB.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-b', 'FILLED', 100, 0.55),
      );

      await engine.submit(opp1);
      await engine.submit(opp2);
      await vi.runAllTimersAsync();

      expect(insertTrade).toHaveBeenCalledTimes(2);
      const tradeCalls = (insertTrade as any).mock.calls;
      expect(tradeCalls[0][0].opportunityId).toBe('opp-1');
      expect(tradeCalls[1][0].opportunityId).toBe('opp-2');
    });

    it('should continue processing if one opportunity fails', async () => {
      const opp1 = createMockArbitrageOpportunity({ id: 'opp-1' });
      const opp2 = createMockArbitrageOpportunity({ id: 'opp-2' });

      (strategy.validate as any).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await engine.submit(opp1);
      await engine.submit(opp2);
      await vi.runAllTimersAsync();

      expect(insertTrade).toHaveBeenCalledTimes(1);
      const tradeCall = (insertTrade as any).mock.calls[0];
      expect(tradeCall[0].opportunityId).toBe('opp-2');
    });
  });

  // ─── RE-VALIDATION TESTS ───────────────────────────────────────────────

  describe('Re-validation before execution', () => {
    it('should call strategy.validate() before execution', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(strategy.validate).toHaveBeenCalledWith(opp);
    });

    it('should skip execution if strategy.validate() returns false', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(false);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(connectorA.placeOrder).not.toHaveBeenCalled();
      expect(connectorB.placeOrder).not.toHaveBeenCalled();
    });

    it('should skip validation if strategy is not found but continue execution', async () => {
      const opp = createMockArbitrageOpportunity({ strategyId: 'unknown-strategy' });
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', 100, 0.40),
      );
      connectorB.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-b', 'FILLED', 100, 0.55),
      );
      connectorA.getOpenOrders = vi.fn().mockResolvedValue([]);
      connectorB.getOpenOrders = vi.fn().mockResolvedValue([]);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      // Engine should proceed without validation since strategy doesn't exist
      expect(connectorA.placeOrder).toHaveBeenCalled();
    });
  });

  // ─── RISK CHECK TESTS ──────────────────────────────────────────────────

  describe('Risk manager checks', () => {
    it('should skip execution when risk manager rejects opportunity', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: false,
        reason: 'Exceeds max exposure',
      });

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(connectorA.placeOrder).not.toHaveBeenCalled();
      expect(connectorB.placeOrder).not.toHaveBeenCalled();
    });

    it('should use adjusted size from risk manager', async () => {
      const opp = createMockArbitrageOpportunity();
      const adjustedSize = 50;
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
        adjustedSize,
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', adjustedSize, 0.40),
      );
      connectorB.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-b', 'FILLED', adjustedSize, 0.55),
      );

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      const orderACall = (connectorA.placeOrder as any).mock.calls[0];
      expect(orderACall[0].size).toBe(adjustedSize);

      const orderBCall = (connectorB.placeOrder as any).mock.calls[0];
      expect(orderBCall[0].size).toBe(adjustedSize);
    });
  });

  // ─── SUCCESSFUL EXECUTION TESTS ────────────────────────────────────────

  describe('Successful execution - both legs fill', () => {
    it('should execute trade when both legs fill', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', 100, 0.40),
      );
      connectorB.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-b', 'FILLED', 100, 0.55),
      );

      connectorA.getOpenOrders = vi.fn().mockResolvedValue([]);
      connectorB.getOpenOrders = vi.fn().mockResolvedValue([]);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(updateTradeStatus).toHaveBeenCalledWith(
        expect.any(String),
        'EXECUTED',
        expect.objectContaining({
          realizedProfitUsd: expect.any(Number),
          fees: expect.any(Number),
        }),
      );

      expect(markOpportunityExecuted).toHaveBeenCalledWith(opp.id);
      expect(eventBus.emit).toHaveBeenCalledWith('trade:executed', expect.any(Object));
    });

    it('should emit trade:pending event', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', 100, 0.40),
      );
      connectorB.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-b', 'FILLED', 100, 0.55),
      );

      connectorA.getOpenOrders = vi.fn().mockResolvedValue([]);
      connectorB.getOpenOrders = vi.fn().mockResolvedValue([]);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      const emitCalls = (eventBus.emit as any).mock.calls;
      const pendingEvent = emitCalls.find((call: any) => call[0] === 'trade:pending');
      expect(pendingEvent).toBeDefined();
    });
  });

  // ─── LEG A FAILS OUTRIGHT TESTS ────────────────────────────────────────

  describe('Failed-leg recovery: Leg A fails outright', () => {
    it('should mark trade FAILED and not place leg B if leg A throws', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      const error = new Error('Network error');
      connectorA.placeOrder = vi.fn().mockRejectedValue(error);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(connectorB.placeOrder).not.toHaveBeenCalled();
      expect(updateTradeStatus).toHaveBeenCalledWith(
        expect.any(String),
        'FAILED',
        expect.objectContaining({
          notes: expect.stringContaining('Leg A failed to place'),
        }),
      );
    });

    it('should emit trade:failed event when leg A fails', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockRejectedValue(new Error('Network error'));

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      const emitCalls = (eventBus.emit as any).mock.calls;
      const failedEvent = emitCalls.find((call: any) => call[0] === 'trade:failed');
      expect(failedEvent).toBeDefined();
    });

    it('should mark trade FAILED if leg A immediately returns FAILED status', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FAILED', 0, 0.40),
      );

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(connectorB.placeOrder).not.toHaveBeenCalled();
      expect(updateTradeStatus).toHaveBeenCalledWith(
        expect.any(String),
        'FAILED',
        expect.objectContaining({
          notes: expect.stringContaining('immediately rejected'),
        }),
      );
    });
  });


  // ─── TRADE RECORD CREATION ────────────────────────────────────────────

  describe('Trade record creation and persistence', () => {
    it('should create trade with correct initial status', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', 100, 0.40),
      );
      connectorB.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-b', 'FILLED', 100, 0.55),
      );

      connectorA.getOpenOrders = vi.fn().mockResolvedValue([]);
      connectorB.getOpenOrders = vi.fn().mockResolvedValue([]);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      const tradeCall = (insertTrade as any).mock.calls[0];
      const trade = tradeCall[0];

      expect(trade.status).toBe('PENDING');
      expect(trade.strategyId).toBe('strategy-1');
      expect(trade.opportunityId).toBe(opp.id);
      expect(trade.notes).toBe('');
    });

    it('should update trade with correct fees', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      const feeA = 2.5;
      const feeB = 1.5;

      connectorA.placeOrder = vi.fn().mockResolvedValue(
        createMockOrderResult('order-a', 'FILLED', 100, 0.40),
      );

      connectorB.placeOrder = vi.fn().mockResolvedValue({
        ...createMockOrderResult('order-b', 'FILLED', 100, 0.55),
        fees: feeB,
      });

      connectorA.getOpenOrders = vi.fn().mockResolvedValue([]);
      connectorB.getOpenOrders = vi.fn().mockResolvedValue([]);

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      const updateCall = (updateTradeStatus as any).mock.calls.find(
        (call: any) => call[1] === 'EXECUTED',
      );
      expect(updateCall[2].fees).toBeGreaterThan(0);
    });
  });

  // ─── MISSING CONNECTOR HANDLING ────────────────────────────────────────

  describe('Missing connector handling', () => {
    it('should fail trade if connector is missing', async () => {
      const opp = createMockArbitrageOpportunity();
      (strategy.validate as any).mockResolvedValue(true);
      (riskManager.checkOpportunity as any).mockResolvedValue({
        approved: true,
        reason: 'OK',
      });

      // Create engine with only one connector
      engine = new ExecutionEngine(riskManager, false);
      engine.initialize(
        new Map([['polymarket', connectorA]]),
        new Map([['strategy-1', strategy]]),
      );

      await engine.submit(opp);
      await vi.runAllTimersAsync();

      expect(updateTradeStatus).toHaveBeenCalledWith(
        expect.any(String),
        'FAILED',
        expect.objectContaining({
          notes: expect.stringContaining('Missing connector'),
        }),
      );
    });
  });

  // ─── ORDER BOOK FETCHING IN RECOVERY ───────────────────────────────────

});
