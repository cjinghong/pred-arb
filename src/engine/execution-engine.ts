// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Execution Engine
// Validates opportunities, runs risk checks, executes trades, and handles
// failed-leg recovery to prevent unhedged directional exposure.
// ═══════════════════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import {
  ArbitrageOpportunity,
  Platform,
  TradeRecord,
  OrderRequest,
  OrderResult,
} from '../types';
import { MarketConnector } from '../types/connector';
import { Strategy } from '../types/strategy';
import { RiskManager } from './risk-manager';
import { insertOpportunity, insertTrade, updateTradeStatus, markOpportunityExecuted } from '../db/database';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';

const log = createChildLogger('execution');

/** Maximum time to wait for a fill confirmation (ms) */
const FILL_TIMEOUT_MS = 15_000;
/** Maximum attempts to unwind a stuck leg */
const MAX_UNWIND_ATTEMPTS = 3;
/** How long to wait between unwind retries */
const UNWIND_RETRY_DELAY_MS = 2_000;

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
        await this.executeOpportunity(opp);
      } catch (err) {
        log.error('Failed to execute opportunity', {
          id: opp.id.slice(0, 8),
          error: (err as Error).message,
        });
      }
    }

    this.processing = false;
  }

  private async executeOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    const tradeId = uuid();

    // Step 1: Re-validate with the strategy
    const strategy = this.strategies.get(opp.strategyId);
    if (strategy) {
      const stillValid = await strategy.validate(opp);
      if (!stillValid) {
        log.info('Opportunity no longer valid after re-check', { id: opp.id.slice(0, 8) });
        return;
      }
    }

    // Step 2: Risk check
    const riskResult = await this.riskManager.checkOpportunity(opp);
    if (!riskResult.approved) {
      log.info('Opportunity rejected by risk manager', {
        id: opp.id.slice(0, 8),
        reason: riskResult.reason,
      });
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
      return;
    }

    const orderA: OrderRequest = {
      platform: opp.legA.platform,
      marketId: opp.legA.marketId,
      outcomeIndex: opp.legA.outcomeIndex,
      side: 'BUY',
      type: 'LIMIT',
      price: opp.legA.price,
      size,
    };

    const orderB: OrderRequest = {
      platform: opp.legB.platform,
      marketId: opp.legB.marketId,
      outcomeIndex: opp.legB.outcomeIndex,
      side: 'BUY',
      type: 'LIMIT',
      price: opp.legB.price,
      size,
    };

    // ── Leg A: Place first ──────────────────────────────────────────────

    let resultA: OrderResult;
    try {
      resultA = await connA.placeOrder(orderA);
      trade.legA = resultA;
      log.info('Leg A placed', {
        orderId: resultA.id,
        platform: opp.legA.platform,
        status: resultA.status,
      });
    } catch (err) {
      // Leg A failed outright — no exposure, safe to bail
      updateTradeStatus(trade.id, 'FAILED', {
        notes: `Leg A failed to place: ${(err as Error).message}`,
      });
      eventBus.emit('trade:failed', { tradeId: trade.id, error: (err as Error).message });
      log.error('Leg A placement failed — no exposure, aborting', {
        error: (err as Error).message,
      });
      return;
    }

    // If leg A was immediately rejected (some platforms return FAILED/CANCELLED status)
    if (resultA.status === 'FAILED' || resultA.status === 'CANCELLED') {
      updateTradeStatus(trade.id, 'FAILED', {
        notes: `Leg A immediately rejected: ${resultA.status}`,
      });
      eventBus.emit('trade:failed', { tradeId: trade.id, error: `Leg A rejected: ${resultA.status}` });
      return;
    }

    // ── Leg B: Place second ─────────────────────────────────────────────

    let resultB: OrderResult;
    try {
      resultB = await connB.placeOrder(orderB);
      trade.legB = resultB;
      log.info('Leg B placed', {
        orderId: resultB.id,
        platform: opp.legB.platform,
        status: resultB.status,
      });
    } catch (err) {
      // DANGER: Leg A is open/filled but leg B failed to place
      // We have unhedged exposure on platform A
      log.error('LEG B FAILED — initiating recovery for unhedged leg A', {
        legA: resultA.id,
        error: (err as Error).message,
      });

      await this.handleFailedLeg({
        tradeId: trade.id,
        filledLeg: resultA,
        failedLeg: {
          ...orderB,
          id: 'NEVER_PLACED',
          filledSize: 0,
          avgFillPrice: 0,
          status: 'FAILED',
          timestamp: new Date(),
          fees: 0,
        },
        filledPlatform: opp.legA.platform,
        opportunity: opp,
      });
      return;
    }

    // If leg B was immediately rejected
    if (resultB.status === 'FAILED' || resultB.status === 'CANCELLED') {
      log.error('Leg B immediately rejected — initiating recovery', {
        legA: resultA.id,
        legBStatus: resultB.status,
      });

      await this.handleFailedLeg({
        tradeId: trade.id,
        filledLeg: resultA,
        failedLeg: resultB,
        filledPlatform: opp.legA.platform,
        opportunity: opp,
      });
      return;
    }

    // ── Both legs placed — monitor fill status ──────────────────────────

    trade.legA = resultA;
    trade.legB = resultB;
    trade.fees = resultA.fees + resultB.fees;

    await this.monitorAndFinalize(trade, opp, resultA, resultB);
  }

  /**
   * After both legs are placed, wait for fills and handle the outcome.
   */
  private async monitorAndFinalize(
    trade: TradeRecord,
    opp: ArbitrageOpportunity,
    resultA: OrderResult,
    resultB: OrderResult,
  ): Promise<void> {
    // Wait briefly for fills to confirm (many platforms fill limit orders instantly
    // if there's sufficient liquidity on the book)
    const [finalA, finalB] = await Promise.all([
      this.waitForFill(opp.legA.platform, resultA, FILL_TIMEOUT_MS),
      this.waitForFill(opp.legB.platform, resultB, FILL_TIMEOUT_MS),
    ]);

    const bothFilled = finalA.status === 'FILLED' && finalB.status === 'FILLED';
    const aFilled = finalA.status === 'FILLED' || finalA.status === 'PARTIALLY_FILLED';
    const bFilled = finalB.status === 'FILLED' || finalB.status === 'PARTIALLY_FILLED';

    if (bothFilled) {
      // Happy path — both legs filled
      const realizedProfit =
        1 * Math.min(finalA.filledSize, finalB.filledSize) -
        finalA.avgFillPrice * finalA.filledSize -
        finalB.avgFillPrice * finalB.filledSize -
        (finalA.fees + finalB.fees);

      updateTradeStatus(trade.id, 'EXECUTED', {
        realizedProfitUsd: realizedProfit,
        fees: finalA.fees + finalB.fees,
      });
      markOpportunityExecuted(opp.id);
      eventBus.emit('trade:executed', trade);

      log.info('Trade executed successfully', {
        id: trade.id.slice(0, 8),
        realizedProfit: `$${realizedProfit.toFixed(2)}`,
        fillA: finalA.filledSize,
        fillB: finalB.filledSize,
      });
    } else if (aFilled && !bFilled) {
      // Leg A filled, leg B didn't
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
      // Leg B filled, leg A didn't
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

      const connA = this.connectors.get(opp.legA.platform);
      const connB = this.connectors.get(opp.legB.platform);
      await Promise.allSettled([
        connA?.cancelOrder(finalA.id),
        connB?.cancelOrder(finalB.id),
      ]);

      updateTradeStatus(trade.id, 'FAILED', {
        notes: `Neither leg filled. A: ${finalA.status}, B: ${finalB.status}`,
      });
      eventBus.emit('trade:failed', { tradeId: trade.id, error: 'Neither leg filled' });
    }
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
            log.info('Failed-leg retry SUCCEEDED', {
              tradeId: ctx.tradeId.slice(0, 8),
              attempt,
              profit: `$${profit.toFixed(2)}`,
            });
            return;
          }

          // Didn't fill — cancel and try again
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
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Poll the order status until it fills or the timeout expires.
   * In practice, platforms often fill limits instantly if there's book depth,
   * so this is mostly a safety net.
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
    const pollInterval = 1000;

    while (Date.now() < deadline) {
      await sleep(pollInterval);

      try {
        // Check open orders to find our order's current status
        const openOrders = await conn.getOpenOrders();
        const found = openOrders.find(o => o.id === order.id);

        if (found) {
          if (found.status === 'FILLED') return found;
          if (found.status === 'FAILED' || found.status === 'CANCELLED') return found;
          // Still open — keep waiting
        } else {
          // Order not in open orders — may have been filled and removed
          // Return the original with updated status assumption
          return { ...order, status: 'FILLED', filledSize: order.size, avgFillPrice: order.price };
        }
      } catch {
        // API error — continue polling
      }
    }

    // Timeout reached — return current state
    return order;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
