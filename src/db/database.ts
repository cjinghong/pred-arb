// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Database
// SQLite-backed persistence for trades, opportunities, and metrics
// ═══════════════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../utils/config';
import { createChildLogger } from '../utils/logger';
import {
  ArbitrageOpportunity,
  TradeRecord,
  TradeStatus,
  DashboardMetrics,
} from '../types';

const log = createChildLogger('db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.db.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    log.info('Database connected', { path: config.db.path });
  }
  return db;
}

export function initializeDatabase(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      leg_a_platform TEXT NOT NULL,
      leg_a_market_id TEXT NOT NULL,
      leg_a_question TEXT NOT NULL,
      leg_a_outcome TEXT NOT NULL,
      leg_a_price REAL NOT NULL,
      leg_b_platform TEXT NOT NULL,
      leg_b_market_id TEXT NOT NULL,
      leg_b_question TEXT NOT NULL,
      leg_b_outcome TEXT NOT NULL,
      leg_b_price REAL NOT NULL,
      expected_profit_usd REAL NOT NULL,
      expected_profit_bps REAL NOT NULL,
      max_size REAL NOT NULL,
      match_confidence REAL NOT NULL,
      executed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      leg_a_order_id TEXT,
      leg_a_platform TEXT,
      leg_a_market_id TEXT,
      leg_a_side TEXT,
      leg_a_price REAL,
      leg_a_size REAL,
      leg_a_filled_size REAL DEFAULT 0,
      leg_a_fees REAL DEFAULT 0,
      leg_b_order_id TEXT,
      leg_b_platform TEXT,
      leg_b_market_id TEXT,
      leg_b_side TEXT,
      leg_b_price REAL,
      leg_b_size REAL,
      leg_b_filled_size REAL DEFAULT 0,
      leg_b_fees REAL DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      expected_profit_usd REAL DEFAULT 0,
      realized_profit_usd REAL,
      fees REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      executed_at TEXT,
      settled_at TEXT,
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      market_id TEXT NOT NULL,
      question TEXT NOT NULL,
      outcome_prices TEXT NOT NULL,
      volume REAL,
      liquidity REAL,
      captured_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_opportunities_discovered ON opportunities(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_captured ON market_snapshots(captured_at);
  `);

  log.info('Database schema initialized');
}

// ─── Opportunity CRUD ────────────────────────────────────────────────────

export function insertOpportunity(opp: ArbitrageOpportunity): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO opportunities (
      id, strategy_id, discovered_at,
      leg_a_platform, leg_a_market_id, leg_a_question, leg_a_outcome, leg_a_price,
      leg_b_platform, leg_b_market_id, leg_b_question, leg_b_outcome, leg_b_price,
      expected_profit_usd, expected_profit_bps, max_size, match_confidence, executed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opp.id, opp.strategyId, opp.discoveredAt.toISOString(),
    opp.legA.platform, opp.legA.marketId, opp.legA.marketQuestion, opp.legA.outcome, opp.legA.price,
    opp.legB.platform, opp.legB.marketId, opp.legB.marketQuestion, opp.legB.outcome, opp.legB.price,
    opp.expectedProfitUsd, opp.expectedProfitBps, opp.maxSize, opp.matchConfidence,
    opp.executed ? 1 : 0,
  );
}

export function markOpportunityExecuted(id: string): void {
  getDb().prepare('UPDATE opportunities SET executed = 1 WHERE id = ?').run(id);
}

export function getRecentOpportunities(limit = 50): ArbitrageOpportunity[] {
  const rows = getDb().prepare(
    'SELECT * FROM opportunities ORDER BY discovered_at DESC LIMIT ?'
  ).all(limit) as Record<string, unknown>[];

  return rows.map(rowToOpportunity);
}

// ─── Trade CRUD ──────────────────────────────────────────────────────────

export function insertTrade(trade: TradeRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO trades (
      id, opportunity_id, strategy_id, status,
      leg_a_order_id, leg_a_platform, leg_a_market_id, leg_a_side, leg_a_price, leg_a_size,
      leg_b_order_id, leg_b_platform, leg_b_market_id, leg_b_side, leg_b_price, leg_b_size,
      total_cost_usd, expected_profit_usd, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id, trade.opportunityId, trade.strategyId, trade.status,
    trade.legA?.id, trade.legA?.platform, trade.legA?.marketId, trade.legA?.side,
    trade.legA?.price, trade.legA?.size,
    trade.legB?.id, trade.legB?.platform, trade.legB?.marketId, trade.legB?.side,
    trade.legB?.price, trade.legB?.size,
    trade.totalCostUsd, trade.expectedProfitUsd, trade.notes,
  );
}

export function updateTradeStatus(
  tradeId: string,
  status: TradeStatus,
  updates?: Partial<{ realizedProfitUsd: number; fees: number; notes: string }>
): void {
  const db = getDb();
  const sets = ['status = ?'];
  const params: unknown[] = [status];

  if (status === 'EXECUTED') {
    sets.push('executed_at = datetime("now")');
  }
  if (updates?.realizedProfitUsd !== undefined) {
    sets.push('realized_profit_usd = ?');
    params.push(updates.realizedProfitUsd);
  }
  if (updates?.fees !== undefined) {
    sets.push('fees = ?');
    params.push(updates.fees);
  }
  if (updates?.notes !== undefined) {
    sets.push('notes = ?');
    params.push(updates.notes);
  }

  params.push(tradeId);
  db.prepare(`UPDATE trades SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getRecentTrades(limit = 100): Record<string, unknown>[] {
  return getDb().prepare(
    'SELECT * FROM trades ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as Record<string, unknown>[];
}

// ─── Dashboard Metrics ───────────────────────────────────────────────────

export function getDashboardMetrics(): DashboardMetrics {
  const db = getDb();

  const allTime = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(realized_profit_usd), 0) as totalProfit,
      COALESCE(SUM(fees), 0) as totalFees,
      COUNT(CASE WHEN realized_profit_usd > 0 THEN 1 END) as wins
    FROM trades WHERE status = 'EXECUTED'
  `).get() as Record<string, number>;

  const last24h = db.prepare(`
    SELECT COALESCE(SUM(realized_profit_usd), 0) as pnl
    FROM trades
    WHERE status = 'EXECUTED' AND executed_at >= datetime('now', '-1 day')
  `).get() as { pnl: number };

  const last7d = db.prepare(`
    SELECT COALESCE(SUM(realized_profit_usd), 0) as pnl
    FROM trades
    WHERE status = 'EXECUTED' AND executed_at >= datetime('now', '-7 days')
  `).get() as { pnl: number };

  const totalTrades = allTime.total || 0;
  const totalProfit = allTime.totalProfit || 0;

  return {
    pnl24h: last24h.pnl,
    pnl7d: last7d.pnl,
    pnlAllTime: totalProfit,
    winRate: totalTrades > 0 ? (allTime.wins / totalTrades) * 100 : 0,
    totalTrades,
    avgProfitPerTrade: totalTrades > 0 ? totalProfit / totalTrades : 0,
    sharpeRatio: 0, // TODO: implement rolling Sharpe
    currentExposure: 0, // filled by portfolio manager
    maxDrawdown: 0, // TODO: implement drawdown tracking
  };
}

// ─── Bot State KV ────────────────────────────────────────────────────────

export function setBotStateKV(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function getBotStateKV(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function rowToOpportunity(row: Record<string, unknown>): ArbitrageOpportunity {
  return {
    id: row.id as string,
    strategyId: row.strategy_id as string,
    discoveredAt: new Date(row.discovered_at as string),
    legA: {
      platform: row.leg_a_platform as 'polymarket' | 'predictfun',
      marketId: row.leg_a_market_id as string,
      marketQuestion: row.leg_a_question as string,
      outcome: row.leg_a_outcome as 'YES' | 'NO',
      outcomeIndex: row.leg_a_outcome === 'YES' ? 0 : 1,
      price: row.leg_a_price as number,
      availableSize: 0,
      orderBook: null as unknown as import('../types').OrderBook,
    },
    legB: {
      platform: row.leg_b_platform as 'polymarket' | 'predictfun',
      marketId: row.leg_b_market_id as string,
      marketQuestion: row.leg_b_question as string,
      outcome: row.leg_b_outcome as 'YES' | 'NO',
      outcomeIndex: row.leg_b_outcome === 'YES' ? 0 : 1,
      price: row.leg_b_price as number,
      availableSize: 0,
      orderBook: null as unknown as import('../types').OrderBook,
    },
    expectedProfitUsd: row.expected_profit_usd as number,
    expectedProfitBps: row.expected_profit_bps as number,
    maxSize: row.max_size as number,
    matchConfidence: row.match_confidence as number,
    executed: (row.executed as number) === 1,
  };
}
