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

interface MarketItem {
  id: string;
  question: string;
  category: string;
  matched: boolean;
}

interface MatchedPair {
  pairId: string;
  marketA: { id: string; platform: string; question: string };
  marketB: { id: string; platform: string; question: string };
  confidence: number;
  matchMethod: string;
  status: 'pending' | 'approved' | 'paused' | 'rejected';
  llmReasoning?: string;
}

interface MarketsSummary {
  platforms: Record<string, { total: number; markets: MarketItem[] }>;
  matchedPairs: MatchedPair[];
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

// ─── Tab selector type ─────────────────────────────────────────────────────
type ActiveTab = 'opportunities' | 'markets' | 'trades';

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

// ─── API base URL ───────────────────────────────────────────────────────────

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
  const [marketsSummary, setMarketsSummary] = useState<MarketsSummary>({ platforms: {}, matchedPairs: [] });
  const [feed, setFeed] = useState<Array<{ time: string; type: string; msg: string; cls: string }>>([]);
  const [clock, setClock] = useState('1970-01-01T00:00:00.000Z');
  const [pnlHistory, setPnlHistory] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('opportunities');
  const [marketFilter, setMarketFilter] = useState<'all' | 'matched' | 'unmatched'>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [pairStatusFilter, setPairStatusFilter] = useState<'all' | 'approved' | 'pending' | 'paused' | 'rejected'>('all');
  const wsRef = useRef<WebSocket | null>(null);

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
      ws.onclose = () => { setTimeout(connect, 3000); };
    };
    connect();
    return () => wsRef.current?.close();
  }, [handleWsMessage]);

  useEffect(() => {
    const apiBase = getApiBase();
    const poll = async () => {
      try {
        const [s, m, t, o, mk] = await Promise.all([
          fetch(`${apiBase}/api/status`).then(r => r.json()),
          fetch(`${apiBase}/api/metrics`).then(r => r.json()),
          fetch(`${apiBase}/api/trades?limit=30`).then(r => r.json()),
          fetch(`${apiBase}/api/opportunities?limit=30`).then(r => r.json()),
          fetch(`${apiBase}/api/markets`).then(r => r.json()).catch(() => ({ platforms: {}, matchedPairs: [] })),
        ]);
        setStatus(s);
        setMetrics(m);
        setTrades(t);
        setOpportunities(o);
        setMarketsSummary(mk);
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

  const updatePairStatus = async (pairId: string, status: string) => {
    const apiBase = getApiBase();
    await fetch(`${apiBase}/api/pairs/${encodeURIComponent(pairId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    // Optimistically update local state
    setMarketsSummary(prev => ({
      ...prev,
      matchedPairs: prev.matchedPairs.map(p =>
        p.pairId === pairId ? { ...p, status: status as MatchedPair['status'] } : p
      ),
    }));
  };

  const stateClass = status.state === 'RUNNING' ? 'status-running'
    : status.state === 'PAUSED' ? 'status-paused'
    : status.state === 'ERROR' ? 'status-error'
    : 'status-stopped';

  const pulseClass = status.state === 'RUNNING' ? 'pulse-green'
    : status.state === 'PAUSED' ? 'pulse-amber'
    : 'pulse-red';

  // Compute market counts
  const platformNames = Object.keys(marketsSummary.platforms);
  const totalMarkets = platformNames.reduce((s, p) => s + (marketsSummary.platforms[p]?.total || 0), 0);
  const totalMatched = marketsSummary.matchedPairs.length;

  // Build filtered market list for Markets tab
  const getFilteredMarkets = () => {
    const allMarkets: (MarketItem & { platform: string })[] = [];
    for (const [platform, data] of Object.entries(marketsSummary.platforms)) {
      for (const m of data.markets) {
        if (platformFilter !== 'all' && platform !== platformFilter) continue;
        if (marketFilter === 'matched' && !m.matched) continue;
        if (marketFilter === 'unmatched' && m.matched) continue;
        allMarkets.push({ ...m, platform });
      }
    }
    return allMarkets;
  };

  return (
    <div className="root-layout">
      <div className="scanlines" />

      {/* ─── HEADER ──────────────────────────────────────────── */}
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

      {/* ─── METRICS STRIP ──────────────────────────────────── */}
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
          <span className="metric-label">MARKETS</span>
          <span className="metric-value cyan">{totalMarkets}</span>
          <span className="metric-sub">{totalMatched} matched</span>
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

      {/* ─── MAIN CONTENT ───────────────────────────────────── */}
      <div className="main-content">
        {/* LEFT: Tabbed main panel */}
        <div className="main-left">
          {/* Tab bar */}
          <div className="tab-bar">
            <button className={`tab-btn ${activeTab === 'opportunities' ? 'tab-active' : ''}`} onClick={() => setActiveTab('opportunities')}>
              OPPORTUNITIES
            </button>
            <button className={`tab-btn ${activeTab === 'markets' ? 'tab-active' : ''}`} onClick={() => setActiveTab('markets')}>
              MARKETS ({totalMarkets})
            </button>
            <button className={`tab-btn ${activeTab === 'trades' ? 'tab-active' : ''}`} onClick={() => setActiveTab('trades')}>
              TRADES ({metrics.totalTrades})
            </button>
          </div>

          {/* Tab content */}
          <div className="tab-content">
            {/* ─── OPPORTUNITIES TAB ─── */}
            {activeTab === 'opportunities' && (
              <>
                {opportunities.length === 0 ? (
                  <div className="empty-state">Scanning for opportunities...</div>
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
              </>
            )}

            {/* ─── MARKETS TAB ─── */}
            {activeTab === 'markets' && (
              <>
                {/* Filter bar */}
                <div className="filter-bar">
                  <div className="filter-group">
                    <span className="filter-label">MARKETS</span>
                    <button className={`filter-btn ${marketFilter === 'all' ? 'filter-active' : ''}`} onClick={() => setMarketFilter('all')}>ALL</button>
                    <button className={`filter-btn ${marketFilter === 'matched' ? 'filter-active' : ''}`} onClick={() => setMarketFilter('matched')}>MATCHED</button>
                    <button className={`filter-btn ${marketFilter === 'unmatched' ? 'filter-active' : ''}`} onClick={() => setMarketFilter('unmatched')}>UNMATCHED</button>
                  </div>
                  <div className="filter-group">
                    <span className="filter-label">PLATFORM</span>
                    <button className={`filter-btn ${platformFilter === 'all' ? 'filter-active' : ''}`} onClick={() => setPlatformFilter('all')}>ALL</button>
                    {platformNames.map(p => (
                      <button key={p} className={`filter-btn ${platformFilter === p ? 'filter-active' : ''}`} onClick={() => setPlatformFilter(p)}>
                        {p.toUpperCase().slice(0, 7)}
                      </button>
                    ))}
                  </div>
                  <div className="filter-group">
                    <span className="filter-label">PAIR STATUS</span>
                    <button className={`filter-btn ${pairStatusFilter === 'all' ? 'filter-active' : ''}`} onClick={() => setPairStatusFilter('all')}>ALL</button>
                    <button className={`filter-btn ${pairStatusFilter === 'approved' ? 'filter-active' : ''}`} onClick={() => setPairStatusFilter('approved')}>APPROVED</button>
                    <button className={`filter-btn ${pairStatusFilter === 'pending' ? 'filter-active' : ''}`} onClick={() => setPairStatusFilter('pending')}>PENDING</button>
                    <button className={`filter-btn ${pairStatusFilter === 'paused' ? 'filter-active' : ''}`} onClick={() => setPairStatusFilter('paused')}>PAUSED</button>
                    <button className={`filter-btn ${pairStatusFilter === 'rejected' ? 'filter-active' : ''}`} onClick={() => setPairStatusFilter('rejected')}>REJECTED</button>
                  </div>
                </div>

                {/* Matched pairs section */}
                {marketFilter !== 'unmatched' && marketsSummary.matchedPairs.length > 0 && (
                  <div className="matched-pairs-section">
                    <div className="section-header">
                      <span className="section-title">MATCHED PAIRS</span>
                      <span className="panel-tag">{marketsSummary.matchedPairs.filter(p => pairStatusFilter === 'all' || p.status === pairStatusFilter).length}</span>
                    </div>
                    {marketsSummary.matchedPairs
                      .filter(p => pairStatusFilter === 'all' || p.status === pairStatusFilter)
                      .map((pair, i) => (
                      <div className={`pair-row pair-status-${pair.status}`} key={pair.pairId || i}>
                        <div className="pair-info">
                          <div className="pair-markets">
                            <span className={`row-platform platform-${pair.marketA.platform}`}>
                              {pair.marketA.platform.slice(0, 5).toUpperCase()}
                            </span>
                            <span className="pair-question">{pair.marketA.question.slice(0, 55)}</span>
                          </div>
                          <div className="pair-separator">⟷</div>
                          <div className="pair-markets">
                            <span className={`row-platform platform-${pair.marketB.platform}`}>
                              {pair.marketB.platform.slice(0, 5).toUpperCase()}
                            </span>
                            <span className="pair-question">{pair.marketB.question.slice(0, 55)}</span>
                          </div>
                        </div>
                        <div className="pair-meta">
                          <span className="pair-confidence">{formatPct(pair.confidence * 100)}</span>
                          <span className={`pair-method method-${pair.matchMethod}`}>{pair.matchMethod.replace('_', ' ')}</span>
                          <span className={`pair-status-badge status-${pair.status ?? 'pending'}`}>{(pair.status ?? 'pending').toUpperCase()}</span>
                        </div>
                        {pair.llmReasoning && (
                          <div className="pair-reasoning">{pair.llmReasoning}</div>
                        )}
                        <div className="pair-actions">
                          {pair.status !== 'approved' && (
                            <button className="pair-btn pair-btn-approve" onClick={() => updatePairStatus(pair.pairId, 'approved')}>APPROVE</button>
                          )}
                          {pair.status !== 'paused' && pair.status !== 'rejected' && (
                            <button className="pair-btn pair-btn-pause" onClick={() => updatePairStatus(pair.pairId, 'paused')}>PAUSE</button>
                          )}
                          {pair.status !== 'rejected' && (
                            <button className="pair-btn pair-btn-reject" onClick={() => updatePairStatus(pair.pairId, 'rejected')}>REJECT</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* All markets list */}
                <div className="section-header" style={{ marginTop: 8 }}>
                  <span className="section-title">ALL MARKETS</span>
                  <span className="panel-tag">{getFilteredMarkets().length}</span>
                </div>
                {getFilteredMarkets().length === 0 ? (
                  <div className="empty-state">No markets loaded yet</div>
                ) : getFilteredMarkets().map((m, i) => (
                  <div className="market-row" key={`${m.platform}-${m.id}-${i}`}>
                    <span className={`row-platform platform-${m.platform}`}>{m.platform.slice(0, 5).toUpperCase()}</span>
                    <span className={`match-badge ${m.matched ? 'match-yes' : 'match-no'}`}>
                      {m.matched ? 'PAIRED' : '—'}
                    </span>
                    <span className="market-question">{m.question}</span>
                    {m.category && <span className="market-category">{m.category}</span>}
                  </div>
                ))}
              </>
            )}

            {/* ─── TRADES TAB ─── */}
            {activeTab === 'trades' && (
              <>
                {trades.length === 0 ? (
                  <div className="empty-state">No trades executed yet</div>
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
              </>
            )}
          </div>
        </div>

        {/* RIGHT: Activity Feed + Strategy */}
        <div className="main-right">
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-header">
              <span className="panel-title">Activity Feed</span>
              <span className="panel-tag">STREAM</span>
            </div>
            <div className="panel-body">
              {feed.length === 0 ? (
                <div className="empty-state">Waiting for events...</div>
              ) : feed.map((item, i) => (
                <div className="feed-item" key={i}>
                  <span className="feed-time">{item.time}</span>
                  <span className={`feed-type ${item.cls}`}>{item.type}</span>
                  <span className="feed-msg">{item.msg}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel" style={{ flex: 0, minHeight: 'auto' }}>
            <div className="panel-header">
              <span className="panel-title">Strategy</span>
              <span className="panel-tag">CONFIG</span>
            </div>
            <div className="panel-body">
              <div style={{ padding: '6px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: 'var(--accent-amber)', fontWeight: 600, fontSize: 10 }}>CROSS-PLATFORM ARB</span>
                  <span className="status-badge status-running" style={{ fontSize: 8 }}>ACTIVE</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', fontSize: 10 }}>
                  <span className="metric-label">MIN PROFIT</span>
                  <span style={{ color: 'var(--text-primary)' }}>150 BPS</span>
                  <span className="metric-label">MAX POSITION</span>
                  <span style={{ color: 'var(--text-primary)' }}>$500</span>
                  <span className="metric-label">SCAN INTERVAL</span>
                  <span style={{ color: 'var(--text-primary)' }}>10s</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── FOOTER ─────────────────────────────────────────── */}
      <div className="footer">
        <div className="footer-connections">
          {platformNames.length > 0 ? platformNames.map(p => (
            <span className="conn-indicator" key={p}>
              <span className={`conn-dot ${status.state !== 'STOPPED' ? 'conn-active' : 'conn-inactive'}`} />
              {p.toUpperCase()}
              <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>
                ({marketsSummary.platforms[p]?.total || 0})
              </span>
            </span>
          )) : (
            <>
              <span className="conn-indicator">
                <span className={`conn-dot ${status.state !== 'STOPPED' ? 'conn-active' : 'conn-inactive'}`} />
                POLYMARKET
              </span>
              <span className="conn-indicator">
                <span className={`conn-dot ${status.state !== 'STOPPED' ? 'conn-active' : 'conn-inactive'}`} />
                PREDICT.FUN
              </span>
            </>
          )}
        </div>
        <span>PRED-ARB v1.0.0 // DRY RUN MODE</span>
        <span>{new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</span>
      </div>
    </div>
  );
}
