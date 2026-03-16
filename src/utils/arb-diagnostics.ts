// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Arb Diagnostics
// Captures full diagnostic snapshots when arb opportunities are detected.
// Output is human-readable text, logged to file + console, designed to be
// copy-pasted for offline analysis.
//
// Each snapshot captures:
//   - Pair metadata (platforms, questions, match info, outcome alignment)
//   - Raw orderbook states at detection time (both sides, pre/post-flip)
//   - Book walking trace (which levels consumed, fees per level)
//   - Final sizing, profit math, and risk thresholds
// ═══════════════════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from './logger';
import { OrderBook, PriceLevel, ArbitrageOpportunity, Platform } from '../types';
import { MarketPair } from '../matcher/market-matcher';
import { SportsMarketInfo } from '../discovery/types';

const log = createChildLogger('arb-diagnostics');

// ─── Types ────────────────────────────────────────────────────────────────

export interface BookWalkLevel {
  levelIdx: number;
  priceA: number;
  priceB: number;
  chunkSize: number;
  totalCostPerShare: number;
  feePerShare: number;
  profitPerShare: number;
  profitBps: number;
  cumulativeSize: number;
  cumulativeCostA: number;
  cumulativeCostB: number;
  cumulativeFees: number;
}

export interface ArbDiagnosticSnapshot {
  // ── Identity ──
  opportunityId: string;
  timestamp: string;        // ISO 8601
  timestampUnix: number;    // ms since epoch

  // ── Pair metadata ──
  pairId: string;
  matchMethod: string;
  matchConfidence: number;
  outcomesInverted: boolean;

  // ── Market A ──
  marketA: {
    platform: Platform;
    id: string;
    question: string;
    slug: string;
    outcomes: string[];
    outcomePrices: number[];
    endDate: string | null;
    sportsInfo: SportsMarketInfo | null;
  };

  // ── Market B ──
  marketB: {
    platform: Platform;
    id: string;
    question: string;
    slug: string;
    outcomes: string[];
    outcomePrices: number[];
    endDate: string | null;
    sportsInfo: SportsMarketInfo | null;
  };

  // ── Orderbook A (raw, always YES outcomeIndex=0) ──
  bookA: {
    bids: PriceLevel[];
    asks: PriceLevel[];
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
    timestamp: string;
  };

  // ── Orderbook B (raw, before any inversion flip) ──
  bookBRaw: {
    bids: PriceLevel[];
    asks: PriceLevel[];
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
    timestamp: string;
  };

  // ── Orderbook B (effective — after flip if inverted) ──
  bookBEffective: {
    bids: PriceLevel[];
    asks: PriceLevel[];
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
    flipped: boolean;
  };

  // ── Arb direction ──
  direction: 'D1_buyYesA_buyNoB' | 'D2_buyNoA_buyYesB';

  // ── Leg details (what would be executed) ──
  legA: {
    outcome: 'YES' | 'NO';
    outcomeIndex: number;
    price: number;
    nativeOutcome: string;   // what the platform sees
  };
  legB: {
    outcome: 'YES' | 'NO';
    outcomeIndex: number;
    price: number;
    nativeOutcome: string;   // what the platform sees (may differ if inverted)
  };

  // ── Book walk trace ──
  bookWalkLevels: BookWalkLevel[];

  // ── Sizing ──
  size: number;
  maxPositionUsd: number;

  // ── Profit math ──
  avgPriceA: number;
  avgPriceB: number;
  totalCost: number;
  grossProfitPerShare: number;
  totalFees: number;
  feeBreakdown: {
    platformA: { platform: Platform; feePerShare: number; totalFee: number };
    platformB: { platform: Platform; feePerShare: number; totalFee: number };
  };
  netProfitPerShare: number;
  netProfitTotal: number;
  profitBps: number;

  // ── Risk thresholds ──
  dynamicMinProfitBps: number;
  configMinProfitBps: number;

