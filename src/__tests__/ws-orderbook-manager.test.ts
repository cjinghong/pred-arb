// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: WsOrderBookManager Tests
// Unit tests for WebSocket order book caching and subscription logic
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WsOrderBookManager, WsOrderBookManagerConfig, ParsedBookUpdate } from '../connectors/ws-orderbook-manager';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../utils/logger', () => ({
  createChildLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));
vi.mock('../utils/event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

// ─── Mock WebSocket ────────────────────────────────────────────────────────

let mockWsInstance: any;
let mockWsHandlers: Map<string, Function>;

vi.mock('ws', () => {
  class MockWebSocket {
    readyState = 1; // OPEN
    send = vi.fn();
    close = vi.fn();
    on = vi.fn((event: string, handler: Function) => {
      mockWsHandlers.set(event, handler);
      // Auto-fire 'open' event so connect() resolves
      if (event === 'open') {
        setTimeout(() => handler(), 0);
      }
    });

    constructor() {
      mockWsHandlers = new Map();
      mockWsInstance = this;
    }

    static OPEN = 1;
  }

  return { default: MockWebSocket, __esModule: true };
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WsOrderBookManagerConfig = {
  platform: 'polymarket',
  wsUrl: 'wss://ws.test.com',
  maxReconnects: 3,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  heartbeatIntervalMs: 0, // disable heartbeat for tests
  staleThresholdMs: 5000,
};

function makeCallbacks() {
  const buildSubscribeMsg = (assetIds: string[]) =>
    JSON.stringify({ type: 'subscribe', assets: assetIds });
  const buildUnsubscribeMsg = (assetIds: string[]) =>
    JSON.stringify({ type: 'unsubscribe', assets: assetIds });
  const buildHeartbeatResponse = (msg: unknown) => {
    const m = msg as Record<string, unknown>;
    return m?.type === 'ping' ? JSON.stringify({ type: 'pong' }) : null;
  };
  const parseBookUpdate = (raw: unknown): ParsedBookUpdate | null => {
    const m = raw as Record<string, unknown>;
    if (m?.type !== 'book') return null;
    return {
      assetId: m.assetId as string,
      marketId: m.marketId as string,
      outcomeIndex: (m.outcomeIndex as number) ?? 0,
      bids: (m.bids as any[]) || [],
      asks: (m.asks as any[]) || [],
      timestamp: new Date((m.timestamp as string | number) || Date.now()),
      minOrderSize: (m.minOrderSize as number) ?? undefined,
      tickSize: (m.tickSize as number) ?? undefined,
    };
  };
  return { buildSubscribeMsg, buildUnsubscribeMsg, buildHeartbeatResponse, parseBookUpdate };
}

function createManager(configOverrides?: Partial<WsOrderBookManagerConfig>) {
  const cfg = { ...DEFAULT_CONFIG, ...configOverrides };
  const cbs = makeCallbacks();
  return new WsOrderBookManager(
    cfg,
    cbs.buildSubscribeMsg,
    cbs.buildUnsubscribeMsg,
    cbs.buildHeartbeatResponse,
    cbs.parseBookUpdate,
  );
}

/** Simulate a WebSocket message arriving */
function simulateMessage(data: unknown): void {
  const handler = mockWsHandlers.get('message');
  if (handler) handler(JSON.stringify(data));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('WsOrderBookManager', () => {
  let manager: WsOrderBookManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Configuration ────────────────────────────────────────────────────

  describe('Configuration', () => {
    it('should create without errors', () => {
      expect(manager).toBeDefined();
    });

    it('should accept different platform configs', () => {
      const m = createManager({ platform: 'predictfun' });
      expect(m).toBeDefined();
    });
  });

  // ─── Subscription tracking (no WS needed) ────────────────────────────

  describe('Subscription Tracking', () => {
    it('should start with 0 tracked assets', () => {
      expect(manager.trackedCount).toBe(0);
    });

    it('should track subscribed assets', () => {
      manager.subscribe(
        ['a1', 'a2'],
        [
          { assetId: 'a1', marketId: 'm1', outcomeIndex: 0 },
          { assetId: 'a2', marketId: 'm2', outcomeIndex: 0 },
        ],
      );
      expect(manager.trackedCount).toBe(2);
    });

    it('should not add duplicates', () => {
      manager.subscribe(['a1'], [{ assetId: 'a1', marketId: 'm1', outcomeIndex: 0 }]);
      manager.subscribe(['a1'], [{ assetId: 'a1', marketId: 'm1', outcomeIndex: 0 }]);
      expect(manager.trackedCount).toBe(1);
    });

    it('should remove on unsubscribe', () => {
      manager.subscribe(
        ['a1', 'a2', 'a3'],
        [
          { assetId: 'a1', marketId: 'm1', outcomeIndex: 0 },
          { assetId: 'a2', marketId: 'm2', outcomeIndex: 0 },
          { assetId: 'a3', marketId: 'm3', outcomeIndex: 0 },
        ],
      );
      manager.unsubscribe(['a1', 'a2']);
      expect(manager.trackedCount).toBe(1);
    });

    it('should gracefully handle unsubscribing unknown assets', () => {
      manager.subscribe(['a1'], [{ assetId: 'a1', marketId: 'm1', outcomeIndex: 0 }]);
      expect(() => manager.unsubscribe(['unknown'])).not.toThrow();
      expect(manager.trackedCount).toBe(1);
    });
  });

  // ─── Book access (empty state) ────────────────────────────────────────

  describe('Book Access (empty)', () => {
    it('getBook returns null for unknown asset', () => {
      expect(manager.getBook('nonexistent')).toBeNull();
    });

    it('getBookByMarket returns null for unknown market', () => {
      expect(manager.getBookByMarket('nonexistent', 0)).toBeNull();
    });

    it('isBookFresh returns false for unknown asset', () => {
      expect(manager.isBookFresh('nonexistent')).toBe(false);
    });
  });

  // ─── Book access with WS messages ────────────────────────────────────

  describe('Book Access (with WS data)', () => {
    beforeEach(async () => {
      await manager.connect();
    });

    it('should populate book from WS message', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [{ price: 0.65, size: 100 }, { price: 0.60, size: 200 }],
        asks: [{ price: 0.70, size: 150 }],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1');
      expect(book).not.toBeNull();
      expect(book!.bestBid).toBe(0.65);
      expect(book!.bestAsk).toBe(0.70);
      expect(book!.marketId).toBe('mkt1');
      expect(book!.platform).toBe('polymarket');
    });

    it('should sort bids highest-first and asks lowest-first', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [
          { price: 0.50, size: 10 },
          { price: 0.70, size: 20 },
          { price: 0.60, size: 30 },
        ],
        asks: [
          { price: 0.90, size: 10 },
          { price: 0.75, size: 20 },
          { price: 0.80, size: 30 },
        ],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1')!;
      expect(book.bids.map(b => b.price)).toEqual([0.70, 0.60, 0.50]);
      expect(book.asks.map(a => a.price)).toEqual([0.75, 0.80, 0.90]);
    });

    it('should calculate midPrice and spread', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [{ price: 0.60, size: 100 }],
        asks: [{ price: 0.80, size: 100 }],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1')!;
      expect(book.midPrice).toBe(0.70);
      expect(book.spread).toBeCloseTo(0.20);
    });

    it('should handle empty bids/asks', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [],
        asks: [],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1')!;
      expect(book.bestBid).toBeNull();
      expect(book.bestAsk).toBeNull();
      expect(book.midPrice).toBeNull();
      expect(book.spread).toBeNull();
    });

    it('should handle one-sided book (bids only)', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [{ price: 0.55, size: 100 }],
        asks: [],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1')!;
      expect(book.bestBid).toBe(0.55);
      expect(book.bestAsk).toBeNull();
      expect(book.midPrice).toBeNull();
    });

    it('should use default minOrderSize and tickSize', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.55, size: 100 }],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1')!;
      expect(book.minOrderSize).toBe(1);
      expect(book.tickSize).toBe(0.01);
    });

    it('should preserve custom minOrderSize and tickSize', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book',
        assetId: 'tok1',
        marketId: 'mkt1',
        outcomeIndex: 0,
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.55, size: 100 }],
        timestamp: Date.now(),
        minOrderSize: 50,
        tickSize: 0.05,
      });

      const book = manager.getBook('tok1')!;
      expect(book.minOrderSize).toBe(50);
      expect(book.tickSize).toBe(0.05);
    });

    it('getBookByMarket should find book by market+outcome', () => {
      manager.subscribe(
        ['tok0', 'tok1'],
        [
          { assetId: 'tok0', marketId: 'mktX', outcomeIndex: 0 },
          { assetId: 'tok1', marketId: 'mktX', outcomeIndex: 1 },
        ],
      );

      simulateMessage({
        type: 'book', assetId: 'tok0', marketId: 'mktX', outcomeIndex: 0,
        bids: [{ price: 0.40, size: 10 }], asks: [{ price: 0.45, size: 10 }],
        timestamp: Date.now(),
      });
      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mktX', outcomeIndex: 1,
        bids: [{ price: 0.55, size: 10 }], asks: [{ price: 0.60, size: 10 }],
        timestamp: Date.now(),
      });

      expect(manager.getBookByMarket('mktX', 0)!.bestBid).toBe(0.40);
      expect(manager.getBookByMarket('mktX', 1)!.bestBid).toBe(0.55);
      expect(manager.getBookByMarket('mktX', 2)).toBeNull();
    });

    it('isBookFresh should return true for recent book', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
        bids: [{ price: 0.50, size: 10 }], asks: [{ price: 0.55, size: 10 }],
        timestamp: Date.now(), // fresh timestamp
      });

      expect(manager.isBookFresh('tok1')).toBe(true);
    });

    it('isBookFresh should return false for stale book', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
        bids: [{ price: 0.50, size: 10 }], asks: [{ price: 0.55, size: 10 }],
        timestamp: Date.now() - 10000, // older than staleThresholdMs (5000)
      });

      expect(manager.isBookFresh('tok1')).toBe(false);
    });

    it('should overwrite book on subsequent updates', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
        bids: [{ price: 0.40, size: 10 }], asks: [{ price: 0.50, size: 10 }],
        timestamp: Date.now(),
      });
      expect(manager.getBook('tok1')!.bestBid).toBe(0.40);

      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
        bids: [{ price: 0.65, size: 10 }], asks: [{ price: 0.70, size: 10 }],
        timestamp: Date.now(),
      });
      expect(manager.getBook('tok1')!.bestBid).toBe(0.65);
    });

    it('should clear book cache on unsubscribe', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
        bids: [{ price: 0.50, size: 10 }], asks: [{ price: 0.55, size: 10 }],
        timestamp: Date.now(),
      });
      expect(manager.getBook('tok1')).not.toBeNull();

      manager.unsubscribe(['tok1']);
      expect(manager.getBook('tok1')).toBeNull();
    });
  });

  // ─── Message handling ─────────────────────────────────────────────────

  describe('Message Handling', () => {
    beforeEach(async () => {
      await manager.connect();
    });

    it('should respond to heartbeat messages', () => {
      simulateMessage({ type: 'ping' });
      expect(mockWsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'pong' }),
      );
    });

    it('should ignore unknown message types', () => {
      expect(() => simulateMessage({ type: 'status', data: 'ok' })).not.toThrow();
    });

    it('should handle array of messages', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      // The manager handles arrays by iterating
      const handler = mockWsHandlers.get('message')!;
      handler(JSON.stringify([
        {
          type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
          bids: [{ price: 0.50, size: 10 }], asks: [{ price: 0.55, size: 10 }],
          timestamp: Date.now(),
        },
      ]));

      expect(manager.getBook('tok1')).not.toBeNull();
    });

    it('should gracefully handle unparseable messages', () => {
      const handler = mockWsHandlers.get('message')!;
      expect(() => handler('not json {{{')).not.toThrow();
    });

    it('should send subscribe message when connected', () => {
      manager.subscribe(['newAsset'], [{ assetId: 'newAsset', marketId: 'mktNew', outcomeIndex: 0 }]);
      expect(mockWsInstance.send).toHaveBeenCalled();
      const msg = mockWsInstance.send.mock.calls[0][0];
      expect(msg).toContain('subscribe');
      expect(msg).toContain('newAsset');
    });

    it('should send unsubscribe message when connected', () => {
      manager.subscribe(['tokUnsub'], [{ assetId: 'tokUnsub', marketId: 'mktU', outcomeIndex: 0 }]);
      mockWsInstance.send.mockClear();
      manager.unsubscribe(['tokUnsub']);
      expect(mockWsInstance.send).toHaveBeenCalled();
      const msg = mockWsInstance.send.mock.calls[0][0];
      expect(msg).toContain('unsubscribe');
    });
  });

  // ─── Callback builders (standalone tests) ─────────────────────────────

  describe('Callback Builders', () => {
    const cbs = makeCallbacks();

    it('buildSubscribeMsg should include all asset IDs', () => {
      const msg = cbs.buildSubscribeMsg(['a', 'b', 'c']);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('subscribe');
      expect(parsed.assets).toEqual(['a', 'b', 'c']);
    });

    it('buildUnsubscribeMsg should include all asset IDs', () => {
      const msg = cbs.buildUnsubscribeMsg(['x', 'y']);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('unsubscribe');
      expect(parsed.assets).toEqual(['x', 'y']);
    });

    it('buildHeartbeatResponse should return pong for ping', () => {
      expect(cbs.buildHeartbeatResponse({ type: 'ping' })).toBe(JSON.stringify({ type: 'pong' }));
    });

    it('buildHeartbeatResponse should return null for non-ping', () => {
      expect(cbs.buildHeartbeatResponse({ type: 'book' })).toBeNull();
      expect(cbs.buildHeartbeatResponse({})).toBeNull();
    });

    it('parseBookUpdate should return update for book type', () => {
      const update = cbs.parseBookUpdate({
        type: 'book', assetId: 'a', marketId: 'm', outcomeIndex: 0,
        bids: [{ price: 0.5, size: 10 }], asks: [],
        timestamp: Date.now(),
      });
      expect(update).not.toBeNull();
      expect(update!.assetId).toBe('a');
    });

    it('parseBookUpdate should return null for non-book type', () => {
      expect(cbs.parseBookUpdate({ type: 'heartbeat' })).toBeNull();
      expect(cbs.parseBookUpdate({ type: 'status' })).toBeNull();
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await manager.connect();
    });

    it('should handle rapid updates (100 in sequence)', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      for (let i = 0; i < 100; i++) {
        simulateMessage({
          type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
          bids: [{ price: 0.50 + i * 0.001, size: 100 }],
          asks: [{ price: 0.55 + i * 0.001, size: 100 }],
          timestamp: Date.now(),
        });
      }

      const book = manager.getBook('tok1')!;
      expect(book.bestBid).toBeCloseTo(0.599, 3);
    });

    it('should handle special characters in asset IDs', () => {
      const id = 'asset-$pecial_chars-123';
      manager.subscribe([id], [{ assetId: id, marketId: 'mktS', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book', assetId: id, marketId: 'mktS', outcomeIndex: 0,
        bids: [{ price: 0.50, size: 10 }], asks: [{ price: 0.55, size: 10 }],
        timestamp: Date.now(),
      });

      expect(manager.getBook(id)).not.toBeNull();
    });

    it('should handle zero-size price levels', () => {
      manager.subscribe(['tok1'], [{ assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0 }]);

      simulateMessage({
        type: 'book', assetId: 'tok1', marketId: 'mkt1', outcomeIndex: 0,
        bids: [{ price: 0.50, size: 0 }, { price: 0.45, size: 100 }],
        asks: [{ price: 0.55, size: 200 }],
        timestamp: Date.now(),
      });

      const book = manager.getBook('tok1')!;
      expect(book.bids).toHaveLength(2);
      expect(book.bestBid).toBe(0.50);
    });
  });
});
