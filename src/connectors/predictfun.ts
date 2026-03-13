// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: predict.fun Connector
// Connects to the predict.fun REST API and WebSocket for real-time order books
// Real trading via @predictdotfun/sdk
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
import { Wallet } from 'ethers';
import {
  OrderBuilder,
  Side as PredictSide,
  SignatureType as PredictSigType,
  ChainId,
} from '@predictdotfun/sdk';
import type { SignedOrder as PredictSignedOrder } from '@predictdotfun/sdk';

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

// ─── Category → predict.fun Mapping ──────────────────────────────────────
// predict.fun uses `categorySlug` on raw markets and supports `category` query param.
// We also filter by `marketVariant` for sports-specific types.
const PREDICTFUN_CATEGORY_SLUGS: Record<string, string[]> = {
  sports: [], // empty = match any sports variant
  basketball: ['basketball'],
  nba: ['basketball'],       // NBA is under basketball slug
  football: ['football'],
  nfl: ['football'],
  soccer: ['soccer'],
  baseball: ['baseball'],
  mlb: ['baseball'],
  hockey: ['hockey'],
  nhl: ['hockey'],
  mma: ['mma'],
  ufc: ['mma'],
  tennis: ['tennis'],
  golf: ['golf'],
  motorsports: ['motorsports'],
  f1: ['motorsports'],
  boxing: ['boxing'],
  cricket: ['cricket'],
  esports: ['esports'],
};

/** Market variants that indicate sports markets */
const SPORTS_VARIANTS = new Set(['SPORTS_MATCH', 'SPORTS_TEAM_MATCH']);

// ─── Connector Implementation ────────────────────────────────────────────

export class PredictFunConnector extends BaseConnector {
  readonly platform: Platform = 'predictfun';
  readonly name = 'predict.fun';

  private apiUrl: string;
  private jwtToken: string | null = null;
  private wsManager: WsOrderBookManager;

  /** predict.fun SDK OrderBuilder for EIP-712 signing */
  private orderBuilder: OrderBuilder | null = null;
  /** Wallet for signing */
  private wallet: Wallet | null = null;
  /** Wallet address */
  private walletAddress: string | null = null;

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
      await this.httpGet(`${this.apiUrl}/v1/markets?first=1&status=OPEN`, this.getAuthHeaders());
      this._isConnected = true;
      this.emit('connected');
      this.log.info('Connected to predict.fun REST API', { url: this.apiUrl });

      // Initialize trading SDK
      await this.initTradingClient();

      // Authenticate for JWT (needed for order management)
      await this.authenticate();

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

