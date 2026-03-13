// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: predict.fun Connector
// Connects to the predict.fun REST API and WebSocket for real-time order books
// ═══════════════════════════════════════════════════════════════════════════

import { BaseConnector } from './base-connector';
import {
  FetchMarketsOptions,
  NormalizedMarket,
  OrderBook,
  OrderRequest,
  OrderResult,
  Platform,
  Position,
  PriceLevel,
} from '../types';
import { config } from '../utils/config';
import { WsOrderBookManager, ParsedBookUpdate } from './ws-orderbook-manager';

// ─── Raw predict.fun API Types (from https://dev.predict.fun) ────────────

interface PredictFunOutcome {
  name: string;
  indexSet: number;
  onChainId: string;
  status: 'WON' | 'LOST' | string;
}

interface PredictFunRawMarket {
  id: number;                       // numeric ID
  imageUrl: string;
  title: string;
  question: string;
  description: string;
  tradingStatus: 'OPEN' | 'MATCHING_NOT_ENABLED' | 'CANCEL_ONLY' | 'CLOSED';
  status: 'REGISTERED' | 'PRICE_PROPOSED' | 'PRICE_DISPUTED' | 'PAUSED' | 'UNPAUSED' | 'RESOLVED' | 'REMOVED';
  isVisible: boolean;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;
  resolution: { name: string; indexSet: number; onChainId: string; status: string } | null;
  oracleQuestionId: string;
  conditionId: string;
  resolverAddress: string;
  outcomes: PredictFunOutcome[];
  questionIndex: number | null;
  spreadThreshold: number;
  shareThreshold: number;
  isBoosted: boolean;
  boostStartsAt: string | null;
  boostEndsAt: string | null;
  polymarketConditionIds: string[];
  kalshiMarketTicker: string | null;
  categorySlug: string;
  createdAt: string;
  decimalPrecision: 2 | 3;
  marketVariant: 'DEFAULT' | 'SPORTS_MATCH' | 'CRYPTO_UP_DOWN' | 'TWEET_COUNT' | 'SPORTS_TEAM_MATCH';
  variantData: unknown;
}

interface PredictFunMarketsResponse {
  success: boolean;
  cursor: string | null;
  data: PredictFunRawMarket[];
}

interface PredictFunOrderBookResponse {
  success: boolean;
  data: PredictFunRawOrderBook;
}

interface PredictFunRawOrderBook {
  bids: Array<[number, number]>;  // [price, quantity]
  asks: Array<[number, number]>;  // [price, quantity]
}

interface PredictFunAuthMessage {
  message: string;
}

// ─── Connector Implementation ────────────────────────────────────────────

export class PredictFunConnector extends BaseConnector {
  readonly platform: Platform = 'predictfun';
  readonly name = 'predict.fun';

  private apiUrl: string;
  private jwtToken: string | null = null;
  private wsManager: WsOrderBookManager;

  /** Cache: marketId → NormalizedMarket (for token lookups and WS event parsing) */
  private marketCache = new Map<string, NormalizedMarket>();

  /** Auto-incrementing request ID for predict.fun WS protocol */
  private nextRequestId = 1;