  // ── Real-world outcome mapping ──
  outcomeMapping: {
    ifTeamAWins: {
      legAResolves: string;    // e.g., "YES → $1.00" or "NO → $0.00"
      legBResolves: string;
      payout: number;
      cost: number;
      netProfit: number;
    };
    ifTeamBWins: {
      legAResolves: string;
      legBResolves: string;
      payout: number;
      cost: number;
      netProfit: number;
    };
    teamA: string;
    teamB: string;
  } | null;  // null if not a sports market

  // ── Diagnostics version ──
  diagnosticsVersion: string;
}

// ─── Diagnostics Versioning ───────────────────────────────────────────────
// Bump this version whenever diagnostic-related code changes.
// Each version gets its own output files so you can identify which code produced which report.
export const DIAGNOSTICS_VERSION = 'v6';

// ─── Snapshot File Writer ─────────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DIAG_FILE = path.join(DATA_DIR, `arb-diagnostics-${DIAGNOSTICS_VERSION}.jsonl`);
const DIAG_TEXT_FILE = path.join(DATA_DIR, `arb-diagnostics-${DIAGNOSTICS_VERSION}.txt`);

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Write a diagnostic snapshot to both JSONL (machine-readable) and TXT (human-readable).
 */
export function writeDiagnosticSnapshot(snapshot: ArbDiagnosticSnapshot): void {
  ensureDataDir();

  // JSONL — one JSON object per line for easy parsing
  try {
    fs.appendFileSync(DIAG_FILE, JSON.stringify(snapshot) + '\n');
  } catch (err) {
    log.error('Failed to write JSONL diagnostic', { error: (err as Error).message });
  }

  // Human-readable text
  try {
    const text = formatSnapshotText(snapshot);
    fs.appendFileSync(DIAG_TEXT_FILE, text + '\n');
    log.info('Diagnostic snapshot written', {
      file: DIAG_TEXT_FILE,
      opportunityId: snapshot.opportunityId,
    });
  } catch (err) {
    log.error('Failed to write text diagnostic', { error: (err as Error).message });
  }
}

// ─── Human-Readable Formatter ─────────────────────────────────────────────

