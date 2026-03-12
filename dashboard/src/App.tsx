import React, { useState, useEffect, useCallback, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Retro-Futuristic Bloomberg Terminal Dashboard
// ═══════════════════════════════════════════════════════════════════════════

interface Metrics {
  pnl24h: number;
  pnl7d: number;
  pnlAllTime: number;
  winRate: number;
  totalTrades: number;
  avgProfitPerTrade: number;
  sharpeRatio: number;
  currentExposure: number;
  maxDrawdown: number;
}

interface Trade {
  id: string;
  opportunity_id: string;
  strategy_id: string;
  status: string;
  leg_a_platform: string;
  leg_a_market_id: string;
  leg_a_side: string;
  leg_a_price: number;
  leg_b_platform: string;
  leg_b_market_id: string;
  leg_b_side: string;
  leg_b_price: number;
  expected_profit_usd: number;
  realized_profit_usd: number | null;
  fees: number;
  created_at: string;
  notes: string;
}

interface Opportunity {
  id: string;
  strategyId: string;
  discoveredAt: string;
  legA: { platform: string; marketQuestion: string; outcome: string; price: number };
  legB: { platform: string; marketQuestion: string; outcome: string; price: number };
  expectedProfitUsd: number;
  expectedProfitBps: number;
  matchConfidence: number;
  executed: boolean;
}

interface BotStatus {
  state: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';
  uptime: number;
  timestamp: string;
}

interface WsMessage {
  type: string;
  data: {
    state?: string;
    metrics?: Metrics;
    recentTrades?: Trade[];
    recentOpportunities?: Opportunity[];
    durationMs?: number;
    opportunitiesFound?: number;
  };
  timestamp: string;
}

// ─── Styles ──────────────────────────────────────────────────────────────

const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #0f1117;
    --bg-panel: #111520;
    --bg-panel-header: #161b2e;
    --border: #1e2640;
    --border-bright: #2a3558;
    --text-primary: #e8ecf4;
    --text-secondary: #8892a8;
    --text-dim: #4a5568;
    --accent-amber: #ffb800;
    --accent-amber-dim: #c49000;
    --accent-green: #00ff88;
    --accent-green-dim: #009955;
    --accent-red: #ff3366;
    --accent-red-dim: #cc1144;
    --accent-cyan: #00d4ff;
    --accent-blue: #4488ff;
    --accent-purple: #aa66ff;
    --glow-amber: 0 0 20px rgba(255, 184, 0, 0.15);
    --glow-green: 0 0 20px rgba(0, 255, 136, 0.15);
    --glow-red: 0 0 20px rgba(255, 51, 102, 0.15);
    --font-mono: 'JetBrains Mono', 'Share Tech Mono', monospace;
  }

  body {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    height: 100vh;
  }

  #root { height: 100vh; display: flex; flex-direction: column; }

  /* ─── Scanline Effect ─────────────────────────────────────────────── */
  .scanlines {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 1000;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0, 0, 0, 0.03) 2px,
      rgba(0, 0, 0, 0.03) 4px
    );
  }

  /* ─── Header ──────────────────────────────────────────────────────── */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 16px;
    background: linear-gradient(180deg, #161b2e 0%, #111520 100%);
    border-bottom: 1px solid var(--border-bright);
    min-height: 44px;
  }

  .header-left { display: flex; align-items: center; gap: 16px; }
  .header-right { display: flex; align-items: center; gap: 12px; }

  .logo {
    font-size: 16px; font-weight: 700; letter-spacing: 3px;
    color: var(--accent-amber);
    text-shadow: 0 0 10px rgba(255, 184, 0, 0.4);
  }

  .logo-sub { font-size: 9px; color: var(--text-dim); letter-spacing: 2px; margin-left: 8px; }

  .status-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 2px; font-size: 10px; font-weight: 600;
    letter-spacing: 1px; text-transform: uppercase;
  }

  .status-running { background: rgba(0, 255, 136, 0.1); color: var(--accent-green); border: 1px solid var(--accent-green-dim); }
  .status-paused { background: rgba(255, 184, 0, 0.1); color: var(--accent-amber); border: 1px solid var(--accent-amber-dim); }
  .status-stopped { background: rgba(255, 51, 102, 0.1); color: var(--accent-red); border: 1px solid var(--accent-red-dim); }
  .status-error { background: rgba(255, 51, 102, 0.15); color: var(--accent-red); border: 1px solid var(--accent-red); }

  .pulse {
    width: 6px; height: 6px; border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }

  .pulse-green { background: var(--accent-green); }
  .pulse-amber { background: var(--accent-amber); }
  .pulse-red { background: var(--accent-red); }

  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 4px currentColor; }
    50% { opacity: 0.4; box-shadow: none; }
  }

  .clock { font-size: 11px; color: var(--text-secondary); letter-spacing: 1px; }

  .btn {
    padding: 4px 12px; border: 1px solid var(--border-bright); background: var(--bg-panel);
    color: var(--text-secondary); font-family: var(--font-mono); font-size: 10px;
    cursor: pointer; letter-spacing: 1px; text-transform: uppercase;
    transition: all 0.15s;
  }
  .btn:hover { background: var(--bg-panel-header); color: var(--text-primary); border-color: var(--accent-amber); }
  .btn-danger:hover { border-color: var(--accent-red); color: var(--accent-red); }
  .btn-success:hover { border-color: var(--accent-green); color: var(--accent-green); }

  /* ─── Grid Layout ─────────────────────────────────────────────────── */
  .grid {
    flex: 1; display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    grid-template-rows: auto 1fr 1fr;
    gap: 1px;
    background: var(--border);
    overflow: hidden;
  }

  .metrics-row { grid-column: 1 / -1; }

  /* ─── Panel ───────────────────────────────────────────────────────── */
  .panel {
    background: var(--bg-panel);
    display: flex; flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-panel-header);
    border-bottom: 1px solid var(--border);
    min-height: 28px;
  }

  .panel-title {
    font-size: 10px; font-weight: 600; letter-spacing: 2px;
    text-transform: uppercase; color: var(--accent-amber);
  }

  .panel-tag {
    font-size: 9px; padding: 1px 6px; border-radius: 1px;
    background: rgba(255, 184, 0, 0.08); color: var(--text-dim);
    letter-spacing: 1px;
  }

  .panel-body {
    flex: 1; overflow-y: auto; padding: 8px 12px;
  }

  .panel-body::-webkit-scrollbar { width: 4px; }
  .panel-body::-webkit-scrollbar-track { background: var(--bg-secondary); }
  .panel-body::-webkit-scrollbar-thumb { background: var(--border-bright); }

  /* ─── Metrics Strip ───────────────────────────────────────────────── */
  .metrics-strip {
    display: flex; gap: 1px; background: var(--border);
    padding: 0;
  }

  .metric-cell {
    flex: 1; padding: 10px 14px;
    background: var(--bg-panel);
    display: flex; flex-direction: column; gap: 2px;
  }

  .metric-label {
    font-size: 9px; color: var(--text-dim); letter-spacing: 2px;
    text-transform: uppercase;
  }

  .metric-value {
    font-size: 18px; font-weight: 600; letter-spacing: 1px;
  }

  .metric-sub { font-size: 9px; color: var(--text-dim); }

  .positive { color: var(--accent-green); }
  .negative { color: var(--accent-red); }
  .neutral { color: var(--text-primary); }
  .amber { color: var(--accent-amber); }
  .cyan { color: var(--accent-cyan); }

  /* ─── Trade/Opportunity Rows ──────────────────────────────────────── */
  .row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0; border-bottom: 1px solid rgba(30, 38, 64, 0.5);
    font-size: 11px;
  }

  .row:last-child { border-bottom: none; }

  .row-time { color: var(--text-dim); min-width: 65px; font-size: 10px; }
  .row-platform {
    padding: 1px 6px; border-radius: 1px; font-size: 9px;
    font-weight: 600; letter-spacing: 1px; text-transform: uppercase;
    min-width: 58px; text-align: center;
  }
  .platform-polymarket { background: rgba(102, 51, 255, 0.15); color: #aa88ff; border: 1px solid rgba(102, 51, 255, 0.3); }
  .platform-predictfun { background: rgba(0, 212, 255, 0.1); color: var(--accent-cyan); border: 1px solid rgba(0, 212, 255, 0.2); }

  .row-question { flex: 1; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-outcome {
    padding: 1px 6px; border-radius: 1px; font-size: 9px; font-weight: 600; min-width: 30px; text-align: center;
  }
  .outcome-yes { background: rgba(0, 255, 136, 0.1); color: var(--accent-green); }
  .outcome-no { background: rgba(255, 51, 102, 0.1); color: var(--accent-red); }

  .row-price { min-width: 45px; text-align: right; font-weight: 500; color: var(--text-primary); }
  .row-profit { min-width: 60px; text-align: right; font-weight: 600; }
  .row-confidence { min-width: 40px; text-align: right; color: var(--text-dim); }
  .row-status {
    padding: 1px 6px; border-radius: 1px; font-size: 9px; font-weight: 600;
    letter-spacing: 0.5px; min-width: 60px; text-align: center;
  }
  .status-executed { background: rgba(0, 255, 136, 0.1); color: var(--accent-green); }
  .status-pending-trade { background: rgba(255, 184, 0, 0.1); color: var(--accent-amber); }
  .status-failed-trade { background: rgba(255, 51, 102, 0.1); color: var(--accent-red); }

  /* ─── Activity Feed ───────────────────────────────────────────────── */
  .feed-item {
    padding: 5px 0; border-bottom: 1px solid rgba(30, 38, 64, 0.3);
    display: flex; gap: 8px; font-size: 10px;
  }
  .feed-time { color: var(--text-dim); min-width: 55px; }
  .feed-type {
    padding: 0 4px; font-weight: 600; min-width: 48px; text-align: center;
  }
  .feed-msg { color: var(--text-secondary); flex: 1; }

  /* ─── ASCII Art ────────────────────────────────────────────────────── */
  .ascii-chart {
    font-size: 10px; color: var(--accent-green); line-height: 1.2;
    padding: 4px 0; white-space: pre; overflow-x: auto;
  }

  /* ─── Footer ──────────────────────────────────────────────────────── */
  .footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 16px; background: var(--bg-panel-header);
    border-top: 1px solid var(--border);
    font-size: 9px; color: var(--text-dim); letter-spacing: 1px;
  }

  .footer-connections { display: flex; gap: 12px; }
  .conn-indicator { display: flex; align-items: center; gap: 4px; }
  .conn-dot { width: 5px; height: 5px; border-radius: 50%; }
  .conn-active { background: var(--accent-green); box-shadow: 0 0 4px var(--accent-green); }
  .conn-inactive { background: var(--accent-red); }

  .wide-panel { grid-column: span 2; }
`;

// ─── Utility Functions ───────────────────────────────────────────────────

function formatUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatBps(n: number): string {
  return `${n.toFixed(0)}bp`;
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pnlClass(n: number | null | undefined): string {
  if (n == null) return 'neutral';
  return n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
}

// ─── Mini ASCII Sparkline ────────────────────────────────────────────────

function sparkline(data: number[], width = 40): string {
  if (data.length === 0) return '▁'.repeat(width);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const chars = '▁▂▃▄▅▆▇█';
  return data
    .slice(-width)
    .map(v => chars[Math.min(Math.floor(((v - min) / range) * (chars.length - 1)), chars.length - 1)])
    .join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// App Component
// ═══════════════════════════════════════════════════════════════════════════

export function App() {
  const [status, setStatus] = useState<BotStatus>({ state: 'STOPPED', uptime: 0, timestamp: '' });
  const [metrics, setMetrics] = useState<Metrics>({
    pnl24h: 0, pnl7d: 0, pnlAllTime: 0, winRate: 0,
    totalTrades: 0, avgProfitPerTrade: 0, sharpeRatio: 0,
    currentExposure: 0, maxDrawdown: 0,
  });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [feed, setFeed] = useState<Array<{ time: string; type: string; msg: string; cls: string }>>([]);
  const [clock, setClock] = useState(new Date().toISOString());
  const [pnlHistory] = useState<number[]>(() =>
    Array.from({ length: 40 }, () => Math.random() * 10 - 3)
  );
  const wsRef = useRef<WebSocket | null>(null);

  // Clock
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toISOString()), 1000);
    return () => clearInterval(t);
  }, []);

  // WebSocket
  useEffect(() => {
    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg: WsMessage = JSON.parse(ev.data);
          handleWsMessage(msg);
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        setTimeout(connect, 3000);
      };
    };

    connect();
    return () => wsRef.current?.close();
  }, []);

  // Polling fallback
  useEffect(() => {
    const poll = async () => {
      try {
        const [s, m, t, o] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/metrics').then(r => r.json()),
          fetch('/api/trades?limit=30').then(r => r.json()),
          fetch('/api/opportunities?limit=30').then(r => r.json()),
        ]);
        setStatus(s);
        setMetrics(m);
        setTrades(t);
        setOpportunities(o);
      } catch { /* server not up yet */ }
    };

    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    const addFeed = (type: string, text: string, cls: string) => {
      setFeed(prev => [{ time: formatTime(msg.timestamp), type, msg: text, cls }, ...prev].slice(0, 50));
    };

    switch (msg.type) {
      case 'init':
        if (msg.data.metrics) setMetrics(msg.data.metrics);
        if (msg.data.recentTrades) setTrades(msg.data.recentTrades);
        if (msg.data.recentOpportunities) setOpportunities(msg.data.recentOpportunities);
        if (msg.data.state) setStatus(s => ({ ...s, state: msg.data.state as BotStatus['state'] }));
        addFeed('SYS', 'Dashboard connected', 'cyan');
        break;
      case 'opportunity':
        addFeed('OPP', `New arb opportunity found`, 'amber');
        break;
      case 'trade_executed':
        addFeed('EXEC', `Trade executed`, 'positive');
        break;
      case 'trade_failed':
        addFeed('FAIL', `Trade failed`, 'negative');
        break;
      case 'scan_complete':
        addFeed('SCAN', `Scan: ${msg.data.opportunitiesFound || 0} opps in ${msg.data.durationMs || 0}ms`, 'neutral');
        break;
      case 'state_change':
        addFeed('SYS', `Bot state → ${msg.data.state}`, 'amber');
        break;
      case 'risk_alert':
        addFeed('RISK', `Limit breach detected`, 'negative');
        break;
    }
  }, []);

  const sendCommand = async (cmd: string) => {
    await fetch(`/api/bot/${cmd}`, { method: 'POST' });
  };

  const stateClass = status.state === 'RUNNING' ? 'status-running'
    : status.state === 'PAUSED' ? 'status-paused'
    : status.state === 'ERROR' ? 'status-error'
    : 'status-stopped';

  const pulseClass = status.state === 'RUNNING' ? 'pulse-green'
    : status.state === 'PAUSED' ? 'pulse-amber'
    : 'pulse-red';

  return (
    <>
      <style>{styles}</style>
      <div className="scanlines" />

      {/* ─── Header ───────────────────────────────────────────────────── */}
      <div className="header">
        <div className="header-left">
          <span className="logo">PRED-ARB</span>
          <span className="logo-sub">PREDICTION MARKET ARBITRAGE TERMINAL</span>
          <span className={`status-badge ${stateClass}`}>
            <span className={`pulse ${pulseClass}`} />
            {status.state}
          </span>
        </div>
        <div className="header-right">
          <span className="clock">{formatTime(clock)}</span>
          <span className="clock" style={{ color: 'var(--text-dim)' }}>
            UP {formatUptime(status.uptime || 0)}
          </span>
          {status.state === 'RUNNING' ? (
            <button className="btn" onClick={() => sendCommand('pause')}>⏸ PAUSE</button>
          ) : status.state === 'PAUSED' ? (
            <button className="btn btn-success" onClick={() => sendCommand('resume')}>▶ RESUME</button>
          ) : null}
          <button className="btn btn-danger" onClick={() => sendCommand('stop')}>■ STOP</button>
        </div>
      </div>

      {/* ─── Metrics Strip ────────────────────────────────────────────── */}
      <div className="metrics-strip">
        <div className="metric-cell">
          <span className="metric-label">P&L 24H</span>
          <span className={`metric-value ${pnlClass(metrics.pnl24h)}`}>{formatUsd(metrics.pnl24h)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">P&L 7D</span>
          <span className={`metric-value ${pnlClass(metrics.pnl7d)}`}>{formatUsd(metrics.pnl7d)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">P&L ALL TIME</span>
          <span className={`metric-value ${pnlClass(metrics.pnlAllTime)}`}>{formatUsd(metrics.pnlAllTime)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">WIN RATE</span>
          <span className="metric-value amber">{formatPct(metrics.winRate)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">TRADES</span>
          <span className="metric-value neutral">{metrics.totalTrades}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">AVG PROFIT</span>
          <span className={`metric-value ${pnlClass(metrics.avgProfitPerTrade)}`}>
            {formatUsd(metrics.avgProfitPerTrade)}
          </span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">EXPOSURE</span>
          <span className="metric-value cyan">${metrics.currentExposure.toFixed(0)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">EQUITY CURVE</span>
          <div className="ascii-chart">{sparkline(pnlHistory)}</div>
        </div>
      </div>

      {/* ─── Main Grid ────────────────────────────────────────────────── */}
      <div className="grid">
        {/* Opportunities Panel */}
        <div className="panel wide-panel">
          <div className="panel-header">
            <span className="panel-title">Arbitrage Opportunities</span>
            <span className="panel-tag">LIVE</span>
          </div>
          <div className="panel-body">
            {opportunities.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', padding: '20px', textAlign: 'center' }}>
                Scanning for opportunities...
              </div>
            ) : opportunities.map(opp => (
              <div className="row" key={opp.id}>
                <span className="row-time">{formatTime(opp.discoveredAt)}</span>
                <span className={`row-platform platform-${opp.legA.platform}`}>{opp.legA.platform.slice(0, 5)}</span>
                <span className={`row-outcome ${opp.legA.outcome === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>
                  {opp.legA.outcome}
                </span>
                <span className="row-price">{opp.legA.price.toFixed(3)}</span>
                <span style={{ color: 'var(--text-dim)' }}>↔</span>
                <span className={`row-platform platform-${opp.legB.platform}`}>{opp.legB.platform.slice(0, 5)}</span>
                <span className={`row-outcome ${opp.legB.outcome === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>
                  {opp.legB.outcome}
                </span>
                <span className="row-price">{opp.legB.price.toFixed(3)}</span>
                <span className={`row-profit ${pnlClass(opp.expectedProfitUsd)}`}>
                  {formatUsd(opp.expectedProfitUsd)}
                </span>
                <span className="row-confidence" title="Match confidence">{formatPct(opp.matchConfidence * 100)}</span>
                <span className={`row-status ${opp.executed ? 'status-executed' : 'status-pending-trade'}`}>
                  {opp.executed ? 'EXEC' : 'OPEN'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Activity Feed */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Activity Feed</span>
            <span className="panel-tag">STREAM</span>
          </div>
          <div className="panel-body">
            {feed.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', padding: '20px', textAlign: 'center' }}>
                Waiting for events...
              </div>
            ) : feed.map((item, i) => (
              <div className="feed-item" key={i}>
                <span className="feed-time">{item.time}</span>
                <span className={`feed-type ${item.cls}`}>{item.type}</span>
                <span className="feed-msg">{item.msg}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Trades Panel */}
        <div className="panel wide-panel">
          <div className="panel-header">
            <span className="panel-title">Trade History</span>
            <span className="panel-tag">{metrics.totalTrades} TOTAL</span>
          </div>
          <div className="panel-body">
            {trades.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', padding: '20px', textAlign: 'center' }}>
                No trades executed yet
              </div>
            ) : trades.map(t => (
              <div className="row" key={t.id}>
                <span className="row-time">{formatTime(t.created_at)}</span>
                <span className={`row-platform platform-${t.leg_a_platform || 'polymarket'}`}>
                  {(t.leg_a_platform || 'POLY').slice(0, 5)}
                </span>
                <span className="row-price">{t.leg_a_price?.toFixed(3) || '—'}</span>
                <span style={{ color: 'var(--text-dim)' }}>↔</span>
                <span className={`row-platform platform-${t.leg_b_platform || 'predictfun'}`}>
                  {(t.leg_b_platform || 'PFUN').slice(0, 5)}
                </span>
                <span className="row-price">{t.leg_b_price?.toFixed(3) || '—'}</span>
                <span className={`row-profit ${pnlClass(t.realized_profit_usd)}`}>
                  {formatUsd(t.realized_profit_usd ?? t.expected_profit_usd)}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: '9px' }}>
                  FEE {t.fees?.toFixed(2) || '0.00'}
                </span>
                <span className={`row-status ${
                  t.status === 'EXECUTED' ? 'status-executed' :
                  t.status === 'FAILED' ? 'status-failed-trade' : 'status-pending-trade'
                }`}>
                  {t.status}
                </span>
                {t.notes && <span style={{ color: 'var(--text-dim)', fontSize: '9px' }}>{t.notes}</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Strategy Panel */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Strategies</span>
            <span className="panel-tag">CONFIG</span>
          </div>
          <div className="panel-body">
            <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>CROSS-PLATFORM ARB</span>
                <span className="status-badge status-running" style={{ fontSize: 8 }}>ACTIVE</span>
              </div>
              <div style={{ color: 'var(--text-dim)', fontSize: 10, marginBottom: 8 }}>
                Buy opposite outcomes on matched markets across Polymarket and predict.fun
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 10 }}>
                <span className="metric-label">MIN PROFIT</span>
                <span style={{ color: 'var(--text-primary)' }}>{metrics.totalTrades > 0 ? '150' : '150'} BPS</span>
                <span className="metric-label">MAX POSITION</span>
                <span style={{ color: 'var(--text-primary)' }}>$500</span>
                <span className="metric-label">MAX EXPOSURE</span>
                <span style={{ color: 'var(--text-primary)' }}>$5,000</span>
                <span className="metric-label">SCAN INTERVAL</span>
                <span style={{ color: 'var(--text-primary)' }}>10s</span>
              </div>
            </div>
            <div style={{ padding: '12px 0', color: 'var(--text-dim)', fontSize: 10 }}>
              <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: 1 }}>
                ARCHITECTURE
              </div>
              <pre style={{ fontSize: 9, lineHeight: 1.3, color: 'var(--accent-green)', whiteSpace: 'pre-wrap' }}>{`
┌─────────────┐    ┌──────────────┐
│ POLYMARKET  │    │ PREDICT.FUN  │
│  Connector  │    │  Connector   │
└──────┬──────┘    └──────┬───────┘
       │                  │
       └────────┬─────────┘
                │
        ┌───────▼────────┐
        │ Market Matcher │
        │  (Fuse.js)     │
        └───────┬────────┘
                │
        ┌───────▼────────┐
        │   Strategy     │
        │    Engine      │
        └───────┬────────┘
                │
    ┌───────────▼──────────┐
    │  Execution Engine    │
    │  ┌─────────────────┐ │
    │  │  Risk Manager   │ │
    │  └─────────────────┘ │
    └──────────────────────┘
              `.trim()}</pre>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Footer ───────────────────────────────────────────────────── */}
      <div className="footer">
        <div className="footer-connections">
          <span className="conn-indicator">
            <span className={`conn-dot ${status.state !== 'STOPPED' ? 'conn-active' : 'conn-inactive'}`} />
            POLYMARKET
          </span>
          <span className="conn-indicator">
            <span className={`conn-dot ${status.state !== 'STOPPED' ? 'conn-active' : 'conn-inactive'}`} />
            PREDICT.FUN
          </span>
        </div>
        <span>PRED-ARB v1.0.0 // DRY RUN MODE</span>
        <span>{new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</span>
      </div>
    </>
  );
}
