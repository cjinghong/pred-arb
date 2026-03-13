#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Backtest Runner
// Runs multiple strategy configurations against historical data and
// generates a profitability report
// ═══════════════════════════════════════════════════════════════════════════

import { BacktestDataFetcher } from './data-fetcher';
import { BacktestEngine, StrategyConfig, BacktestResult } from './engine';
import { createChildLogger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

const log = createChildLogger('backtest:runner');

// ─── Strategy Configurations to Test ────────────────────────────────────

const strategies: StrategyConfig[] = [
  // ═══ HOLD-TO-RESOLUTION STRATEGIES (Best for cross-platform arb) ═══
  // These buy YES on A + NO on B for < $1, then hold to resolution for guaranteed $1

  // Strategy 1: Wide spread, small size — safest
  {
    name: 'HTR: Conservative (3% spread)',
    minProfitBps: 300,
    maxPositionUsd: 200,
    feeRateBps: 100,         // 1% per leg (Polymarket ~2%, predict.fun ~1%)
    minDepthUsd: 50,
    slippagePct: 0.5,
    entryMode: 'aggressive',
    maxConcurrentPositions: 10,
    takeProfitBps: undefined,
    stopLossBps: undefined,
  },

  // Strategy 2: Medium spread, medium size
  {
    name: 'HTR: Moderate (2% spread)',
    minProfitBps: 200,
    maxPositionUsd: 400,
    feeRateBps: 100,
    minDepthUsd: 30,
    slippagePct: 0.3,
    entryMode: 'aggressive',
    maxConcurrentPositions: 15,
    takeProfitBps: undefined,
    stopLossBps: undefined,
  },

  // Strategy 3: Wide spread, large size — high conviction
  {
    name: 'HTR: High-Conviction (4% spread)',
    minProfitBps: 400,
    maxPositionUsd: 1000,
    feeRateBps: 100,
    minDepthUsd: 100,
    slippagePct: 0.5,
    entryMode: 'aggressive',
    maxConcurrentPositions: 5,
    takeProfitBps: undefined,
    stopLossBps: undefined,
  },

  // Strategy 4: Tight spread, low fees — volume play
  {
    name: 'HTR: Low-Fee Volume (1.5% spread)',
    minProfitBps: 150,
    maxPositionUsd: 500,
    feeRateBps: 50,          // 0.5% per leg (maker orders)
    minDepthUsd: 20,
    slippagePct: 0.2,
    entryMode: 'aggressive',
    maxConcurrentPositions: 20,
    takeProfitBps: undefined,
    stopLossBps: undefined,
  },

  // Strategy 5: Ultra-conservative, max size
  {
    name: 'HTR: Ultra-Conservative (5% spread)',
    minProfitBps: 500,
    maxPositionUsd: 2000,
    feeRateBps: 100,
    minDepthUsd: 200,
    slippagePct: 1.0,
    entryMode: 'aggressive',
    maxConcurrentPositions: 3,
    takeProfitBps: undefined,
    stopLossBps: undefined,
  },

  // Strategy 6: Balanced — the "recommended" config
  {
    name: 'HTR: Balanced (2.5% spread, $500)',
    minProfitBps: 250,
    maxPositionUsd: 500,
    feeRateBps: 75,          // 0.75% — blend of maker/taker
    minDepthUsd: 50,
    slippagePct: 0.3,
    entryMode: 'aggressive',
    maxConcurrentPositions: 10,
    takeProfitBps: undefined,
    stopLossBps: undefined,
  },
];

// ─── Report Generation ──────────────────────────────────────────────────

function generateReport(results: BacktestResult[]): string {
  const lines: string[] = [];
  const hr = '═'.repeat(80);
  const hr2 = '─'.repeat(80);

  lines.push(hr);
  lines.push('  PRED-ARB :: BACKTESTING PROFITABILITY REPORT');
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push(hr);
  lines.push('');

  // Summary table
  lines.push('┌─────────────────────────────────────┬────────┬────────┬────────┬────────┬────────┬────────┐');
  lines.push('│ Strategy                            │  P&L   │ Trades │Win Rate│ Sharpe │Max DD% │Ann Ret │');
  lines.push('├─────────────────────────────────────┼────────┼────────┼────────┼────────┼────────┼────────┤');

  for (const r of results) {
    const name = r.strategyName.padEnd(37).slice(0, 37);
    const pnl = formatNum(r.totalPnl, 6);
    const trades = String(r.totalTrades).padStart(6);
    const wr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const sharpe = r.sharpeRatio.toFixed(2).padStart(6);
    const dd = `${r.maxDrawdownPct.toFixed(1)}%`.padStart(6);
    const annRet = `${r.annualizedReturn.toFixed(0)}%`.padStart(6);
    lines.push(`│ ${name} │${pnl} │${trades} │${wr} │${sharpe} │${dd} │${annRet} │`);
  }

  lines.push('└─────────────────────────────────────┴────────┴────────┴────────┴────────┴────────┴────────┘');
  lines.push('');

  // Detailed results per strategy
  for (const r of results) {
    lines.push(hr2);
    lines.push(`  STRATEGY: ${r.strategyName.toUpperCase()}`);
    lines.push(hr2);
    lines.push('');
    lines.push('  Configuration:');
    lines.push(`    Min Profit:        ${r.config.minProfitBps} BPS (${(r.config.minProfitBps / 100).toFixed(1)}%)`);
    lines.push(`    Max Position:      $${r.config.maxPositionUsd}`);
    lines.push(`    Fee Rate:          ${r.config.feeRateBps} BPS per leg`);
    lines.push(`    Slippage:          ${r.config.slippagePct}%`);
    lines.push(`    Max Concurrent:    ${r.config.maxConcurrentPositions}`);
    lines.push(`    Take Profit:       ${r.config.takeProfitBps ? `${r.config.takeProfitBps} BPS` : 'Hold to resolution'}`);
    lines.push(`    Stop Loss:         ${r.config.stopLossBps ? `${r.config.stopLossBps} BPS` : 'None'}`);
    lines.push('');
    lines.push('  Performance:');
    lines.push(`    Total P&L:         ${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(2)}`);
    lines.push(`    Total Trades:      ${r.totalTrades}`);
    lines.push(`    Winners:           ${r.winners} (${r.winRate.toFixed(1)}%)`);
    lines.push(`    Losers:            ${r.losers}`);
    lines.push(`    Avg Win:           +$${r.avgWin.toFixed(2)}`);
    lines.push(`    Avg Loss:          -$${r.avgLoss.toFixed(2)}`);
    lines.push(`    Profit Factor:     ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`);
    lines.push('');
    lines.push('  Risk Metrics:');
    lines.push(`    Sharpe Ratio:      ${r.sharpeRatio.toFixed(3)}`);
    lines.push(`    Sortino Ratio:     ${r.sortinoRatio.toFixed(3)}`);
    lines.push(`    Max Drawdown:      $${r.maxDrawdown.toFixed(2)} (${r.maxDrawdownPct.toFixed(1)}%)`);
    lines.push(`    Total Fees:        $${r.totalFees.toFixed(2)}`);
    lines.push('');
    lines.push('  Returns:');
    lines.push(`    Return on Capital: ${r.returnPct.toFixed(2)}%`);
    lines.push(`    Annualized Return: ${r.annualizedReturn.toFixed(0)}%`);
    lines.push(`    Time Span:         ${r.timeSpanHours.toFixed(1)} hours`);
    lines.push(`    Pairs Evaluated:   ${r.pairsEvaluated}`);
    lines.push(`    Avg Hold Time:     ${r.avgHoldTime.toFixed(0)} snapshots (~${(r.avgHoldTime * 0.5).toFixed(0)} minutes)`);
    lines.push('');

    // Mini equity curve (ASCII)
    if (r.equityCurve.length > 0) {
      lines.push('  Equity Curve:');
      lines.push(`    ${drawAsciiChart(r.equityCurve, 60, 8)}`);
      lines.push('');
    }
  }

  // Recommendations
  lines.push(hr);
  lines.push('  RECOMMENDATIONS');
  lines.push(hr);
  lines.push('');

  const ranked = [...results]
    .filter(r => r.totalTrades > 0)
    .sort((a, b) => {
      // Score = Sharpe * sqrt(trades) * (pnl > 0 ? 1 : -1)
      const scoreA = a.sharpeRatio * Math.sqrt(a.totalTrades) * (a.totalPnl > 0 ? 1 : -0.5);
      const scoreB = b.sharpeRatio * Math.sqrt(b.totalTrades) * (b.totalPnl > 0 ? 1 : -0.5);
      return scoreB - scoreA;
    });

  if (ranked.length > 0) {
    lines.push(`  Best Strategy: ${ranked[0].strategyName}`);
    lines.push(`    - P&L: ${ranked[0].totalPnl >= 0 ? '+' : ''}$${ranked[0].totalPnl.toFixed(2)}`);
    lines.push(`    - Sharpe: ${ranked[0].sharpeRatio.toFixed(3)}`);
    lines.push(`    - Win Rate: ${ranked[0].winRate.toFixed(1)}%`);
    lines.push(`    - ${ranked[0].totalTrades} trades over ${ranked[0].timeSpanHours.toFixed(1)} hours`);
  }

  lines.push('');
  lines.push('  Key Findings:');

  const profitable = results.filter(r => r.totalPnl > 0);
  const unprofitable = results.filter(r => r.totalPnl <= 0);
  lines.push(`    - ${profitable.length}/${results.length} strategies were profitable`);

  const avgSpread = results.reduce((s, r) => s + r.config.minProfitBps, 0) / results.length;
  const profitableAvgSpread = profitable.length > 0
    ? profitable.reduce((s, r) => s + r.config.minProfitBps, 0) / profitable.length
    : 0;
  lines.push(`    - Average min spread across profitable strategies: ${profitableAvgSpread.toFixed(0)} BPS`);

  const avgFees = results.reduce((s, r) => s + r.totalFees, 0) / results.length;
  lines.push(`    - Average fees per strategy: $${avgFees.toFixed(2)}`);

  if (profitable.length > 0) {
    const bestWinRate = Math.max(...profitable.map(r => r.winRate));
    const bestSharpe = Math.max(...profitable.map(r => r.sharpeRatio));
    lines.push(`    - Best win rate: ${bestWinRate.toFixed(1)}%`);
    lines.push(`    - Best Sharpe ratio: ${bestSharpe.toFixed(3)}`);
  }

  lines.push('');
  lines.push('  Note: This backtest uses simulated historical data with');
  lines.push('  stochastic price models. Real performance may differ.');
  lines.push('  Fees assumed at 1% per leg (conservative). Lower fees');
  lines.push('  on maker orders could significantly improve results.');
  lines.push('');
  lines.push(hr);

  return lines.join('\n');
}

function formatNum(n: number, width: number): string {
  const s = `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(0)}`;
  return s.padStart(width);
}

function drawAsciiChart(data: number[], width: number, height: number): string {
  if (data.length === 0) return '';

  // Downsample to width
  const sampled: number[] = [];
  for (let i = 0; i < width; i++) {
    const idx = Math.floor((i / width) * data.length);
    sampled.push(data[idx]);
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  const rows: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const normalized = (sampled[col] - min) / range;
      const cellRow = normalized * (height - 1);
      if (Math.round(cellRow) === row) {
        line += sampled[col] >= 0 ? '█' : '▒';
      } else if (row === 0 && min < 0 && max > 0) {
        const zeroRow = (0 - min) / range * (height - 1);
        if (Math.round(zeroRow) === 0) line += '─';
        else line += ' ';
      } else {
        line += ' ';
      }
    }
    rows.push(`    ${line}`);
  }

  return rows.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  PRED-ARB :: Backtesting System\n');

  // Step 1: Fetch/generate data
  const fetcher = new BacktestDataFetcher();
  const dataset = await fetcher.fetchAndBuild({
    numSnapshots: 1000,     // ~8.3 hours of 30-second data
    intervalMs: 30_000,
    maxMarkets: 100,
  });

  const timeSpanHours = (dataset.endTime.getTime() - dataset.startTime.getTime()) / 3600000;
  console.log(`  Dataset: ${dataset.polymarketMarkets.length} Polymarket + ${dataset.predictfunMarkets.length} predict.fun markets`);
  console.log(`  Snapshots: ${dataset.snapshots.length} (${timeSpanHours.toFixed(1)} hours)\n`);

  // Step 2: Run backtests
  const engine = new BacktestEngine();
  const results = engine.runSweep(dataset, strategies);

  // Step 3: Generate report
  const report = generateReport(results);
  console.log(report);

  // Step 4: Save report
  const reportDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, `backtest-${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(reportPath, report);
  console.log(`\n  Report saved: ${reportPath}\n`);

  // Also save JSON results for further analysis
  const jsonPath = path.join(reportDir, `backtest-${new Date().toISOString().slice(0, 10)}.json`);
  const jsonResults = results.map(r => ({
    ...r,
    equityCurve: undefined,  // too large for JSON
    positions: r.positions.length,
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(jsonResults, null, 2));
  console.log(`  JSON data: ${jsonPath}\n`);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
