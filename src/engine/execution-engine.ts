// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Execution Engine
// Validates opportunities, runs risk checks, executes trades, and handles
// failed-leg recovery to prevent unhedged directional exposure.
//
// Live trading flow:
//   opportunity:found → submit() → validate → risk check → place leg A →
//   place leg B → monitor fills → finalize (update positions + P&L)
//
// If a leg fails after the other has filled, the recovery system kicks in:
//   1. RETRY the failed leg (arb may still exist)
//   2. UNWIND the filled leg (sell back to flatten)
//   3. ACCEPT the loss (flag for manual review)
// ═══════════════════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import {
  ArbitrageOpportunity,
  Platform,
  Position,
  TradeRecord,
  OrderRequest,
  OrderResult,
} from '../types';
import { MarketConnector } from '../types/connector';
import { Strategy } from '../types/strategy';
import { RiskManager } from './risk-manager';
import { insertOpportunity, insertTrade, updateTradeStatus, markOpportunityExecuted, updateOpportunityStatus } from '../db/database';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';
import { rateLimit } from '../utils/rate-limiter';

const log = createChildLogger('execution');

// ─── Tuning Constants ────────────────────────────────────────────────────

/** Maximum time to wait for a fill confirmation (ms) */
const FILL_TIMEOUT_MS = 30_000;
/** Polling interval for fill checks (ms) */
const FILL_POLL_INTERVAL_MS = 1_500;
/** Maximum attempts to unwind a stuck leg */
const MAX_UNWIND_ATTEMPTS = 3;
/** How long to wait between unwind retries */
const UNWIND_RETRY_DELAY_MS = 2_000;
/** Max time between discovering an opportunity and starting execution (ms) — stale filter */
const MAX_OPP_AGE_MS = 10_000;

// ─── Failed-Leg Recovery Types ────────────────────────────────────────────

interface FailedLegContext {
  tradeId: string;
  /** The leg that succeeded (filled or partially filled) */
  filledLeg: OrderResult;
  /** The leg that failed */
  failedLeg: OrderResult;
  /** Which platform has the filled position */
  filledPlatform: Platform;
  /** Original opportunity */
  opportunity: ArbitrageOpportunity;
}

type RecoveryAction =
  | { type: 'CANCEL_AND_UNWIND'; reason: string }
  | { type: 'RETRY_FAILED_LEG'; reason: string }
  | { type: 'ACCEPT_LOSS'; reason: string };

// ─── Execution Engine ─────────────────────────────────────────────────────

export class ExecutionEngine {
  private connectors = new Map<Platform, MarketConnector>();
  private strategies = new Map<string, Strategy>();
  private riskManager: RiskManager;
  private dryRun: boolean;

  /** Queue of pending opportunities */
  private queue: ArbitrageOpportunity[] = [];
  private processing = false;

  /** Track active recovery operations to prevent double-recovery */
  private activeRecoveries = new Set<string>();

  /** Track opportunities currently being executed to prevent double-execution */
  private executingOpps = new Set<string>();

  constructor(riskManager: RiskManager, dryRun = true) {
    this.riskManager = riskManager;
    this.dryRun = dryRun;

    if (this.dryRun) {
      log.warn('████ EXECUTION ENGINE IN DRY-RUN MODE — NO REAL TRADES ████');
    }
  }

  initialize(
    connectors: Map<Platform, MarketConnector>,
    strategies: Map<string, Strategy>,
  ): void {
    this.connectors = connectors;
    this.strategies = strategies;
    log.info('Execution engine initialized', {
      dryRun: this.dryRun,
      platforms: Array.from(connectors.keys()),
      strategies: Array.from(strategies.keys()),
    });
  }

  /**
   * Submit an opportunity for execution.
   * The opportunity goes through validation → risk check → execution pipeline.
   */
  async submit(opportunity: ArbitrageOpportunity): Promise<void> {
    // Dedup: don't execute the same opportunity twice
    if (this.executingOpps.has(opportunity.id)) {
      log.debug('Opportunity already executing, skipping', { id: opportunity.id.slice(0, 8) });
      return;
    }

    // Stale check: reject opportunities that are too old
    const ageMs = Date.now() - opportunity.discoveredAt.getTime();
    if (ageMs > MAX_OPP_AGE_MS) {
      log.info('Opportunity too old, skipping', { id: opportunity.id.slice(0, 8), ageMs });
      return;
    }

    // Persist the opportunity
    insertOpportunity(opportunity);

    this.queue.push(opportunity);
    log.info('Opportunity queued', {
      id: opportunity.id.slice(0, 8),
      profitBps: opportunity.expectedProfitBps.toFixed(0),
      platforms: `${opportunity.legA.platform} ↔ ${opportunity.legB.platform}`,
    });

    // Process queue if not already processing
    if (!this.processing) {
      await this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const opp = this.queue.shift()!;

      try {
        this.executingOpps.add(opp.id);
        await this.executeOpportunity(opp);
      } catch (err) {
        log.error('Failed to execute opportunity', {
          id: opp.id.slice(0, 8),
          error: (err as Error).message,
        });
        updateOpportunityStatus(opp.id, 'failed', (err as Error).message);
      } finally {
        this.executingOpps.delete(opp.id);
      }
    }

    this.processing = false;
  }

