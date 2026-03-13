// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Backtest Engine
// Simulates trading strategies against historical/simulated data
// ═══════════════════════════════════════════════════════════════════════════

import { NormalizedMarket, OrderBook, Platform } from '../types';
import { MarketMatcher, MarketPair } from '../matcher/market-matcher';
import { BacktestDataset, HistoricalSnapshot } from './data-fetcher';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('backtest:engine');

// ─── Strategy Configs ────────────────────────────────────────────────────

export interface StrategyConfig {
  name: string;
  /** Minimum spread in BPS to trigger entry */
  minProfitBps: number;
  /** Maximum position size per trade (USD) */
  maxPositionUsd: number;
  /** Fee rate in BPS per leg */
  feeRateBps: number;
  /** Minimum order book depth to execute */
  minDepthUsd: number;
  /** Price slippage assumption (%) */
  slippagePct: number;
  /** Whether to use aggressive (market) or passive (limit) entries */
  entryMode: 'aggressive' | 'passive';
  /** For passive mode: how many basis points from mid to place limit */
  limitOffsetBps?: number;
  /** Maximum number of simultaneous positions */
  maxConcurrentPositions: number;
  /** Take-profit threshold in BPS (close when spread narrows) */
  takeProfitBps?: number;
  /** Stop-loss threshold in BPS (close when spread widens against us) */
  stopLossBps?: number;
}

// ─── Backtest Position / Trade ───────────────────────────────────────────

interface BacktestPosition {
  id: string;
  entryTime: Date;
  exitTime: Date | null;
  pairId: string;
  /** Buy side */
  legA: { platform: Platform; marketId: string; outcome: 'YES' | 'NO'; entryPrice: number; size: number };
  /** Sell side */
  legB: { platform: Platform; marketId: string; outcome: 'YES' | 'NO'; entryPrice: number; size: number };
  entrySpreadBps: number;
  entryFees: number;
  exitSpreadBps: number | null;
  exitFees: number;
  realizedPnl: number;
  status: 'open' | 'closed' | 'stopped_out';
}

// ─── Backtest Results ────────────────────────────────────────────────────

export interface BacktestResult {
  strategyName: string;
  config: StrategyConfig;
  /** Total P&L after fees */
  totalPnl: number;
  /** Number of trades taken */
  totalTrades: number;
  /** Number of winning trades */
  winners: number;
  /** Number of losing trades */
  losers: number;
  /** Win rate (0-100) */
  winRate: number;
  /** Average profit per winning trade */
  avgWin: number;
  /** Average loss per losing trade */
  avgLoss: number;
  /** Profit factor: gross wins / gross losses */
  profitFactor: number;
  /** Maximum drawdown in USD */
  maxDrawdown: number;
  /** Maximum drawdown in % */
  maxDrawdownPct: number;
  /** Sharpe ratio (annualized, assuming 30-second intervals) */
  sharpeRatio: number;
  /** Sortino ratio */
  sortinoRatio: number;
  /** Total fees paid */
  totalFees: number;
  /** Average hold time in snapshots */
  avgHoldTime: number;
  /** Return on capital */
  returnPct: number;
  /** Annualized return */
  annualizedReturn: number;
  /** Equity curve: cumulative P&L at each snapshot */
  equityCurve: number[];
  /** All positions/trades */
  positions: BacktestPosition[];
  /** Time span in hours */
  timeSpanHours: number;
  /** Market pairs evaluated */
  pairsEvaluated: number;
}

// ─── Backtest Engine ─────────────────────────────────────────────────────

export class BacktestEngine {
  private matcher = new MarketMatcher();

