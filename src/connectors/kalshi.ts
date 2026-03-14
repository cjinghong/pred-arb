// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Kalshi Connector
// Connects to the Kalshi REST API v2 (markets, trading) and WebSocket
// for real-time order book updates.
//
// Auth: RSA-PSS signed requests (KALSHI-ACCESS-KEY + KALSHI-ACCESS-SIGNATURE
//       + KALSHI-ACCESS-TIMESTAMP headers).
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
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ─── Raw Kalshi API Types ─────────────────────────────────────────────────

interface KalshiRawMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expiration_time: string;
  settlement_time: string;
  status: 'open' | 'closed' | 'settled' | string;
  response_price_units: string;
  notional_value: number;
  tick_size: number;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  previous_yes_bid: number;
  previous_yes_ask: number;
  previous_price: number;
  volume: number;
  volume_24h: number;
  liquidity: number;
  open_interest: number;
  result: string;
  category: string;
  risk_limit_cents: number;
  strike_type: string;
  floor_strike?: number;
  cap_strike?: number;
  // Additional fields
  rules_primary?: string;
  rules_secondary?: string;
  settlement_value?: number;
  custom_strike?: string;
  can_close_early?: boolean;
  expiration_value?: string;
  expected_expiration_time?: string;
  settlement_timer_seconds?: number;
  functional_strike?: string;
}

interface KalshiMarketsResponse {
  markets: KalshiRawMarket[];
  cursor: string | null;
}

interface KalshiRawOrderBook {
  orderbook: {
    yes: Array<[number, number]>;  // [price_cents, quantity]
    no: Array<[number, number]>;   // [price_cents, quantity]
  };
}

interface KalshiRawOrder {
  order_id: string;
  ticker: string;
  client_order_id?: string;
  status: 'resting' | 'canceled' | 'executed' | 'pending' | string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  yes_price: number;
  no_price: number;
  created_time: string;
  updated_time?: string;
  expiration_time?: string;
  remaining_count: number;
  queue_position?: number;
  place_count: number;
  decrease_count?: number;
  maker_fill_count?: number;
  taker_fill_count?: number;
  taker_fees?: number;
  maker_fees?: number;
}

interface KalshiCreateOrderRequest {
  ticker: string;
  client_order_id?: string;
  type: 'limit' | 'market';
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  yes_price?: number;
  no_price?: number;
  expiration_ts?: number;
  sell_position_floor?: number;
  buy_max_cost?: number;
}

interface KalshiCreateOrderResponse {
  order: KalshiRawOrder;
}

interface KalshiBalanceResponse {
  balance: number; // in cents
}

interface KalshiFillsResponse {
  fills: Array<{
    trade_id: string;
    order_id: string;
    ticker: string;
    side: 'yes' | 'no';
    action: 'buy' | 'sell';
    count: number;
    yes_price: number;
    no_price: number;
    is_taker: boolean;
    created_time: string;
  }>;
  cursor: string | null;
}

interface KalshiPositionsResponse {
  market_positions: Array<{
    ticker: string;
    position: number;
    market_exposure: number;
    realized_pnl: number;
    total_traded: number;
    resting_orders_count: number;
    fees_paid: number;
  }>;
  cursor: string | null;
}

interface KalshiEventResponse {
  event: {
    event_ticker: string;
    series_ticker: string;
    title: string;
    mutually_exclusive: boolean;
    category: string;
    markets: KalshiRawMarket[];
  };
}

// ─── Category Mapping ─────────────────────────────────────────────────────

const KALSHI_CATEGORY_MAP: Record<string, string> = {
  sports: 'Sports',
  basketball: 'Sports',
  nba: 'Sports',
  football: 'Sports',
  nfl: 'Sports',
  soccer: 'Sports',
  baseball: 'Sports',
  mlb: 'Sports',
  hockey: 'Sports',
  nhl: 'Sports',
  mma: 'Sports',
  ufc: 'Sports',
  tennis: 'Sports',
  golf: 'Sports',
  motorsports: 'Sports',
  f1: 'Sports',
  boxing: 'Sports',
  cricket: 'Sports',
  politics: 'Politics',
  economics: 'Economics',
  finance: 'Financials',
  crypto: 'Crypto',
  climate: 'Climate and Weather',
  weather: 'Climate and Weather',
  tech: 'Tech',
  science: 'Science',
  culture: 'Culture',
};

