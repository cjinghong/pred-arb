'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Utils ─────────────────────────────────────────────────────────────────

function formatUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
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

// ─── API base URL (dev: proxy or explicit; prod: same origin) ──────────────

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_API_URL || '';
}

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (wsUrl) return wsUrl;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard Page
// ═══════════════════════════════════════════════════════════════════════════

export default function DashboardPage() {
  const [status, setStatus] = useState<BotStatus>({ state: 'STOPPED', uptime: 0, timestamp: '' });
  const [metrics, setMetrics] = useState<Metrics>({
    pnl24h: 0, pnl7d: 0, pnlAllTime: 0, winRate: 0,
    totalTrades: 0, avgProfitPerTrade: 0, sharpeRatio: 0,
    currentExposure: 0, maxDrawdown: 0,
  });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [feed, setFeed] = useState<Array<{ time: string; type: string; msg: string; cls: string }>>([]);
  const [clock, setClock] = useState('1970-01-01T00:00:00.000Z');
  const [pnlHistory, setPnlHistory] = useState<number[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // Defer random sparkline data to client to avoid hydration mismatch
  useEffect(() => {
    setPnlHistory(Array.from({ length: 40 }, () => Math.random() * 10 - 3));
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
        addFeed('OPP', 'New arb opportunity found', 'amber');
        break;
      case 'trade_executed':
        addFeed('EXEC', 'Trade executed', 'positive');
        break;
      case 'trade_failed':
        addFeed('FAIL', 'Trade failed', 'negative');
        break;
      case 'scan_complete':
        addFeed('SCAN', `Scan: ${msg.data.opportunitiesFound || 0} opps in ${msg.data.durationMs || 0}ms`, 'neutral');
        break;
      case 'state_change':
        addFeed('SYS', `Bot state → ${msg.data.state}`, 'amber');
        break;
      case 'risk_alert':
        addFeed('RISK', 'Limit breach detected', 'negative');
        break;
    }
  }, []);

  useEffect(() => {
    setClock(new Date().toISOString());
    const t = setInterval(() => setClock(new Date().toISOString()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const connect = () => {
      const url = getWsUrl();
      const ws = new WebSocket(url);
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
  }, [handleWsMessage]);

  useEffect(() => {
    const apiBase = getApiBase();
    const poll = async () => {
      try {
        const [s, m, t, o] = await Promise.all([
          fetch(`${apiBase}/api/status`).then(r => r.json()),
          fetch(`${apiBase}/api/metrics`).then(r => r.json()),
          fetch(`${apiBase}/api/trades?limit=30`).then(r => r.json()),
          fetch(`${apiBase}/api/opportunities?limit=30`).then(r => r.json()),
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

  const sendCommand = async (cmd: string) => {
    const apiBase = getApiBase();
    await fetch(`${apiBase}/api/bot/${cmd}`, { method: 'POST' });
  };

  const stateClass = status.state === 'RUNNING' ? 'status-running'
    : status.state === 'PAUSED' ? 'status-paused'
    : status.state === 'ERROR' ? 'status-error'
    : 'status-stopped';

  const pulseClass = status.state === 'RUNNING' ? 'pulse-green'
    : status.state === 'PAUSED' ? 'pulse-amber'
    : 'pulse-red';

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="scanlines" />

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

      <div className="grid">
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
                <span style={{ color: 'var(--text-primary)' }}>150 BPS</span>
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
    </div>
  );
}