function fmtPrice(p: number | null): string {
  if (p === null) return 'NULL';
  return `$${p.toFixed(4)}`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtBps(n: number): string {
  return `${n.toFixed(1)} bps`;
}

function fmtLevel(l: PriceLevel): string {
  return `${fmtPrice(l.price)} × ${l.size.toFixed(2)}`;
}

function fmtLevels(levels: PriceLevel[], max: number = 5): string {
  if (levels.length === 0) return '  (empty)';
  return levels.slice(0, max)
    .map((l, i) => `  [${i}] ${fmtLevel(l)}`)
    .join('\n') + (levels.length > max ? `\n  ... +${levels.length - max} more levels` : '');
}

export function formatSnapshotText(s: ArbDiagnosticSnapshot): string {
  const divider = '═'.repeat(80);
  const subdiv = '─'.repeat(60);

  let out = `
${divider}
ARB DIAGNOSTIC SNAPSHOT (${s.diagnosticsVersion || 'unknown'})
${divider}
ID:        ${s.opportunityId}
Version:   ${s.diagnosticsVersion || 'unknown'}
Timestamp: ${s.timestamp}
Unix:      ${s.timestampUnix}

${subdiv}
PAIR METADATA
${subdiv}
Pair ID:           ${s.pairId}
Match Method:      ${s.matchMethod}
Match Confidence:  ${s.matchConfidence}
Outcomes Inverted: ${s.outcomesInverted}

MARKET A [${s.marketA.platform}]
  ID:       ${s.marketA.id}
  Question: ${s.marketA.question}
  Slug:     ${s.marketA.slug}
  Outcomes: ${JSON.stringify(s.marketA.outcomes)}
  Prices:   ${s.marketA.outcomePrices.map(p => p.toFixed(4)).join(' / ')}
  End Date: ${s.marketA.endDate || 'N/A'}`;

  if (s.marketA.sportsInfo) {
    const si = s.marketA.sportsInfo;
    out += `
  Sports:   ${si.teamA} vs ${si.teamB} | ${si.league} | ${si.marketType} | ${si.gameDate}
  YES Team: ${si.yesTeam || 'UNKNOWN'}${si.yesTeamRaw ? ` (raw: "${si.yesTeamRaw}")` : ''}
  MatchKey: ${si.matchKey}`;
  }

  out += `

MARKET B [${s.marketB.platform}]
  ID:       ${s.marketB.id}
  Question: ${s.marketB.question}
  Slug:     ${s.marketB.slug}
  Outcomes: ${JSON.stringify(s.marketB.outcomes)}
  Prices:   ${s.marketB.outcomePrices.map(p => p.toFixed(4)).join(' / ')}
  End Date: ${s.marketB.endDate || 'N/A'}`;

  if (s.marketB.sportsInfo) {
    const si = s.marketB.sportsInfo;
    out += `
  Sports:   ${si.teamA} vs ${si.teamB} | ${si.league} | ${si.marketType} | ${si.gameDate}
  YES Team: ${si.yesTeam || 'UNKNOWN'}${si.yesTeamRaw ? ` (raw: "${si.yesTeamRaw}")` : ''}
  MatchKey: ${si.matchKey}`;
  }

  out += `

${subdiv}
ORDERBOOKS AT DETECTION TIME
${subdiv}

Book A [${s.marketA.platform}] (YES outcome, raw)
  Best Bid: ${fmtPrice(s.bookA.bestBid)}  |  Best Ask: ${fmtPrice(s.bookA.bestAsk)}  |  Spread: ${s.bookA.spread !== null ? fmtPrice(s.bookA.spread) : 'N/A'}
  Captured: ${s.bookA.timestamp}
  BIDS (buy YES):
${fmtLevels(s.bookA.bids)}
  ASKS (sell YES):
${fmtLevels(s.bookA.asks)}

Book B [${s.marketB.platform}] (YES outcome, RAW — before any flip)
  Best Bid: ${fmtPrice(s.bookBRaw.bestBid)}  |  Best Ask: ${fmtPrice(s.bookBRaw.bestAsk)}  |  Spread: ${s.bookBRaw.spread !== null ? fmtPrice(s.bookBRaw.spread) : 'N/A'}
  Captured: ${s.bookBRaw.timestamp}
  BIDS (buy YES):
${fmtLevels(s.bookBRaw.bids)}
  ASKS (sell YES):
${fmtLevels(s.bookBRaw.asks)}`;

  if (s.outcomesInverted) {
    out += `

Book B [${s.marketB.platform}] (EFFECTIVE — after outcome inversion flip)
  NOTE: B's YES book was flipped because outcomes are inverted.
        B's raw asks (sell YES) → effective bids (price = 1 - rawAskPrice)
        B's raw bids (buy YES) → effective asks (price = 1 - rawBidPrice)
  Best Bid: ${fmtPrice(s.bookBEffective.bestBid)}  |  Best Ask: ${fmtPrice(s.bookBEffective.bestAsk)}
  BIDS (effective):
${fmtLevels(s.bookBEffective.bids)}
  ASKS (effective):
${fmtLevels(s.bookBEffective.asks)}`;
  }

  out += `

${subdiv}
ARB ANALYSIS
${subdiv}

Direction: ${s.direction}

Leg A: Buy ${s.legA.outcome} on ${s.marketA.platform} @ ${fmtPrice(s.legA.price)}
  Native outcome:  ${s.legA.nativeOutcome}
  Outcome index:   ${s.legA.outcomeIndex}

Leg B: Buy ${s.legB.outcome} on ${s.marketB.platform} @ ${fmtPrice(s.legB.price)}
  Native outcome:  ${s.legB.nativeOutcome}
  Outcome index:   ${s.legB.outcomeIndex}

${subdiv}
BOOK WALK TRACE
${subdiv}`;

  if (s.bookWalkLevels.length === 0) {
    out += '\n  (no levels walked — should not happen for a valid opportunity)';
  } else {
    out += `
  Step | PriceA   | PriceB   | Chunk   | Cost/sh  | Fee/sh   | Profit/sh | ProfitBps | CumSize  | CumCostA  | CumCostB  | CumFees`;
    out += `
  ${'-'.repeat(140)}`;
    for (const lvl of s.bookWalkLevels) {
      out += `
  ${String(lvl.levelIdx).padStart(4)} | ${fmtPrice(lvl.priceA).padStart(8)} | ${fmtPrice(lvl.priceB).padStart(8)} | ${lvl.chunkSize.toFixed(2).padStart(7)} | ${fmtPrice(lvl.totalCostPerShare).padStart(8)} | ${fmtPrice(lvl.feePerShare).padStart(8)} | ${fmtPrice(lvl.profitPerShare).padStart(9)} | ${fmtBps(lvl.profitBps).padStart(9)} | ${lvl.cumulativeSize.toFixed(2).padStart(8)} | ${fmtUsd(lvl.cumulativeCostA).padStart(9)} | ${fmtUsd(lvl.cumulativeCostB).padStart(9)} | ${fmtUsd(lvl.cumulativeFees).padStart(7)}`;
    }
  }

  out += `

${subdiv}
PROFIT CALCULATION
${subdiv}

Size:                   ${s.size.toFixed(4)} shares
Max Position USD:       ${fmtUsd(s.maxPositionUsd)}

Avg Price A:            ${fmtPrice(s.avgPriceA)}
Avg Price B:            ${fmtPrice(s.avgPriceB)}
Total Cost Per Share:   ${fmtPrice(s.avgPriceA + s.avgPriceB)}
Total Cost (all):       ${fmtUsd(s.totalCost)}

Gross Profit/Share:     ${fmtPrice(s.grossProfitPerShare)}  (= $1.00 - ${fmtPrice(s.avgPriceA)} - ${fmtPrice(s.avgPriceB)})

Fee Breakdown:
  ${s.feeBreakdown.platformA.platform}: ${fmtPrice(s.feeBreakdown.platformA.feePerShare)}/share × ${s.size.toFixed(2)} = ${fmtUsd(s.feeBreakdown.platformA.totalFee)}
  ${s.feeBreakdown.platformB.platform}: ${fmtPrice(s.feeBreakdown.platformB.feePerShare)}/share × ${s.size.toFixed(2)} = ${fmtUsd(s.feeBreakdown.platformB.totalFee)}
  Total Fees:           ${fmtUsd(s.totalFees)}

Net Profit/Share:       ${fmtPrice(s.netProfitPerShare)}  (= gross - fees)
Net Profit Total:       ${fmtUsd(s.netProfitTotal)}
Profit BPS:             ${fmtBps(s.profitBps)}

Thresholds:
  Config Min Profit:    ${fmtBps(s.configMinProfitBps)}
  Dynamic Min Profit:   ${fmtBps(s.dynamicMinProfitBps)}
  Passed:               ${s.profitBps >= s.dynamicMinProfitBps ? 'YES ✓' : 'NO ✗'}`;

  if (s.outcomeMapping) {
    const om = s.outcomeMapping;
    out += `

${subdiv}
OUTCOME MAPPING (HEDGE VERIFICATION)
${subdiv}

Teams: ${om.teamA} vs ${om.teamB}

If ${om.teamA} wins:
  Leg A: ${om.ifTeamAWins.legAResolves}
  Leg B: ${om.ifTeamAWins.legBResolves}
  Payout: ${fmtUsd(om.ifTeamAWins.payout)}  |  Cost: ${fmtUsd(om.ifTeamAWins.cost)}  |  Net: ${fmtUsd(om.ifTeamAWins.netProfit)}

If ${om.teamB} wins:
  Leg A: ${om.ifTeamBWins.legAResolves}
  Leg B: ${om.ifTeamBWins.legBResolves}
  Payout: ${fmtUsd(om.ifTeamBWins.payout)}  |  Cost: ${fmtUsd(om.ifTeamBWins.cost)}  |  Net: ${fmtUsd(om.ifTeamBWins.netProfit)}

Hedged: ${
      om.ifTeamAWins.netProfit < 0 || om.ifTeamBWins.netProfit < 0
        ? `🚨 DIRECTIONAL BET — ONE SCENARIO IS A LOSS! Team A win: ${fmtUsd(om.ifTeamAWins.netProfit)}, Team B win: ${fmtUsd(om.ifTeamBWins.netProfit)}`
        : Math.abs(om.ifTeamAWins.netProfit - om.ifTeamBWins.netProfit) < 0.01
          ? 'YES ✓ (same profit either way)'
          : `⚠ UNEVEN — Team A win: ${fmtUsd(om.ifTeamAWins.netProfit)}, Team B win: ${fmtUsd(om.ifTeamBWins.netProfit)}`
    }`;
  }

  out += `

${divider}
END SNAPSHOT
${divider}
`;

  return out;
}

// ─── Snapshot Builder ─────────────────────────────────────────────────────

export interface BuildSnapshotParams {
  opportunity: ArbitrageOpportunity;
  pair: MarketPair;
  direction: 'D1' | 'D2';

  // Raw books at detection time
  bookAYes: OrderBook;
  bookBRaw: OrderBook;     // before any flip
  bookBEffective: OrderBook; // after flip (same as bookBRaw if not inverted)

  // Walk trace
  bookWalkLevels: BookWalkLevel[];

  // Fee breakdown
  feePerShareA: number;
  feePerShareB: number;

  // Thresholds
  dynamicMinProfitBps: number;
  configMinProfitBps: number;

  // The native outcome labels for execution
  bOutcomeForYes: string;
  bOutcomeForNo: string;
}

export function buildDiagnosticSnapshot(p: BuildSnapshotParams): ArbDiagnosticSnapshot {
  const opp = p.opportunity;
  const now = new Date();

  const sportsInfoA = (p.pair.marketA as { sportsInfo?: SportsMarketInfo }).sportsInfo || null;
  const sportsInfoB = (p.pair.marketB as { sportsInfo?: SportsMarketInfo }).sportsInfo || null;

  const size = opp.maxSize;
  const avgPriceA = opp.legA.price;
  const avgPriceB = opp.legB.price;
  const totalCost = (avgPriceA + avgPriceB) * size;
  const grossProfitPerShare = 1 - avgPriceA - avgPriceB;
  const totalFeeA = p.feePerShareA * size;
  const totalFeeB = p.feePerShareB * size;
  const totalFees = totalFeeA + totalFeeB;
  const netProfitPerShare = grossProfitPerShare - p.feePerShareA - p.feePerShareB;
  const netProfitTotal = netProfitPerShare * size;
  const profitBps = totalCost > 0 ? (netProfitTotal / totalCost) * 10000 : 0;

  // Build outcome mapping for sports markets.
  // This traces EXACTLY what happens in each real-world scenario to verify the hedge.
  let outcomeMapping: ArbDiagnosticSnapshot['outcomeMapping'] = null;
  if (sportsInfoA && sportsInfoB) {
    const yesTeamA = sportsInfoA.yesTeam || sportsInfoA.teamA;
    const yesTeamB = sportsInfoB.yesTeam || sportsInfoB.teamA;
    const inverted = p.pair.outcomesInverted || false;

    const legAOutcome = opp.legA.outcome as 'YES' | 'NO';
    const legBOutcome = opp.legB.outcome as 'YES' | 'NO';

    // Use Polymarket's outcomes as canonical team names (always has team names, not Yes/No)
    const polyMarket = p.pair.marketA.platform === 'polymarket' ? p.pair.marketA : p.pair.marketB;
    const team1 = polyMarket.outcomes?.[0] || sportsInfoA.teamA;
    const team2 = polyMarket.outcomes?.[1] || sportsInfoA.teamB;

    // Determine how each leg resolves in each real-world scenario.
    // Key insight: we must reason about which REAL-WORLD team each leg pays $1 for,
    // taking outcomesInverted into account.
    //
    // Polymarket (A): YES=team1, NO=team2 (always, by convention)
    // Kalshi (B):
    //   If NOT inverted: YES also refers to team1 → NO=team2
    //   If inverted: YES refers to team2 → NO=team1

    // Leg A payout: simple — based on A's yesTeam
    // Leg A buys legAOutcome on A. A's YES = yesTeamA.
    // If legAOutcome=YES: pays $1 when yesTeamA wins
    // If legAOutcome=NO:  pays $1 when yesTeamA LOSES
    const legAPayIfTeam1Wins = (legAOutcome === 'YES')
      ? 1.0   // YES on team1 market → team1 wins → $1
      : 0.0;  // NO on team1 market → team1 wins → $0
    const legAPayIfTeam2Wins = 1.0 - legAPayIfTeam1Wins;

    // Leg B payout: must account for inversion
    // If NOT inverted: B's YES = same team as A's YES (team1)
    //   legBOutcome=YES → $1 when team1 wins; legBOutcome=NO → $1 when team2 wins
    // If inverted: B's YES = opposite team (team2)
    //   legBOutcome=YES → $1 when team2 wins; legBOutcome=NO → $1 when team1 wins
    let legBPayIfTeam1Wins: number;
    if (!inverted) {
      legBPayIfTeam1Wins = (legBOutcome === 'YES') ? 1.0 : 0.0;
    } else {
      // Inverted: B's YES = team2
      legBPayIfTeam1Wins = (legBOutcome === 'YES') ? 0.0 : 1.0;
    }
    const legBPayIfTeam2Wins = 1.0 - legBPayIfTeam1Wins;

    const payoutIfTeam1Wins = (legAPayIfTeam1Wins + legBPayIfTeam1Wins) * size;
    const payoutIfTeam2Wins = (legAPayIfTeam2Wins + legBPayIfTeam2Wins) * size;
    const netIfTeam1Wins = payoutIfTeam1Wins - totalCost - totalFees;
    const netIfTeam2Wins = payoutIfTeam2Wins - totalCost - totalFees;

    outcomeMapping = {
      teamA: team1,
      teamB: team2,
      ifTeamAWins: {
        legAResolves: `${legAOutcome} → $${legAPayIfTeam1Wins.toFixed(2)} (${opp.legA.platform}, yesTeam=${yesTeamA})`,
        legBResolves: `${legBOutcome} → $${legBPayIfTeam1Wins.toFixed(2)} (${opp.legB.platform}, yesTeam=${yesTeamB}${inverted ? ', INVERTED' : ''})`,
        payout: payoutIfTeam1Wins,
        cost: totalCost,
        netProfit: netIfTeam1Wins,
      },
      ifTeamBWins: {
        legAResolves: `${legAOutcome} → $${legAPayIfTeam2Wins.toFixed(2)} (${opp.legA.platform}, yesTeam=${yesTeamA})`,
        legBResolves: `${legBOutcome} → $${legBPayIfTeam2Wins.toFixed(2)} (${opp.legB.platform}, yesTeam=${yesTeamB}${inverted ? ', INVERTED' : ''})`,
        payout: payoutIfTeam2Wins,
        cost: totalCost,
        netProfit: netIfTeam2Wins,
      },
    };
  }

  return {
    diagnosticsVersion: DIAGNOSTICS_VERSION,
    opportunityId: opp.id,
    timestamp: now.toISOString(),
    timestampUnix: now.getTime(),

    pairId: p.pair.pairId,
    matchMethod: p.pair.matchMethod,
    matchConfidence: p.pair.confidence,
    outcomesInverted: p.pair.outcomesInverted || false,

    marketA: {
      platform: p.pair.marketA.platform,
      id: p.pair.marketA.id,
      question: p.pair.marketA.question,
      slug: p.pair.marketA.slug,
      outcomes: p.pair.marketA.outcomes,
      outcomePrices: p.pair.marketA.outcomePrices,
      endDate: p.pair.marketA.endDate?.toISOString() || null,
      sportsInfo: sportsInfoA,
    },

    marketB: {
      platform: p.pair.marketB.platform,
      id: p.pair.marketB.id,
      question: p.pair.marketB.question,
      slug: p.pair.marketB.slug,
      outcomes: p.pair.marketB.outcomes,
      outcomePrices: p.pair.marketB.outcomePrices,
      endDate: p.pair.marketB.endDate?.toISOString() || null,
      sportsInfo: sportsInfoB,
    },

    bookA: {
      bids: p.bookAYes.bids.slice(0, 10),
      asks: p.bookAYes.asks.slice(0, 10),
      bestBid: p.bookAYes.bestBid,
      bestAsk: p.bookAYes.bestAsk,
      spread: p.bookAYes.spread,
      timestamp: p.bookAYes.timestamp.toISOString(),
    },

    bookBRaw: {
      bids: p.bookBRaw.bids.slice(0, 10),
      asks: p.bookBRaw.asks.slice(0, 10),
      bestBid: p.bookBRaw.bestBid,
      bestAsk: p.bookBRaw.bestAsk,
      spread: p.bookBRaw.spread,
      timestamp: p.bookBRaw.timestamp.toISOString(),
    },

    bookBEffective: {
      bids: p.bookBEffective.bids.slice(0, 10),
      asks: p.bookBEffective.asks.slice(0, 10),
      bestBid: p.bookBEffective.bestBid,
      bestAsk: p.bookBEffective.bestAsk,
      spread: p.bookBEffective.spread,
      flipped: p.pair.outcomesInverted || false,
    },

    direction: p.direction === 'D1' ? 'D1_buyYesA_buyNoB' : 'D2_buyNoA_buyYesB',

    legA: {
      outcome: opp.legA.outcome as 'YES' | 'NO',
      outcomeIndex: opp.legA.outcomeIndex,
      price: opp.legA.price,
      nativeOutcome: `${opp.legA.outcome} on ${opp.legA.platform} (${p.pair.marketA.question.slice(0, 50)})`,
    },

    legB: {
      outcome: opp.legB.outcome as 'YES' | 'NO',
      outcomeIndex: opp.legB.outcomeIndex,
      price: opp.legB.price,
      nativeOutcome: `${opp.legB.outcome} on ${opp.legB.platform} (${p.pair.marketB.question.slice(0, 50)})`,
    },

    bookWalkLevels: p.bookWalkLevels,

    size,
    maxPositionUsd: 500, // will be overridden by caller

    avgPriceA,
    avgPriceB,
    totalCost,
    grossProfitPerShare,
    totalFees,
    feeBreakdown: {
      platformA: {
        platform: opp.legA.platform,
        feePerShare: p.feePerShareA,
        totalFee: totalFeeA,
      },
      platformB: {
        platform: opp.legB.platform,
        feePerShare: p.feePerShareB,
        totalFee: totalFeeB,
      },
    },
    netProfitPerShare,
    netProfitTotal,
    profitBps,

    dynamicMinProfitBps: p.dynamicMinProfitBps,
    configMinProfitBps: p.configMinProfitBps,

    outcomeMapping,
  };
}
