'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────

interface PriceLevel {
  price: number;
  size: number;
}

interface OrderBookData {
  platform: string;
  marketId: string;
  outcomeIndex: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  timestamp: string;
}

export interface BookSelection {
  mode: 'single' | 'pair';
  platformA: string;
  marketIdA: string;
  questionA: string;
  platformB?: string;
  marketIdB?: string;
  questionB?: string;
  /** Whether outcome 0 (YES) on market A means the opposite of outcome 0 (YES) on market B */
  outcomesInverted?: boolean;
  /** Outcome labels for market A, e.g. ["Lightning", "Kraken"] */
  outcomesA?: string[];
  /** Outcome labels for market B, e.g. ["Kraken", "Lightning"] */
  outcomesB?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatPrice(p: number): string {
  return p.toFixed(3);
}

function formatSize(s: number): string {
  if (s >= 1000) return `${(s / 1000).toFixed(1)}k`;
  return s.toFixed(0);
}

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_API_URL || `http://${window.location.hostname}:3848`;
}

const MAX_LEVELS = 12;

// ─── OrderBook Viewer Component ───────────────────────────────────────────
// Can be rendered as a modal (with onClose) or inline (without onClose).

export default function OrderBookViewer({
  selection,
  onClose,
  inline,
}: {
  selection: BookSelection;
  onClose?: () => void;
  inline?: boolean;
}) {
  const [bookA, setBookA] = useState<OrderBookData | null>(null);
  const [bookB, setBookB] = useState<OrderBookData | null>(null);
  // YES books always fetched for arb calculation (independent of toggle)
  const [yesBookA, setYesBookA] = useState<OrderBookData | null>(null);
  const [yesBookB, setYesBookB] = useState<OrderBookData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // YES/NO toggle per book: 0 = YES, 1 = NO
  const [outcomeA, setOutcomeA] = useState(0);
  const [outcomeB, setOutcomeB] = useState(0);

  // Track previous prices for flash effect
  const prevBidsA = useRef<Map<number, number>>(new Map());
  const prevAsksA = useRef<Map<number, number>>(new Map());
  const prevBidsB = useRef<Map<number, number>>(new Map());
  const prevAsksB = useRef<Map<number, number>>(new Map());

  // Flash tracking
  const [flashCells, setFlashCells] = useState<Set<string>>(new Set());

  const fetchBook = useCallback(async (platform: string, marketId: string, outcome: number): Promise<OrderBookData | null> => {
    try {
      const resp = await fetch(`${getApiBase()}/api/orderbook/${platform}/${marketId}?outcome=${outcome}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      return await resp.json();
    } catch (err) {
      setError(`Failed to fetch ${platform} orderbook: ${(err as Error).message}`);
      return null;
    }
  }, []);

  const detectFlashes = useCallback((
    newBook: OrderBookData | null,
    prevBids: React.MutableRefObject<Map<number, number>>,
    prevAsks: React.MutableRefObject<Map<number, number>>,
    prefix: string,
  ) => {
    if (!newBook) return;
    const newFlashes = new Set<string>();

    for (const bid of newBook.bids.slice(0, MAX_LEVELS)) {
      const prev = prevBids.current.get(bid.price);
      if (prev !== undefined && prev !== bid.size) {
        newFlashes.add(`${prefix}-bid-${bid.price}`);
      }
    }
    for (const ask of newBook.asks.slice(0, MAX_LEVELS)) {
      const prev = prevAsks.current.get(ask.price);
      if (prev !== undefined && prev !== ask.size) {
        newFlashes.add(`${prefix}-ask-${ask.price}`);
      }
    }

    prevBids.current = new Map(newBook.bids.map(b => [b.price, b.size]));
    prevAsks.current = new Map(newBook.asks.map(a => [a.price, a.size]));

    if (newFlashes.size > 0) {
      setFlashCells(prev => new Set([...prev, ...newFlashes]));
      setTimeout(() => {
        setFlashCells(prev => {
          const next = new Set(prev);
          for (const f of newFlashes) next.delete(f);
          return next;
        });
      }, 600);
    }
  }, []);

  // Reset prev maps when outcome toggles change
  useEffect(() => {
    prevBidsA.current.clear();
    prevAsksA.current.clear();
    setBookA(null);
  }, [outcomeA]);

  useEffect(() => {
    prevBidsB.current.clear();
    prevAsksB.current.clear();
    setBookB(null);
  }, [outcomeB]);

  // Fetch books on mount and poll
  useEffect(() => {
    let active = true;

    const refresh = async () => {
      // Fetch the toggled display books
      const a = await fetchBook(selection.platformA, selection.marketIdA, outcomeA);
      if (!active) return;
      detectFlashes(a, prevBidsA, prevAsksA, 'A');
      setBookA(a);
      // If toggle is on YES, reuse for arb calc; otherwise fetch YES separately
      if (outcomeA === 0) {
        setYesBookA(a);
      } else {
        const yesA = await fetchBook(selection.platformA, selection.marketIdA, 0);
        if (!active) return;
        setYesBookA(yesA);
      }

      if (selection.mode === 'pair' && selection.platformB && selection.marketIdB) {
        const b = await fetchBook(selection.platformB, selection.marketIdB, outcomeB);
        if (!active) return;
        detectFlashes(b, prevBidsB, prevAsksB, 'B');
        setBookB(b);
        if (outcomeB === 0) {
          setYesBookB(b);
        } else {
          const yesB = await fetchBook(selection.platformB, selection.marketIdB, 0);
          if (!active) return;
          setYesBookB(yesB);
        }
      }
    };

    refresh();
    const timer = setInterval(refresh, 1000);

    return () => { active = false; clearInterval(timer); };
  }, [selection, outcomeA, outcomeB, fetchBook, detectFlashes]);

  // Close on Escape (only in modal mode)
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const maxBidSize = Math.max(
    ...(bookA?.bids.slice(0, MAX_LEVELS).map(b => b.size) ?? [1]),
    ...(bookB?.bids.slice(0, MAX_LEVELS).map(b => b.size) ?? [1]),
  );
  const maxAskSize = Math.max(
    ...(bookA?.asks.slice(0, MAX_LEVELS).map(a => a.size) ?? [1]),
    ...(bookB?.asks.slice(0, MAX_LEVELS).map(a => a.size) ?? [1]),
  );

  const outcomeName = (idx: number) => idx === 0 ? 'YES' : 'NO';

  const content = (
    <div className={inline ? 'ob-inline' : 'ob-modal'} onClick={e => e.stopPropagation()}>
      {/* Header */}
      <div className="ob-header">
        <div className="ob-title">
          {selection.mode === 'pair' ? 'MATCHED PAIR ORDER BOOKS' : 'ORDER BOOK'}
        </div>
        {onClose && <button className="ob-close" onClick={onClose}>✕</button>}
      </div>

      {error && <div className="ob-error">{error}</div>}

      <div className={`ob-books ${selection.mode === 'pair' ? 'ob-books-pair' : 'ob-books-single'}`}>
        {/* Book A */}
        <div className="ob-book">
          <div className="ob-book-header">
            <span className={`row-platform platform-${selection.platformA}`}>
              {selection.platformA.toUpperCase()}
            </span>
            <span className="ob-question">{selection.questionA.slice(0, 60)}</span>
            <OutcomeToggle value={outcomeA} onChange={setOutcomeA} />
          </div>
          {bookA ? (
            <>
              <div className="ob-stats">
                <span className="ob-outcome-badge">
                  <span className={`ob-outcome-label ${outcomeA === 0 ? 'ob-outcome-yes' : 'ob-outcome-no'}`}>
                    {outcomeName(outcomeA)} BOOK
                  </span>
                </span>
                <span>Bid: <span className="ob-bid-price">{bookA.bestBid !== null ? formatPrice(bookA.bestBid) : '—'}</span></span>
                <span>Ask: <span className="ob-ask-price">{bookA.bestAsk !== null ? formatPrice(bookA.bestAsk) : '—'}</span></span>
                <span>Spread: <span className="ob-spread">{bookA.spread !== null ? formatPrice(bookA.spread) : '—'}</span></span>
                <span>Mid: <span>{bookA.midPrice !== null ? formatPrice(bookA.midPrice) : '—'}</span></span>
              </div>
              <BookTable
                bids={bookA.bids}
                asks={bookA.asks}
                maxBidSize={maxBidSize}
                maxAskSize={maxAskSize}
                flashCells={flashCells}
                prefix="A"
              />
            </>
          ) : (
            <div className="ob-loading">Loading orderbook...</div>
          )}
        </div>

        {/* Book B (for pairs) */}
        {selection.mode === 'pair' && (
          <div className="ob-book">
            <div className="ob-book-header">
              <span className={`row-platform platform-${selection.platformB}`}>
                {selection.platformB?.toUpperCase()}
              </span>
              <span className="ob-question">{selection.questionB?.slice(0, 60)}</span>
              <OutcomeToggle value={outcomeB} onChange={setOutcomeB} />
            </div>
            {bookB ? (
              <>
                <div className="ob-stats">
                  <span className="ob-outcome-badge">
                    <span className={`ob-outcome-label ${outcomeB === 0 ? 'ob-outcome-yes' : 'ob-outcome-no'}`}>
                      {outcomeName(outcomeB)} BOOK
                    </span>
                  </span>
                  <span>Bid: <span className="ob-bid-price">{bookB.bestBid !== null ? formatPrice(bookB.bestBid) : '—'}</span></span>
                  <span>Ask: <span className="ob-ask-price">{bookB.bestAsk !== null ? formatPrice(bookB.bestAsk) : '—'}</span></span>
                  <span>Spread: <span className="ob-spread">{bookB.spread !== null ? formatPrice(bookB.spread) : '—'}</span></span>
                  <span>Mid: <span>{bookB.midPrice !== null ? formatPrice(bookB.midPrice) : '—'}</span></span>
                </div>
                <BookTable
                  bids={bookB.bids}
                  asks={bookB.asks}
                  maxBidSize={maxBidSize}
                  maxAskSize={maxAskSize}
                  flashCells={flashCells}
                  prefix="B"
                />
              </>
            ) : (
              <div className="ob-loading">Loading orderbook...</div>
            )}
          </div>
        )}
      </div>

      {/* Arb summary for pairs — always uses YES books for calculation */}
      {selection.mode === 'pair' && yesBookA && yesBookB && (
        <ArbSummary
          bookA={yesBookA}
          bookB={yesBookB}
          platformA={selection.platformA}
          platformB={selection.platformB!}
          outcomesInverted={selection.outcomesInverted}
          outcomesA={selection.outcomesA}
          outcomesB={selection.outcomesB}
        />
      )}
    </div>
  );

  if (inline) return content;

  return (
    <div className="ob-overlay" onClick={onClose}>
      {content}
    </div>
  );
}

// ─── Outcome Toggle ──────────────────────────────────────────────────────

function OutcomeToggle({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="ob-outcome-toggle">
      <button
        className={`ob-toggle-btn ob-toggle-yes ${value === 0 ? 'ob-toggle-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onChange(0); }}
      >
        YES
      </button>
      <button
        className={`ob-toggle-btn ob-toggle-no ${value === 1 ? 'ob-toggle-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onChange(1); }}
      >
        NO
      </button>
    </div>
  );
}

// ─── Arb Summary ─────────────────────────────────────────────────────────
//
// Hold-to-resolution (HTR) arb: buy opposing outcomes across platforms so that
// regardless of which team/outcome wins, one position pays $1 and the other $0.
// Profit = $1 - total cost of both legs.
//
// When outcomesInverted = true, YES on platform A means the OPPOSITE of YES on
// platform B. The bot handles this by flipping book B before comparing. Here we
// replicate that logic so the dashboard shows the same math the bot uses.

function ArbSummary({
  bookA, bookB, platformA, platformB,
  outcomesInverted, outcomesA, outcomesB,
}: {
  bookA: OrderBookData; bookB: OrderBookData;
  platformA: string; platformB: string;
  outcomesInverted?: boolean;
  outcomesA?: string[];
  outcomesB?: string[];
}) {
  // bookA and bookB are ALWAYS the YES books (outcome index 0).
  // The arb calculation is independent of the YES/NO toggle above.
  const pA = platformA.slice(0, 5).toUpperCase();
  const pB = platformB.slice(0, 5).toUpperCase();
  const inverted = outcomesInverted ?? false;

  // Resolve human-readable outcome labels
  // outcomesA[0] = what "YES" means on A (e.g. "Lightning")
  // outcomesA[1] = what "NO" means on A (e.g. "Kraken")
  const teamA_yes = outcomesA?.[0] || 'YES';  // what A's YES represents
  const teamA_no  = outcomesA?.[1] || 'NO';   // what A's NO represents

  // Effective book B: when inverted, flip B's book (bids↔asks, prices inverted)
  // This mirrors what the bot does in cross-platform-arb.ts
  let effBookB: { bestBid: number | null; bestAsk: number | null; bids: PriceLevel[]; asks: PriceLevel[] };
  if (inverted) {
    effBookB = {
      bestBid: bookB.bestAsk !== null ? 1 - bookB.bestAsk : null,
      bestAsk: bookB.bestBid !== null ? 1 - bookB.bestBid : null,
      bids: bookB.asks.map(a => ({ price: 1 - a.price, size: a.size })).sort((a, b) => b.price - a.price),
      asks: bookB.bids.map(b => ({ price: 1 - b.price, size: b.size })).sort((a, b) => a.price - b.price),
    };
  } else {
    effBookB = bookB;
  }

  // What outcome to actually buy on B (native) for each direction:
  const bNativeForD1 = inverted ? 'YES' : 'NO';   // bot buys B's native YES when inverted (= opposite outcome)
  const bNativeForD2 = inverted ? 'NO' : 'YES';

  // ── Direction 1: Bet on team A_YES winning ──
  // Buy YES on A (at A's best ask) + buy opposing outcome on B
  // Opposing on B: if aligned, buy NO on B (cost = 1 - B_yes_bid)
  //                if inverted, buy YES on B (cost = B_yes_ask), which represents the opposite team
  // Using effective book: always = A.bestAsk + (1 - effB.bestBid)
  const d1Valid = bookA.bestAsk !== null && effBookB.bestBid !== null;
  const costA_d1 = bookA.bestAsk ?? 0;
  const costB_d1 = effBookB.bestBid !== null ? 1 - effBookB.bestBid : 0;
  const totalCostD1 = costA_d1 + costB_d1;
  const profitD1 = 1 - totalCostD1;

  // ── Direction 2: Bet on team A_NO winning ──
  // Buy NO on A (cost = 1 - A_yes_bid) + buy opposing outcome on B
  // Using effective book: always = (1 - A.bestBid) + effB.bestAsk
  const d2Valid = bookA.bestBid !== null && effBookB.bestAsk !== null;
  const costA_d2 = bookA.bestBid !== null ? 1 - bookA.bestBid : 0;
  const costB_d2 = effBookB.bestAsk ?? 0;
  const totalCostD2 = costA_d2 + costB_d2;
  const profitD2 = 1 - totalCostD2;

  // Sizing (top-of-book only for display)
  const maxSizeD1 = Math.min(
    bookA.asks?.[0]?.size ?? 0,
    inverted ? (bookB.asks?.[0]?.size ?? 0) : (bookB.bids?.[0]?.size ?? 0),
  );
  const maxSizeD2 = Math.min(
    bookA.bids?.[0]?.size ?? 0,
    inverted ? (bookB.bids?.[0]?.size ?? 0) : (bookB.asks?.[0]?.size ?? 0),
  );

  return (
    <div className="ob-arb-summary">
      <div className="ob-arb-header">
        ARB ANALYSIS
        {inverted && <span className="ob-arb-inverted-tag">OUTCOMES INVERTED</span>}
      </div>

      {/* How it works */}
      <div className="ob-arb-explainer">
        Hold-to-resolution: buy opposing outcomes across platforms. One leg always pays $1, the other $0. Profit = $1 - total cost.
        {inverted && ` Since outcomes are inverted, YES on ${pA} and YES on ${pB} represent different teams.`}
        {' '}Computed from YES books — unaffected by the toggle above.
      </div>

      {d1Valid && (
        <div className={`ob-arb-direction ${profitD1 > 0 ? 'ob-arb-profitable' : ''}`}>
          <div className="ob-arb-dir-header">
            <span className="ob-arb-dir-label">DIRECTION 1</span>
            <span className="ob-arb-dir-bet">Bet: {teamA_yes} wins</span>
            <span className={`ob-arb-profit ${profitD1 > 0 ? 'positive' : 'negative'}`}>
              {profitD1 > 0 ? '+' : ''}{formatPrice(profitD1)}/share ({totalCostD1 > 0 ? ((profitD1 / totalCostD1) * 10000).toFixed(0) : '0'} bps)
            </span>
          </div>
          <div className="ob-arb-legs">
            <div className="ob-arb-leg">
              <span className={`ob-arb-leg-platform platform-${platformA}`}>{pA}</span>
              <span className="ob-arb-leg-action">Buy YES</span>
              <span className="ob-arb-leg-price">@ {formatPrice(costA_d1)}</span>
              {outcomesA && <span className="ob-arb-leg-team">{outcomesA[0]}</span>}
            </div>
            <div className="ob-arb-leg">
              <span className={`ob-arb-leg-platform platform-${platformB}`}>{pB}</span>
              <span className="ob-arb-leg-action">Buy {bNativeForD1}</span>
              <span className="ob-arb-leg-price">@ {formatPrice(costB_d1)}</span>
              {outcomesB && <span className="ob-arb-leg-team">
                {inverted ? outcomesB[0] : outcomesB[1]}
              </span>}
            </div>
          </div>
          <div className="ob-arb-math">
            Cost: {formatPrice(costA_d1)} + {formatPrice(costB_d1)} = {formatPrice(totalCostD1)} | Size: {formatSize(maxSizeD1)}
          </div>
          <div className="ob-arb-scenarios">
            <span className="ob-arb-scenario">
              If {teamA_yes} wins: A pays $1, B pays $0 → net = $1 - ${formatPrice(totalCostD1)} = <span className={profitD1 >= 0 ? 'positive' : 'negative'}>${formatPrice(Math.abs(profitD1))}</span>
            </span>
            <span className="ob-arb-scenario">
              If {teamA_no} wins: A pays $0, B pays $1 → net = $1 - ${formatPrice(totalCostD1)} = <span className={profitD1 >= 0 ? 'positive' : 'negative'}>${formatPrice(Math.abs(profitD1))}</span>
            </span>
          </div>
        </div>
      )}

      {d2Valid && (
        <div className={`ob-arb-direction ${profitD2 > 0 ? 'ob-arb-profitable' : ''}`}>
          <div className="ob-arb-dir-header">
            <span className="ob-arb-dir-label">DIRECTION 2</span>
            <span className="ob-arb-dir-bet">Bet: {teamA_no} wins</span>
            <span className={`ob-arb-profit ${profitD2 > 0 ? 'positive' : 'negative'}`}>
              {profitD2 > 0 ? '+' : ''}{formatPrice(profitD2)}/share ({totalCostD2 > 0 ? ((profitD2 / totalCostD2) * 10000).toFixed(0) : '0'} bps)
            </span>
          </div>
          <div className="ob-arb-legs">
            <div className="ob-arb-leg">
              <span className={`ob-arb-leg-platform platform-${platformA}`}>{pA}</span>
              <span className="ob-arb-leg-action">Buy NO</span>
              <span className="ob-arb-leg-price">@ {formatPrice(costA_d2)}</span>
              {outcomesA && <span className="ob-arb-leg-team">{outcomesA[1]}</span>}
            </div>
            <div className="ob-arb-leg">
              <span className={`ob-arb-leg-platform platform-${platformB}`}>{pB}</span>
              <span className="ob-arb-leg-action">Buy {bNativeForD2}</span>
              <span className="ob-arb-leg-price">@ {formatPrice(costB_d2)}</span>
              {outcomesB && <span className="ob-arb-leg-team">
                {inverted ? outcomesB[1] : outcomesB[0]}
              </span>}
            </div>
          </div>
          <div className="ob-arb-math">
            Cost: {formatPrice(costA_d2)} + {formatPrice(costB_d2)} = {formatPrice(totalCostD2)} | Size: {formatSize(maxSizeD2)}
          </div>
          <div className="ob-arb-scenarios">
            <span className="ob-arb-scenario">
              If {teamA_no} wins: A pays $1, B pays $0 → net = $1 - ${formatPrice(totalCostD2)} = <span className={profitD2 >= 0 ? 'positive' : 'negative'}>${formatPrice(Math.abs(profitD2))}</span>
            </span>
            <span className="ob-arb-scenario">
              If {teamA_yes} wins: A pays $0, B pays $1 → net = $1 - ${formatPrice(totalCostD2)} = <span className={profitD2 >= 0 ? 'positive' : 'negative'}>${formatPrice(Math.abs(profitD2))}</span>
            </span>
          </div>
        </div>
      )}

      {!d1Valid && !d2Valid && (
        <div className="ob-arb-direction">
          <span style={{ color: 'var(--text-dim)' }}>Insufficient book data for arb calculation</span>
        </div>
      )}
    </div>
  );
}

// ─── Book Table Sub-Component ─────────────────────────────────────────────

function BookTable({
  bids,
  asks,
  maxBidSize,
  maxAskSize,
  flashCells,
  prefix,
}: {
  bids: PriceLevel[];
  asks: PriceLevel[];
  maxBidSize: number;
  maxAskSize: number;
  flashCells: Set<string>;
  prefix: string;
}) {
  const displayAsks = asks.slice(0, MAX_LEVELS).reverse(); // asks: cheapest at bottom
  const displayBids = bids.slice(0, MAX_LEVELS); // bids: highest at top

  return (
    <div className="ob-table">
      {/* Column headers */}
      <div className="ob-row ob-header-row">
        <span className="ob-col ob-col-size">SIZE</span>
        <span className="ob-col ob-col-price">PRICE</span>
        <span className="ob-col ob-col-bar"></span>
      </div>

      {/* Asks (sell side) */}
      {displayAsks.map((level, i) => {
        const barWidth = (level.size / maxAskSize) * 100;
        const isFlashing = flashCells.has(`${prefix}-ask-${level.price}`);
        return (
          <div className={`ob-row ob-ask-row ${isFlashing ? 'ob-flash-ask' : ''}`} key={`ask-${i}`}>
            <span className="ob-col ob-col-size">{formatSize(level.size)}</span>
            <span className="ob-col ob-col-price ob-ask-price">{formatPrice(level.price)}</span>
            <span className="ob-col ob-col-bar">
              <span className="ob-bar ob-bar-ask" style={{ width: `${barWidth}%` }} />
            </span>
          </div>
        );
      })}

      {/* Spread row */}
      <div className="ob-row ob-spread-row">
        <span className="ob-col ob-col-size"></span>
        <span className="ob-col ob-col-price ob-spread-label">
          {asks.length > 0 && bids.length > 0
            ? `SPREAD ${formatPrice(asks[0].price - bids[0].price)}`
            : 'NO SPREAD'}
        </span>
        <span className="ob-col ob-col-bar"></span>
      </div>

      {/* Bids (buy side) */}
      {displayBids.map((level, i) => {
        const barWidth = (level.size / maxBidSize) * 100;
        const isFlashing = flashCells.has(`${prefix}-bid-${level.price}`);
        return (
          <div className={`ob-row ob-bid-row ${isFlashing ? 'ob-flash-bid' : ''}`} key={`bid-${i}`}>
            <span className="ob-col ob-col-size">{formatSize(level.size)}</span>
            <span className="ob-col ob-col-price ob-bid-price">{formatPrice(level.price)}</span>
            <span className="ob-col ob-col-bar">
              <span className="ob-bar ob-bar-bid" style={{ width: `${barWidth}%` }} />
            </span>
          </div>
        );
      })}

      {bids.length === 0 && asks.length === 0 && (
        <div className="ob-empty">No orders in book</div>
      )}
    </div>
  );
}
