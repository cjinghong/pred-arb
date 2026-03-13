// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Polymarket Connector
// Connects to Polymarket's Gamma API (markets) and CLOB API (order books)
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

// ─── Raw Polymarket API Types ────────────────────────────────────────────

interface PolymarketRawMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  category: string;
  outcomes: string;           // JSON string: '["Yes","No"]'
  outcomePrices: string;      // JSON string: '[0.65, 0.35]'
  clobTokenIds: string;       // JSON string: '["token1","token2"]'
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  updatedAt: string;
}

interface PolymarketRawOrderBook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
  min_tick_size?: number;
  hash?: string;
}

// ─── Connector Implementation ────────────────────────────────────────────

export class PolymarketConnector extends BaseConnector {
  readonly platform: Platform = 'polymarket';
  readonly name = 'Polymarket';

  private gammaUrl: string;
  private clobUrl: string;
  private wsManager: WsOrderBookManager;

  /** Cache: marketId → NormalizedMarket (to avoid refetching for token lookups) */
  private marketCache = new Map<string, NormalizedMarket>();

  constructor() {
    super('polymarket');
    this.gammaUrl = config.polymarket.gammaUrl;
    this.clobUrl = config.polymarket.clobUrl;

    // ─── Polymarket WebSocket setup ─────────────────────────────────────
    // URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
    // Subscribe: { "assets_ids": [...tokenIds], "type": "market" }
    // Events: book (full snapshot), price_change, last_trade_price, tick_size_change
    this.wsManager = new WsOrderBookManager(
      {
        platform: 'polymarket',
        wsUrl: config.polymarket.wsUrl,
        maxReconnects: 0,              // infinite reconnects
        reconnectBaseDelayMs: 1000,
        reconnectMaxDelayMs: 30000,
        heartbeatIntervalMs: 0,        // Polymarket has no heartbeat requirement
        staleThresholdMs: 5000,
      },
      // Subscribe message builder
      (assetIds: string[]) => JSON.stringify({
        assets_ids: assetIds,
        type: 'market',
      }),
      // Unsubscribe message builder (Polymarket doesn't have explicit unsubscribe;
      // we just stop processing events for those IDs)
      (_assetIds: string[]) => '',
      // Heartbeat response builder (Polymarket has no heartbeat requirement)
      (_msg: unknown) => null,
      // Book update parser
      (raw: unknown) => this.parsePolymarketWsEvent(raw),
    );
  }

