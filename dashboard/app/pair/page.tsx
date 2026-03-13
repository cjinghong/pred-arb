'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import OrderBookViewer, { BookSelection } from '../orderbook-viewer';

// ─── Types ────────────────────────────────────────────────────────────────

interface MatchedPair {
  pairId: string;
  marketA: { id: string; platform: string; question: string };
  marketB: { id: string; platform: string; question: string };
  confidence: number;
  matchMethod: string;
  status: string;
  llmReasoning?: string;
}

// ─── Utils ────────────────────────────────────────────────────────────────

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_API_URL || '';
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// ─── Page ─────────────────────────────────────────────────────────────────

function PairPageContent() {
  const searchParams = useSearchParams();

  // URL only needs the two market IDs — everything else comes from the API
  const marketIdA = searchParams.get('a') || '';
  const marketIdB = searchParams.get('b') || '';

  const [pair, setPair] = useState<MatchedPair | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!marketIdA || !marketIdB) {
      setLoading(false);
      setError('Missing market IDs in URL. Expected: /pair?a=<marketIdA>&b=<marketIdB>');
      return;
    }

    const fetchPair = async () => {
      try {
        const resp = await fetch(`${getApiBase()}/api/markets`);
        if (!resp.ok) { setError(`API error: ${resp.status}`); setLoading(false); return; }
        const data = await resp.json();
        const found = (data.matchedPairs || []).find((p: MatchedPair) =>
          (p.marketA.id === marketIdA && p.marketB.id === marketIdB) ||
          (p.marketA.id === marketIdB && p.marketB.id === marketIdA)
        );
        if (found) {
          setPair(found);
        } else {
          setError(`No matched pair found for markets ${marketIdA} and ${marketIdB}`);
        }
      } catch (err) {
        setError(`Failed to fetch pair data: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    };
    fetchPair();
  }, [marketIdA, marketIdB]);

  if (loading) {
    return (
      <div className="pair-page">
        <div className="pair-page-header">
          <a href="/" className="pair-back-btn">← DASHBOARD</a>
          <span className="pair-page-title">LOADING...</span>
        </div>
        <div className="empty-state">Fetching pair data...</div>
      </div>
    );
  }

  if (error || !pair) {
    return (
      <div className="pair-page">
        <div className="pair-page-header">
          <a href="/" className="pair-back-btn">← DASHBOARD</a>
          <span className="pair-page-title">PAIR NOT FOUND</span>
        </div>
        <div className="empty-state">{error || 'No pair data available.'}</div>
      </div>
    );
  }

  const selection: BookSelection = {
    mode: 'pair',
    platformA: pair.marketA.platform,
    marketIdA: pair.marketA.id,
    questionA: pair.marketA.question,
    platformB: pair.marketB.platform,
    marketIdB: pair.marketB.id,
    questionB: pair.marketB.question,
  };

  return (
    <div className="pair-page">
      {/* Header bar */}
      <div className="pair-page-header">
        <a href="/" className="pair-back-btn">← DASHBOARD</a>
        <span className="pair-page-title">MATCHED PAIR</span>
        <div className="pair-page-meta">
          <span className={`pair-status-badge status-${pair.status}`}>{pair.status.toUpperCase()}</span>
          <span className="pair-confidence-badge">{formatPct(pair.confidence * 100)} confidence</span>
          <span className={`pair-method-badge method-${pair.matchMethod}`}>{pair.matchMethod.replace('_', ' ')}</span>
        </div>
      </div>

      {/* Pair questions */}
      <div className="pair-page-questions">
        <div className="pair-page-q">
          <span className={`row-platform platform-${selection.platformA}`}>{selection.platformA.toUpperCase()}</span>
          <span className="pair-page-question-text">{selection.questionA}</span>
        </div>
        <span className="pair-page-separator">⟷</span>
        <div className="pair-page-q">
          <span className={`row-platform platform-${selection.platformB}`}>{selection.platformB?.toUpperCase()}</span>
          <span className="pair-page-question-text">{selection.questionB}</span>
        </div>
      </div>

      {pair.llmReasoning && (
        <div className="pair-page-reasoning">
          <span className="pair-page-reasoning-label">LLM REASONING</span>
          {pair.llmReasoning}
        </div>
      )}

      {/* Inline orderbook viewer */}
      <div className="pair-page-books">
        <OrderBookViewer selection={selection} inline />
      </div>
    </div>
  );
}

export default function PairPage() {
  return (
    <Suspense fallback={<div className="pair-page"><div className="empty-state">Loading...</div></div>}>
      <PairPageContent />
    </Suspense>
  );
}