  /**
   * Run a single backtest with given strategy config against a dataset.
   */
  run(dataset: BacktestDataset, config: StrategyConfig): BacktestResult {
    log.info(`Running backtest: ${config.name}`, {
      snapshots: dataset.snapshots.length,
      minProfitBps: config.minProfitBps,
      maxPositionUsd: config.maxPositionUsd,
    });

    // Step 1: Find matched pairs
    const pairs = this.matcher.findPairsSync(
      dataset.polymarketMarkets,
      dataset.predictfunMarkets,
    );

    log.info(`Found ${pairs.length} matched pairs for backtesting`);

    // Step 2: Simulate through snapshots
    const openPositions: BacktestPosition[] = [];
    const closedPositions: BacktestPosition[] = [];
    const equityCurve: number[] = [];
    let cumulativePnl = 0;
    let posCounter = 0;

    for (let i = 0; i < dataset.snapshots.length; i++) {
      const snap = dataset.snapshots[i];

      // Check open positions for exits
      for (let j = openPositions.length - 1; j >= 0; j--) {
        const pos = openPositions[j];
        const exitResult = this.checkExit(pos, snap, config);
        if (exitResult) {
          pos.exitTime = snap.timestamp;
          pos.exitSpreadBps = exitResult.exitSpreadBps;
          pos.exitFees = exitResult.exitFees;
          pos.realizedPnl = exitResult.pnl;
          pos.status = exitResult.reason === 'stop_loss' ? 'stopped_out' : 'closed';
          cumulativePnl += pos.realizedPnl;
          closedPositions.push(pos);
          openPositions.splice(j, 1);
        }
      }

      // Check for new entries
      if (openPositions.length < config.maxConcurrentPositions) {
        for (const pair of pairs) {
          if (pair.status === 'rejected') continue;
          if (openPositions.some(p => p.pairId === pair.pairId)) continue;
          if (openPositions.length >= config.maxConcurrentPositions) break;

          const entry = this.checkEntry(pair, snap, config);
          if (entry) {
            posCounter++;
            openPositions.push({
              id: `bt-${posCounter}`,
              entryTime: snap.timestamp,
              exitTime: null,
              pairId: pair.pairId,
              legA: entry.legA,
              legB: entry.legB,
              entrySpreadBps: entry.spreadBps,
              entryFees: entry.fees,
              exitSpreadBps: null,
              exitFees: 0,
              realizedPnl: 0,
              status: 'open',
            });
          }
        }
      }

      equityCurve.push(cumulativePnl);
    }

    // Force-close any remaining open positions at last snapshot
    if (openPositions.length > 0 && dataset.snapshots.length > 0) {
      const lastSnap = dataset.snapshots[dataset.snapshots.length - 1];
      for (const pos of openPositions) {
        const exitResult = this.forceClose(pos, lastSnap, config);
        pos.exitTime = lastSnap.timestamp;
        pos.exitSpreadBps = exitResult.exitSpreadBps;
        pos.exitFees = exitResult.exitFees;
        pos.realizedPnl = exitResult.pnl;
        pos.status = 'closed';
        cumulativePnl += pos.realizedPnl;
        closedPositions.push(pos);
      }
    }

    // Compute metrics
    return this.computeMetrics(config, closedPositions, equityCurve, dataset, pairs.length);
  }

  /**
   * Run multiple strategy configurations for comparison.
   */
  runSweep(
    dataset: BacktestDataset,
    configs: StrategyConfig[],
  ): BacktestResult[] {
    return configs.map(config => this.run(dataset, config));
  }

  // ─── Entry Logic ──────────────────────────────────────────────────────