// ─── Connector Implementation ─────────────────────────────────────────────

export class KalshiConnector extends BaseConnector {
  readonly platform: Platform = 'kalshi';
  readonly name = 'Kalshi';

  private apiUrl: string;
  private apiKeyId: string;
  private rsaPrivateKey: crypto.KeyObject | null = null;

  /** Cache: ticker → NormalizedMarket */
  private marketCache = new Map<string, NormalizedMarket>();

  constructor() {
    super('kalshi');

    const cfg = config.kalshi;
    this.apiUrl = cfg.useDemo ? cfg.demoApiUrl : cfg.apiUrl;
    this.apiKeyId = cfg.apiKeyId;

    // Load RSA private key
    this.loadPrivateKey();
  }

  /**
   * Load the RSA private key from config.
   * Supports either an inline PEM string (with \n escaped) or a file path.
   */
  private loadPrivateKey(): void {
    const { privateKey, privateKeyPath } = config.kalshi;

    if (privateKey) {
      try {
        // Inline key — replace escaped newlines
        const pem = privateKey.replace(/\\n/g, '\n');
        this.rsaPrivateKey = crypto.createPrivateKey({
          key: pem,
          format: 'pem',
        });
        this.log.info('Kalshi RSA private key loaded from env var');
      } catch (err) {
        this.log.error('Failed to parse Kalshi RSA private key from env', {
          error: (err as Error).message,
        });
      }
    } else if (privateKeyPath) {
      try {
        const resolvedPath = path.resolve(privateKeyPath);
        const pem = fs.readFileSync(resolvedPath, 'utf8');
        this.rsaPrivateKey = crypto.createPrivateKey({
          key: pem,
          format: 'pem',
        });
        this.log.info('Kalshi RSA private key loaded from file', { path: resolvedPath });
      } catch (err) {
        this.log.error('Failed to load Kalshi RSA private key from file', {
          path: privateKeyPath,
          error: (err as Error).message,
        });
      }
    } else {
      this.log.warn('KALSHI_PRIVATE_KEY / KALSHI_PRIVATE_KEY_PATH not set — trading disabled');
    }
  }

  /**
   * Sign a request using RSA-PSS (SHA-256, max salt length).
   * Kalshi auth: timestamp_ms + newline + method + newline + path
   */
  private signRequest(method: string, urlPath: string): { timestamp: string; signature: string } | null {
    if (!this.rsaPrivateKey || !this.apiKeyId) return null;

    const timestampMs = Date.now().toString();
    // Build the message: timestamp + \n + METHOD + \n + /trade-api/v2/...path
    const message = `${timestampMs}\n${method.toUpperCase()}\n${urlPath}`;

    const signature = crypto.sign('sha256', Buffer.from(message), {
      key: this.rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN,
    });

    return {
      timestamp: timestampMs,
      signature: signature.toString('base64'),
    };
  }