  private async executeOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    const tradeId = uuid();

    // Step 1: Re-validate with the strategy (re-fetches books to confirm arb still exists)
    const strategy = this.strategies.get(opp.strategyId);
    if (strategy) {
      const stillValid = await strategy.validate(opp);
      if (!stillValid) {
        log.info('Opportunity no longer valid after re-check', { id: opp.id.slice(0, 8) });
        updateOpportunityStatus(opp.id, 'expired', 'No longer profitable at current prices');
        return;
      }
    }

    // Step 2: Risk check (balance, exposure, position limits)
    updateOpportunityStatus(opp.id, 'executing');
    const riskResult = await this.riskManager.checkOpportunity(opp);
    if (!riskResult.approved) {
      log.info('Opportunity rejected by risk manager', {
        id: opp.id.slice(0, 8),
        reason: riskResult.reason,
      });
      updateOpportunityStatus(opp.id, 'rejected', riskResult.reason || 'Risk check failed');
      return;
    }

    const size = riskResult.adjustedSize ?? opp.maxSize;

    // Step 3: Create trade record
    const trade: TradeRecord = {
      id: tradeId,
      opportunityId: opp.id,
      strategyId: opp.strategyId,
      status: 'PENDING',
      legA: null,
      legB: null,
      totalCostUsd: (opp.legA.price + opp.legB.price) * size,
      expectedProfitUsd: opp.expectedProfitUsd * (size / opp.maxSize),
      realizedProfitUsd: null,
      fees: 0,
      createdAt: new Date(),
      executedAt: null,
      settledAt: null,
      notes: this.dryRun ? 'DRY RUN' : '',
    };

    insertTrade(trade);
    eventBus.emit('trade:pending', trade);

    if (this.dryRun) {
      log.info('DRY RUN — would execute:', {
        legA: `${opp.legA.outcome} on ${opp.legA.platform} @ ${opp.legA.price.toFixed(3)}`,
        legB: `${opp.legB.outcome} on ${opp.legB.platform} @ ${opp.legB.price.toFixed(3)}`,
        size: size.toFixed(1),
        expectedProfit: `$${trade.expectedProfitUsd.toFixed(2)}`,
      });

      updateTradeStatus(tradeId, 'EXECUTED', {
        realizedProfitUsd: trade.expectedProfitUsd,
        notes: 'DRY RUN — simulated execution',
      });
      markOpportunityExecuted(opp.id);

      trade.status = 'EXECUTED';
      eventBus.emit('trade:executed', trade);
      return;
    }

    // Step 4: Execute both legs with sequential strategy
    // ── WHY SEQUENTIAL? ──
    // Placing both legs concurrently with Promise.all is faster but creates a
    // dangerous race: if one leg fills and the other rejects instantly, the
    // rejection fires before we can cancel. Sequential placement lets us
    // abort before placing leg B if leg A fails outright.
    // However, if leg A places successfully and leg B fails, we need recovery.
    //
    // ── SMART LEG ORDERING ──
    // We place the LESS LIQUID leg first. If it fails, we have zero exposure
    // (safe abort). If the more-liquid leg fails after the thinner one fills,
    // recovery/unwind is easier on the deeper book.
    await this.executeLiveArbitrage(opp, trade, size);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LIVE EXECUTION — Sequential Leg Placement with Recovery
  // ═══════════════════════════════════════════════════════════════════════