  private checkEntry(
    pair: MarketPair,
    snap: HistoricalSnapshot,
    config: StrategyConfig,
  ): {
    legA: BacktestPosition['legA'];
    legB: BacktestPosition['legB'];
    spreadBps: number;
    fees: number;
  } | null {
    const bookA = snap.orderBooks.get(`${pair.marketA.id}:0`);
    const bookB = snap.orderBooks.get(`${pair.marketB.id}:0`);

    if (!bookA || !bookB) return null;

    // Direction 1: Buy YES on A + Buy NO on B
    // Cost = bestAsk(A) + (1 - bestBid(B))
    if (bookA.bestAsk !== null && bookB.bestBid !== null) {
      const costYesA = bookA.bestAsk * (1 + config.slippagePct / 100);
      const costNoB = (1 - bookB.bestBid) * (1 + config.slippagePct / 100);
      const totalCost = costYesA + costNoB;
      const profitPerShare = 1 - totalCost;
      const profitBps = totalCost > 0 ? (profitPerShare / totalCost) * 10000 : 0;

      if (profitBps >= config.minProfitBps) {
        const maxSizeA = bookA.asks[0]?.size ?? 0;
        const maxSizeB = bookB.bids[0]?.size ?? 0;
        const maxSize = Math.min(maxSizeA, maxSizeB, config.maxPositionUsd / totalCost);

        if (maxSize * totalCost >= config.minDepthUsd) {
          const fees = maxSize * totalCost * (config.feeRateBps * 2 / 10000);
          return {
            legA: { platform: pair.marketA.platform, marketId: pair.marketA.id, outcome: 'YES', entryPrice: costYesA, size: maxSize },
            legB: { platform: pair.marketB.platform, marketId: pair.marketB.id, outcome: 'NO', entryPrice: costNoB, size: maxSize },
            spreadBps: profitBps,
            fees,
          };
        }
      }
    }

    // Direction 2: Buy NO on A + Buy YES on B
    if (bookA.bestBid !== null && bookB.bestAsk !== null) {
      const costNoA = (1 - bookA.bestBid) * (1 + config.slippagePct / 100);
      const costYesB = bookB.bestAsk * (1 + config.slippagePct / 100);
      const totalCost = costNoA + costYesB;
      const profitPerShare = 1 - totalCost;
      const profitBps = totalCost > 0 ? (profitPerShare / totalCost) * 10000 : 0;

      if (profitBps >= config.minProfitBps) {
        const maxSizeA = bookA.bids[0]?.size ?? 0;
        const maxSizeB = bookB.asks[0]?.size ?? 0;
        const maxSize = Math.min(maxSizeA, maxSizeB, config.maxPositionUsd / totalCost);

        if (maxSize * totalCost >= config.minDepthUsd) {
          const fees = maxSize * totalCost * (config.feeRateBps * 2 / 10000);
          return {
            legA: { platform: pair.marketA.platform, marketId: pair.marketA.id, outcome: 'NO', entryPrice: costNoA, size: maxSize },
            legB: { platform: pair.marketB.platform, marketId: pair.marketB.id, outcome: 'YES', entryPrice: costYesB, size: maxSize },
            spreadBps: profitBps,
            fees,
          };
        }
      }
    }

    return null;
  }

  // ─── Exit Logic ───────────────────────────────────────────────────────

  private checkExit(
    pos: BacktestPosition,
    snap: HistoricalSnapshot,
    config: StrategyConfig,
  ): { pnl: number; exitSpreadBps: number; exitFees: number; reason: 'take_profit' | 'stop_loss' | 'convergence' } | null {
    const bookA = snap.orderBooks.get(`${pos.legA.marketId}:0`);
    const bookB = snap.orderBooks.get(`${pos.legB.marketId}:0`);

    if (!bookA || !bookB) return null;

    // Current spread (what we'd get exiting now)
    const currentCostA = pos.legA.outcome === 'YES'
      ? (bookA.bestBid ?? 0) : (1 - (bookA.bestAsk ?? 1));
    const currentCostB = pos.legB.outcome === 'YES'
      ? (bookB.bestBid ?? 0) : (1 - (bookB.bestAsk ?? 1));

    // P&L = value recovered - entry cost
    const entryTotal = pos.legA.entryPrice + pos.legB.entryPrice;
    const currentValuePerShare = currentCostA + currentCostB;

    // Realized PnL per share at exit
    // At entry we paid entryTotal for a guaranteed $1 payout
    // We can exit early by selling our positions back
    // Or we can hold to resolution for the guaranteed $1
    const unrealizedPnlPerShare = currentValuePerShare - entryTotal;
    const unrealizedBps = entryTotal > 0 ? (unrealizedPnlPerShare / entryTotal) * 10000 : 0;

    // For arb positions, the expected exit is convergence to $1
    // Check if we should take profit early if spread has significantly converged
    if (config.takeProfitBps && unrealizedBps >= config.takeProfitBps) {
      const exitFees = pos.legA.size * currentValuePerShare * (config.feeRateBps * 2 / 10000);
      const pnl = pos.legA.size * unrealizedPnlPerShare - pos.entryFees - exitFees;
      return { pnl, exitSpreadBps: unrealizedBps, exitFees, reason: 'take_profit' };
    }

    // Stop loss
    if (config.stopLossBps && unrealizedBps < -config.stopLossBps) {
      const exitFees = pos.legA.size * currentValuePerShare * (config.feeRateBps * 2 / 10000);
      const pnl = pos.legA.size * unrealizedPnlPerShare - pos.entryFees - exitFees;
      return { pnl, exitSpreadBps: unrealizedBps, exitFees, reason: 'stop_loss' };
    }

    // Default: hold to resolution (we simulate resolution as convergence)
    // Exit when spread is near zero (convergence = arb resolved)
    const convergenceThreshold = 10; // 10 bps = essentially converged
    if (Math.abs(unrealizedBps) < convergenceThreshold && unrealizedPnlPerShare > 0) {
      const exitFees = pos.legA.size * currentValuePerShare * (config.feeRateBps * 2 / 10000);
      const pnl = pos.legA.size * unrealizedPnlPerShare - pos.entryFees - exitFees;
      return { pnl, exitSpreadBps: unrealizedBps, exitFees, reason: 'convergence' };
    }

    return null;
  }

