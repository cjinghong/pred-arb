'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import OrderBookViewer, { BookSelection } from './orderbook-viewer';

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
  leg_a_question?: string;
  leg_b_platform: string;
  leg_b_market_id: string;
  leg_b_side: string;
  leg_b_price: number;
  leg_b_question?: string;
  opp_leg_a_outcome?: string;
  opp_leg_b_outcome?: string;
  expected_profit_usd: number;
  expected_profit_bps?: number;
  realized_profit_usd: number | null;
  fees: number;
  total_cost_usd?: number;
  leg_a_size?: number;
  leg_b_size?: number;
  created_at: string;
  notes: string;
}

interface Opportunity {
  id: string;
  strategyId: string;
  discoveredAt: string;
  legA: { platform: string; marketId: string; marketQuestion: string; outcome: string; price: number };
  legB: { platform: string; marketId: string; marketQuestion: string; outcome: string; price: number };
  expectedProfitUsd: number;
  expectedProfitBps: number;
  maxSize: number;
  matchConfidence: number;
  executed: boolean;
  status?: 'open' | 'executing' | 'executed' | 'failed' | 'expired' | 'rejected';
  failReason?: string;
  outcomesInverted?: boolean;
  outcomesA?: string[];
  outcomesB?: string[];
}

interface PositionItem {
  platform: string;
  marketId: string;
  marketQuestion: string;
  outcomeIndex: number;
  side: string;
  size: number;
  marketUrl?: string;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  source?: 'bot' | 'personal';
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
  slug: string;
  eventSlug?: string;
  matched: boolean;
}

