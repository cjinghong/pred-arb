// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Core Market Types
// Normalized data structures for cross-platform prediction market arbitrage
// ═══════════════════════════════════════════════════════════════════════════

/** Supported prediction market platforms */
export type Platform = 'polymarket' | 'predictfun';

/** Outcome side in a binary market */
export type OutcomeSide = 'YES' | 'NO';

/** Order side */
export type OrderSide = 'BUY' | 'SELL';

/** Order type */
export type OrderType = 'LIMIT' | 'MARKET';

/** Order status */
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'FAILED';

/** Trade status */
export type TradeStatus = 'PENDING' | 'EXECUTED' | 'FAILED' | 'EXPIRED';

/** Bot operational state */
export type BotState = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';

// ─── Normalized Market ───────────────────────────────────────────────────

export interface NormalizedMarket {
  /** Unique ID within the platform */
  id: string;
  /** Platform this market belongs to */
  platform: Platform;
  /** Human-readable question / title */
  question: string;
  /** URL slug or identifier */
  slug: string;
  /** Parent event slug (Polymarket only — for building /event/{eventSlug}/{slug} URLs) */
  eventSlug?: string;
  /** Category / tag */
  category: string;
  /** Outcome labels (usually ["Yes", "No"]) */
  outcomes: string[];
  /** Token IDs for each outcome (platform-specific) */
  outcomeTokenIds: string[];
  /** Current mid prices for each outcome [0..1] */
  outcomePrices: number[];
  /** Total volume traded (USD) */
  volume: number;
  /** Current liquidity (USD) */
  liquidity: number;
  /** Whether the market is actively trading */
  active: boolean;
  /** Market end / resolution date */
  endDate: Date | null;
  /** When this snapshot was taken */
  lastUpdated: Date;
  /** Platform-specific raw data */
  raw?: unknown;
}

// ─── Order Book ──────────────────────────────────────────────────────────

export interface PriceLevel {
  /** Price per share [0..1] */
  price: number;
  /** Size in shares */
  size: number;
}

export interface OrderBook {
  /** Platform this order book belongs to */
  platform: Platform;
  /** Market ID on that platform */
  marketId: string;
  /** Which outcome token this book is for */
  outcomeIndex: number;
  /** Bid side (sorted best first — highest price) */
  bids: PriceLevel[];
  /** Ask side (sorted best first — lowest price) */
  asks: PriceLevel[];
  /** Minimum order size */
  minOrderSize: number;
  /** Tick size (minimum price increment) */
  tickSize: number;
  /** Best bid price */
  bestBid: number | null;
  /** Best ask price */
  bestAsk: number | null;
  /** Mid price */
  midPrice: number | null;
  /** Spread in absolute terms */
  spread: number | null;
  /** Timestamp */
  timestamp: Date;
}

// ─── Orders & Trades ─────────────────────────────────────────────────────

export interface OrderRequest {
  platform: Platform;
  marketId: string;
  outcomeIndex: number;
  side: OrderSide;
  type: OrderType;
  price: number;
  size: number;
}

export interface OrderResult {
  id: string;
  platform: Platform;
  marketId: string;
  outcomeIndex: number;
  side: OrderSide;
  type: OrderType;
  price: number;
  size: number;
  filledSize: number;
  avgFillPrice: number;
  status: OrderStatus;
  timestamp: Date;
  fees: number;
  raw?: unknown;
}

// ─── Arbitrage Opportunity ───────────────────────────────────────────────

export interface ArbitrageOpportunity {
  /** Unique ID for this opportunity */
  id: string;
  /** Strategy that discovered this */
  strategyId: string;
  /** Timestamp when discovered */
  discoveredAt: Date;
  /** Leg A: the "buy" side */
  legA: ArbLeg;
  /** Leg B: the "sell" / opposite side */
  legB: ArbLeg;
  /** Expected profit in USD */
  expectedProfitUsd: number;
  /** Expected profit in basis points */
  expectedProfitBps: number;
  /** Maximum executable size (limited by thinnest book side) */
  maxSize: number;
  /** Confidence score [0..1] based on market similarity */
  matchConfidence: number;
  /** Whether this opportunity has been acted on */
  executed: boolean;
}

export interface ArbLeg {
  platform: Platform;
  marketId: string;
  marketQuestion: string;
  outcome: OutcomeSide;
  outcomeIndex: number;
  /** Price we would pay / receive */
  price: number;
  /** Available depth at that price */
  availableSize: number;
  /** The full order book snapshot */
  orderBook: OrderBook;
}

// ─── Trade Record ────────────────────────────────────────────────────────

export interface TradeRecord {
  id: string;
  opportunityId: string;
  strategyId: string;
  status: TradeStatus;
  legA: OrderResult | null;
  legB: OrderResult | null;
  totalCostUsd: number;
  expectedProfitUsd: number;
  realizedProfitUsd: number | null;
  fees: number;
  createdAt: Date;
  executedAt: Date | null;
  settledAt: Date | null;
  notes: string;
}

// ─── Portfolio & Risk ────────────────────────────────────────────────────

export interface Position {
  platform: Platform;
  marketId: string;
  marketQuestion: string;
  outcomeIndex: number;
  side: OutcomeSide;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
}

export interface PortfolioSnapshot {
  timestamp: Date;
  positions: Position[];
  totalExposureUsd: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  availableBalanceUsd: number;
}

// ─── Dashboard / API ─────────────────────────────────────────────────────

export interface BotStatus {
  state: BotState;
  uptime: number;
  lastScanAt: Date | null;
  activePlatforms: Platform[];
  activeStrategies: string[];
  totalMarketsTracked: number;
  totalOpportunitiesFound: number;
  totalTradesExecuted: number;
  portfolio: PortfolioSnapshot;
}

export interface DashboardMetrics {
  /** Rolling 24h P&L */
  pnl24h: number;
  /** Rolling 7d P&L */
  pnl7d: number;
  /** All-time P&L */
  pnlAllTime: number;
  /** Win rate percentage */
  winRate: number;
  /** Total number of trades */
  totalTrades: number;
  /** Average profit per trade */
  avgProfitPerTrade: number;
  /** Sharpe ratio approximation */
  sharpeRatio: number;
  /** Current exposure */
  currentExposure: number;
  /** Max drawdown */
  maxDrawdown: number;
}