  /** Initialize the predict.fun OrderBuilder for EIP-712 signing */
  private async initTradingClient(): Promise<void> {
    const { privateKey, smartWallet } = config.predictfun;

    if (!privateKey) {
      this.log.warn('PREDICTFUN_PRIVATE_KEY not set — trading disabled');
      return;
    }

    try {
      // Ensure private key has 0x prefix (ethers v6 requires it)
      const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      this.wallet = new Wallet(formattedKey);
      this.walletAddress = this.wallet.address;

      const chainId = config.predictfun.useTestnet ? ChainId.BnbTestnet : ChainId.BnbMainnet;

      // If smartWallet (Predict Account / Smart Wallet) is configured,
      // pass it so the SDK uses the Smart Wallet for orders and balances
      const options = smartWallet ? { predictAccount: smartWallet } : undefined;
      this.orderBuilder = await OrderBuilder.make(chainId, this.wallet, options);

      this.log.info('predict.fun OrderBuilder initialized', {
        address: this.walletAddress,
        smartWallet: smartWallet || 'none (using EOA)',
        chainId,
      });
    } catch (err) {
      this.log.error('Failed to initialize predict.fun trading SDK', {
        error: (err as Error).message,
      });
      this.orderBuilder = null;
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
    if (!config.predictfun.apiKey || !config.predictfun.privateKey || !this.wallet) {
      this.log.warn('predict.fun credentials not configured — trading disabled');
      return;
    }

    // When using a Smart Wallet (Predict Account), we must authenticate as the
    // Smart Wallet address (not the Privy wallet). The signature is wrapped via
    // the SDK's signPredictAccountMessage() to include the ECDSA validator.
    const { smartWallet } = config.predictfun;
    const authAddress = smartWallet || this.walletAddress;

    try {
      // Step 1: Get auth message
      const authMsgResponse = await this.httpGet<any>(
        `${this.apiUrl}/v1/auth/message`,
        this.getAuthHeaders(),
      );

      const message = authMsgResponse?.message || authMsgResponse?.data?.message;
      if (!message) {
        throw new Error(`Unexpected auth message response: ${JSON.stringify(authMsgResponse)}`);
      }

      this.log.info('Auth message received, signing...', { authAddress });

      // Step 2: Sign message
      let signature: string;
      if (smartWallet && this.orderBuilder) {
        // Use SDK to create a Smart Wallet signature (wraps with ECDSA validator)
        signature = await this.orderBuilder.signPredictAccountMessage(message);
      } else {
        // Direct EOA signature
        signature = await this.wallet.signMessage(message);
      }

      // Step 3: Exchange for JWT
      const authResponse = await this.httpPost<any>(
        `${this.apiUrl}/v1/auth`,
        {
          signer: authAddress,
          signature,
          message,
        },
        this.getAuthHeaders(),
      );

      this.jwtToken = authResponse?.token || authResponse?.data?.token;
      this.log.info('predict.fun JWT authentication successful', {
        address: authAddress,
      });
    } catch (err) {
      this.log.error('predict.fun authentication failed — trading may be limited', {
        error: (err as Error).message,
      });
    }
  }

  /** Re-authenticate if JWT has expired */
  private async ensureAuthenticated(): Promise<void> {
    // JWT tokens typically expire — re-authenticate if needed
    if (!this.jwtToken && this.wallet) {
      await this.authenticate();
    }
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
    // If a category is specified, use paginated fetching to get ALL markets in that category
    if (options?.category) {
      return this.fetchMarketsByCategory(options.category, options);
    }

    const params = new URLSearchParams();
    params.set('first', String(options?.limit ?? 100));
    if (options?.offset) params.set('after', String(options.offset));

    // ─── Server-side filters ────────────────────────────────────────────
    // Query parameter is `status` (not `tradingStatus`).
    if (options?.activeOnly !== false) {
      params.set('status', 'OPEN');
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

    const url = `${this.apiUrl}/v1/markets?${params.toString()}`;
    const response = await this.httpGet<PredictFunMarketsResponse>(url, this.getAuthHeaders());

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

  /**
   * Fetch ALL markets in a specific category with pagination.
   * Uses `category` query param where supported, plus client-side filtering
   * by `categorySlug` and `marketVariant` for sports markets.
   */
  private async fetchMarketsByCategory(
    category: string,
    options?: FetchMarketsOptions,
  ): Promise<NormalizedMarket[]> {
    const categorySlugs = PREDICTFUN_CATEGORY_SLUGS[category] || [category];
    const isBroadSports = category === 'sports';
    const allMarkets: NormalizedMarket[] = [];
    const pageSize = 100;
    let cursor: string | null = null;
    const maxPages = 20; // Safety limit: 2000 markets max

    this.log.info('Fetching predict.fun markets by category', {
      category,
      categorySlugs,
      isBroadSports,
    });

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      params.set('first', String(pageSize));
      if (cursor) params.set('after', cursor);
      if (options?.activeOnly !== false) params.set('status', 'OPEN');

      // Try server-side category filter if it's a specific slug
      if (categorySlugs.length === 1) {
        params.set('category', categorySlugs[0]);
      }

      const url = `${this.apiUrl}/v1/markets?${params.toString()}`;
      const response = await this.httpGet<PredictFunMarketsResponse>(url, this.getAuthHeaders());

      const markets = response.data || [];
      if (!markets || markets.length === 0) break;

      // Client-side filter: binary + open + category match
      const filtered = markets.filter(m => {
        if ((m.outcomes || []).length !== 2) return false;
        if (m.tradingStatus !== 'OPEN') return false;

        // Category filtering
        if (isBroadSports) {
          // "sports" = any market with a sports variant OR a sports-related category slug
          return SPORTS_VARIANTS.has(m.marketVariant) ||
            Object.values(PREDICTFUN_CATEGORY_SLUGS).flat().includes(m.categorySlug);
        }
        // Specific sport: match by categorySlug
        return categorySlugs.includes(m.categorySlug);
      });

      allMarkets.push(...filtered.map(m => this.normalizeMarket(m)));

      // Use cursor-based pagination
      cursor = response.cursor || null;
      if (!cursor || markets.length < pageSize) break;
    }

    this.log.info('predict.fun category fetch complete', {
      category,
      totalMarkets: allMarkets.length,
    });

    return allMarkets;
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    try {
      const response = await this.httpGet<{ success: boolean; data: PredictFunRawMarket }>(
        `${this.apiUrl}/v1/markets/${marketId}`,
        this.getAuthHeaders(),
      );
      const raw = response.data ?? response as unknown as PredictFunRawMarket;
      const normalized = this.normalizeMarket(raw);
      this.marketCache.set(normalized.id, normalized);
      return normalized;
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

  // ─── Trading (requires auth + SDK) ─────────────────────────────────────

  private ensureOrderBuilder(): OrderBuilder {
    if (!this.orderBuilder) {
      throw new Error('predict.fun: OrderBuilder not initialized — set PREDICTFUN_PRIVATE_KEY');
    }
    return this.orderBuilder;
  }

  /**
   * Calculate predict.fun taker fee.
   * Formula: rawFee = baseFee% × min(price, 1 - price) × shares
   * Base fee: 2% (0.02). Discounted: multiply by 0.9 → 1.8% effective.
   *
   * Polymarket has no fees, so we only need this for predict.fun.
   */
  static calculateTakerFee(price: number, shares: number, discounted = false): number {
    const baseFee = 0.02;
    const rawFee = baseFee * Math.min(price, 1 - price) * shares;
    return discounted ? rawFee * 0.9 : rawFee;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const ob = this.ensureOrderBuilder();
    await this.ensureAuthenticated();

    let market = this.marketCache.get(order.marketId);
    if (!market) {
      // Auto-fetch market if not in cache
      market = await this.fetchMarket(order.marketId) ?? undefined;
      if (!market) throw new Error(`Market ${order.marketId} not found`);
    }

    const rawMarket = market.raw as PredictFunRawMarket;
    const tokenId = market.outcomeTokenIds[order.outcomeIndex];
    if (!tokenId) throw new Error(`No token for outcome index ${order.outcomeIndex}`);

    const side = order.side === 'BUY' ? PredictSide.BUY : PredictSide.SELL;
    // predict.fun uses 18 decimals for all wei values
    const priceWei = BigInt(Math.round(order.price * 1e18));
    const quantityWei = BigInt(Math.round(order.size * 1e18));

    this.log.info('Placing order on predict.fun', {
      marketId: order.marketId,
      tokenId,
      side: order.side,
      price: order.price,
      size: order.size,
      priceWei: priceWei.toString(),
      quantityWei: quantityWei.toString(),
      isNegRisk: rawMarket.isNegRisk,
    });

    try {
      // Calculate order amounts using SDK
      const amounts = ob.getLimitOrderAmounts({
        side,
        pricePerShareWei: priceWei,
        quantityWei,
      });

      // Build the order struct
      const orderStruct = ob.buildOrder('LIMIT', {
        side,
        tokenId,
        makerAmount: amounts.makerAmount.toString(),
        takerAmount: amounts.takerAmount.toString(),
        feeRateBps: rawMarket.feeRateBps || 200, // 2% default
      });

      // Build typed data and sign
      const typedData = ob.buildTypedData(orderStruct, {
        isNegRisk: rawMarket.isNegRisk || false,
        isYieldBearing: rawMarket.isYieldBearing || false,
      });
      const signedOrder: PredictSignedOrder = await ob.signTypedDataOrder(typedData);
      const orderHash = ob.buildTypedDataHash(typedData);

      // Submit to predict.fun API
      // pricePerShare must be an integer string in wei (e.g., "10000000000000000" for $0.01)
      const strategy = order.type === 'MARKET' ? 'MARKET' : 'LIMIT';
      const response = await this.httpPost<any>(
        `${this.apiUrl}/v1/orders`,
        {
          data: {
            pricePerShare: priceWei.toString(),
            strategy,
            ...(order.type === 'MARKET' ? { isFillOrKill: true } : {}),
            order: {
              ...signedOrder,
              hash: orderHash,
            },
          },
        },
        this.getAuthHeaders(),
      );

      // Response: { success: true, data: { code: "OK", orderId: "...", orderHash: "..." } }
      const respData = response?.data || response;
      const orderId = respData?.orderId || respData?.orderHash || orderHash || `pfun_${Date.now()}`;
      const fees = PredictFunConnector.calculateTakerFee(order.price, order.size);

      this.log.info('Order placed on predict.fun', {
        orderId,
        orderHash: respData?.orderHash,
        code: respData?.code,
        raw: response,
      });

      return {
        id: orderId,
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
        fees,
        raw: response,
      };
    } catch (err) {
      this.log.error('Failed to place order on predict.fun', {
        error: (err as Error).message,
        order,
      });
      return {
        id: `pfun_failed_${Date.now()}`,
        platform: 'predictfun',
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
    await this.ensureAuthenticated();
    this.log.info('Cancelling order on predict.fun', { orderId });

    try {
      await this.httpPost(
        `${this.apiUrl}/v1/orders/remove`,
        { data: { ids: [orderId] } },
        this.getAuthHeaders(),
      );
      this.log.info('Order cancelled on predict.fun', { orderId });
      return true;
    } catch (err) {
      this.log.error('Failed to cancel order on predict.fun', {
        orderId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    await this.ensureAuthenticated();

    try {
      // GET /v1/orders returns { success, cursor, data: [{ id, marketId, order, status, amount, amountFilled, ... }] }
      const response = await this.httpGet<any>(
        `${this.apiUrl}/v1/orders?status=OPEN`,
        this.getAuthHeaders(),
      );

      const orders = response?.data || [];
      return orders.map((o: any) => {
        const orderData = o.order || {};
        const side = orderData.side === 0 ? 'BUY' as const : 'SELL' as const;
        // makerAmount and takerAmount are wei strings
        const makerAmount = Number(BigInt(orderData.makerAmount || '0')) / 1e18;
        const takerAmount = Number(BigInt(orderData.takerAmount || '0')) / 1e18;
        // For BUY: price = makerAmount / takerAmount (USDT per share)
        // For SELL: price = takerAmount / makerAmount
        const price = side === 'BUY'
          ? (takerAmount > 0 ? makerAmount / takerAmount : 0)
          : (makerAmount > 0 ? takerAmount / makerAmount : 0);
        const amount = Number(BigInt(o.amount || '0')) / 1e18;
        const amountFilled = Number(BigInt(o.amountFilled || '0')) / 1e18;

        return {
          id: o.id || orderData.hash || '',
          platform: 'predictfun' as Platform,
          marketId: String(o.marketId || ''),
          outcomeIndex: 0,
          side,
          type: (o.strategy || 'LIMIT') as 'LIMIT' | 'MARKET',
          price,
          size: amount,
          filledSize: amountFilled,
          avgFillPrice: 0,
          status: this.mapPredictFunStatus(o.status),
          timestamp: new Date(),
          fees: 0,
          raw: o,
        };
      });
    } catch (err) {
      this.log.error('Failed to get open orders', { error: (err as Error).message });
      return [];
    }
  }

  async getOrder(orderId: string): Promise<OrderResult | null> {
    await this.ensureAuthenticated();

    try {
      // predict.fun GET /v1/orders?id=<orderId>
      const response = await this.httpGet<any>(
        `${this.apiUrl}/v1/orders?id=${encodeURIComponent(orderId)}`,
        this.getAuthHeaders(),
      );

      const orders = response?.data || [];
      const o = Array.isArray(orders) ? orders[0] : orders;
      if (!o) return null;

      const orderData = o.order || {};
      const side = orderData.side === 0 ? 'BUY' as const : 'SELL' as const;
      const makerAmount = Number(BigInt(orderData.makerAmount || '0')) / 1e18;
      const takerAmount = Number(BigInt(orderData.takerAmount || '0')) / 1e18;
      const price = side === 'BUY'
        ? (takerAmount > 0 ? makerAmount / takerAmount : 0)
        : (makerAmount > 0 ? takerAmount / makerAmount : 0);
      const amount = Number(BigInt(o.amount || '0')) / 1e18;
      const amountFilled = Number(BigInt(o.amountFilled || '0')) / 1e18;

      return {
        id: o.id || orderData.hash || orderId,
        platform: 'predictfun' as Platform,
        marketId: String(o.marketId || ''),
        outcomeIndex: 0,
        side,
        type: (o.strategy || 'LIMIT') as 'LIMIT' | 'MARKET',
        price,
        size: amount,
        filledSize: amountFilled,
        avgFillPrice: amountFilled > 0 ? price : 0,
        status: this.mapPredictFunStatus(o.status),
        timestamp: new Date(),
        fees: amountFilled > 0 ? PredictFunConnector.calculateTakerFee(price, amountFilled) : 0,
        raw: o,
      };
    } catch (err) {
      this.log.error('Failed to get order', { orderId, error: (err as Error).message });
      return null;
    }
  }

  async getPositions(): Promise<Position[]> {
    await this.ensureAuthenticated();

    try {
      const response = await this.httpGet<any>(
        `${this.apiUrl}/v1/positions?first=50`,
        this.getAuthHeaders(),
      );

      const positions = response?.edges?.map((e: any) => e.node) || response?.data || [];
      return positions.map((p: any) => ({
        platform: 'predictfun' as Platform,
        marketId: p.marketId || '',
        marketQuestion: p.title || '',
        outcomeIndex: p.outcome === 'YES' || p.outcomeIndex === 0 ? 0 : 1,
        side: (p.outcome === 'YES' ? 'YES' : 'NO') as 'YES' | 'NO',
        size: parseFloat(p.balance || '0') / 1e18,
        avgEntryPrice: parseFloat(p.avgPrice || '0'),
        currentPrice: parseFloat(p.currentPrice || '0'),
        unrealizedPnl: parseFloat(p.unrealizedPnL || '0') / 1e18,
      }));
    } catch (err) {
      this.log.error('Failed to get positions', { error: (err as Error).message });
      return [];
    }
  }

  async getBalance(): Promise<number> {
    try {
      const { JsonRpcProvider, Contract } = await import('ethers');
      const provider = new JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
      const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
      const usdt = new Contract(USDT_ADDRESS, [
        'function balanceOf(address) view returns (uint256)',
      ], provider);

      // Check balance of the Smart Wallet if configured,
      // otherwise fall back to the signer wallet address
      const { smartWallet } = config.predictfun;
      const balanceAddress = smartWallet || this.walletAddress || this.wallet?.address;

      if (!balanceAddress) {
        this.log.warn('predict.fun: no address available for balance check');
        return 0;
      }

      const balanceWei = await usdt.balanceOf(balanceAddress);
      // USDT on BNB has 18 decimals
      const balance = Number(balanceWei) / 1e18;
      this.log.debug('predict.fun balance fetched', { balance, address: balanceAddress });
      return balance;
    } catch (err) {
      this.log.error('Failed to get predict.fun balance', { error: (err as Error).message });
      return 0;
    }
  }

  // ─── Trading Helpers ────────────────────────────────────────────────────

  private mapPredictFunStatus(status: string): OrderResult['status'] {
    switch ((status || '').toUpperCase()) {
      case 'LIVE':
      case 'OPEN':
        return 'OPEN';
      case 'MATCHED':
      case 'FILLED':
        return 'FILLED';
      case 'CANCELLED':
      case 'CANCELED':
        return 'CANCELLED';
      case 'PENDING':
        return 'PENDING';
      case 'PARTIALLY_MATCHED':
        return 'PARTIALLY_FILLED';
      default:
        return 'PENDING';
    }
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