  /**
   * Build auth headers for a request.
   */
  private getAuthHeaders(method: string, urlPath: string): Record<string, string> {
    const sig = this.signRequest(method, urlPath);
    if (!sig) return {};

    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': sig.signature,
      'KALSHI-ACCESS-TIMESTAMP': sig.timestamp,
    };
  }

  /**
   * Extract the path portion from a full URL for signing.
   */
  private extractPath(fullUrl: string): string {
    const url = new URL(fullUrl);
    return url.pathname + url.search;
  }

  /**
   * Authenticated GET request.
   */
  private async kalshiGet<T>(url: string): Promise<T> {
    const urlPath = this.extractPath(url);
    const authHeaders = this.getAuthHeaders('GET', urlPath);
    return this.httpGet<T>(url, authHeaders);
  }

  /**
   * Authenticated POST request.
   */
  private async kalshiPost<T>(url: string, body: unknown): Promise<T> {
    const urlPath = this.extractPath(url);
    const authHeaders = this.getAuthHeaders('POST', urlPath);
    return this.httpPost<T>(url, body, authHeaders);
  }

  /**
   * Authenticated DELETE request.
   */
  private async kalshiDelete<T>(url: string): Promise<T> {
    const urlPath = this.extractPath(url);
    const authHeaders = this.getAuthHeaders('DELETE', urlPath);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    try {
      // Test REST connectivity by fetching markets
      await this.kalshiGet<KalshiMarketsResponse>(
        `${this.apiUrl}/markets?limit=1&status=open`
      );
      this._isConnected = true;
      this.emit('connected');
      this.log.info('Connected to Kalshi REST API', { url: this.apiUrl });
    } catch (err) {
      this.log.error('Failed to connect to Kalshi', { error: (err as Error).message });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this._isWsConnected = false;
    this.marketCache.clear();
    this.emit('disconnected');
    this.log.info('Disconnected from Kalshi');
  }

  // ─── Market Data ────────────────────────────────────────────────────────

  async fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]> {
    if (options?.category) {
      return this.fetchMarketsByCategory(options.category, options);
    }

    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 200));
    params.set('status', 'open');

    if (options?.offset && typeof options.offset === 'string') {
      params.set('cursor', options.offset);
    }

    const response = await this.kalshiGet<KalshiMarketsResponse>(
      `${this.apiUrl}/markets?${params.toString()}`
    );

    return (response.markets || [])
      .filter(m => m.status === 'open')
      .map(m => this.normalizeMarket(m));
  }

  /**
   * Fetch ALL markets in a specific category with pagination.
   */
  private async fetchMarketsByCategory(
    category: string,
    options?: FetchMarketsOptions,
  ): Promise<NormalizedMarket[]> {
    const kalshiCategory = KALSHI_CATEGORY_MAP[category] || category;
    const allMarkets: NormalizedMarket[] = [];
    let cursor: string | null = null;
    const pageSize = 200;
    const maxPages = 10; // Safety: 2000 markets max

    this.log.info('Fetching Kalshi markets by category', { category, kalshiCategory });

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('status', 'open');
      // Note: Kalshi API uses `event_ticker` filter, not `category` directly.
      // We'll fetch all open markets and filter client-side by category.
      if (cursor) params.set('cursor', cursor);

      const response = await this.kalshiGet<KalshiMarketsResponse>(
        `${this.apiUrl}/markets?${params.toString()}`
      );

      const markets = response.markets || [];
      if (markets.length === 0) break;

      for (const m of markets) {
        if (m.status !== 'open') continue;
        // Client-side category filter
        if (kalshiCategory && m.category !== kalshiCategory) continue;
        allMarkets.push(this.normalizeMarket(m));
      }

      cursor = response.cursor || null;
      if (!cursor || markets.length < pageSize) break;
    }

    this.log.info('Kalshi category fetch complete', {
      category,
      kalshiCategory,
      totalMarkets: allMarkets.length,
    });

    return allMarkets;
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    try {
      const response = await this.kalshiGet<{ market: KalshiRawMarket }>(
        `${this.apiUrl}/markets/${marketId}`
      );
      const market = this.normalizeMarket(response.market);
      this.marketCache.set(market.id, market);
      return market;
    } catch {
      return null;
    }
  }

  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> {
    const response = await this.kalshiGet<KalshiRawOrderBook>(
      `${this.apiUrl}/markets/${marketId}/orderbook`
    );

    return this.normalizeOrderBook(response, marketId, outcomeIndex);
  }

  // ─── WebSocket (stub — Kalshi WS integration can be added later) ────────

  subscribeOrderBooks(_markets: NormalizedMarket[]): void {
    // Kalshi WS requires separate auth handshake; for now use REST polling
    this.log.debug('Kalshi WS subscriptions not yet implemented — using REST fallback');
  }

  unsubscribeOrderBooks(_marketIds: string[]): void {
    // No-op for now
  }

  // ─── Trading ────────────────────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.rsaPrivateKey || !this.apiKeyId) {
      throw new Error('Kalshi: credentials not configured — set KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY');
    }

    // Kalshi uses cents for prices, integer count for contracts
    const side = order.outcomeIndex === 0 ? 'yes' : 'no';
    const yesPrice = side === 'yes'
      ? Math.round(order.price * 100)
      : undefined;
    const noPrice = side === 'no'
      ? Math.round(order.price * 100)
      : undefined;

    const count = Math.max(1, Math.round(order.size));

    const body: KalshiCreateOrderRequest = {
      ticker: order.marketId,
      type: order.type === 'MARKET' ? 'market' : 'limit',
      action: order.side === 'BUY' ? 'buy' : 'sell',
      side,
      count,
      ...(yesPrice !== undefined ? { yes_price: yesPrice } : {}),
      ...(noPrice !== undefined ? { no_price: noPrice } : {}),
    };

    this.log.info('Placing order on Kalshi', {
      ticker: order.marketId,
      side,
      action: order.side,
      price: order.price,
      count,
    });

    try {
      const response = await this.kalshiPost<KalshiCreateOrderResponse>(
        `${this.apiUrl}/portfolio/orders`,
        body,
      );

      const raw = response.order;
      const fees = KalshiConnector.calculateTakerFee(order.price, count);

      return {
        id: raw.order_id,
        platform: 'kalshi',
        marketId: raw.ticker,
        outcomeIndex: raw.side === 'yes' ? 0 : 1,
        side: raw.action === 'buy' ? 'BUY' : 'SELL',
        type: raw.type === 'market' ? 'MARKET' : 'LIMIT',
        price: order.price,
        size: raw.place_count,
        filledSize: raw.place_count - raw.remaining_count,
        avgFillPrice: order.price,
        status: this.mapKalshiStatus(raw.status),
        timestamp: new Date(raw.created_time),
        fees,
        raw: response,
      };
    } catch (err) {
      this.log.error('Failed to place order on Kalshi', {
        error: (err as Error).message,
        order,
      });
      return {
        id: `kalshi_failed_${Date.now()}`,
        platform: 'kalshi',
        marketId: order.marketId,
        outcomeIndex: order.outcomeIndex,
        side: order.side,
        type: order.type,
        price: order.price,
        size: order.size,
        filledSize: 0,
        avgFillPrice: 0,
        status: 'FAILED',
        timestamp: new Date(),
        fees: 0,
        raw: { error: (err as Error).message },
      };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.kalshiDelete(`${this.apiUrl}/portfolio/orders/${orderId}`);
      this.log.info('Order cancelled on Kalshi', { orderId });
      return true;
    } catch (err) {
      this.log.error('Failed to cancel order on Kalshi', {
        orderId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    try {
      const response = await this.kalshiGet<{ orders: KalshiRawOrder[] }>(
        `${this.apiUrl}/portfolio/orders?status=resting`
      );

      return (response.orders || []).map(o => this.mapRawOrderToResult(o));
    } catch (err) {
      this.log.error('Failed to get open orders', { error: (err as Error).message });
      return [];
    }
  }

  async getOrder(orderId: string): Promise<OrderResult | null> {
    try {
      const response = await this.kalshiGet<{ order: KalshiRawOrder }>(
        `${this.apiUrl}/portfolio/orders/${orderId}`
      );
      return this.mapRawOrderToResult(response.order);
    } catch (err) {
      this.log.error('Failed to get order', { orderId, error: (err as Error).message });
      return null;
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const response = await this.kalshiGet<KalshiPositionsResponse>(
        `${this.apiUrl}/portfolio/positions`
      );

      return (response.market_positions || [])
        .filter(p => p.position !== 0)
        .map(p => ({
          platform: 'kalshi' as Platform,
          marketId: p.ticker,
          marketQuestion: p.ticker,
          outcomeIndex: p.position > 0 ? 0 : 1, // positive = YES, negative = NO
          side: (p.position > 0 ? 'YES' : 'NO') as 'YES' | 'NO',
          size: Math.abs(p.position),
          avgEntryPrice: 0, // Not directly available; would need to compute from fills
          currentPrice: 0,
          unrealizedPnl: 0,
        }));
    } catch (err) {
      this.log.error('Failed to get positions', { error: (err as Error).message });
      return [];
    }
  }

  async getBalance(): Promise<number> {
    try {
      const response = await this.kalshiGet<KalshiBalanceResponse>(
        `${this.apiUrl}/portfolio/balance`
      );
      // Balance is in cents
      const balance = (response.balance || 0) / 100;
      this.log.debug('Kalshi balance fetched', { balance });
      return balance;
    } catch (err) {
      this.log.error('Failed to get Kalshi balance', { error: (err as Error).message });
      return 0;
    }
  }

  // ─── Fee Calculation ─────────────────────────────────────────────────────

  /**
   * Calculate Kalshi taker fee.
   * Formula: $0.07 × P × (1 - P) × count
   * where P is the contract price (0..1) and count is number of contracts.
   *
   * Fees are capped at $0.07 per contract (maximum at P = 0.50).
   * Minimum fee: $0.02 per contract.
   * No maker fees on Kalshi.
   */
  static calculateTakerFee(price: number, count: number): number {
    const feePerContract = 0.07 * price * (1 - price);
    // Floor at $0.02 per contract (Kalshi minimum)
    const cappedFee = Math.max(feePerContract, 0.02);
    return cappedFee * count;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private mapKalshiStatus(status: string): OrderResult['status'] {
    switch (status.toLowerCase()) {
      case 'resting':
        return 'OPEN';
      case 'executed':
        return 'FILLED';
      case 'canceled':
        return 'CANCELLED';
      case 'pending':
        return 'PENDING';
      default:
        return 'PENDING';
    }
  }

  private mapRawOrderToResult(o: KalshiRawOrder): OrderResult {
    const filledCount = o.place_count - o.remaining_count;
    const price = o.side === 'yes' ? o.yes_price / 100 : o.no_price / 100;

    let status: OrderResult['status'] = this.mapKalshiStatus(o.status);
    if (filledCount >= o.place_count && o.place_count > 0) status = 'FILLED';
    else if (filledCount > 0 && o.remaining_count > 0) status = 'PARTIALLY_FILLED';

    return {
      id: o.order_id,
      platform: 'kalshi',
      marketId: o.ticker,
      outcomeIndex: o.side === 'yes' ? 0 : 1,
      side: o.action === 'buy' ? 'BUY' : 'SELL',
      type: o.type === 'market' ? 'MARKET' : 'LIMIT',
      price,
      size: o.place_count,
      filledSize: filledCount,
      avgFillPrice: filledCount > 0 ? price : 0,
      status,
      timestamp: new Date(o.created_time),
      fees: (o.taker_fees || 0) / 100, // cents → dollars
      raw: o,
    };
  }

  // ─── Normalization ─────────────────────────────────────────────────────

  private normalizeMarket(raw: KalshiRawMarket): NormalizedMarket {
    const market: NormalizedMarket = {
      id: raw.ticker,
      platform: 'kalshi',
      question: raw.title,
      slug: raw.ticker.toLowerCase(), // Kalshi uses tickers as URL identifiers
      category: raw.category || '',
      outcomes: ['Yes', 'No'],
      outcomeTokenIds: [`${raw.ticker}_yes`, `${raw.ticker}_no`],
      outcomePrices: [
        raw.yes_ask > 0 ? raw.yes_ask / 100 : raw.last_price / 100,
        raw.no_ask > 0 ? raw.no_ask / 100 : (100 - raw.last_price) / 100,
      ],
      volume: raw.volume || 0,
      liquidity: raw.liquidity || 0,
      active: raw.status === 'open',
      endDate: raw.close_time ? new Date(raw.close_time) : null,
      lastUpdated: new Date(),
      raw,
    };

    this.marketCache.set(market.id, market);
    return market;
  }

  private normalizeOrderBook(
    raw: KalshiRawOrderBook,
    marketId: string,
    outcomeIndex: number,
  ): OrderBook {
    const isYes = outcomeIndex === 0;
    const rawBook = raw.orderbook || { yes: [], no: [] };

    let bids: PriceLevel[];
    let asks: PriceLevel[];

    if (isYes) {
      // YES bids: people wanting to buy YES
      // YES asks: people wanting to sell YES
      // Kalshi order book is [price_cents, quantity]
      // For YES outcome:
      //   YES bids = yes side bids (highest price first)
      //   YES asks = construct from NO bids: if someone bids NO at 40c, they're offering YES at 60c
      bids = rawBook.yes
        .map(([priceCents, qty]) => ({ price: priceCents / 100, size: qty }))
        .sort((a, b) => b.price - a.price);
      asks = rawBook.no
        .map(([priceCents, qty]) => ({ price: (100 - priceCents) / 100, size: qty }))
        .sort((a, b) => a.price - b.price);
    } else {
      // NO bids = no side bids
      // NO asks = construct from YES bids
      bids = rawBook.no
        .map(([priceCents, qty]) => ({ price: priceCents / 100, size: qty }))
        .sort((a, b) => b.price - a.price);
      asks = rawBook.yes
        .map(([priceCents, qty]) => ({ price: (100 - priceCents) / 100, size: qty }))
        .sort((a, b) => a.price - b.price);
    }

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    return {
      platform: 'kalshi',
      marketId,
      outcomeIndex,
      bids,
      asks,
      minOrderSize: 1,
      tickSize: 0.01, // Kalshi tick size is 1 cent
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp: new Date(),
    };
  }
}
