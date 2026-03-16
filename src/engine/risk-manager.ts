// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Risk Manager
// Pre-trade risk checks, position limits, exposure tracking, and
// periodic balance caching to avoid rate-limiting platform APIs.
// ═══════════════════════════════════════════════════════════════════════════

import { ArbitrageOpportunity, Platform, Position } from '../types';
import { MarketConnector } from '../types/connector';
import { config } from '../utils/config';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';
import { rateLimit } from '../utils/rate-limiter';

const log = createChildLogger('risk');

/** How often to refresh balance caches (ms) */
const BALANCE_CACHE_TTL_MS = 30_000; // 30 seconds

export interface RiskCheckResult {
  approved: boolean;
  reason: string;
  adjustedSize?: number;
}

interface CachedBalance {
  balance: number;
  fetchedAt: number;
}

export class RiskManager {
  private positions: Position[] = [];
  private connectors = new Map<Platform, MarketConnector>();

  /** Cached balances per platform to avoid hammering APIs */
  private balanceCache = new Map<Platform, CachedBalance>();

  /** Maximum total exposure across all platforms */
  private maxTotalExposure = config.bot.maxTotalExposureUsd;

  /** Maximum position size per trade */
  private maxPositionSize = config.bot.maxPositionUsd;

  /** Maximum number of concurrent open positions */
  private maxOpenPositions = 20;

  /** Minimum balance to keep as reserve (%) */
  private reserveRatio = 0.1;

  /** Update max total exposure at runtime */
  setMaxTotalExposure(value: number): void {
    this.maxTotalExposure = value;
    log.info('maxTotalExposure updated at runtime', { maxTotalExposure: value });
  }

  /** Update max position size at runtime */
  setMaxPositionSize(value: number): void {
    this.maxPositionSize = value;
    log.info('maxPositionSize updated at runtime', { maxPositionSize: value });
  }

  /** Get current limits for dashboard display */
  getLimits(): { maxTotalExposure: number; maxPositionSize: number } {
    return { maxTotalExposure: this.maxTotalExposure, maxPositionSize: this.maxPositionSize };
  }

  initialize(connectors: Map<Platform, MarketConnector>): void {
    this.connectors = connectors;
    log.info('Risk manager initialized', {
      maxExposure: this.maxTotalExposure,
      maxPosition: this.maxPositionSize,
      maxOpenPositions: this.maxOpenPositions,
      reserveRatio: this.reserveRatio,
    });

    // Prime the balance cache
    this.refreshBalances().catch(err =>
      log.warn('Initial balance fetch failed', { error: err.message })
    );
  }

  /**
   * Pre-trade risk check.
   * Returns whether the trade should proceed and at what size.
   */
  async checkOpportunity(opp: ArbitrageOpportunity): Promise<RiskCheckResult> {
    // 1. Check if we're at max positions
    if (this.positions.length >= this.maxOpenPositions) {
      log.warn('Max open positions reached', { current: this.positions.length });
      eventBus.emit('risk:limit_breach', {
        type: 'max_positions',
        current: this.positions.length,
        limit: this.maxOpenPositions,
      });
      return { approved: false, reason: 'Maximum open positions reached' };
    }

    // 2. Check total exposure
    const currentExposure = this.getCurrentExposure();
    const tradeCost = (opp.legA.price + opp.legB.price) * opp.maxSize;

    if (currentExposure + tradeCost > this.maxTotalExposure) {
      const availableExposure = this.maxTotalExposure - currentExposure;
      if (availableExposure <= 0) {
        eventBus.emit('risk:limit_breach', {
          type: 'max_exposure',
          current: currentExposure,
          limit: this.maxTotalExposure,
        });
        return { approved: false, reason: 'Maximum total exposure reached' };
      }
      // Reduce size to fit within limits
      const adjustedSize = availableExposure / (opp.legA.price + opp.legB.price);
      log.info('Position size adjusted for exposure limit', {
        original: opp.maxSize,
        adjusted: adjustedSize,
      });
      return { approved: true, reason: 'Size adjusted for exposure limit', adjustedSize };
    }

    // 3. Check per-trade size limit
    if (tradeCost > this.maxPositionSize) {
      const adjustedSize = this.maxPositionSize / (opp.legA.price + opp.legB.price);
      return { approved: true, reason: 'Size adjusted for position limit', adjustedSize };
    }

    // 4. Check available balance on both platforms (using cached values)
    try {
      const [balA, balB] = await Promise.all([
        this.getCachedBalance(opp.legA.platform),
        this.getCachedBalance(opp.legB.platform),
      ]);

      const costA = opp.legA.price * opp.maxSize;
      const costB = opp.legB.price * opp.maxSize;

      if (balA < costA * (1 + this.reserveRatio) || balB < costB * (1 + this.reserveRatio)) {
        const maxAffordableA = (balA * (1 - this.reserveRatio)) / opp.legA.price;
        const maxAffordableB = (balB * (1 - this.reserveRatio)) / opp.legB.price;
        const adjustedSize = Math.min(maxAffordableA, maxAffordableB);

        if (adjustedSize <= 0) {
          return {
            approved: false,
            reason: `Insufficient balance. ${opp.legA.platform}: $${balA.toFixed(2)}, ${opp.legB.platform}: $${balB.toFixed(2)}`,
          };
        }

        log.info('Position size adjusted for available balance', {
          original: opp.maxSize,
          adjusted: adjustedSize,
          balA,
          balB,
        });
        return { approved: true, reason: 'Size adjusted for available balance', adjustedSize };
      }
    } catch (err) {
      log.warn('Balance check failed, proceeding with caution', {
        error: (err as Error).message,
      });
    }

    // 5. Check match confidence
    if (opp.matchConfidence < 0.6) {
      return { approved: false, reason: `Match confidence too low: ${opp.matchConfidence}` };
    }

    return { approved: true, reason: 'All risk checks passed' };
  }

