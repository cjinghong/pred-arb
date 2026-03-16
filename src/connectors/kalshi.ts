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
import {
  DiscoveredMarket,
  SportsFetchOptions,
  KALSHI_SERIES_TICKERS,
} from '../discovery/types';
import { parseSportsMarket } from '../matcher/sports-matcher';
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
  status: 'open' | 'active' | 'closed' | 'settled' | 'determined' | string;
  response_price_units: string;
  notional_value: number;
  tick_size: number;
  // Legacy integer cents fields (REMOVED by Kalshi on 2026-03-12)
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  previous_yes_bid?: number;
  previous_yes_ask?: number;
  previous_price?: number;
  // New dollar string fields (e.g., "0.27")
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  previous_yes_bid_dollars?: string;
  previous_yes_ask_dollars?: string;
  previous_price_dollars?: string;
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
  // Current Kalshi API format: orderbook_fp with dollar-string arrays
  orderbook_fp?: {
    yes_dollars: Array<[string, string]>;  // [price_dollars, count_fp] e.g. ["0.42", "13.00"]
    no_dollars: Array<[string, string]>;   // [price_dollars, count_fp] e.g. ["0.38", "5.00"]
  };
  // Legacy format (kept for backward compatibility)
  orderbook?: {
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
    // Legacy integer fields (may be 0 or missing in newer API)
    position?: number;
    market_exposure?: number;
    realized_pnl?: number;
    total_traded?: number;
    // New fixed-point string fields (e.g., "10.00", "-5.00")
    position_fp?: string;
    market_exposure_dollars?: number;
    realized_pnl_dollars?: number;
    total_traded_dollars?: number;
    resting_orders_count: number;
    fees_paid?: number;
    fees_paid_dollars?: number;
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

interface KalshiEventsResponse {
  events: Array<{
    event_ticker: string;
    series_ticker: string;
    title: string;
    mutually_exclusive: boolean;
    category: string;
    markets: KalshiRawMarket[];
  }>;
  cursor: string | null;
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
  elections: 'Politics',
  'us-politics': 'Politics',
  'us-elections': 'Politics',
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
    // Strip query parameters — Kalshi signs path only (no query string)
    const pathWithoutQuery = urlPath.split('?')[0];
    // Build the message: timestamp + METHOD + path (NO separators/newlines)
    const message = `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;

    const signature = crypto.sign('sha256', Buffer.from(message), {
      key: this.rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
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
      .filter(m => m.status === 'open' || m.status === 'active')
      .map(m => this.normalizeMarket(m));
  }

  /**
   * Fetch markets in a specific category using the events API.
   *
   * Kalshi's GET /markets endpoint returns empty `category` on individual markets.
   * The GET /events endpoint supports server-side `category` filtering and returns
   * nested markets per event — much more efficient for category-based fetching.
   *
   * Returns up to MAX_CATEGORY_MARKETS markets, sorted by volume (most liquid first).
   */
  private async fetchMarketsByCategory(
    category: string,
    _options?: FetchMarketsOptions,
  ): Promise<NormalizedMarket[]> {
    const kalshiCategory = KALSHI_CATEGORY_MAP[category] || category;
    const allMarkets: NormalizedMarket[] = [];
    let cursor: string | null = null;
    const pageSize = 200;
    const maxPages = 20;
    const MAX_CATEGORY_MARKETS = _options?.limit || 2000; // Respect caller's limit

    this.log.info('Fetching Kalshi events by category', { category, kalshiCategory });

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('with_nested_markets', 'true');
      // NOTE: Kalshi removed `category` and possibly `status` query params from GET /events
      // (circa March 2026). We filter client-side instead.
      if (cursor) params.set('cursor', cursor);

      this.log.info('Kalshi events request', { url: `${this.apiUrl}/events?${params.toString()}` });

      const response = await this.kalshiGet<KalshiEventsResponse>(
        `${this.apiUrl}/events?${params.toString()}`
      );

      const events = response.events || [];
      if (events.length === 0) break;

      for (const event of events) {
        // Client-side category filter: only include events whose category matches.
        // Many Kalshi events have empty/missing category — skip those too.
        if (!event.category || event.category.toLowerCase() !== kalshiCategory.toLowerCase()) {
          continue;
        }
        const markets = event.markets || [];
        for (const m of markets) {
          // Client-side status filter (server-side param removed)
          if (m.status !== 'open' && m.status !== 'active') continue;
          // Inherit category from the event since market.category is empty
          if (!m.category && event.category) {
            m.category = event.category;
          }
          allMarkets.push(this.normalizeMarket(m));
        }
      }

      cursor = response.cursor || null;
      if (!cursor || events.length < pageSize) break;
      // Early exit: if we already have enough markets, stop paginating
      if (allMarkets.length >= MAX_CATEGORY_MARKETS) break;
    }

    // Sort by volume (most liquid first) and cap at MAX_CATEGORY_MARKETS
    allMarkets.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const capped = allMarkets.slice(0, MAX_CATEGORY_MARKETS);

    this.log.info('Kalshi category fetch complete', {
      category,
      kalshiCategory,
      marketsFound: allMarkets.length,
      kept: capped.length,
    });

    return capped;
  }

  // ─── Sports-Specific Discovery ──────────────────────────────────────────

  /**
   * Fetch sports markets using Kalshi's series_ticker-based querying.
   * Much more targeted than the generic events API — fetches only markets
   * from a specific sports league with time bounds.
   *
   * Uses: GET /markets?series_ticker=KXNBAGAME&status=open&min_end_timestamp=...&max_end_timestamp=...
   */
  async fetchSportsMarkets(options?: SportsFetchOptions): Promise<DiscoveredMarket[]> {
    const lookAheadDays = options?.lookAheadDays ?? 3;
    const maxResults = options?.maxResults ?? 1000;
    const league = options?.league;

    const now = Date.now();
    const minTimestamp = Math.floor(now / 1000);
    const maxTimestamp = Math.floor((now + lookAheadDays * 24 * 60 * 60 * 1000) / 1000);

    // Determine which series tickers to query
    const tickers: Array<{ league: string; ticker: string }> = [];
    if (league && KALSHI_SERIES_TICKERS[league]) {
      tickers.push({ league, ticker: KALSHI_SERIES_TICKERS[league] });
    } else {
      // Query all known sports series
      for (const [lg, tk] of Object.entries(KALSHI_SERIES_TICKERS)) {
        tickers.push({ league: lg, ticker: tk });
      }
    }

    const allMarkets: DiscoveredMarket[] = [];
    const seenIds = new Set<string>();

    for (const { league: lg, ticker } of tickers) {
      try {
        const params = new URLSearchParams();
        params.set('series_ticker', ticker);
        params.set('status', 'open');
        params.set('min_end_timestamp', String(minTimestamp));
        params.set('max_end_timestamp', String(maxTimestamp));
        params.set('limit', String(Math.min(maxResults, 1000)));

        const response = await this.kalshiGet<KalshiMarketsResponse>(
          `${this.apiUrl}/markets?${params.toString()}`
        );

        const markets = (response.markets || [])
          .filter(m => m.status === 'open' || m.status === 'active')
          .filter(m => {
            if (seenIds.has(m.ticker)) return false;
            seenIds.add(m.ticker);
            return true;
          })
          // Deduplicate by event_ticker: Kalshi creates 2 markets per game (one per team).
          // Keep only the first (higher-volume) market per event to avoid duplicate matches.
          .filter(m => {
            const eventKey = m.event_ticker || m.ticker;
            if (seenIds.has(`evt:${eventKey}`)) return false;
            seenIds.add(`evt:${eventKey}`);
            return true;
          })
          .map(m => {
            const normalized = this.normalizeMarket(m);
            const discovered: DiscoveredMarket = { ...normalized };
            discovered.sportsInfo = parseSportsMarket(discovered) || undefined;
            return discovered;
          });

        allMarkets.push(...markets);

        this.log.info(`Kalshi sports fetch: ${lg}`, {
          seriesTicker: ticker,
          found: markets.length,
          withSportsInfo: markets.filter(m => m.sportsInfo).length,
        });
      } catch (err) {
        this.log.warn(`Failed to fetch Kalshi sports for ${lg}`, {
          ticker,
          error: (err as Error).message,
        });
      }
    }

    // Sort by volume, cap results
    allMarkets.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const capped = allMarkets.slice(0, maxResults);

    this.log.info('Kalshi sports discovery complete', {
      totalFound: allMarkets.length,
      kept: capped.length,
      withSportsInfo: capped.filter(m => m.sportsInfo).length,
    });

    return capped;
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
      `${this.apiUrl}/markets/${marketId}/orderbook?depth=20`
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
      // Only fetch unsettled positions
      const response = await this.kalshiGet<KalshiPositionsResponse>(
        `${this.apiUrl}/portfolio/positions?settlement_status=unsettled`
      );

      // Parse position size: prefer position_fp (string, e.g. "10.00"), fall back to position (int)
      const parsePosition = (p: (typeof response.market_positions)[number]): number => {
        if (p.position_fp !== undefined && p.position_fp !== null) {
          return parseFloat(p.position_fp);
        }
        return p.position ?? 0;
      };

      const positions = (response.market_positions || [])
        .filter(p => {
          const pos = parsePosition(p);
          // Filter out settled/empty positions
          if (pos === 0 || isNaN(pos)) return false;
          return true;
        });

      this.log.debug('Kalshi positions fetched', {
        raw: response.market_positions?.length ?? 0,
        afterFilter: positions.length,
        sample: response.market_positions?.slice(0, 3).map(p => ({
          ticker: p.ticker,
          position: p.position,
          position_fp: p.position_fp,
        })),
      });

      // Batch-fetch market details for titles and URLs
      const result: Position[] = [];
      for (const p of positions) {
        const posSize = parsePosition(p);

        // Derive URL from ticker pattern:
        // Per-team ticker: KXNBAGAME-26MAR16GSWWAS-WAS
        // Event ticker: KXNBAGAME-26MAR16GSWWAS (strip last team segment)
        // Series ticker: KXNBAGAME (strip date+teams)
        const tickerParts = p.ticker.split('-');
        const eventTicker = tickerParts.length >= 3
          ? tickerParts.slice(0, -1).join('-')  // strip last team segment
          : p.ticker;
        const seriesTicker = eventTicker.replace(/-\d{2}[a-z]{3}\d{2}.*$/i, '') || eventTicker;

        // Try to get market title + current price from cache or API
        let question = p.ticker;
        let currentPrice = 0;
        const cached = this.marketCache.get(p.ticker);
        if (cached) {
          question = cached.question;
          // outcomePrices[0] = YES price, outcomePrices[1] = NO price (already normalized 0-1)
          const isYes = posSize > 0;
          currentPrice = isYes
            ? (cached.outcomePrices?.[0] ?? 0)
            : (cached.outcomePrices?.[1] ?? 0);
        } else {
          try {
            const market = await this.fetchMarket(p.ticker);
            if (market) {
              question = market.question;
              const isYes = posSize > 0;
              currentPrice = isYes
                ? (market.outcomePrices?.[0] ?? 0)
                : (market.outcomePrices?.[1] ?? 0);
            }
          } catch { /* use ticker as fallback */ }
        }

        // Compute avg entry price from exposure / position:
        // market_exposure_dollars (or market_exposure in cents) = total cost of position
        const absPos = Math.abs(posSize);
        const exposureDollars = p.market_exposure_dollars ?? ((p.market_exposure ?? 0) / 100);
        const avgEntryPrice = absPos > 0 ? exposureDollars / absPos : 0;

        const marketUrl = `https://kalshi.com/markets/${seriesTicker.toLowerCase()}/${eventTicker.toLowerCase()}`;
        const realizedPnl = p.realized_pnl_dollars ?? p.realized_pnl ?? 0;

        result.push({
          platform: 'kalshi' as Platform,
          marketId: p.ticker,
          marketQuestion: question,
          outcomeIndex: posSize > 0 ? 0 : 1,
          side: (posSize > 0 ? 'YES' : 'NO') as 'YES' | 'NO',
          size: absPos,
          avgEntryPrice,
          currentPrice,
          unrealizedPnl: realizedPnl,
          marketUrl,
        });
      }

      return result;
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

  /** Slugify a subtitle string for Kalshi URLs (e.g., "Professional Basketball Game" → "professional-basketball-game") */
  private slugifySubtitle(subtitle: string): string {
    return subtitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private normalizeMarket(raw: KalshiRawMarket): NormalizedMarket {
    // Kalshi URL format: /markets/{series_ticker}/{subtitle_slug}/{event_ticker}
    // e.g., /markets/kxnbagame/professional-basketball-game/kxnbagame-26mar17phiden
    const subtitleSlug = raw.subtitle ? this.slugifySubtitle(raw.subtitle) : '';
    const eventTicker = raw.event_ticker?.toLowerCase() || '';
    // Derive series_ticker from event_ticker by stripping the date+teams suffix
    // e.g., "kxnbagame-26mar17phiden" → "kxnbagame"
    const seriesTicker = eventTicker.replace(/-\d{2}[a-z]{3}\d{2}.*$/i, '') || eventTicker;
    const market: NormalizedMarket = {
      id: raw.ticker,
      platform: 'kalshi',
      question: raw.title,
      // slug encodes both subtitle and event_ticker for URL construction:
      // Format: "{subtitle_slug}|{event_ticker}" — dashboard splits on "|"
      slug: `${subtitleSlug || 'market'}|${eventTicker}`,
      eventSlug: seriesTicker, // series_ticker for URL first segment
      category: raw.category || '',
      outcomes: ['Yes', 'No'],
      outcomeTokenIds: [`${raw.ticker}_yes`, `${raw.ticker}_no`],
      outcomePrices: (() => {
        // Prefer _dollars fields (strings like "0.27"); fall back to legacy cents / 100
        const yesAsk = raw.yes_ask_dollars != null ? parseFloat(raw.yes_ask_dollars)
          : (raw.yes_ask ?? 0) > 0 ? (raw.yes_ask ?? 0) / 100 : 0;
        const noAsk = raw.no_ask_dollars != null ? parseFloat(raw.no_ask_dollars)
          : (raw.no_ask ?? 0) > 0 ? (raw.no_ask ?? 0) / 100 : 0;
        const lastPrice = raw.last_price_dollars != null ? parseFloat(raw.last_price_dollars)
          : (raw.last_price ?? 0) / 100;
        return [
          yesAsk > 0 ? yesAsk : lastPrice,
          noAsk > 0 ? noAsk : (1 - lastPrice),
        ];
      })(),
      volume: raw.volume || 0,
      liquidity: raw.liquidity || 0,
      active: raw.status === 'open' || raw.status === 'active',
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

    // Parse order book levels from either format:
    // Current API: orderbook_fp.yes_dollars / no_dollars (string arrays: ["0.42", "13.00"])
    // Legacy API:  orderbook.yes / no (number arrays: [42, 13] in cents)
    let yesBids: PriceLevel[];
    let noBids: PriceLevel[];

    if (raw.orderbook_fp) {
      // Current format: dollar strings → parse to [0..1] prices and numeric sizes
      yesBids = (raw.orderbook_fp.yes_dollars || [])
        .map(([priceDollars, countFp]) => ({ price: parseFloat(priceDollars), size: parseFloat(countFp) }))
        .filter(l => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
      noBids = (raw.orderbook_fp.no_dollars || [])
        .map(([priceDollars, countFp]) => ({ price: parseFloat(priceDollars), size: parseFloat(countFp) }))
        .filter(l => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
    } else if (raw.orderbook) {
      // Legacy format: cents → normalize to [0..1]
      yesBids = (raw.orderbook.yes || [])
        .map(([priceCents, qty]) => ({ price: priceCents / 100, size: qty }));
      noBids = (raw.orderbook.no || [])
        .map(([priceCents, qty]) => ({ price: priceCents / 100, size: qty }));
    } else {
      yesBids = [];
      noBids = [];
    }

    let bids: PriceLevel[];
    let asks: PriceLevel[];

    if (isYes) {
      // YES bids = yes side bids (highest price first)
      // YES asks = construct from NO bids: if someone bids NO at $0.40, they're offering YES at $0.60
      bids = yesBids.sort((a, b) => b.price - a.price);
      asks = noBids
        .map(l => ({ price: 1 - l.price, size: l.size }))
        .sort((a, b) => a.price - b.price);
    } else {
      // NO bids = no side bids (highest price first)
      // NO asks = construct from YES bids
      bids = noBids.sort((a, b) => b.price - a.price);
      asks = yesBids
        .map(l => ({ price: 1 - l.price, size: l.size }))
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