  constructor() {
    super('predictfun');
    this.apiUrl = config.predictfun.useTestnet
      ? config.predictfun.testnetUrl
      : config.predictfun.apiUrl;

    const wsUrl = config.predictfun.useTestnet
      ? config.predictfun.wsTestnetUrl
      : config.predictfun.wsUrl;

    // Build the WS URL with API key query param if available
    const wsUrlWithAuth = config.predictfun.apiKey
      ? `${wsUrl}?apiKey=${config.predictfun.apiKey}`
      : wsUrl;

    // ─── predict.fun WebSocket setup ───────────────────────────────────
    // Protocol:
    //   - Connect to /ws?apiKey=<key>
    //   - Heartbeat every 15s from server; client must respond with same timestamp
    //   - Subscribe: { "type": "subscribe", "channel": "orderbook", "marketId": "...", "requestId": N }
    //   - Unsubscribe: { "type": "unsubscribe", "channel": "orderbook", "marketId": "...", "requestId": N }
    //   - Book updates: { "type": "orderbook", "marketId": "...", "bids": [...], "asks": [...] }
    this.wsManager = new WsOrderBookManager(
      {
        platform: 'predictfun',
        wsUrl: wsUrlWithAuth,
        maxReconnects: 0,               // infinite reconnects
        reconnectBaseDelayMs: 1000,
        reconnectMaxDelayMs: 30000,
        heartbeatIntervalMs: 15000,      // predict.fun sends heartbeat every 15s
        staleThresholdMs: 20000,         // slightly more than heartbeat interval
      },
      // Subscribe message builder
      // predict.fun subscribes per-market, so we send one message per asset
      // (asset IDs are market IDs for predict.fun)
      (assetIds: string[]) => {
        // Send all subscribe messages as a JSON array (the WS manager sends this
        // as a single message, so we batch them)
        const messages = assetIds.map(marketId => ({
          type: 'subscribe',
          channel: 'orderbook',
          marketId,
          requestId: this.nextRequestId++,
        }));
        // If only one, send as single object; otherwise batch
        return messages.length === 1
          ? JSON.stringify(messages[0])
          : JSON.stringify(messages);
      },
      // Unsubscribe message builder
      (assetIds: string[]) => {
        const messages = assetIds.map(marketId => ({
          type: 'unsubscribe',
          channel: 'orderbook',
          marketId,
          requestId: this.nextRequestId++,
        }));
        return messages.length === 1
          ? JSON.stringify(messages[0])
          : JSON.stringify(messages);
      },
      // Heartbeat response builder
      // predict.fun sends: { "type": "heartbeat", "timestamp": <number> }
      // Client must respond: { "type": "heartbeat", "timestamp": <same_number> }
      (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m.type === 'heartbeat' && m.timestamp !== undefined) {
          return JSON.stringify({ type: 'heartbeat', timestamp: m.timestamp });
        }
        return null;
      },
      // Book update parser
      (raw: unknown) => this.parsePredictFunWsEvent(raw),
    );
  }

  async connect(): Promise<void> {
    try {
      // Test REST connectivity — pass auth headers so mainnet doesn't 401
      await this.httpGet(`${this.apiUrl}/v1/markets?first=1&tradingStatus=OPEN`, this.getAuthHeaders());
      this._isConnected = true;
      this.emit('connected');
      this.log.info('Connected to predict.fun REST API', { url: this.apiUrl });

      // Connect WebSocket for real-time book streaming
      try {
        await this.wsManager.connect();
        this._isWsConnected = true;
        this.log.info('Connected to predict.fun WebSocket');
      } catch (wsErr) {
        this.log.warn('WebSocket connection failed, will use REST fallback', {
          error: (wsErr as Error).message,
        });
      }
    } catch (err) {
      this.log.error('Failed to connect to predict.fun', { error: (err as Error).message });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.wsManager.disconnect();
    this._isWsConnected = false;
    this.jwtToken = null;
    this._isConnected = false;
    this.marketCache.clear();
    this.emit('disconnected');
    this.log.info('Disconnected from predict.fun');
  }

  /** Authenticate and get JWT token */
  private async authenticate(): Promise<void> {
    if (!config.predictfun.apiKey || !config.predictfun.privateKey) {
      this.log.warn('predict.fun credentials not configured — trading disabled');
      return;
    }

    // Step 1: Get auth message
    const { message } = await this.httpGet<PredictFunAuthMessage>(
      `${this.apiUrl}/v1/auth/message`
    );

    // Step 2: Sign message with private key (would use ethers.js)
    this.log.info('Auth message received, signing required for trading');

    // Step 3: Exchange for JWT
    // const jwt = await this.httpPost(`${this.apiUrl}/v1/auth`, { ... });
    // this.jwtToken = jwt.token;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.predictfun.apiKey) {
      headers['x-api-key'] = config.predictfun.apiKey;
    }
    if (this.jwtToken) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
    }
    return headers;
  }

  // ─── Market Data ───────────────────────────────────────────────────────

  async fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]> {
    const params = new URLSearchParams();
    params.set('first', String(options?.limit ?? 100));
    if (options?.offset) params.set('after', String(options.offset));

    // ─── Server-side filters (per https://dev.predict.fun docs) ─────────
    // NB: the query parameter is `tradingStatus`, not `status`.
    // `status` is the market lifecycle field (REGISTERED/RESOLVED/etc.);
    // `tradingStatus` controls whether the order book is open (OPEN/CANCEL_ONLY/CLOSED).
    if (options?.activeOnly !== false) {
      params.set('tradingStatus', 'OPEN');
    }

    // predict.fun supports sort: VOLUME_TOTAL_DESC, VOLUME_24H_DESC, etc.
    if (options?.sortBy) {
      const sortMap: Record<string, string> = {
        volume: options.sortDirection === 'asc' ? 'VOLUME_TOTAL_ASC' : 'VOLUME_TOTAL_DESC',
        liquidity: options.sortDirection === 'asc' ? 'VOLUME_TOTAL_ASC' : 'VOLUME_TOTAL_DESC', // no liquidity sort; use volume as proxy
        updatedAt: options.sortDirection === 'asc' ? 'VOLUME_24H_ASC' : 'VOLUME_24H_DESC',
      };
      const sortValue = sortMap[options.sortBy];
      if (sortValue) params.set('sort', sortValue);
    }

    const response = await this.httpGet<PredictFunMarketsResponse>(
      `${this.apiUrl}/v1/markets?${params.toString()}`,
      this.getAuthHeaders(),
    );

    const markets = response.data || [];

    // ─── Client-side filters ────────────────────────────────────────────
    // predict.fun API doesn't expose liquidity/volume fields for filtering,
    // so binary-only and tradingStatus checks are done here
    return (Array.isArray(markets) ? markets : [])
      .filter(m => {
        // Binary markets only
        if ((m.outcomes || []).length !== 2) return false;
        // Must be actively tradable
        if (m.tradingStatus !== 'OPEN') return false;
        return true;
      })
      .map(m => this.normalizeMarket(m));
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    try {
      const response = await this.httpGet<{ success: boolean; data: PredictFunRawMarket }>(
        `${this.apiUrl}/v1/markets/${marketId}`,
        this.getAuthHeaders(),
      );
      const raw = response.data ?? response as unknown as PredictFunRawMarket;
      return this.normalizeMarket(raw);
    } catch {
      return null;
    }
  }

  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> {
    // Try WebSocket cache first (sub-millisecond)
    const wsBook = this.wsManager.getBookByMarket(marketId, outcomeIndex);
    if (wsBook && this.wsManager.isBookFresh(marketId)) {
      return wsBook;
    }

    // Fallback to REST — response is wrapped: { success, data: { bids, asks } }
    const response = await this.httpGet<PredictFunOrderBookResponse>(
      `${this.apiUrl}/v1/markets/${marketId}/orderbook`,
      this.getAuthHeaders(),
    );
    const raw = response.data ?? response as unknown as PredictFunRawOrderBook;

    this.log.debug('Fetched orderbook via REST', {
      marketId,
      bids: (raw.bids || []).length,
      asks: (raw.asks || []).length,
    });

    return this.normalizeOrderBook(raw, marketId, outcomeIndex);
  }

  // ─── WebSocket Subscriptions ──────────────────────────────────────────

  subscribeOrderBooks(markets: NormalizedMarket[]): void {
    // For predict.fun, the "asset ID" in the WS manager is the market ID itself
    // since predict.fun subscribes per-market (not per-token)
    const assetIds: string[] = [];
    const mappings: Array<{ assetId: string; marketId: string; outcomeIndex: number }> = [];

    for (const market of markets) {
      // Cache the market for WS event parsing
      this.marketCache.set(market.id, market);

      // predict.fun sends order book data for the whole market,
      // so we subscribe once per market but create mappings for both outcomes
      if (!assetIds.includes(market.id)) {
        assetIds.push(market.id);
      }

      // Map the market ID to both YES (0) and NO (1) outcomes
      // The WS manager will store one book per assetId, but we parse
      // both outcomes from a single update event
      mappings.push({ assetId: market.id, marketId: market.id, outcomeIndex: 0 });
      // For NO outcome, we create a separate mapping key
      mappings.push({ assetId: `${market.id}:NO`, marketId: market.id, outcomeIndex: 1 });
    }

    if (assetIds.length > 0) {
      this.wsManager.subscribe(assetIds, mappings);
      this.log.info('Subscribed to predict.fun WS books', {
        markets: markets.length,
      });
    }
  }

  unsubscribeOrderBooks(marketIds: string[]): void {
    const assetIds: string[] = [];
    for (const mid of marketIds) {
      assetIds.push(mid);
      this.marketCache.delete(mid);
    }
    if (assetIds.length > 0) {
      this.wsManager.unsubscribe(assetIds);
    }
  }

  // ─── Trading (requires auth) ───────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.jwtToken && !config.predictfun.apiKey) {
      throw new Error('predict.fun: not authenticated for trading');
    }

    this.log.info('Placing order on predict.fun', { order });

    const orderPayload = {
      marketId: order.marketId,
      outcomeIndex: order.outcomeIndex,
      side: order.side,
      type: order.type,
      price: order.price,
      amount: order.size,
    };

    this.log.info('Order payload prepared (dry-run mode)', { orderPayload });

    return {
      id: `pfun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      platform: 'predictfun',
      marketId: order.marketId,
      outcomeIndex: order.outcomeIndex,
      side: order.side,
      type: order.type,
      price: order.price,
      size: order.size,
      filledSize: 0,
      avgFillPrice: 0,
      status: 'PENDING',
      timestamp: new Date(),
      fees: 0,
      raw: orderPayload,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.log.info('Cancelling order on predict.fun', { orderId });
    return true;
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getBalance(): Promise<number> {
    return 0;
  }

  // ─── WebSocket Event Parsing ─────────────────────────────────────────

  /**
   * Parse a predict.fun WebSocket event into a book update.
   *
   * predict.fun WS events:
   *   - type: "orderbook"
   *     { type, marketId, bids: [[price, qty], ...], asks: [[price, qty], ...], timestamp }
   *   - type: "heartbeat"
   *     { type, timestamp } — handled by the heartbeat callback
   *   - type: "subscribed" / "unsubscribed" — ack messages
   */
  private parsePredictFunWsEvent(raw: unknown): ParsedBookUpdate | null {
    const msg = raw as Record<string, unknown>;

    if (msg.type !== 'orderbook') return null;

    const marketId = msg.marketId as string;
    if (!marketId) return null;

    // Check if we're tracking this market
    const market = this.marketCache.get(marketId);
    if (!market) return null;

    const rawBids = (msg.bids as Array<[number, number]>) || [];
    const rawAsks = (msg.asks as Array<[number, number]>) || [];

    // predict.fun sends YES-side order book data
    // We store the YES book directly (outcomeIndex 0)
    return {
      assetId: marketId,
      marketId,
      outcomeIndex: 0,
      bids: rawBids.map(([price, size]) => ({ price, size })),
      asks: rawAsks.map(([price, size]) => ({ price, size })),
      timestamp: new Date((msg.timestamp as number) || Date.now()),
      minOrderSize: 1,
      tickSize: 0.01,
    };
  }

  // ─── Normalization ─────────────────────────────────────────────────────

  private normalizeMarket(raw: PredictFunRawMarket): NormalizedMarket {
    const outcomes = (raw.outcomes || []).map(o => o.name || 'Unknown');
    const outcomeTokenIds = (raw.outcomes || []).map(o => o.onChainId || '');
    // predict.fun doesn't return current prices in the markets endpoint;
    // prices come from the order book. Use 0 as placeholder.
    const outcomePrices = (raw.outcomes || []).map(() => 0);

    return {
      id: String(raw.id),           // numeric → string for our normalized type
      platform: 'predictfun',
      question: raw.question || raw.title,
      slug: raw.conditionId || '',
      category: raw.categorySlug || '',
      outcomes,
      outcomeTokenIds,
      outcomePrices,
      volume: 0,                     // not returned by markets endpoint
      liquidity: 0,                  // not returned by markets endpoint
      active: raw.status !== 'RESOLVED' && raw.status !== 'REMOVED' && raw.tradingStatus === 'OPEN',
      endDate: null,                 // not in the API response
      lastUpdated: new Date(raw.createdAt || Date.now()),
      raw,
    };
  }

  private normalizeOrderBook(
    raw: PredictFunRawOrderBook,
    marketId: string,
    outcomeIndex: number,
  ): OrderBook {
    // predict.fun returns [price, quantity] tuples
    // Prices are for YES outcome. For NO, we need to invert.
    const isYes = outcomeIndex === 0;

    let bids: PriceLevel[];
    let asks: PriceLevel[];

    if (isYes) {
      bids = (raw.bids || []).map(([price, size]) => ({ price, size }))
        .sort((a, b) => b.price - a.price);
      asks = (raw.asks || []).map(([price, size]) => ({ price, size }))
        .sort((a, b) => a.price - b.price);
    } else {
      // For NO outcome: flip bid/ask and invert prices
      // A YES ask at 0.60 = a NO bid at 0.40
      // A YES bid at 0.55 = a NO ask at 0.45
      bids = (raw.asks || []).map(([price, size]) => ({ price: 1 - price, size }))
        .sort((a, b) => b.price - a.price);
      asks = (raw.bids || []).map(([price, size]) => ({ price: 1 - price, size }))
        .sort((a, b) => a.price - b.price);
    }

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    return {
      platform: 'predictfun',
      marketId,
      outcomeIndex,
      bids,
      asks,
      minOrderSize: 1,
      tickSize: 0.01,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp: new Date(),
    };
  }
}
