// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Risk Manager
// Pre-trade risk checks, position limits, and exposure tracking
// ═══════════════════════════════════════════════════════════════════════════

import { ArbitrageOpportunity, Platform, Position } from '../types';
import { MarketConnector } from '../types/connector';
import { config } from '../utils/config';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';

const log = createChildLogger('risk');

export interface RiskCheckResult {
  approved: boolean;
  reason: string;
  adjustedSize?: number;
}

export class RiskManager {
  private positions: Position[] = [];
  private connectors = new Map<Platform, MarketConnector>();

  /** Maximum total exposure across all platforms */
  private maxTotalExposure = config.bot.maxTotalExposureUsd;

  /** Maximum position size per trade */
  private maxPositionSize = config.bot.maxPositionUsd;

  /** Maximum number of concurrent open positions */
  private maxOpenPositions = 20;

  /** Minimum balance to keep as reserve (%) */
  private reserveRatio = 0.1;

  initialize(connectors: Map<Platform, MarketConnector>): void {
    this.connectors = connectors;
    log.info('Risk manager initialized', {
      maxExposure: this.maxTotalExposure,
      maxPosition: this.maxPositionSize,
    });
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

    // 4. Check available balance on both platforms
    try {
      const [balA, balB] = await Promise.all([
        this.connectors.get(opp.legA.platform)?.getBalance() ?? Promise.resolve(0),
        this.connectors.get(opp.legB.platform)?.getBalance() ?? Promise.resolve(0),
      ]);

      const costA = opp.legA.price * opp.maxSize;
      const costB = opp.legB.price * opp.maxSize;

      if (balA < costA * (1 + this.reserveRatio) || balB < costB * (1 + this.reserveRatio)) {
        const maxAffordableA = (balA * (1 - this.reserveRatio)) / opp.legA.price;
        const maxAffordableB = (balB * (1 - this.reserveRatio)) / opp.legB.price;
        const adjustedSize = Math.min(maxAffordableA, maxAffordableB);

        if (adjustedSize <= 0) {
          return { approved: false, reason: 'Insufficient balance on one or both platforms' };
        }
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
  }

  /** Get all tracked positions */
  getPositions(): Position[] {
    return [...this.positions];
  }
}