  private async executeLiveArbitrage(
    opp: ArbitrageOpportunity,
    trade: TradeRecord,
    size: number,
  ): Promise<void> {
    const connA = this.connectors.get(opp.legA.platform);
    const connB = this.connectors.get(opp.legB.platform);
    if (!connA || !connB) {
      updateTradeStatus(trade.id, 'FAILED', { notes: 'Missing connector' });
      updateOpportunityStatus(opp.id, 'failed', 'Missing platform connector');
      return;
    }

    // ── Smart Leg Ordering ──────────────────────────────────────────────
    // Place the LESS liquid leg first (thinner book depth). If it fails,
    // we have no exposure (safe). If the deeper leg fails later, recovery
    // is easier on the more liquid book.
    const depthA = opp.legA.availableSize * opp.legA.price;
    const depthB = opp.legB.availableSize * opp.legB.price;
    const firstLegIsA = depthA <= depthB; // place thinner leg first

    const firstLeg = firstLegIsA ? opp.legA : opp.legB;
    const secondLeg = firstLegIsA ? opp.legB : opp.legA;
    const firstConn = firstLegIsA ? connA : connB;
    const secondConn = firstLegIsA ? connB : connA;

    log.info('Leg ordering decided', {
      first: `${firstLeg.platform} (depth $${(firstLegIsA ? depthA : depthB).toFixed(0)})`,
      second: `${secondLeg.platform} (depth $${(firstLegIsA ? depthB : depthA).toFixed(0)})`,
    });

    // ── Aggressive Pricing ──────────────────────────────────────────────
    // Bid slightly above the best ask to increase fill probability on
    // time-sensitive arbs. The overshoot is capped at half a tick to
    // avoid paying significantly more than intended.
    const tickA = firstLeg.orderBook.tickSize || 0.01;
    const tickB = secondLeg.orderBook.tickSize || 0.01;
    const aggressiveFirstPrice = Math.min(firstLeg.price + tickA * 0.5, 0.99);
    const aggressiveSecondPrice = Math.min(secondLeg.price + tickB * 0.5, 0.99);

    // Verify aggressive prices still yield a profitable arb
    const aggressiveTotalCost = aggressiveFirstPrice + aggressiveSecondPrice;
    const useAggressivePricing = aggressiveTotalCost < 1.0;

    const orderFirst: OrderRequest = {
      platform: firstLeg.platform,
      marketId: firstLeg.marketId,
      outcomeIndex: firstLeg.outcomeIndex,
      side: 'BUY',
      type: 'LIMIT',
      price: useAggressivePricing ? aggressiveFirstPrice : firstLeg.price,
      size,
    };

    const orderSecond: OrderRequest = {
      platform: secondLeg.platform,
      marketId: secondLeg.marketId,
      outcomeIndex: secondLeg.outcomeIndex,
      side: 'BUY',
      type: 'LIMIT',
      price: useAggressivePricing ? aggressiveSecondPrice : secondLeg.price,
      size,
    };

    if (useAggressivePricing) {
      log.info('Using aggressive pricing', {
        firstOriginal: firstLeg.price.toFixed(4),
        firstAggressive: orderFirst.price.toFixed(4),
        secondOriginal: secondLeg.price.toFixed(4),
        secondAggressive: orderSecond.price.toFixed(4),
        totalCost: aggressiveTotalCost.toFixed(4),
      });
    }

    // ── First Leg: Place ────────────────────────────────────────────────

    let resultFirst: OrderResult;
    try {
      await rateLimit(firstLeg.platform);
      resultFirst = await firstConn.placeOrder(orderFirst);
      if (firstLegIsA) trade.legA = resultFirst; else trade.legB = resultFirst;
      log.info('First leg placed', {
        orderId: resultFirst.id,
        platform: firstLeg.platform,
        status: resultFirst.status,
      });
    } catch (err) {
      // First leg failed outright — no exposure, safe to bail
      updateTradeStatus(trade.id, 'FAILED', {
        notes: `First leg (${firstLeg.platform}) failed to place: ${(err as Error).message}`,
      });
      updateOpportunityStatus(opp.id, 'failed', `First leg failed: ${(err as Error).message}`);
      eventBus.emit('trade:failed', { tradeId: trade.id, error: (err as Error).message });
      log.error('First leg placement failed — no exposure, aborting', {
        error: (err as Error).message,
      });
      return;
    }

    // If first leg was immediately rejected
    if (resultFirst.status === 'FAILED' || resultFirst.status === 'CANCELLED') {
      updateTradeStatus(trade.id, 'FAILED', {
        notes: `First leg immediately rejected: ${resultFirst.status}`,
      });
      updateOpportunityStatus(opp.id, 'failed', `First leg rejected: ${resultFirst.status}`);
      eventBus.emit('trade:failed', { tradeId: trade.id, error: `First leg rejected: ${resultFirst.status}` });
      return;
    }

    // ── Second Leg: Place ───────────────────────────────────────────────

    let resultSecond: OrderResult;
    try {
      await rateLimit(secondLeg.platform);
      resultSecond = await secondConn.placeOrder(orderSecond);
      if (firstLegIsA) trade.legB = resultSecond; else trade.legA = resultSecond;
      log.info('Second leg placed', {
        orderId: resultSecond.id,
        platform: secondLeg.platform,
        status: resultSecond.status,
      });
    } catch (err) {
      // DANGER: First leg is open/filled but second leg failed to place
      log.error('SECOND LEG FAILED — initiating recovery for unhedged first leg', {
        firstLeg: resultFirst.id,
        error: (err as Error).message,
      });

      await this.handleFailedLeg({
        tradeId: trade.id,
        filledLeg: resultFirst,
        failedLeg: {
          ...orderSecond,
          id: 'NEVER_PLACED',
          filledSize: 0,
          avgFillPrice: 0,
          status: 'FAILED',
          timestamp: new Date(),
          fees: 0,
        },
        filledPlatform: firstLeg.platform,
        opportunity: opp,
      });
      return;
    }

    // If second leg was immediately rejected
    if (resultSecond.status === 'FAILED' || resultSecond.status === 'CANCELLED') {
      log.error('Second leg immediately rejected — initiating recovery', {
        firstLeg: resultFirst.id,
        secondLegStatus: resultSecond.status,
      });

      await this.handleFailedLeg({
        tradeId: trade.id,
        filledLeg: resultFirst,
        failedLeg: resultSecond,
        filledPlatform: firstLeg.platform,
        opportunity: opp,
      });
      return;
    }

    // ── Both legs placed — monitor fill status ──────────────────────────
    // Map results back to A/B for consistent downstream handling
    const resultA = firstLegIsA ? resultFirst : resultSecond;
    const resultB = firstLegIsA ? resultSecond : resultFirst;

    trade.legA = resultA;
    trade.legB = resultB;
    trade.fees = resultA.fees + resultB.fees;

    await this.monitorAndFinalize(trade, opp, resultA, resultB, size);
  }