  private forceClose(
    pos: BacktestPosition,
    snap: HistoricalSnapshot,
    config: StrategyConfig,
  ): { pnl: number; exitSpreadBps: number; exitFees: number } {
    // At force close, assume we hold to resolution
    // The guaranteed payout is $1 per share in arb
    const entryTotal = pos.legA.entryPrice + pos.legB.entryPrice;
    const profitPerShare = 1 - entryTotal;
    const exitFees = pos.legA.size * 1 * (config.feeRateBps / 10000); // only settlement fee
    const pnl = pos.legA.size * profitPerShare - pos.entryFees - exitFees;
    const exitSpreadBps = entryTotal > 0 ? (profitPerShare / entryTotal) * 10000 : 0;
    return { pnl, exitSpreadBps, exitFees };
  }

  // ─── Metrics Computation ──────────────────────────────────────────────

  private computeMetrics(
    config: StrategyConfig,
    positions: BacktestPosition[],
    equityCurve: number[],
    dataset: BacktestDataset,
    pairsEvaluated: number,
  ): BacktestResult {
    const winners = positions.filter(p => p.realizedPnl > 0);
    const losers = positions.filter(p => p.realizedPnl <= 0);
    const totalPnl = positions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalFees = positions.reduce((s, p) => s + p.entryFees + p.exitFees, 0);

    const grossWins = winners.reduce((s, p) => s + p.realizedPnl, 0);
    const grossLosses = Math.abs(losers.reduce((s, p) => s + p.realizedPnl, 0));

    // Max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    for (const pnl of equityCurve) {
      if (pnl > peak) peak = pnl;
      const dd = peak - pnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Returns per interval for Sharpe/Sortino
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push(equityCurve[i] - equityCurve[i - 1]);
    }

    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdReturn = returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
      : 0;
    const downside = returns.filter(r => r < 0);
    const downsideDev = downside.length > 1
      ? Math.sqrt(downside.reduce((s, r) => s + r ** 2, 0) / downside.length)
      : 0;

    // Annualization: assume 30s intervals, 365 days
    const intervalsPerYear = (365 * 24 * 3600 * 1000) / 30000;
    const annualizationFactor = Math.sqrt(intervalsPerYear);

    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * annualizationFactor : 0;
    const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * annualizationFactor : 0;

    const timeSpanHours = (dataset.endTime.getTime() - dataset.startTime.getTime()) / 3600000;
    const capital = config.maxPositionUsd * config.maxConcurrentPositions;
    const returnPct = capital > 0 ? (totalPnl / capital) * 100 : 0;
    const annualizedReturn = timeSpanHours > 0
      ? returnPct * (8760 / timeSpanHours) // 8760 hours/year
      : 0;

    // Average hold time in snapshots
    const avgHoldTime = positions.length > 0
      ? positions.reduce((s, p) => {
          if (!p.entryTime || !p.exitTime) return s;
          return s + (p.exitTime.getTime() - p.entryTime.getTime());
        }, 0) / positions.length / 30000
      : 0;

    return {
      strategyName: config.name,
      config,
      totalPnl,
      totalTrades: positions.length,
      winners: winners.length,
      losers: losers.length,
      winRate: positions.length > 0 ? (winners.length / positions.length) * 100 : 0,
      avgWin: winners.length > 0 ? grossWins / winners.length : 0,
      avgLoss: losers.length > 0 ? grossLosses / losers.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      maxDrawdown,
      maxDrawdownPct: capital > 0 ? (maxDrawdown / capital) * 100 : 0,
      sharpeRatio,
      sortinoRatio,
      totalFees,
      avgHoldTime,
      returnPct,
      annualizedReturn,
      equityCurve,
      positions,
      timeSpanHours,
      pairsEvaluated,
    };
  }
}