interface MatchedPair {
  pairId: string;
  marketA: { id: string; platform: string; question: string; slug: string; eventSlug?: string; outcomes?: string[] };
  marketB: { id: string; platform: string; question: string; slug: string; eventSlug?: string; outcomes?: string[] };
  confidence: number;
  matchMethod: string;
  status: 'pending' | 'approved' | 'paused' | 'rejected';
  outcomesInverted?: boolean;
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
type ActiveTab = 'opportunities' | 'markets' | 'trades' | 'positions';

// ─── Platform URL helpers ────────────────────────────────────────────────
function getPlatformMarketUrl(platform: string, slug: string, marketId: string, eventSlug?: string): string {
  if (platform === 'polymarket') {
    // Polymarket URL: /event/{eventSlug}/{marketSlug}
    // eventSlug comes from Gamma API events[0].slug; may be empty for some markets
    if (eventSlug && slug) return `https://polymarket.com/event/${eventSlug}/${slug}`;
    if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
    // Fallback: use market slug (Polymarket redirects /event/{marketSlug} correctly)
    if (slug) return `https://polymarket.com/event/${slug}`;
    return `https://polymarket.com/event/${marketId}`;
  }
  if (platform === 'predictfun') return slug ? `https://predict.fun/market/${slug}` : `https://predict.fun/market/${marketId}`;
  if (platform === 'kalshi') {
    // Kalshi URL: /markets/{series_ticker}/{subtitle_slug}/{event_ticker}
    // eventSlug = series_ticker, slug = "{subtitle_slug}|{event_ticker}"
    const parts = slug.split('|');
    const subtitleSlug = parts[0] || '';
    const eventTicker = parts[1] || '';
    if (eventSlug && subtitleSlug && eventTicker) return `https://kalshi.com/markets/${eventSlug}/${subtitleSlug}/${eventTicker}`;
    if (eventSlug && eventTicker) return `https://kalshi.com/markets/${eventSlug}/${eventTicker}`;
    if (eventSlug) return `https://kalshi.com/markets/${eventSlug}`;
    return `https://kalshi.com/markets/${marketId.toLowerCase()}`;
  }
  return '#';
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

// ─── API base URL ───────────────────────────────────────────────────────────

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_API_URL || `http://${window.location.hostname}:3848`;
}

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (wsUrl) return wsUrl;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.hostname}:3848`;
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
  const [bookSelection, setBookSelection] = useState<BookSelection | null>(null);
  const [manualMatchMode, setManualMatchMode] = useState(false);
  const [manualMatchA, setManualMatchA] = useState<{ id: string; platform: string; question: string } | null>(null);
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [oppSearch, setOppSearch] = useState('');
  const [pairSearch, setPairSearch] = useState('');
  const [marketSearch, setMarketSearch] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [marketCategory, setMarketCategory] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [configParams, setConfigParams] = useState<{ minProfitBps: number; maxPositionUsd: number; maxTotalExposureUsd: number }>({
    minProfitBps: 150, maxPositionUsd: 500, maxTotalExposureUsd: 5000,
  });
  const [editingParam, setEditingParam] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setPnlHistory(Array.from({ length: 40 }, () => Math.random() * 10 - 3));
  }, []);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    const addFeed = (type: string, text: string, cls: string) => {
      setFeed(prev => [{ time: formatTime(msg.timestamp), type, msg: text, cls }, ...prev].slice(0, 100));
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
        const [s, m, t, o, mk, pos] = await Promise.all([
          fetch(`${apiBase}/api/status`).then(r => r.json()),
          fetch(`${apiBase}/api/metrics`).then(r => r.json()),
          fetch(`${apiBase}/api/trades?limit=500`).then(r => r.json()),
          fetch(`${apiBase}/api/opportunities?limit=500`).then(r => r.json()),
          fetch(`${apiBase}/api/markets`).then(r => r.json()).catch(() => ({ platforms: {}, matchedPairs: [] })),
          fetch(`${apiBase}/api/positions`).then(r => r.json()).catch(() => []),
        ]);
        setStatus(s);
        setMetrics(m);
        setTrades(t);
        setOpportunities(o);
        setMarketsSummary(mk);
        setPositions(Array.isArray(pos) ? pos : []);
      } catch { /* server not up yet */ }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  const navigateToPair = (pair: MatchedPair) => {
    window.location.href = `/pair?a=${encodeURIComponent(pair.marketA.id)}&b=${encodeURIComponent(pair.marketB.id)}`;
  };

  const navigateToPairFromOpp = (opp: Opportunity) => {
    window.location.href = `/pair?a=${encodeURIComponent(opp.legA.marketId)}&b=${encodeURIComponent(opp.legB.marketId)}`;
  };

  const handleManualMatchClick = async (market: { id: string; platform: string; question: string }) => {
    if (!manualMatchMode) return;

    if (!manualMatchA) {
      // First selection
      setManualMatchA(market);
      return;
    }

    // Second selection — must be from a different platform
    if (market.platform === manualMatchA.platform) {
      // Same platform — replace the first selection
      setManualMatchA(market);
      return;
    }

    // Create the manual pair
    try {
      const apiBase = getApiBase();
      const resp = await fetch(`${apiBase}/api/pairs/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketAId: manualMatchA.id,
          marketBId: market.id,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        alert(`Failed to create pair: ${err.error}`);
      }
    } catch (err) {
      alert(`Error: ${(err as Error).message}`);
    }

    // Reset
    setManualMatchA(null);
    setManualMatchMode(false);
  };

  const sendCommand = async (cmd: string) => {
    const apiBase = getApiBase();
    await fetch(`${apiBase}/api/bot/${cmd}`, { method: 'POST' });
  };

  // Fetch initial config (category + params)
  useEffect(() => {
    const apiBase = getApiBase();
    fetch(`${apiBase}/api/config`).then(r => r.json()).then(cfg => {
      if (cfg.marketCategory !== undefined) setMarketCategory(cfg.marketCategory);
      setConfigParams(prev => ({
        minProfitBps: cfg.minProfitBps ?? prev.minProfitBps,
        maxPositionUsd: cfg.maxPositionUsd ?? prev.maxPositionUsd,
        maxTotalExposureUsd: cfg.maxTotalExposureUsd ?? prev.maxTotalExposureUsd,
      }));
    }).catch(() => {});
  }, []);

  const handleRefreshMarkets = async () => {
    setIsRefreshing(true);
    try {
      const apiBase = getApiBase();
      const resp = await fetch(`${apiBase}/api/bot/refresh-markets`, { method: 'POST' });
      const data = await resp.json();
      if (data.markets) setMarketsSummary(data.markets as MarketsSummary);
      setFeed(prev => [{ time: formatTime(new Date().toISOString()), type: 'SYS', msg: `Markets refreshed${marketCategory ? ` (${marketCategory})` : ''}`, cls: 'cyan' }, ...prev.slice(0, 99)]);
    } catch (err) {
      alert(`Refresh failed: ${(err as Error).message}`);
    }
    setIsRefreshing(false);
  };

  const handleCategoryChange = async (newCategory: string) => {
    setMarketCategory(newCategory);
    try {
      const apiBase = getApiBase();
      await fetch(`${apiBase}/api/config/category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: newCategory }),
      });
      // Auto-refresh markets after category change
      setIsRefreshing(true);
      const resp = await fetch(`${apiBase}/api/bot/refresh-markets`, { method: 'POST' });
      const data = await resp.json();
      if (data.markets) setMarketsSummary(data.markets as MarketsSummary);
      setFeed(prev => [{ time: formatTime(new Date().toISOString()), type: 'SYS', msg: `Category → ${newCategory || 'ALL'}, markets refreshed`, cls: 'cyan' }, ...prev.slice(0, 99)]);
    } catch (err) {
      alert(`Category update failed: ${(err as Error).message}`);
    }
    setIsRefreshing(false);
  };

  const handleParamSave = async (paramName: string, value: string) => {
    const num = Number(value);
    if (isNaN(num)) return;
    try {
      const apiBase = getApiBase();
      const resp = await fetch(`${apiBase}/api/config/params`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [paramName]: num }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setConfigParams(prev => ({ ...prev, ...data }));
        setFeed(prev => [{ time: formatTime(new Date().toISOString()), type: 'SYS', msg: `${paramName} → ${num}`, cls: 'cyan' }, ...prev.slice(0, 99)]);
      }
    } catch (err) {
      alert(`Failed to update ${paramName}: ${(err as Error).message}`);
    }
    setEditingParam(null);
  };

  const handleReset = async () => {
    try {
      const apiBase = getApiBase();
      const resp = await fetch(`${apiBase}/api/bot/reset`, { method: 'POST' });
      const data = await resp.json();
      // Clear local state — bot will auto-restart
      setTrades([]);
      setOpportunities([]);
      setMarketsSummary({ platforms: {}, matchedPairs: [] });
      setPositions([]);
      setFeed(prev => [{ time: formatTime(new Date().toISOString()), type: 'SYS', msg: 'Full reset — bot restarting', cls: 'amber' }, ...prev.slice(0, 99)]);
      setPnlHistory([]);
      setStatus(s => ({ ...s, state: data.state || 'RUNNING' }));
      setMetrics({ pnl24h: 0, pnl7d: 0, pnlAllTime: 0, winRate: 0, totalTrades: 0, avgProfitPerTrade: 0, sharpeRatio: 0, currentExposure: 0, maxDrawdown: 0 });
    } catch (err) {
      alert(`Reset failed: ${(err as Error).message}`);
    }
    setShowResetConfirm(false);
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

  // ─── Opportunity status helpers ─────────────────────────────────────────
  const getOppStatus = (opp: Opportunity): { label: string; cls: string } => {
    if (opp.status === 'failed') return { label: 'FAILED', cls: 'status-failed-trade' };
    if (opp.status === 'expired') return { label: 'EXPIRED', cls: 'status-expired' };
    if (opp.status === 'rejected') return { label: 'REJECTED', cls: 'status-rejected-opp' };
    if (opp.status === 'executing') return { label: 'EXEC...', cls: 'status-executing' };
    if (opp.executed || opp.status === 'executed') return { label: 'EXECUTED', cls: 'status-executed' };
    return { label: 'OPEN', cls: 'status-pending-trade' };
  };

  /**
   * Resolve the real-world display label for an opportunity leg.
   * When outcomesInverted is true on the B leg, raw YES/NO is misleading.
   * Instead, show the team/outcome name the leg is betting on.
   */
  const getLegDisplay = (opp: Opportunity, leg: 'A' | 'B'): { label: string; isHedged: boolean; teamBetting: string | null } => {
    const legData = leg === 'A' ? opp.legA : opp.legB;
    const outcomes = leg === 'A' ? opp.outcomesA : opp.outcomesB;
    const rawOutcome = legData.outcome; // YES or NO

    // If no inversion or no outcome labels, show raw
    if (!opp.outcomesInverted || !outcomes || outcomes.length < 2) {
      return { label: rawOutcome, isHedged: false, teamBetting: null };
    }

    // For inverted pairs, show which team this leg is actually betting on
    // YES = outcomes[0], NO = outcomes[1]
    const teamBetting = rawOutcome === 'YES' ? outcomes[0] : outcomes[1];
    return { label: rawOutcome, isHedged: true, teamBetting };
  };

  // ─── Filtered + searched opportunities ─────────────────────────────────
  const filteredOpps = opportunities.filter(opp => {
    if (!oppSearch) return true;
    const q = oppSearch.toLowerCase();
    return (opp.legA.marketQuestion?.toLowerCase().includes(q) ||
            opp.legB.marketQuestion?.toLowerCase().includes(q) ||
            opp.legA.platform.toLowerCase().includes(q) ||
            opp.legB.platform.toLowerCase().includes(q));
  });

  // ─── Sorted + filtered matched pairs ───────────────────────────────────
  const pairStatusOrder: Record<string, number> = { approved: 0, pending: 1, paused: 2, rejected: 3 };
  const sortedPairs = [...marketsSummary.matchedPairs]
    .filter(p => pairStatusFilter === 'all' || p.status === pairStatusFilter)
    .filter(p => {
      if (!pairSearch) return true;
      const q = pairSearch.toLowerCase();
      return (p.marketA.question.toLowerCase().includes(q) ||
              p.marketB.question.toLowerCase().includes(q) ||
              p.matchMethod.toLowerCase().includes(q));
    })
    .sort((a, b) => (pairStatusOrder[a.status] ?? 99) - (pairStatusOrder[b.status] ?? 99));

  // Group pairs by status for section headers
  const pairGroups: { status: string; pairs: MatchedPair[] }[] = [];
  let lastStatus = '';
  for (const p of sortedPairs) {
    if (p.status !== lastStatus) {
      pairGroups.push({ status: p.status, pairs: [] });
      lastStatus = p.status;
    }
    pairGroups[pairGroups.length - 1].pairs.push(p);
  }

  // Build filtered market list for Markets tab
  const getFilteredMarkets = () => {
    const allMarkets: (MarketItem & { platform: string })[] = [];
    for (const [platform, data] of Object.entries(marketsSummary.platforms)) {
      for (const m of data.markets) {
        if (platformFilter !== 'all' && platform !== platformFilter) continue;
        if (marketFilter === 'matched' && !m.matched) continue;
        if (marketFilter === 'unmatched' && m.matched) continue;
        if (marketSearch) {
          const q = marketSearch.toLowerCase();
          if (!m.question.toLowerCase().includes(q) && !platform.toLowerCase().includes(q) && !(m.category || '').toLowerCase().includes(q)) continue;
        }
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
          <button className="btn btn-reset" onClick={() => setShowResetConfirm(true)}>⟳ RESET</button>
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
              OPPORTUNITIES ({opportunities.length})
            </button>
            <button className={`tab-btn ${activeTab === 'markets' ? 'tab-active' : ''}`} onClick={() => setActiveTab('markets')}>
              MARKETS ({totalMarkets})
            </button>
            <button className={`tab-btn ${activeTab === 'trades' ? 'tab-active' : ''}`} onClick={() => setActiveTab('trades')}>
              TRADES ({metrics.totalTrades})
            </button>
            <button className={`tab-btn ${activeTab === 'positions' ? 'tab-active' : ''}`} onClick={() => setActiveTab('positions')}>
              POSITIONS ({positions.length})
            </button>
          </div>

          {/* Tab content */}
          <div className="tab-content">
            {/* ─── OPPORTUNITIES TAB ─── */}
            {activeTab === 'opportunities' && (
              <>
                <div className="search-bar-wrap">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search opportunities..."
                    value={oppSearch}
                    onChange={e => setOppSearch(e.target.value)}
                  />
                  {oppSearch && <button className="search-clear" onClick={() => setOppSearch('')}>✕</button>}
                </div>
                {filteredOpps.length === 0 ? (
                  <div className="empty-state">{opportunities.length === 0 ? 'Scanning for opportunities...' : 'No matches'}</div>
                ) : filteredOpps.map((opp, idx) => {
                  const oppSt = getOppStatus(opp);
                  return (
                  <div className="opp-card clickable" key={opp.id} onClick={() => navigateToPairFromOpp(opp)}>
                    <div className="opp-card-header">
                      <span className="opp-number">#{filteredOpps.length - idx}</span>
                      <span className="row-time">{formatTime(opp.discoveredAt)}</span>
                      <span className={`row-profit ${pnlClass(opp.expectedProfitUsd)}`}>
                        {formatUsd(opp.expectedProfitUsd)}
                      </span>
                      <span className="opp-bps">{opp.expectedProfitBps?.toFixed(0) || '—'} bps</span>
                      {opp.maxSize != null && <span className="opp-size">sz {opp.maxSize.toFixed(0)}</span>}
                      <span className="row-confidence" title="Match confidence">{formatPct(opp.matchConfidence * 100)}</span>
                      <span className={`row-status ${oppSt.cls}`}>{oppSt.label}</span>
                    </div>
                    {opp.failReason && (
                      <div className="opp-fail-reason">{opp.failReason}</div>
                    )}
                    <div className="opp-card-legs">
                      {(() => {
                        const legADisplay = getLegDisplay(opp, 'A');
                        const legBDisplay = getLegDisplay(opp, 'B');
                        return (<>
                          <div className="opp-leg">
                            <span className={`row-platform platform-${opp.legA.platform}`}>{opp.legA.platform.slice(0, 5)}</span>
                            <span className={`row-outcome ${opp.legA.outcome === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>
                              {opp.legA.outcome}
                            </span>
                            {legADisplay.teamBetting && (
                              <span className="outcome-team" title={`Betting on: ${legADisplay.teamBetting}`}>
                                ({legADisplay.teamBetting.slice(0, 12)})
                              </span>
                            )}
                            <span className="row-price">{opp.legA.price.toFixed(3)}</span>
                            <span className="opp-market-q">{opp.legA.marketQuestion?.slice(0, 50) || '—'}</span>
                          </div>
                          <span className="opp-arrow">{opp.outcomesInverted ? '⇄' : '↔'}</span>
                          <div className="opp-leg">
                            <span className={`row-platform platform-${opp.legB.platform}`}>{opp.legB.platform.slice(0, 5)}</span>
                            <span className={`row-outcome ${opp.legB.outcome === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>
                              {opp.legB.outcome}
                            </span>
                            {legBDisplay.teamBetting && (
                              <span className="outcome-team" title={`Betting on: ${legBDisplay.teamBetting}`}>
                                ({legBDisplay.teamBetting.slice(0, 12)})
                              </span>
                            )}
                            <span className="row-price">{opp.legB.price.toFixed(3)}</span>
                            <span className="opp-market-q">{opp.legB.marketQuestion?.slice(0, 50) || '—'}</span>
                          </div>
                          {opp.outcomesInverted && (
                            <span className="hedge-badge" title="Outcomes are inverted between platforms — this is a hedged trade">HEDGED</span>
                          )}
                        </>);
                      })()}
                    </div>
                  </div>
                  );
                })}
              </>
            )}

            {/* ─── MARKETS TAB ─── */}
            {activeTab === 'markets' && (
              <>
                {/* Category + Refresh bar */}
                <div className="filter-bar" style={{ alignItems: 'center' }}>
                  <div className="filter-group">
                    <span className="filter-label">CATEGORY</span>
                    <select
                      className="category-select"
                      value={marketCategory}
                      onChange={e => handleCategoryChange(e.target.value)}
                    >
                      <option value="">ALL MARKETS</option>
                      <optgroup label="Sports">
                        <option value="sports">ALL SPORTS</option>
                        <option value="basketball">BASKETBALL</option>
                        <option value="football">FOOTBALL</option>
                        <option value="soccer">SOCCER</option>
                        <option value="baseball">BASEBALL</option>
                        <option value="hockey">HOCKEY</option>
                        <option value="mma">MMA / UFC</option>
                        <option value="tennis">TENNIS</option>
                        <option value="golf">GOLF</option>
                        <option value="motorsports">MOTORSPORTS</option>
                        <option value="boxing">BOXING</option>
                        <option value="cricket">CRICKET</option>
                      </optgroup>
                      <optgroup label="Politics">
                        <option value="politics">ALL POLITICS</option>
                        <option value="elections">ELECTIONS</option>
                        <option value="us-politics">US POLITICS</option>
                      </optgroup>
                      <optgroup label="Other">
                        <option value="crypto">CRYPTO</option>
                        <option value="esports">ESPORTS</option>
                        <option value="finance">FINANCE</option>
                        <option value="culture">CULTURE</option>
                      </optgroup>
                    </select>
                  </div>
                  <button
                    className={`btn btn-refresh ${isRefreshing ? 'btn-refreshing' : ''}`}
                    onClick={handleRefreshMarkets}
                    disabled={isRefreshing}
                  >
                    {isRefreshing ? '↻ REFRESHING...' : '↻ REFRESH MARKETS'}
                  </button>
                </div>

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
                      <span className="panel-tag">{sortedPairs.length}</span>
                    </div>
                    <div className="search-bar-wrap">
                      <input
                        type="text"
                        className="search-input"
                        placeholder="Search pairs..."
                        value={pairSearch}
                        onChange={e => setPairSearch(e.target.value)}
                      />
                      {pairSearch && <button className="search-clear" onClick={() => setPairSearch('')}>✕</button>}
                    </div>
                    {sortedPairs.length === 0 ? (
                      <div className="empty-state">No pairs match filters</div>
                    ) : pairGroups.map(group => (
                      <div key={group.status}>
                        <div className="pair-group-header">
                          <span className={`pair-group-label status-${group.status}`}>{group.status.toUpperCase()}</span>
                          <span className="pair-group-count">{group.pairs.length}</span>
                        </div>
                        {group.pairs.map((pair, i) => (
                          <div className={`pair-row pair-status-${pair.status} clickable`} key={pair.pairId || i}
                            onClick={() => navigateToPair(pair)}>
                            <div className="pair-info">
                              <div className="pair-markets">
                                <span className={`row-platform platform-${pair.marketA.platform}`}>
                                  {pair.marketA.platform.slice(0, 5).toUpperCase()}
                                </span>
                                <span className="pair-question">{pair.marketA.question.slice(0, 55)}</span>
                                <a
                                  className="platform-link"
                                  href={getPlatformMarketUrl(pair.marketA.platform, pair.marketA.slug, pair.marketA.id, pair.marketA.eventSlug)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={e => e.stopPropagation()}
                                  title={`View on ${pair.marketA.platform}`}
                                >↗</a>
                              </div>
                              <div className="pair-separator">⟷</div>
                              <div className="pair-markets">
                                <span className={`row-platform platform-${pair.marketB.platform}`}>
                                  {pair.marketB.platform.slice(0, 5).toUpperCase()}
                                </span>
                                <span className="pair-question">{pair.marketB.question.slice(0, 55)}</span>
                                <a
                                  className="platform-link"
                                  href={getPlatformMarketUrl(pair.marketB.platform, pair.marketB.slug, pair.marketB.id, pair.marketB.eventSlug)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={e => e.stopPropagation()}
                                  title={`View on ${pair.marketB.platform}`}
                                >↗</a>
                              </div>
                            </div>
                            <div className="pair-meta">
                              <span className="pair-confidence">{formatPct(pair.confidence * 100)}</span>
                              <span className={`pair-method method-${pair.matchMethod}`}>{pair.matchMethod.replace('_', ' ')}</span>
                              <span className={`pair-status-badge status-${pair.status ?? 'pending'}`}>{(pair.status ?? 'pending').toUpperCase()}</span>
                              {pair.outcomesInverted && (
                                <span className="inverted-badge" title="YES on one platform = NO on the other. Outcomes are inverted but correctly handled.">INVERTED</span>
                              )}
                            </div>
                            {pair.llmReasoning && (
                              <div className="pair-reasoning">{pair.llmReasoning}</div>
                            )}
                            <div className="pair-actions" onClick={e => e.stopPropagation()}>
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
                    ))}
                  </div>
                )}

                {/* Manual match section */}
                <div className="manual-match-section">
                  <button
                    className={`filter-btn ${manualMatchMode ? 'manual-match-active' : ''}`}
                    onClick={() => { setManualMatchMode(!manualMatchMode); setManualMatchA(null); }}
                  >
                    {manualMatchMode ? '✕ CANCEL MATCH' : '+ MANUAL MATCH'}
                  </button>
                  {manualMatchMode && (
                    <div className="manual-match-banner">
                      {!manualMatchA
                        ? 'Select the FIRST market from the list below'
                        : <>
                            Selected: <span className={`row-platform platform-${manualMatchA.platform}`}>{manualMatchA.platform.slice(0, 5).toUpperCase()}</span>{' '}
                            <span style={{ color: 'var(--text-primary)' }}>{manualMatchA.question.slice(0, 50)}</span>
                            {' — now select a market from the OTHER platform'}
                          </>
                      }
                    </div>
                  )}
                </div>

                {/* All markets list */}
                <div className="section-header" style={{ marginTop: 8 }}>
                  <span className="section-title">ALL MARKETS</span>
                  <span className="panel-tag">{getFilteredMarkets().length}</span>
                </div>
                <div className="search-bar-wrap">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search markets..."
                    value={marketSearch}
                    onChange={e => setMarketSearch(e.target.value)}
                  />
                  {marketSearch && <button className="search-clear" onClick={() => setMarketSearch('')}>✕</button>}
                </div>
                {getFilteredMarkets().length === 0 ? (
                  <div className="empty-state">No markets loaded yet</div>
                ) : getFilteredMarkets().map((m, i) => {
                  const isSelectedA = manualMatchA?.id === m.id && manualMatchA?.platform === m.platform;
                  return (
                  <div
                    className={`market-row clickable ${isSelectedA ? 'manual-match-selected' : ''} ${manualMatchMode ? 'manual-match-candidate' : ''}`}
                    key={`${m.platform}-${m.id}-${i}`}
                    onClick={() => {
                      if (manualMatchMode) {
                        handleManualMatchClick({ id: m.id, platform: m.platform, question: m.question });
                      } else {
                        setBookSelection({ mode: 'single', platformA: m.platform, marketIdA: m.id, questionA: m.question });
                      }
                    }}>
                    <span className={`row-platform platform-${m.platform}`}>{m.platform.slice(0, 5).toUpperCase()}</span>
                    <span className={`match-badge ${m.matched ? 'match-yes' : 'match-no'}`}>
                      {m.matched ? 'PAIRED' : '—'}
                    </span>
                    <span className="market-question">{m.question}</span>
                    {m.category && <span className="market-category">{m.category}</span>}
                    <a
                      className="platform-link"
                      href={getPlatformMarketUrl(m.platform, m.slug, m.id, m.eventSlug)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      title={`View on ${m.platform}`}
                    >↗</a>
                  </div>
                  );
                })}
              </>
            )}

            {/* ─── TRADES TAB ─── */}
            {activeTab === 'trades' && (
              <>
                {trades.length === 0 ? (
                  <div className="empty-state">No trades executed yet</div>
                ) : trades.map((t, idx) => (
                  <div className="trade-card" key={t.id}>
                    <div className="trade-card-header">
                      <span className="opp-number">#{trades.length - idx}</span>
                      <span className="row-time">{formatTime(t.created_at)}</span>
                      <span className={`row-profit ${pnlClass(t.realized_profit_usd)}`}>
                        {formatUsd(t.realized_profit_usd ?? t.expected_profit_usd)}
                      </span>
                      {t.expected_profit_bps != null && (
                        <span className="opp-bps">{t.expected_profit_bps.toFixed(0)} bps</span>
                      )}
                      {t.leg_a_size != null && (
                        <span className="opp-size">sz {t.leg_a_size.toFixed(0)}</span>
                      )}
                      <span className={`row-status ${
                        t.status === 'EXECUTED' ? 'status-executed' :
                        t.status === 'FAILED' ? 'status-failed-trade' : 'status-pending-trade'
                      }`}>
                        {t.status}
                      </span>
                      {t.notes && <span style={{ color: 'var(--text-dim)', fontSize: '9px' }}>{t.notes}</span>}
                    </div>
                    <div className="opp-card-legs">
                      <div className="opp-leg">
                        <span className={`row-platform platform-${t.leg_a_platform || 'polymarket'}`}>
                          {(t.leg_a_platform || 'POLY').slice(0, 5)}
                        </span>
                        <span className={`row-outcome ${t.opp_leg_a_outcome === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>
                          {t.opp_leg_a_outcome || t.leg_a_side || '—'}
                        </span>
                        <span className="row-price">{t.leg_a_price?.toFixed(3) || '—'}</span>
                        <span className="opp-market-q">{t.leg_a_question?.slice(0, 50) || t.leg_a_market_id?.slice(0, 20) || '—'}</span>
                      </div>
                      <span className="opp-arrow">↔</span>
                      <div className="opp-leg">
                        <span className={`row-platform platform-${t.leg_b_platform || 'predictfun'}`}>
                          {(t.leg_b_platform || 'PFUN').slice(0, 5)}
                        </span>
                        <span className={`row-outcome ${t.opp_leg_b_outcome === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>
                          {t.opp_leg_b_outcome || t.leg_b_side || '—'}
                        </span>
                        <span className="row-price">{t.leg_b_price?.toFixed(3) || '—'}</span>
                        <span className="opp-market-q">{t.leg_b_question?.slice(0, 50) || t.leg_b_market_id?.slice(0, 20) || '—'}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* ─── POSITIONS TAB ─── */}
            {activeTab === 'positions' && (
              <>
                {positions.length === 0 ? (
                  <div className="empty-state">No open positions</div>
                ) : positions.map((pos, i) => (
                  <a
                    className="position-row clickable"
                    key={`${pos.platform}-${pos.marketId}-${i}`}
                    href={pos.marketUrl || getPlatformMarketUrl(pos.platform, '', pos.marketId)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className={`pos-source ${pos.source === 'bot' ? 'pos-source-bot' : 'pos-source-personal'}`}>
                      {pos.source === 'bot' ? 'BOT' : 'USER'}
                    </span>
                    <span className={`row-platform platform-${pos.platform}`}>{pos.platform.slice(0, 5).toUpperCase()}</span>
                    <span className={`row-outcome ${pos.side === 'YES' ? 'outcome-yes' : 'outcome-no'}`}>{pos.side}</span>
                    <span className="pos-size">{(pos.size ?? 0).toFixed(1)} shares</span>
                    <span className="pos-entry">@ {(pos.avgEntryPrice ?? 0).toFixed(3)}</span>
                    <span className="pos-current">now {(pos.currentPrice ?? 0).toFixed(3)}</span>
                    <span className={`row-profit ${pnlClass(pos.unrealizedPnl ?? 0)}`}>
                      {formatUsd(pos.unrealizedPnl ?? 0)}
                    </span>
                    <span className="pos-question">{pos.marketQuestion?.slice(0, 45) || pos.marketId}</span>
                    <span className="pos-link-icon">↗</span>
                  </a>
                ))}
              </>
            )}
          </div>
        </div>

        {/* RIGHT: Activity Feed + Strategy */}
        <div className="main-right">
          <div className="panel" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
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

          <div className="panel" style={{ flexShrink: 0 }}>
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
                  {/* Min Profit BPS */}
                  <span className="metric-label">MIN PROFIT</span>
                  {editingParam === 'minProfitBps' ? (
                    <form onSubmit={e => { e.preventDefault(); handleParamSave('minProfitBps', editValue); }} style={{ display: 'flex', gap: 2 }}>
                      <input className="config-input" autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                        onBlur={() => setEditingParam(null)} onKeyDown={e => { if (e.key === 'Escape') setEditingParam(null); }} />
                      <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>BPS</span>
                    </form>
                  ) : (
                    <span className="config-value" onClick={() => { setEditingParam('minProfitBps'); setEditValue(String(configParams.minProfitBps)); }}>
                      {configParams.minProfitBps} BPS
                    </span>
                  )}
                  {/* Max Position */}
                  <span className="metric-label">MAX POSITION</span>
                  {editingParam === 'maxPositionUsd' ? (
                    <form onSubmit={e => { e.preventDefault(); handleParamSave('maxPositionUsd', editValue); }} style={{ display: 'flex', gap: 2 }}>
                      <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>$</span>
                      <input className="config-input" autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                        onBlur={() => setEditingParam(null)} onKeyDown={e => { if (e.key === 'Escape') setEditingParam(null); }} />
                    </form>
                  ) : (
                    <span className="config-value" onClick={() => { setEditingParam('maxPositionUsd'); setEditValue(String(configParams.maxPositionUsd)); }}>
                      ${configParams.maxPositionUsd}
                    </span>
                  )}
                  {/* Max Total Exposure */}
                  <span className="metric-label">MAX EXPOSURE</span>
                  {editingParam === 'maxTotalExposureUsd' ? (
                    <form onSubmit={e => { e.preventDefault(); handleParamSave('maxTotalExposureUsd', editValue); }} style={{ display: 'flex', gap: 2 }}>
                      <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>$</span>
                      <input className="config-input" autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                        onBlur={() => setEditingParam(null)} onKeyDown={e => { if (e.key === 'Escape') setEditingParam(null); }} />
                    </form>
                  ) : (
                    <span className="config-value" onClick={() => { setEditingParam('maxTotalExposureUsd'); setEditValue(String(configParams.maxTotalExposureUsd)); }}>
                      ${configParams.maxTotalExposureUsd.toLocaleString()}
                    </span>
                  )}
                  {/* Scan Interval (read-only) */}
                  <span className="metric-label">SCAN INTERVAL</span>
                  <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>event-driven</span>
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

      {/* ─── ORDER BOOK VIEWER MODAL (single market only) ──── */}
      {bookSelection && (
        <OrderBookViewer
          selection={bookSelection}
          onClose={() => setBookSelection(null)}
        />
      )}

      {/* ─── RESET CONFIRMATION MODAL ────────────────────────── */}
      {showResetConfirm && (
        <div className="reset-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="reset-modal" onClick={e => e.stopPropagation()}>
            <div className="reset-modal-title">RESET ALL DATA</div>
            <div className="reset-modal-body">
              This will permanently delete all data including:
              <ul className="reset-list">
                <li>All matched market pairs</li>
                <li>All trade history</li>
                <li>All discovered opportunities</li>
                <li>All position tracking</li>
                <li>Bot state and configuration overrides</li>
              </ul>
              <div className="reset-warning">This action cannot be undone.</div>
            </div>
            <div className="reset-modal-actions">
              <button className="btn" onClick={() => setShowResetConfirm(false)}>CANCEL</button>
              <button className="btn btn-danger" onClick={handleReset}>CONFIRM RESET</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