  /**
   * After both legs are placed, poll for fills and handle the outcome.
   * Uses getOrder() for precise single-order lookups, falling back to
   * getOpenOrders() if getOrder() isn't supported or fails.
   */
  private async monitorAndFinalize(
    trade: TradeRecord,
    opp: ArbitrageOpportunity,
    resultA: OrderResult,
    resultB: OrderResult,
    size: number,
  ): Promise<void> {
    const [finalA, finalB] = await Promise.all([
      this.waitForFill(opp.legA.platform, resultA, FILL_TIMEOUT_MS),
      this.waitForFill(opp.legB.platform, resultB, FILL_TIMEOUT_MS),
    ]);

    const bothFilled = finalA.status === 'FILLED' && finalB.status === 'FILLED';
    const aFilled = finalA.status === 'FILLED' || finalA.status === 'PARTIALLY_FILLED';
    const bFilled = finalB.status === 'FILLED' || finalB.status === 'PARTIALLY_FILLED';

    if (bothFilled) {
      // ── Happy path — both legs filled ──────────────────────────────
      const hedgedSize = Math.min(finalA.filledSize, finalB.filledSize);
      const realizedProfit =
        1 * hedgedSize -
        finalA.avgFillPrice * finalA.filledSize -
        finalB.avgFillPrice * finalB.filledSize -
        (finalA.fees + finalB.fees);

      updateTradeStatus(trade.id, 'EXECUTED', {
        realizedProfitUsd: realizedProfit,
        fees: finalA.fees + finalB.fees,
      });
      markOpportunityExecuted(opp.id);

      // Track positions in risk manager
      this.recordPositions(opp, finalA, finalB);

      trade.status = 'EXECUTED';
      trade.legA = finalA;
      trade.legB = finalB;
      eventBus.emit('trade:executed', trade);

      log.info('Trade executed successfully', {
        id: trade.id.slice(0, 8),
        realizedProfit: `$${realizedProfit.toFixed(2)}`,
        fillA: `${finalA.filledSize} @ ${finalA.avgFillPrice.toFixed(3)}`,
        fillB: `${finalB.filledSize} @ ${finalB.avgFillPrice.toFixed(3)}`,
        totalFees: `$${(finalA.fees + finalB.fees).toFixed(4)}`,
      });
    } else if (aFilled && !bFilled) {
      log.warn('PARTIAL EXECUTION — Leg A filled, Leg B not filled', {
        legA: `${finalA.status} (${finalA.filledSize}/${finalA.size})`,
        legB: `${finalB.status} (${finalB.filledSize}/${finalB.size})`,
      });

      await this.handleFailedLeg({
        tradeId: trade.id,
        filledLeg: finalA,
        failedLeg: finalB,
        filledPlatform: opp.legA.platform,
        opportunity: opp,
      });
    } else if (bFilled && !aFilled) {
      log.warn('PARTIAL EXECUTION — Leg B filled, Leg A not filled', {
        legA: `${finalA.status} (${finalA.filledSize}/${finalA.size})`,
        legB: `${finalB.status} (${finalB.filledSize}/${finalB.size})`,
      });

      await this.handleFailedLeg({
        tradeId: trade.id,
        filledLeg: finalB,
        failedLeg: finalA,
        filledPlatform: opp.legB.platform,
        opportunity: opp,
      });
    } else {
      // Neither filled — cancel both and mark failed
      log.warn('Neither leg filled — cancelling both', {
        legA: finalA.status,
        legB: finalB.status,
      });

      await Promise.allSettled([
        connA_cancel(this.connectors.get(opp.legA.platform), finalA.id),
        connA_cancel(this.connectors.get(opp.legB.platform), finalB.id),
      ]);

      updateTradeStatus(trade.id, 'FAILED', {
        notes: `Neither leg filled within ${FILL_TIMEOUT_MS / 1000}s. A: ${finalA.status}, B: ${finalB.status}`,
      });
      updateOpportunityStatus(opp.id, 'failed', `Neither leg filled. A: ${finalA.status}, B: ${finalB.status}`);
      eventBus.emit('trade:failed', { tradeId: trade.id, error: 'Neither leg filled' });
    }
  }

