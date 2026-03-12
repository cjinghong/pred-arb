// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Execution Engine
// Validates opportunities, runs risk checks, and executes trades
// ═══════════════════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import {
  ArbitrageOpportunity,
  Platform,
  TradeRecord,
  OrderRequest,
} from '../types';
import { MarketConnector } from '../types/connector';
import { Strategy } from '../types/strategy';
import { RiskManager } from './risk-manager';
import { insertOpportunity, insertTrade, updateTradeStatus, markOpportunityExecuted } from '../db/database';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';

const log = createChildLogger('execution');

export class ExecutionEngine {
  private connectors = new Map<Platform, MarketConnector>();
  private strategies = new Map<string, Strategy>();
  private riskManager: RiskManager;
  private dryRun: boolean;

  /** Queue of pending opportunities */
  private queue: ArbitrageOpportunity[] = [];
  private processing = false;

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

    // Step 4: Execute both legs (in production)
    try {
      const connA = this.connectors.get(opp.legA.platform);
      const connB = this.connectors.get(opp.legB.platform);
      if (!connA || !connB) throw new Error('Missing connector');

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

      // Execute both legs concurrently
      const [resultA, resultB] = await Promise.all([
        connA.placeOrder(orderA),
        connB.placeOrder(orderB),
      ]);

      trade.legA = resultA;
      trade.legB = resultB;
      trade.fees = resultA.fees + resultB.fees;

      // Check fill status
      if (resultA.status === 'FILLED' && resultB.status === 'FILLED') {
        const realizedProfit =
          1 * Math.min(resultA.filledSize, resultB.filledSize) -
          resultA.avgFillPrice * resultA.filledSize -
          resultB.avgFillPrice * resultB.filledSize -
          trade.fees;

        updateTradeStatus(tradeId, 'EXECUTED', {
          realizedProfitUsd: realizedProfit,
          fees: trade.fees,
        });
        markOpportunityExecuted(opp.id);
        eventBus.emit('trade:executed', trade);

        log.info('Trade executed successfully', {
          id: tradeId.slice(0, 8),
          realizedProfit: `$${realizedProfit.toFixed(2)}`,
        });
      } else {
        // Partial fill or failure — log and handle
        updateTradeStatus(tradeId, 'PENDING', {
          notes: `Leg A: ${resultA.status}, Leg B: ${resultB.status}`,
        });

        log.warn('Trade partially filled', {
          legA: resultA.status,
          legB: resultB.status,
        });
      }
    } catch (err) {
      updateTradeStatus(tradeId, 'FAILED', {
        notes: (err as Error).message,
      });
      eventBus.emit('trade:failed', { tradeId, error: (err as Error).message });
      log.error('Trade execution failed', { tradeId, error: (err as Error).message });
    }
  }
}
