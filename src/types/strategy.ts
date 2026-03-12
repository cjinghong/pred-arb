// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Strategy Interface
// Abstract interface for extensible trading strategies
// ═══════════════════════════════════════════════════════════════════════════

import { ArbitrageOpportunity, NormalizedMarket, OrderBook, Platform } from './market';
import { MarketConnector } from './connector';

/** Strategy lifecycle state */
export type StrategyState = 'IDLE' | 'SCANNING' | 'EXECUTING' | 'ERROR';

/**
 * Strategy — the contract every trading strategy must fulfill.
 *
 * Strategies are responsible for:
 *  1. Scanning markets for opportunities
 *  2. Evaluating and scoring opportunities
 *  3. Generating trade signals
 *
 * Strategies do NOT execute trades directly — they return opportunities
 * to the execution engine which handles risk checks and order placement.
 */
export interface Strategy {
  /** Unique identifier for this strategy */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Description of what this strategy does */
  readonly description: string;

  /** Current state */
  readonly state: StrategyState;

  /** Which platforms this strategy operates across */
  readonly platforms: Platform[];

  /** Configuration for this strategy */
  readonly config: StrategyConfig;

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /** Initialize the strategy with available connectors */
  initialize(connectors: Map<Platform, MarketConnector>): Promise<void>;

  /** Shut down the strategy */
  shutdown(): Promise<void>;

  // ─── Core Logic ──────────────────────────────────────────────────────

  /**
   * Scan for arbitrage opportunities.
   * Called periodically by the bot's main loop.
   * Returns an array of opportunities found in this scan.
   */
  scan(): Promise<ArbitrageOpportunity[]>;

  /**
   * Validate that an opportunity is still viable.
   * Called just before execution to confirm prices haven't moved.
   */
  validate(opportunity: ArbitrageOpportunity): Promise<boolean>;

  // ─── Metrics ─────────────────────────────────────────────────────────

  /** Get strategy-specific metrics */
  getMetrics(): StrategyMetrics;
}

export interface StrategyConfig {
  /** Whether this strategy is enabled */
  enabled: boolean;
  /** Minimum profit in basis points to trigger a trade */
  minProfitBps: number;
  /** Maximum position size in USD per trade */
  maxPositionUsd: number;
  /** Minimum match confidence to consider an opportunity */
  minMatchConfidence: number;
  /** Strategy-specific parameters */
  params: Record<string, unknown>;
}

export interface StrategyMetrics {
  strategyId: string;
  scansCompleted: number;
  opportunitiesFound: number;
  opportunitiesExecuted: number;
  totalProfitUsd: number;
  avgProfitPerTrade: number;
  winRate: number;
  lastScanDurationMs: number;
  lastScanAt: Date | null;
  marketsTracked: number;
}