  async connect(): Promise<void> {
    try {
      // Test REST connectivity by fetching a single market
      await this.httpGet(`${this.gammaUrl}/markets?limit=1`);
      this._isConnected = true;
      this.emit('connected');
      this.log.info('Connected to Polymarket REST API');

      // Connect WebSocket for real-time book streaming
      try {
        await this.wsManager.connect();
        this._isWsConnected = true;
        this.log.info('Connected to Polymarket WebSocket');
      } catch (wsErr) {
        this.log.warn('WebSocket connection failed, will use REST fallback', {
          error: (wsErr as Error).message,
        });
      }
    } catch (err) {
      this.log.error('Failed to connect to Polymarket', { error: (err as Error).message });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.wsManager.disconnect();
    this._isWsConnected = false;
    this._isConnected = false;
    this.marketCache.clear();
    this.emit('disconnected');
    this.log.info('Disconnected from Polymarket');
  }

  // ─── Market Data ───────────────────────────────────────────────────────

  async fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]> {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 100));
    if (options?.offset) params.set('offset', String(options.offset));

    // ─── Server-side filters (Polymarket Gamma API supports these) ──────
    if (options?.activeOnly !== false) params.set('active', 'true');
    params.set('closed', 'false');

    // Liquidity & volume filters — let the API do the heavy lifting
    if (options?.minLiquidity) {
      params.set('liquidity_num_min', String(options.minLiquidity));
    }
    if (options?.minVolume) {
      params.set('volume_num_min', String(options.minVolume));
    }

    // Sorting — default to highest liquidity first for better arb candidates
    if (options?.sortBy) {
      const sortFieldMap: Record<string, string> = {
        liquidity: 'liquidity',
        volume: 'volume',
        updatedAt: 'updatedAt',
      };
      params.set('order', sortFieldMap[options.sortBy] || options.sortBy);
      params.set('ascending', String(options.sortDirection === 'asc'));
    }

    const raw = await this.httpGet<PolymarketRawMarket[]>(
      `${this.gammaUrl}/markets?${params.toString()}`
    );

    // Client-side: only filter for binary markets (no API param for outcome count)
    return raw
      .filter(m => {
        try {
          const outcomes = JSON.parse(m.outcomes || '[]');
          return outcomes.length === 2;
        } catch {
          return false;
        }
      })
      .map(m => this.normalizeMarket(m));
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    try {
      const raw = await this.httpGet<PolymarketRawMarket>(
        `${this.gammaUrl}/markets/${marketId}`
      );
      return this.normalizeMarket(raw);
    } catch {
      return null;
    }
  }

  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> {
    // Try WebSocket cache first (sub-millisecond)
    const wsBook = this.wsManager.getBookByMarket(marketId, outcomeIndex);
    if (wsBook && this.wsManager.isBookFresh(marketId + ':' + outcomeIndex)) {
      return wsBook;
    }

    // Fallback to REST
    const market = await this.getOrFetchMarket(marketId);
    if (!market) throw new Error(`Market ${marketId} not found`);

    const tokenId = market.outcomeTokenIds[outcomeIndex];
    if (!tokenId) throw new Error(`No token for outcome index ${outcomeIndex}`);

    const raw = await this.httpGet<PolymarketRawOrderBook>(
      `${this.clobUrl}/book?token_id=${tokenId}`
    );

    this.log.debug('Fetched orderbook via REST', {
      marketId,
      tokenId,
      bids: (raw.bids || []).length,
      asks: (raw.asks || []).length,
    });

    return this.normalizeOrderBook(raw, marketId, outcomeIndex);
  }

  // ─── WebSocket Subscriptions ─────────────────────────────────────────

  subscribeOrderBooks(markets: NormalizedMarket[]): void {
    const assetIds: string[] = [];
    const mappings: Array<{ assetId: string; marketId: string; outcomeIndex: number }> = [];

    for (const market of markets) {
      // Cache the market for token lookups
      this.marketCache.set(market.id, market);

      // Subscribe to both YES and NO token IDs
      for (let i = 0; i < market.outcomeTokenIds.length; i++) {
        const tokenId = market.outcomeTokenIds[i];
        if (tokenId) {
          assetIds.push(tokenId);
          mappings.push({ assetId: tokenId, marketId: market.id, outcomeIndex: i });
        }
      }
    }

    if (assetIds.length > 0) {
      this.wsManager.subscribe(assetIds, mappings);
      this.log.info('Subscribed to Polymarket WS books', {
        markets: markets.length,
        tokens: assetIds.length,
      });
    }
  }

  unsubscribeOrderBooks(marketIds: string[]): void {
    const assetIds: string[] = [];
    for (const mid of marketIds) {
      const market = this.marketCache.get(mid);
      if (market) {
        assetIds.push(...market.outcomeTokenIds.filter(Boolean));
        this.marketCache.delete(mid);
      }
    }
    if (assetIds.length > 0) {
      this.wsManager.unsubscribe(assetIds);
    }
  }

  /** Get market from cache or fetch via REST */
  private async getOrFetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    const cached = this.marketCache.get(marketId);
    if (cached) return cached;
    const market = await this.fetchMarket(marketId);
    if (market) this.marketCache.set(marketId, market);
    return market;
  }

  /** Batch-fetch order books for multiple token IDs */
  async fetchOrderBooks(tokenIds: string[]): Promise<Map<string, PolymarketRawOrderBook>> {
    const result = new Map<string, PolymarketRawOrderBook>();

    // CLOB supports batch via POST /books
    try {
      const books = await this.httpPost<PolymarketRawOrderBook[]>(
        `${this.clobUrl}/books`,
        tokenIds,
      );
      for (const book of books) {
        result.set(book.asset_id, book);
      }
    } catch (err) {
      this.log.warn('Batch book fetch failed, falling back to individual', {
        error: (err as Error).message,
      });
      // Fallback: fetch individually
      for (const tokenId of tokenIds) {
        try {
          const book = await this.httpGet<PolymarketRawOrderBook>(
            `${this.clobUrl}/book?token_id=${tokenId}`
          );
          result.set(tokenId, book);
        } catch {
          this.log.warn(`Failed to fetch book for token ${tokenId}`);
        }
      }
    }

    return result;
  }

  // ─── Trading (requires auth) ───────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // NOTE: Full order signing requires EIP-712 integration with ethers.js
    // This is a scaffold — production would use the Polymarket CLOB client SDK
    this.log.info('Placing order on Polymarket', { order });

    const market = await this.fetchMarket(order.marketId);
    if (!market) throw new Error(`Market ${order.marketId} not found`);

    const tokenId = market.outcomeTokenIds[order.outcomeIndex];

    // In production, this would:
    // 1. Build the order struct
    // 2. Sign with EIP-712
    // 3. POST to CLOB /order endpoint
    const orderPayload = {
      tokenID: tokenId,
      price: order.price,
      size: order.size,
      side: order.side,
      feeRateBps: 0,
      nonce: Date.now().toString(),
    };

    this.log.info('Order payload prepared (dry-run mode)', { orderPayload });

    // Return a simulated result for now
    return {
      id: `poly_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      platform: 'polymarket',
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
    this.log.info('Cancelling order on Polymarket', { orderId });
    // Would DELETE to CLOB /order/{orderId}
    return true;
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    // Would GET from CLOB /orders with API credentials
    return [];
  }

  async getPositions(): Promise<Position[]> {
    // Would GET from data-api with API credentials
    return [];
  }

  async getBalance(): Promise<number> {
    // Would query USDC balance on Polygon
    return 0;
  }

  // ─── Normalization ─────────────────────────────────────────────────────

  private normalizeMarket(raw: PolymarketRawMarket): NormalizedMarket {
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    let tokenIds: string[] = [];

    try { outcomes = JSON.parse(raw.outcomes || '[]'); } catch { outcomes = []; }
    try { outcomePrices = JSON.parse(raw.outcomePrices || '[]').map(Number); } catch { outcomePrices = []; }
    try { tokenIds = JSON.parse(raw.clobTokenIds || '[]'); } catch { tokenIds = []; }

    return {
      id: raw.id || raw.conditionId,
      platform: 'polymarket',
      question: raw.question,
      slug: raw.slug,
      category: raw.category || '',
      outcomes,
      outcomeTokenIds: tokenIds,
      outcomePrices,
      volume: raw.volume || 0,
      liquidity: raw.liquidity || 0,
      active: raw.active && !raw.closed,
      endDate: raw.endDate ? new Date(raw.endDate) : null,
      lastUpdated: new Date(raw.updatedAt || Date.now()),
      raw,
    };
  }

  // ─── WebSocket Event Parsing ─────────────────────────────────────────

  /**
   * Parse a Polymarket WebSocket event into a book update.
   *
   * Polymarket market channel events:
   *  - event_type: "book" — full order book snapshot
   *    { event_type, asset_id, market, bids: [{price, size}], asks: [{price, size}],
   *      timestamp, hash, min_order_size, tick_size, neg_risk }
   *
   *  - event_type: "price_change" — price level update (ignored, we use full books)
   *  - event_type: "last_trade_price" — trade executed
   *  - event_type: "tick_size_change" — tick size changed
   */
  private parsePolymarketWsEvent(raw: unknown): ParsedBookUpdate | null {
    const msg = raw as Record<string, unknown>;
    if (msg.event_type !== 'book') return null;

    const assetId = msg.asset_id as string;
    if (!assetId) return null;

    // Look up market mapping from our cache
    let marketId = '';
    let outcomeIndex = 0;
    for (const [mid, market] of this.marketCache.entries()) {
      const idx = market.outcomeTokenIds.indexOf(assetId);
      if (idx !== -1) {
        marketId = mid;
        outcomeIndex = idx;
        break;
      }
    }
    if (!marketId) return null;

    const rawBids = (msg.bids as Array<{ price: string; size: string }>) || [];
    const rawAsks = (msg.asks as Array<{ price: string; size: string }>) || [];

    return {
      assetId,
      marketId,
      outcomeIndex,
      bids: rawBids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks: rawAsks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
      timestamp: new Date(parseInt(msg.timestamp as string) * 1000 || Date.now()),
      minOrderSize: (msg.min_order_size as number) ?? 1,
      tickSize: (msg.tick_size as number) ?? 0.01,
    };
  }

  private normalizeOrderBook(
    raw: PolymarketRawOrderBook,
    marketId: string,
    outcomeIndex: number,
  ): OrderBook {
    const bids: PriceLevel[] = (raw.bids || []).map(b => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })).sort((a, b) => b.price - a.price);

    const asks: PriceLevel[] = (raw.asks || []).map(a => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })).sort((a, b) => a.price - b.price);

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    return {
      platform: 'polymarket',
      marketId,
      outcomeIndex,
      bids,
      asks,
      minOrderSize: 1,
      tickSize: raw.min_tick_size || 0.01,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp: new Date(parseInt(raw.timestamp) * 1000 || Date.now()),
    };
  }
}
