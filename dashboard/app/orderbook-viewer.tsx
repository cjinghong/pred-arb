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
      const a = await fetchBook(selection.platformA, selection.marketIdA, outcomeA);
      if (!active) return;
      detectFlashes(a, prevBidsA, prevAsksA, 'A');
      setBookA(a);

      if (selection.mode === 'pair' && selection.platformB && selection.marketIdB) {
        const b = await fetchBook(selection.platformB, selection.marketIdB, outcomeB);
        if (!active) return;
        detectFlashes(b, prevBidsB, prevAsksB, 'B');
        setBookB(b);
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

      {/* Arb summary for pairs */}
      {selection.mode === 'pair' && bookA && bookB && (
        <ArbSummary
          bookA={bookA}
          bookB={bookB}
          platformA={selection.platformA}
          platformB={selection.platformB!}
          outcomeA={outcomeA}
          outcomeB={outcomeB}
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

function ArbSummary({
  bookA, bookB, platformA, platformB, outcomeA, outcomeB,
}: {
  bookA: OrderBookData; bookB: OrderBookData;
  platformA: string; platformB: string;
  outcomeA: number; outcomeB: number;
}) {
  // Always compute arb based on YES books (outcome 0) regardless of current toggle
  // But show the currently selected outcome context
  const pA = platformA.slice(0, 5).toUpperCase();
  const pB = platformB.slice(0, 5).toUpperCase();

  // Direction 1: Buy YES on A + Buy NO on B
  // Cost = A.bestAsk (YES price) + (1 - B.bestBid) (NO price = 1 - YES bid)
  const d1Valid = bookA.bestAsk !== null && bookB.bestBid !== null;
  const costYesA = bookA.bestAsk ?? 0;
  const costNoB = bookB.bestBid !== null ? 1 - bookB.bestBid : 0;
  const totalCostD1 = costYesA + costNoB;
  const profitD1 = 1 - totalCostD1;

  // Direction 2: Buy NO on A + Buy YES on B
  const d2Valid = bookA.bestBid !== null && bookB.bestAsk !== null;
  const costNoA = bookA.bestBid !== null ? 1 - bookA.bestBid : 0;
  const costYesB = bookB.bestAsk ?? 0;
  const totalCostD2 = costNoA + costYesB;
  const profitD2 = 1 - totalCostD2;

  // Sizing
  const sizeD1A = bookA.asks?.[0]?.size ?? 0;
  const sizeD1B = bookB.bids?.[0]?.size ?? 0;
  const maxSizeD1 = Math.min(sizeD1A, sizeD1B);
  const sizeD2A = bookA.bids?.[0]?.size ?? 0;
  const sizeD2B = bookB.asks?.[0]?.size ?? 0;
  const maxSizeD2 = Math.min(sizeD2A, sizeD2B);

  const outLabel = (idx: number) => idx === 0 ? 'YES' : 'NO';
  const note = (outcomeA !== 0 || outcomeB !== 0)
    ? '(arb calc uses YES books; toggle above to inspect NO book)'
    : '';

  return (
    <div className="ob-arb-summary">
      <div className="ob-arb-header">
        ARB ANALYSIS
        {note && <span className="ob-arb-note">{note}</span>}
      </div>

      {d1Valid && (
        <div className="ob-arb-row">
          <span className="ob-arb-label">
            <span className="ob-arb-dir">D1</span>
            YES {pA} + NO {pB}
          </span>
          <span className="ob-arb-cost">Cost: {formatPrice(totalCostD1)}</span>
          <span className="ob-arb-size">Size: {formatSize(maxSizeD1)}</span>
          <span className={`ob-arb-profit ${profitD1 > 0 ? 'positive' : 'negative'}`}>
            {profitD1 > 0 ? '+' : ''}{formatPrice(profitD1)} ({totalCostD1 > 0 ? ((profitD1 / totalCostD1) * 10000).toFixed(0) : '0'} bps)
          </span>
        </div>
      )}

      {d2Valid && (
        <div className="ob-arb-row">
          <span className="ob-arb-label">
            <span className="ob-arb-dir">D2</span>
            NO {pA} + YES {pB}
          </span>
          <span className="ob-arb-cost">Cost: {formatPrice(totalCostD2)}</span>
          <span className="ob-arb-size">Size: {formatSize(maxSizeD2)}</span>
          <span className={`ob-arb-profit ${profitD2 > 0 ? 'positive' : 'negative'}`}>
            {profitD2 > 0 ? '+' : ''}{formatPrice(profitD2)} ({totalCostD2 > 0 ? ((profitD2 / totalCostD2) * 10000).toFixed(0) : '0'} bps)
          </span>
        </div>
      )}

      {!d1Valid && !d2Valid && (
        <div className="ob-arb-row">
          <span className="ob-arb-label" style={{ color: 'var(--text-dim)' }}>Insufficient book data for arb calculation</span>
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