  /**
   * After a successful arb execution, record the hedged positions
   * in the risk manager so exposure tracking stays accurate.
   */
  private recordPositions(
    opp: ArbitrageOpportunity,
    fillA: OrderResult,
    fillB: OrderResult,
  ): void {
    const posA: Position = {
      platform: opp.legA.platform,
      marketId: opp.legA.marketId,
      marketQuestion: opp.legA.marketQuestion,
      outcomeIndex: opp.legA.outcomeIndex,
      side: opp.legA.outcome,
      size: fillA.filledSize,
      avgEntryPrice: fillA.avgFillPrice,
      currentPrice: fillA.avgFillPrice,
      unrealizedPnl: 0,
    };

    const posB: Position = {
      platform: opp.legB.platform,
      marketId: opp.legB.marketId,
      marketQuestion: opp.legB.marketQuestion,
      outcomeIndex: opp.legB.outcomeIndex,
      side: opp.legB.outcome,
      size: fillB.filledSize,
      avgEntryPrice: fillB.avgFillPrice,
      currentPrice: fillB.avgFillPrice,
      unrealizedPnl: 0,
    };

    this.riskManager.addPosition(posA);
    this.riskManager.addPosition(posB);

    log.info('Positions recorded', {
      legA: `${posA.side} ${posA.size} @ ${posA.avgEntryPrice.toFixed(3)} on ${posA.platform}`,
      legB: `${posB.side} ${posB.size} @ ${posB.avgEntryPrice.toFixed(3)} on ${posB.platform}`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FAILED-LEG RECOVERY
  //
  // When one leg fills and the other doesn't, we have unhedged directional
  // exposure. The recovery strategy follows this priority:
  //
  //   1. RETRY the failed leg (the arb may still be available)
  //   2. UNWIND the filled leg (sell back to flatten exposure)
  //   3. ACCEPT the loss and mark the trade for manual review
  //
  // The goal is to minimize time spent with unhedged exposure.
  // ═══════════════════════════════════════════════════════════════════════

  private async handleFailedLeg(ctx: FailedLegContext): Promise<void> {
    if (this.activeRecoveries.has(ctx.tradeId)) {
      log.warn('Recovery already in progress for this trade', { tradeId: ctx.tradeId });
      return;
    }

    this.activeRecoveries.add(ctx.tradeId);
    log.warn('╔══════════════════════════════════════════════════╗');
    log.warn('║  FAILED-LEG RECOVERY INITIATED                  ║');
    log.warn('╚══════════════════════════════════════════════════╝', {
      tradeId: ctx.tradeId.slice(0, 8),
      filledPlatform: ctx.filledPlatform,
      filledSize: ctx.filledLeg.filledSize,
      failedStatus: ctx.failedLeg.status,
    });

    try {
      // First: try to cancel the failed leg if it's still open
      if (ctx.failedLeg.id !== 'NEVER_PLACED' && ctx.failedLeg.status !== 'FAILED') {
        const failedPlatform = ctx.filledPlatform === ctx.opportunity.legA.platform
          ? ctx.opportunity.legB.platform
          : ctx.opportunity.legA.platform;

        const conn = this.connectors.get(failedPlatform);
        if (conn) {
          await rateLimit(failedPlatform);
          await conn.cancelOrder(ctx.failedLeg.id).catch(() => {});
        }
      }

      // Decide recovery strategy
      const action = await this.decideRecoveryAction(ctx);

      switch (action.type) {
        case 'RETRY_FAILED_LEG':
          await this.retryFailedLeg(ctx);
          break;
        case 'CANCEL_AND_UNWIND':
          await this.unwindFilledLeg(ctx);
          break;
        case 'ACCEPT_LOSS':
          this.acceptLoss(ctx, action.reason);
          break;
      }
    } catch (err) {
      log.error('Recovery itself failed — manual intervention required', {
        tradeId: ctx.tradeId,
        error: (err as Error).message,
      });

      updateTradeStatus(ctx.tradeId, 'FAILED', {
        notes: `CRITICAL: Recovery failed. Unhedged position on ${ctx.filledPlatform}. Manual intervention required. Error: ${(err as Error).message}`,
      });
      updateOpportunityStatus(ctx.opportunity.id, 'failed', `Recovery failed: ${(err as Error).message}`);

      eventBus.emit('trade:failed', {
        tradeId: ctx.tradeId,
        error: `Recovery failed: ${(err as Error).message}`,
      });
    } finally {
      this.activeRecoveries.delete(ctx.tradeId);
    }
  }

  /**
   * Analyze the situation and decide the best recovery action.
   */
  private async decideRecoveryAction(ctx: FailedLegContext): Promise<RecoveryAction> {
    // If the filled leg has zero fills (order was placed but never matched), just cancel
    if (ctx.filledLeg.filledSize === 0) {
      // Try to cancel the placed-but-unfilled leg
      const conn = this.connectors.get(ctx.filledPlatform);
      if (conn) {
        await rateLimit(ctx.filledPlatform);
        const cancelled = await conn.cancelOrder(ctx.filledLeg.id).catch(() => false);
        if (cancelled) {
          return { type: 'ACCEPT_LOSS', reason: 'Filled leg had 0 fills, successfully cancelled' };
        }
      }
    }

    // If the failed leg was never placed (connection error), retry once
    if (ctx.failedLeg.id === 'NEVER_PLACED') {
      return { type: 'RETRY_FAILED_LEG', reason: 'Failed leg was never placed — retrying' };
    }

    // If the filled amount is very small, the loss from unwinding is minimal
    const filledValueUsd = ctx.filledLeg.filledSize * ctx.filledLeg.avgFillPrice;
    if (filledValueUsd < 5) {
      return { type: 'ACCEPT_LOSS', reason: `Filled value too small ($${filledValueUsd.toFixed(2)}), accepting loss` };
    }

    // Default: try to unwind the filled leg
    return { type: 'CANCEL_AND_UNWIND', reason: 'Attempting to sell back the filled leg to flatten exposure' };
  }

  /**
   * Retry placing the failed leg of the arbitrage.
   * The arb might still exist if the failure was transient (network glitch, etc.).
   */
  private async retryFailedLeg(ctx: FailedLegContext): Promise<void> {
    const failedPlatform = ctx.filledPlatform === ctx.opportunity.legA.platform
      ? ctx.opportunity.legB.platform
      : ctx.opportunity.legA.platform;

    const failedOppLeg = ctx.filledPlatform === ctx.opportunity.legA.platform
      ? ctx.opportunity.legB
      : ctx.opportunity.legA;

    const conn = this.connectors.get(failedPlatform);
    if (!conn) {
      log.error('No connector for retry — falling back to unwind', { platform: failedPlatform });
      await this.unwindFilledLeg(ctx);
      return;
    }

    for (let attempt = 1; attempt <= MAX_UNWIND_ATTEMPTS; attempt++) {
      log.info(`Retrying failed leg (attempt ${attempt}/${MAX_UNWIND_ATTEMPTS})`, {
        platform: failedPlatform,
        marketId: failedOppLeg.marketId,
      });

      try {
        // Re-fetch order book to get current price
        await rateLimit(failedPlatform);
        const currentBook = await conn.fetchOrderBook(
          failedOppLeg.marketId,
          failedOppLeg.outcomeIndex,
        );

        if (!currentBook.bestAsk) {
          log.warn('No ask available for retry', { attempt });
          await sleep(UNWIND_RETRY_DELAY_MS);
          continue;
        }

        // Check if the arb is still profitable at current prices
        const filledPrice = ctx.filledLeg.avgFillPrice || ctx.filledLeg.price;
        const retryPrice = currentBook.bestAsk;
        const totalCost = filledPrice + retryPrice;

        if (totalCost >= 1.0) {
          log.warn('Arb no longer profitable at current prices — switching to unwind', {
            filledPrice,
            retryPrice,
            totalCost,
          });
          await this.unwindFilledLeg(ctx);
          return;
        }

        const retryOrder: OrderRequest = {
          platform: failedPlatform,
          marketId: failedOppLeg.marketId,
          outcomeIndex: failedOppLeg.outcomeIndex,
          side: 'BUY',
          type: 'LIMIT',
          price: retryPrice,
          size: ctx.filledLeg.filledSize || ctx.filledLeg.size,
        };

        await rateLimit(failedPlatform);
        const result = await conn.placeOrder(retryOrder);

        if (result.status === 'FILLED' || result.status === 'PENDING' || result.status === 'OPEN') {
          // Wait briefly for fill
          const final = await this.waitForFill(failedPlatform, result, FILL_TIMEOUT_MS);

          if (final.status === 'FILLED') {
            const profit = 1 * Math.min(ctx.filledLeg.filledSize, final.filledSize) -
              filledPrice * ctx.filledLeg.filledSize -
              final.avgFillPrice * final.filledSize -
              (ctx.filledLeg.fees + final.fees);

            updateTradeStatus(ctx.tradeId, 'EXECUTED', {
              realizedProfitUsd: profit,
              fees: ctx.filledLeg.fees + final.fees,
              notes: `Recovered via retry (attempt ${attempt}). Profit: $${profit.toFixed(2)}`,
            });

            markOpportunityExecuted(ctx.opportunity.id);

            // Record positions for the recovered trade
            this.recordPositions(
              ctx.opportunity,
              ctx.filledLeg,
              final,
            );

            log.info('Failed-leg retry SUCCEEDED', {
              tradeId: ctx.tradeId.slice(0, 8),
              attempt,
              profit: `$${profit.toFixed(2)}`,
            });
            return;
          }

          // Didn't fill — cancel and try again
          await rateLimit(failedPlatform);
          await conn.cancelOrder(final.id).catch(() => {});
        }
      } catch (err) {
        log.warn(`Retry attempt ${attempt} failed`, { error: (err as Error).message });
      }

      if (attempt < MAX_UNWIND_ATTEMPTS) {
        await sleep(UNWIND_RETRY_DELAY_MS);
      }
    }

    // All retries exhausted — fall back to unwinding
    log.warn('All retry attempts failed — falling back to unwind');
    await this.unwindFilledLeg(ctx);
  }

  /**
   * Sell back the filled leg to flatten our exposure.
   * We'll likely take a loss on the spread, but it prevents holding
   * unhedged directional risk.
   */
  private async unwindFilledLeg(ctx: FailedLegContext): Promise<void> {
    const conn = this.connectors.get(ctx.filledPlatform);
    if (!conn) {
      this.acceptLoss(ctx, 'No connector available for unwind');
      return;
    }

    const filledOppLeg = ctx.filledPlatform === ctx.opportunity.legA.platform
      ? ctx.opportunity.legA
      : ctx.opportunity.legB;

    for (let attempt = 1; attempt <= MAX_UNWIND_ATTEMPTS; attempt++) {
      log.info(`Unwinding filled leg (attempt ${attempt}/${MAX_UNWIND_ATTEMPTS})`, {
        platform: ctx.filledPlatform,
        marketId: filledOppLeg.marketId,
        size: ctx.filledLeg.filledSize,
      });

      try {
        // Fetch current book to find a sellable price
        await rateLimit(ctx.filledPlatform);
        const book = await conn.fetchOrderBook(
          filledOppLeg.marketId,
          filledOppLeg.outcomeIndex,
        );

        if (!book.bestBid) {
          log.warn('No bid available for unwind', { attempt });
          await sleep(UNWIND_RETRY_DELAY_MS);
          continue;
        }

        // Sell at the best bid (aggressive price to ensure fill)
        const unwindOrder: OrderRequest = {
          platform: ctx.filledPlatform,
          marketId: filledOppLeg.marketId,
          outcomeIndex: filledOppLeg.outcomeIndex,
          side: 'SELL',
          type: 'LIMIT',
          price: book.bestBid,
          size: ctx.filledLeg.filledSize || ctx.filledLeg.size,
        };

        await rateLimit(ctx.filledPlatform);
        const result = await conn.placeOrder(unwindOrder);
        const final = await this.waitForFill(ctx.filledPlatform, result, FILL_TIMEOUT_MS);

        if (final.status === 'FILLED' || final.filledSize > 0) {
          const costBasis = ctx.filledLeg.avgFillPrice * ctx.filledLeg.filledSize;
          const proceeds = final.avgFillPrice * final.filledSize;
          const loss = proceeds - costBasis - final.fees;

          updateTradeStatus(ctx.tradeId, 'FAILED', {
            realizedProfitUsd: loss,
            fees: ctx.filledLeg.fees + final.fees,
            notes: `Unwound filled leg (attempt ${attempt}). Loss: $${loss.toFixed(2)}. Original arb failed due to leg failure.`,
          });

          log.info('Unwind completed', {
            tradeId: ctx.tradeId.slice(0, 8),
            loss: `$${loss.toFixed(2)}`,
            attempt,
          });

          eventBus.emit('trade:failed', {
            tradeId: ctx.tradeId,
            error: `Unwound after failed leg. Loss: $${loss.toFixed(2)}`,
          });
          return;
        }

        // Didn't fill — cancel and retry
        await rateLimit(ctx.filledPlatform);
        await conn.cancelOrder(final.id).catch(() => {});
      } catch (err) {
        log.error(`Unwind attempt ${attempt} failed`, { error: (err as Error).message });
      }

      if (attempt < MAX_UNWIND_ATTEMPTS) {
        await sleep(UNWIND_RETRY_DELAY_MS);
      }
    }

    // All unwind attempts exhausted
    this.acceptLoss(ctx, 'All unwind attempts exhausted — manual intervention required');
  }

  /**
   * Last resort: mark the trade as failed and flag for manual review.
   * This means we have an open position that needs human attention.
   */
  private acceptLoss(ctx: FailedLegContext, reason: string): void {
    const filledValue = (ctx.filledLeg.filledSize || 0) * (ctx.filledLeg.avgFillPrice || ctx.filledLeg.price);

    updateTradeStatus(ctx.tradeId, 'FAILED', {
      notes: `UNHEDGED POSITION — ${reason}. Platform: ${ctx.filledPlatform}, Value: $${filledValue.toFixed(2)}, Order: ${ctx.filledLeg.id}. REQUIRES MANUAL REVIEW.`,
    });
    updateOpportunityStatus(ctx.opportunity.id, 'failed', `Unhedged: ${reason}`);

    eventBus.emit('trade:failed', {
      tradeId: ctx.tradeId,
      error: `Unhedged position: ${reason}`,
    });

    eventBus.emit('risk:limit_breach', {
      type: 'unhedged_position',
      current: filledValue,
      limit: 0,
    });

    log.error('ACCEPTING LOSS — manual intervention required', {
      tradeId: ctx.tradeId.slice(0, 8),
      platform: ctx.filledPlatform,
      filledSize: ctx.filledLeg.filledSize,
      reason,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FILL MONITORING
  //
  // Uses getOrder() for precise single-order lookups (preferred).
  // Falls back to getOpenOrders() list scan if getOrder() fails.
  // If the order disappears from open orders, we assume it filled.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Poll the order status until it fills or the timeout expires.
   */
  private async waitForFill(
    platform: Platform,
    order: OrderResult,
    timeoutMs: number,
  ): Promise<OrderResult> {
    // If already in a terminal state, return immediately
    if (['FILLED', 'FAILED', 'CANCELLED'].includes(order.status)) {
      return order;
    }

    const conn = this.connectors.get(platform);
    if (!conn) return order;

    const deadline = Date.now() + timeoutMs;
    let lastKnown = order;
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      await sleep(FILL_POLL_INTERVAL_MS);

      try {
        await rateLimit(platform);

        // Prefer getOrder() for precise lookup
        const single = await conn.getOrder(order.id);

        if (single) {
          lastKnown = single;
          consecutiveErrors = 0;

          if (single.status === 'FILLED') {
            log.info('Order filled', { orderId: order.id, platform, filledSize: single.filledSize });
            return single;
          }
          if (single.status === 'FAILED' || single.status === 'CANCELLED') {
            return single;
          }
          if (single.status === 'PARTIALLY_FILLED' && single.filledSize >= order.size * 0.99) {
            // Close enough to fully filled (rounding)
            return { ...single, status: 'FILLED' };
          }
          // Still open — keep waiting
          continue;
        }

        // getOrder() returned null — order may have been filled and removed
        // Double-check via getOpenOrders()
        await rateLimit(platform);
        const openOrders = await conn.getOpenOrders();
        const found = openOrders.find(o => o.id === order.id);

        if (found) {
          lastKnown = found;
          if (found.status === 'FILLED') return found;
          if (found.status === 'FAILED' || found.status === 'CANCELLED') return found;
          // Still open
        } else {
          // Not in open orders AND getOrder returned null → assume filled
          log.info('Order disappeared from open orders — assuming filled', {
            orderId: order.id,
            platform,
          });
          return {
            ...order,
            status: 'FILLED',
            filledSize: order.size,
            avgFillPrice: order.price,
          };
        }

        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        log.warn('Fill poll error', {
          orderId: order.id,
          platform,
          error: (err as Error).message,
          consecutiveErrors,
        });

        // After 3 consecutive errors, stop polling to avoid hammering a broken API
        if (consecutiveErrors >= 3) {
          log.error('Too many consecutive poll errors, returning last known state', {
            orderId: order.id,
          });
          return lastKnown;
        }
      }
    }

    // Timeout reached — return last known state
    log.warn('Fill timeout reached', {
      orderId: order.id,
      platform,
      lastStatus: lastKnown.status,
      timeoutMs,
    });
    return lastKnown;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Safe cancel helper — ignores missing connectors */
async function connA_cancel(conn: MarketConnector | undefined, orderId: string): Promise<void> {
  if (conn && orderId && orderId !== 'NEVER_PLACED') {
    await conn.cancelOrder(orderId).catch(() => {});
  }
}