  // ─── Balance Caching ────────────────────────────────────────────────────

  /**
   * Get the cached balance for a platform, refreshing if stale.
   */
  private async getCachedBalance(platform: Platform): Promise<number> {
    const cached = this.balanceCache.get(platform);
    if (cached && Date.now() - cached.fetchedAt < BALANCE_CACHE_TTL_MS) {
      return cached.balance;
    }

    // Cache miss or stale — fetch fresh
    const conn = this.connectors.get(platform);
    if (!conn) return 0;

    try {
      await rateLimit(platform);
      const balance = await conn.getBalance();
      this.balanceCache.set(platform, { balance, fetchedAt: Date.now() });
      return balance;
    } catch (err) {
      log.warn('Failed to refresh balance', { platform, error: (err as Error).message });
      // Return stale cache if available, else 0
      return cached?.balance ?? 0;
    }
  }

  /**
   * Refresh all platform balances. Called periodically by the bot.
   */
  async refreshBalances(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.connectors.entries()).map(async ([platform, conn]) => {
        await rateLimit(platform);
        const balance = await conn.getBalance();
        this.balanceCache.set(platform, { balance, fetchedAt: Date.now() });
        return { platform, balance };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        log.info('Balance cached', result.value);
      } else {
        log.warn('Balance refresh failed', { error: result.reason });
      }
    }
  }

  /**
   * Invalidate balance cache for a platform (e.g., after a trade executes).
   */
  invalidateBalance(platform: Platform): void {
    this.balanceCache.delete(platform);
  }

  // ─── Exposure & Positions ───────────────────────────────────────────────

  /** Get current total exposure across all positions */
  getCurrentExposure(): number {
    return this.positions.reduce(
      (sum, p) => sum + p.size * p.avgEntryPrice,
      0,
    );
  }

  /** Update internal position tracking */
  updatePositions(positions: Position[]): void {
    this.positions = positions;
  }

  /** Add a new position after trade execution */
  addPosition(position: Position): void {
    this.positions.push(position);
    // Invalidate the balance cache for this platform since funds were used
    this.invalidateBalance(position.platform);
    log.info('Position added', {
      platform: position.platform,
      market: position.marketQuestion.slice(0, 50),
      side: position.side,
      size: position.size,
      price: position.avgEntryPrice,
    });
  }

  /** Get all tracked positions */
  getPositions(): Position[] {
    return [...this.positions];
  }

  /** Get cached balances (for dashboard display) */
  getBalances(): Record<Platform, number> {
    const result: Partial<Record<Platform, number>> = {};
    for (const [platform, cached] of this.balanceCache) {
      result[platform] = cached.balance;
    }
    return result as Record<Platform, number>;
  }
}
