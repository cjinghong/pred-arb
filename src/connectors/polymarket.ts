// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Polymarket Connector
// Connects to Polymarket's Gamma API (markets) and CLOB API (order books)
// Real trading via @polymarket/clob-client SDK
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
  ClobClient,
  Side as PolySide,
  OrderType as PolyOrderType,
  AssetType,
  SignatureType,
  type ApiKeyCreds,
  type OpenOrder,
  type ClobSigner,
} from '@polymarket/clob-client';

/**
 * Adapter: wraps ethers v6 Wallet to match the EthersSigner interface
 * expected by @polymarket/clob-client (which expects _signTypedData with underscore).
 */
function walletToClobSigner(wallet: Wallet): ClobSigner {
  return {
    _signTypedData: (domain: any, types: any, value: any) =>
      wallet.signTypedData(domain, types, value),
    getAddress: () => Promise.resolve(wallet.address),
  } as ClobSigner;
}

// ─── Raw Polymarket API Types ────────────────────────────────────────────

interface PolymarketRawMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  category?: string;
  outcomes: string;           // JSON string: '["Yes","No"]'
  outcomePrices: string;      // JSON string: '["0.324","0.676"]'
  clobTokenIds: string;       // JSON string: '["tokenId1","tokenId2"]'
  volume: number | string;
  liquidity: number | string;
  active: boolean;
  closed: boolean;
  endDate: string;
  updatedAt: string;
  // Extended fields from Gamma API
  startDate?: string;
  image?: string;
  icon?: string;
  description?: string;
  resolutionSource?: string;
  marketMakerAddress?: string;
  createdAt?: string;
  new?: boolean;
  featured?: boolean;
  submitted_by?: string;
  archived?: boolean;
  resolvedBy?: string;
  restricted?: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  questionID?: string;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  volumeNum?: number;
  liquidityNum?: number;
  endDateIso?: string;
  startDateIso?: string;
  hasReviewedDates?: boolean;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  umaBond?: string;
  umaReward?: string;
  volume24hrClob?: number;
  volume1wkClob?: number;
  volume1moClob?: number;
  volume1yrClob?: number;
  volumeClob?: number;
  liquidityClob?: number;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  events?: any[];
  ready?: boolean;
  funded?: boolean;
  acceptingOrdersTimestamp?: string;
  cyom?: boolean;
  competitive?: number;
  pagerDutyNotificationEnabled?: boolean;
  approved?: boolean;
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  spread?: number;
  oneDayPriceChange?: number;
  oneHourPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  automaticallyActive?: boolean;
  clearBookOnStart?: boolean;
  manualActivation?: boolean;
  negRiskOther?: boolean;
  umaResolutionStatuses?: string;
  pendingDeployment?: boolean;
  deploying?: boolean;
  rfqEnabled?: boolean;
  holdingRewardsEnabled?: boolean;
  feesEnabled?: boolean;
  requiresTranslation?: boolean;
  feeType?: string | null;
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

  /** CLOB client for authenticated trading operations */
  private clobClient: ClobClient | null = null;
  /** Wallet address derived from private key */
  private walletAddress: string | null = null;

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

      // Initialize CLOB client for trading if credentials are available
      await this.initClobClient();

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

  /** Initialize the CLOB client for authenticated trading */
  private async initClobClient(): Promise<void> {
    const { privateKey, apiKey, apiSecret, apiPassphrase, proxyAddress } = config.polymarket;

    if (!privateKey) {
      this.log.warn('POLYMARKET_PRIVATE_KEY not set — trading disabled');
      return;
    }

    try {
      // Ensure private key has 0x prefix (ethers v6 requires it)
      const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const wallet = new Wallet(formattedKey);
      this.walletAddress = wallet.address;
      const signer = walletToClobSigner(wallet);

      // Determine signature type and funder address
      // POLY_GNOSIS_SAFE (2) = browser wallet (MetaMask, Rabby) or embedded wallet (Privy, Turnkey)
      // POLY_PROXY (1) = Magic Link (email/Google login) with exported private key
      // EOA (0) = standalone wallet, no proxy
      const sigType = proxyAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
      const funder = proxyAddress || undefined;

      if (proxyAddress) {
        this.log.info('Using Polymarket proxy wallet (Gnosis Safe)', {
          eoa: this.walletAddress,
          proxy: proxyAddress,
          signatureType: 'POLY_GNOSIS_SAFE',
        });
      }

      // If API credentials are provided, use L2 auth (faster, no signature per request)
      if (apiKey && apiSecret && apiPassphrase) {
        const creds: ApiKeyCreds = {
          key: apiKey,
          secret: apiSecret,
          passphrase: apiPassphrase,
        };
        this.clobClient = new ClobClient(
          this.clobUrl,
          137,  // Polygon mainnet
          signer,
          creds,
          sigType,
          funder,
        );
        this.log.info('Polymarket CLOB client initialized with L2 auth (API key)', {
          address: this.walletAddress,
          funderAddress: funder || 'EOA (self)',
        });
      } else {
        // L1 auth only — derive API credentials automatically
        this.clobClient = new ClobClient(
          this.clobUrl,
          137,
          signer,
          undefined,  // no creds yet
          sigType,
          funder,
        );
        // Derive or create API keys
        const creds = await this.clobClient.createOrDeriveApiKey();

        // Reinitialize with L2 creds for faster subsequent requests
        this.clobClient = new ClobClient(
          this.clobUrl,
          137,
          signer,
          creds,
          sigType,
          funder,
        );
        this.log.info('Polymarket CLOB client initialized with derived API key', {
          address: this.walletAddress,
          funderAddress: funder || 'EOA (self)',
          apiKey: creds.key,
        });
      }
    } catch (err) {
      this.log.error('Failed to initialize CLOB client — trading disabled', {
        error: (err as Error).message,
      });
      this.clobClient = null;
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

  // ─── Trading (requires CLOB client) ────────────────────────────────────

  private ensureClobClient(): ClobClient {
    if (!this.clobClient) {
      throw new Error('Polymarket: CLOB client not initialized — set POLYMARKET_PRIVATE_KEY');
    }
    return this.clobClient;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const client = this.ensureClobClient();

    const market = await this.getOrFetchMarket(order.marketId);
    if (!market) throw new Error(`Market ${order.marketId} not found`);

    const tokenId = market.outcomeTokenIds[order.outcomeIndex];
    if (!tokenId) throw new Error(`No token for outcome index ${order.outcomeIndex}`);

    const side = order.side === 'BUY' ? PolySide.BUY : PolySide.SELL;

    this.log.info('Placing order on Polymarket', {
      marketId: order.marketId,
      tokenId,
      side: order.side,
      price: order.price,
      size: order.size,
    });

    try {
      // Use the SDK to create, sign, and post the order in one call
      // Polymarket has NO fees per user confirmation
      let response: any;
      if (order.type === 'MARKET') {
        // Market orders use FOK (Fill or Kill)
        response = await client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            price: order.price,
            amount: order.side === 'BUY' ? order.size * order.price : order.size,
            side,
            feeRateBps: 0,
          },
          undefined,
          PolyOrderType.FOK,
        );
      } else {
        // Limit orders use GTC (Good Till Cancelled)
        response = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: order.price,
            size: order.size,
            side,
            feeRateBps: 0,
          },
          undefined,
          PolyOrderType.GTC,
        );
      }

      // Check for error response (API returns { error: string, status: number })
      if (response?.error) {
        throw new Error(response.error);
      }

      const orderId = response?.orderID || response?.id || `poly_${Date.now()}`;
      const rawStatus = typeof response?.status === 'string' ? response.status : '';
      const status = rawStatus.toUpperCase() || 'PENDING';

      this.log.info('Order placed on Polymarket', {
        orderId,
        status,
        raw: response,
      });

      return {
        id: orderId,
        platform: 'polymarket',
        marketId: order.marketId,
        outcomeIndex: order.outcomeIndex,
        side: order.side,
        type: order.type,
        price: order.price,
        size: order.size,
        filledSize: status === 'MATCHED' || status === 'FILLED' ? order.size : 0,
        avgFillPrice: status === 'MATCHED' || status === 'FILLED' ? order.price : 0,
        status: this.mapPolyStatus(status),
        timestamp: new Date(),
        fees: 0, // Polymarket has no fees
        raw: response,
      };
    } catch (err) {
      this.log.error('Failed to place order on Polymarket', {
        error: (err as Error).message,
        order,
      });
      return {
        id: `poly_failed_${Date.now()}`,
        platform: 'polymarket',
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
    const client = this.ensureClobClient();
    this.log.info('Cancelling order on Polymarket', { orderId });

    try {
      await client.cancelOrder({ orderID: orderId });
      this.log.info('Order cancelled on Polymarket', { orderId });
      return true;
    } catch (err) {
      this.log.error('Failed to cancel order on Polymarket', {
        orderId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  async cancelAllOrders(): Promise<boolean> {
    const client = this.ensureClobClient();
    try {
      await client.cancelAll();
      this.log.info('All orders cancelled on Polymarket');
      return true;
    } catch (err) {
      this.log.error('Failed to cancel all orders', { error: (err as Error).message });
      return false;
    }
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    const client = this.ensureClobClient();

    try {
      const response = await client.getOpenOrders();
      const orders: OpenOrder[] = Array.isArray(response) ? response : (response as any)?.data || [];

      return orders.map((o: OpenOrder) => this.mapOpenOrderToResult(o));
    } catch (err) {
      this.log.error('Failed to get open orders', { error: (err as Error).message });
      return [];
    }
  }

  async getPositions(): Promise<Position[]> {
    // Polymarket doesn't have a direct positions endpoint in the CLOB client.
    // We can derive positions from balance allowance or trade history.
    // For now, return empty — positions are tracked in-memory by RiskManager.
    this.log.debug('getPositions: using RiskManager in-memory tracking');
    return [];
  }

  async getBalance(): Promise<number> {
    const client = this.ensureClobClient();

    try {
      // Get USDC (collateral) balance via the CLOB client
      const balanceResponse = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      const balanceStr = balanceResponse?.balance || '0';
      // CLOB API returns USDC balance in micro-units (6 decimals)
      const balance = parseFloat(balanceStr) / 1e6;
      this.log.debug('Polymarket balance fetched', { balance, raw: balanceStr });
      return balance;
    } catch (err) {
      this.log.error('Failed to get Polymarket balance', { error: (err as Error).message });
      return 0;
    }
  }

  /** Get order details by ID */
  async getOrder(orderId: string): Promise<OrderResult | null> {
    const client = this.ensureClobClient();
    try {
      const order = await client.getOrder(orderId);
      if (!order) return null;
      return this.mapOpenOrderToResult(order);
    } catch (err) {
      this.log.error('Failed to get order', { orderId, error: (err as Error).message });
      return null;
    }
  }

  // ─── Trading Helpers ────────────────────────────────────────────────────

  private mapPolyStatus(status: string): OrderResult['status'] {
    switch (status.toUpperCase()) {
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
      default:
        return 'PENDING';
    }
  }

  private mapOpenOrderToResult(o: OpenOrder): OrderResult {
    const originalSize = parseFloat(o.original_size || '0');
    const sizeMatched = parseFloat(o.size_matched || '0');
    const price = parseFloat(o.price || '0');

    let status: OrderResult['status'] = 'OPEN';
    if (o.status === 'MATCHED' || o.status === 'FILLED') status = 'FILLED';
    else if (o.status === 'CANCELLED' || o.status === 'CANCELED') status = 'CANCELLED';
    else if (sizeMatched >= originalSize && originalSize > 0) status = 'FILLED';
    else if (sizeMatched > 0) status = 'PARTIALLY_FILLED';

    return {
      id: o.id,
      platform: 'polymarket',
      marketId: o.market || '',
      outcomeIndex: 0, // Would need token→outcome mapping
      side: o.side === 'BUY' ? 'BUY' : 'SELL',
      type: o.order_type === 'FOK' ? 'MARKET' : 'LIMIT',
      price,
      size: originalSize,
      filledSize: sizeMatched,
      avgFillPrice: sizeMatched > 0 ? price : 0, // Approximate
      status,
      timestamp: new Date(o.created_at * 1000),
      fees: 0, // Polymarket has no fees
      raw: o,
    };
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
      volume: Number(raw.volumeNum ?? raw.volume) || 0,
      liquidity: Number(raw.liquidityNum ?? raw.liquidity) || 0,
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
