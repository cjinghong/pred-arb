// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Connector Interface
// Abstract interface that all platform connectors must implement
// ═══════════════════════════════════════════════════════════════════════════

import {
  NormalizedMarket,
  OrderBook,
  OrderRequest,
  OrderResult,
  Platform,
  Position,
} from './market';

/** Event types emitted by connectors */
export type ConnectorEvent =
  | 'connected'
  | 'disconnected'
  | 'market_update'
  | 'orderbook_update'
  | 'order_update'
  | 'error';

export type ConnectorEventHandler = (event: ConnectorEvent, data: unknown) => void;

/**
 * MarketConnector — the contract every platform connector must fulfill.
 *
 * Connectors are responsible for:
 *  1. Fetching and normalizing market data
 *  2. Fetching and normalizing order books
 *  3. Placing and managing orders
 *  4. Streaming real-time updates via WebSocket
 */
export interface MarketConnector {
  /** Which platform this connector serves */
  readonly platform: Platform;

  /** Human-readable name */
  readonly name: string;

  /** Whether the connector is currently connected and healthy */
  readonly isConnected: boolean;

  /** Whether the WebSocket is connected and streaming */
  readonly isWsConnected: boolean;

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /** Initialize the connector (auth, websockets, etc.) */
  connect(): Promise<void>;

  /** Gracefully shut down */
  disconnect(): Promise<void>;

  // ─── Market Data ─────────────────────────────────────────────────────

  /** Fetch all active markets (paginated internally) */
  fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]>;

  /** Fetch a single market by ID */
  fetchMarket(marketId: string): Promise<NormalizedMarket | null>;

  /** Fetch the order book for a specific outcome token.
   *  Prefers the live WebSocket cache; falls back to REST if stale. */
  fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook>;

  // ─── WebSocket Streaming ───────────────────────────────────────────

  /** Subscribe to real-time order book updates for the given markets */
  subscribeOrderBooks(markets: NormalizedMarket[]): void;

  /** Unsubscribe from real-time updates */
  unsubscribeOrderBooks(marketIds: string[]): void;

  // ─── Trading ─────────────────────────────────────────────────────────

  /** Place an order */
  placeOrder(order: OrderRequest): Promise<OrderResult>;

  /** Cancel an order */
  cancelOrder(orderId: string): Promise<boolean>;

  /** Get current open orders */
  getOpenOrders(): Promise<OrderResult[]>;

  /** Get a single order by ID (for fill monitoring) */
  getOrder(orderId: string): Promise<OrderResult | null>;

  /** Get current positions */
  getPositions(): Promise<Position[]>;

  /** Get account balance in USD */
  getBalance(): Promise<number>;

  // ─── Events ──────────────────────────────────────────────────────────

  /** Register event handler */
  on(event: ConnectorEvent, handler: ConnectorEventHandler): void;

  /** Remove event handler */
  off(event: ConnectorEvent, handler: ConnectorEventHandler): void;
}

export interface FetchMarketsOptions {
  /** Filter by category */
  category?: string;
  /** Only active markets */
  activeOnly?: boolean;
  /** Maximum number of markets */
  limit?: number;
  /** Pagination offset / cursor */
  offset?: number | string;
  /** Minimum liquidity in USD (server-side on Polymarket, client-side on predict.fun) */
  minLiquidity?: number;
  /** Minimum volume in USD (server-side on Polymarket, client-side on predict.fun) */
  minVolume?: number;
  /** Sort field (server-side on Polymarket) */
  sortBy?: 'liquidity' | 'volume' | 'updatedAt';
  /** Sort direction */
  sortDirection?: 'asc' | 'desc';
}
