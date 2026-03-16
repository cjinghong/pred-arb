// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Market Matcher
// Multi-pass matching engine to pair equivalent markets across platforms.
//
// Pass 0: Cross-reference match (predict.fun polymarketConditionIds)
// Pass 1: Exact slug match
// Pass 2: Sports-specific normalization (teams + date)
// Pass 3: Fuzzy question text match using Fuse.js
// Pass 4: LLM batch-match (send mixed markets, ask LLM to identify pairs)
// ═══════════════════════════════════════════════════════════════════════════

import Fuse, { IFuseOptions } from 'fuse.js';
import { NormalizedMarket, Platform } from '../types';
import { createChildLogger } from '../utils/logger';
import { LLMVerifier, LLMVerificationResult } from './llm-verifier';
import { eventBus } from '../utils/event-bus';

const log = createChildLogger('matcher');

/** Status of a matched market pair */
export type PairStatus = 'pending' | 'approved' | 'paused' | 'rejected';

export interface MarketPair {
  /** Unique ID for this pair (deterministic from market IDs) */
  pairId: string;
  /** Market on platform A */
  marketA: NormalizedMarket;
  /** Market on platform B */
  marketB: NormalizedMarket;
  /** Confidence score [0..1] */
  confidence: number;
  /** How the match was determined */
  matchMethod: 'cross_reference' | 'exact_slug' | 'sports_normalized' | 'fuzzy_question' | 'combined' | 'llm_verified' | 'llm_matched' | 'manual';
  /** Current status */
  status: PairStatus;
  /**
   * Whether outcome 0 (YES) on marketA represents the OPPOSITE real-world outcome
   * as outcome 0 (YES) on marketB. When true, the arb engine must invert the
   * orderbook for marketB before comparing.
   *
   * Example: Polymarket "Suns vs Celtics" (YES=Suns) matched with
   * Kalshi "KXNBAGAME-...-BOS" (YES=Celtics) → outcomes are inverted.
   *
   * Default: false (outcomes aligned — YES on both = same team wins)
   */
  outcomesInverted?: boolean;
  /** LLM verification result (if available) */
  llmVerification?: LLMVerificationResult;
}

// ─── Sports Normalization ─────────────────────────────────────────────────

interface SportsParsed {
  teamA: string;
  teamB: string;
  date: string | null;
  league: string | null;
  marketType: string; // 'win', 'over', 'spread', etc.
}

/**
 * Extracts team names, date, league from a sports market question.
 * Handles common formats:
 * - "Will the Los Angeles Lakers beat the Boston Celtics on March 15?"
 * - "Lakers vs Celtics - March 15, 2026"
 * - "Will X win the Y game on Z?"
 * - "X vs Y" / "X v Y" / "X at Y"
 */
function parseSportsMarket(question: string, category: string): SportsParsed | null {
  const q = question.trim();

  // Skip non-sports
  const sportsCategories = ['sports', 'nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football',
    'basketball', 'baseball', 'hockey', 'mls', 'tennis', 'ufc', 'mma', 'boxing',
    'cricket', 'f1', 'formula', 'epl', 'premier-league', 'la-liga', 'serie-a', 'bundesliga',
    'champions-league', 'ncaa'];
  const isSportsCategory = sportsCategories.some(s =>
    category.toLowerCase().includes(s) || q.toLowerCase().includes(s)
  );

  // Also detect by pattern: "X vs Y", "X beat Y", "X win against Y"
  const vsPattern = /(.+?)\s+(?:vs\.?|v\.?|versus|at|@)\s+(.+?)(?:\s+(?:on|[-–])\s+(.+))?$/i;
  const winBeatPattern = /will\s+(?:the\s+)?(.+?)\s+(?:win|beat|defeat)\s+(?:the\s+)?(.+?)(?:\s+(?:on|in)\s+(.+?))?(?:\?|$)/i;
  const winGamePattern = /will\s+(?:the\s+)?(.+?)\s+win\s+(?:the\s+)?(?:game|match|series)(?:\s+(?:on|against)\s+(.+?))?(?:\?|$)/i;

  let teamA = '', teamB = '', dateStr: string | null = null;

  const vsMatch = q.match(vsPattern);
  const winMatch = q.match(winBeatPattern);

  if (winMatch) {
    teamA = winMatch[1].trim();
    teamB = winMatch[2].trim();
    dateStr = winMatch[3]?.trim() || null;
  } else if (vsMatch) {
    teamA = vsMatch[1].replace(/^will\s+(?:the\s+)?/i, '').trim();
    teamB = vsMatch[2].trim();
    dateStr = vsMatch[3]?.trim() || null;
  } else if (!isSportsCategory) {
    return null;
  } else {
    return null; // Sports category but can't parse teams
  }

  // Extract date if embedded
  const datePattern = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}/i;
  if (!dateStr) {
    const dateMatch = q.match(datePattern);
    if (dateMatch) dateStr = dateMatch[0];
  }

  // Detect league
  const leaguePatterns: Array<[RegExp, string]> = [
    [/\b(?:NBA|basketball)\b/i, 'NBA'],
    [/\b(?:NFL|football)\b/i, 'NFL'],
    [/\b(?:MLB|baseball)\b/i, 'MLB'],
    [/\b(?:NHL|hockey)\b/i, 'NHL'],
    [/\b(?:MLS|soccer)\b/i, 'MLS'],
    [/\b(?:UFC|MMA)\b/i, 'UFC'],
    [/\b(?:EPL|Premier League)\b/i, 'EPL'],
    [/\b(?:NCAA|college)\b/i, 'NCAA'],
  ];
  let league: string | null = null;
  for (const [pat, name] of leaguePatterns) {
    if (pat.test(q) || pat.test(category)) { league = name; break; }
  }

  return {
    teamA: normalizeTeamName(teamA),
    teamB: normalizeTeamName(teamB),
    date: dateStr,
    league,
    marketType: detectMarketType(q),
  };
}

/** Normalize team name for comparison — strip "the", city names, etc. */
function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/['']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Detect market type: win/moneyline, over/under, spread, etc. */
function detectMarketType(question: string): string {
  const q = question.toLowerCase();
  if (/over|under|total/i.test(q)) return 'over_under';
  if (/spread|handicap|points/i.test(q)) return 'spread';
  if (/win|beat|defeat|champion|finals/i.test(q)) return 'win';
  return 'win'; // default
}

/** Create a normalized key for sports matching */
function sportsMatchKey(parsed: SportsParsed): string {
  // Sort teams alphabetically so order doesn't matter
  const teams = [parsed.teamA, parsed.teamB].sort().join('|');
  const parts = [teams, parsed.marketType];
  if (parsed.date) parts.push(parsed.date);
  if (parsed.league) parts.push(parsed.league);
  return parts.join('::');
}

// ─── Market Matcher ───────────────────────────────────────────────────────

/**
 * MarketMatcher finds equivalent markets across different platforms.
 *
 * Matching strategy (layered, in priority order):
 *  0. Cross-reference match (predict.fun's polymarketConditionIds)
 *  1. Exact slug match (highest confidence)
 *  2. Sports-specific normalization (teams + date)
 *  3. Fuzzy question text match using Fuse.js
 *  4. LLM batch-match for remaining unmatched (ask LLM to identify pairs)
 */
export class MarketMatcher {
  private fuseOptions: IFuseOptions<NormalizedMarket> = {
    keys: [
      { name: 'question', weight: 0.7 },
      { name: 'slug', weight: 0.2 },
      { name: 'category', weight: 0.1 },
    ],
    threshold: 0.4,
    distance: 200,
    includeScore: true,
    minMatchCharLength: 4,
  };

  /** Minimum confidence to consider a match valid */
  private minConfidence = 0.5;

  /** LLM verifier for confirming fuzzy matches and batch-matching */
  private llmVerifier: LLMVerifier;

  /** Persisted pair statuses: pairId → status */
  private pairStatuses = new Map<string, PairStatus>();

  /** Persisted LLM verifications: pairId → result */
  private llmResults = new Map<string, LLMVerificationResult>();

  /** Manually matched pairs: pairId → { marketAId, marketBId } */
  private manualPairs = new Map<string, { marketAId: string; marketBId: string }>();

  constructor(llmVerifier?: LLMVerifier) {
    this.llmVerifier = llmVerifier || new LLMVerifier();
  }

  /** Generate a deterministic pair ID from two market IDs */
  static pairId(marketAId: string, marketBId: string): string {
    const sorted = [marketAId, marketBId].sort();
    return `${sorted[0]}::${sorted[1]}`;
  }

  /**
   * Post-LLM sanity check: verify that two questions share enough content
   * to plausibly be the same market. Catches hallucinated LLM matches like
   * "Morgan Wallen Spotify" ↔ "Ethereum price" that share zero entities.
   *
   * Uses token overlap: extracts meaningful words (3+ chars, not stop words),
   * requires at least 1 shared significant token between the two questions.
   */
  static passesBasicSanityCheck(questionA: string, questionB: string): boolean {
    const stopWords = new Set([
      'will', 'the', 'be', 'of', 'on', 'by', 'in', 'at', 'to', 'for', 'a', 'an',
      'is', 'are', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did',
      'and', 'or', 'but', 'not', 'yes', 'no', 'this', 'that', 'with', 'from',
      'above', 'below', 'over', 'under', 'before', 'after', 'reach', 'hit',
      'price', 'market', 'what', 'who', 'when', 'where', 'how', 'which',
      'than', 'more', 'less', 'most', 'least', 'any', 'all', 'each', 'every',
    ]);

    const extractTokens = (q: string): Set<string> => {
      const tokens = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
      const meaningful = tokens.filter(t => t.length >= 3 && !stopWords.has(t));
      return new Set(meaningful);
    };

    const tokensA = extractTokens(questionA);
    const tokensB = extractTokens(questionB);

    // Count shared tokens
    let shared = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) shared++;
    }

    // Require at least 2 shared meaningful tokens, or 1 if questions are very short
    const minTokens = Math.min(tokensA.size, tokensB.size);
    const requiredShared = minTokens <= 3 ? 1 : 2;

    if (shared < requiredShared) {
      return false;
    }

    // Additional check: if one question mentions a specific entity/asset
    // that the other doesn't mention at all, reject.
    // Extract proper nouns / capitalized words and numbers from originals.
    const extractEntities = (q: string): Set<string> => {
      const entities = new Set<string>();
      // Cryptocurrency/asset names
      const assets = q.match(/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge|cardano|ada)\b/gi);
      if (assets) assets.forEach(a => entities.add(a.toLowerCase()));
      // Dollar amounts
      const amounts = q.match(/\$[\d,]+(?:\.\d+)?/g);
      if (amounts) amounts.forEach(a => entities.add(a.replace(/,/g, '')));
      // Percentages
      const pcts = q.match(/\d+(?:\.\d+)?%/g);
      if (pcts) pcts.forEach(p => entities.add(p));
      // Named entities: capitalized multi-word sequences
      const names = q.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
      if (names) names.forEach(n => entities.add(n.toLowerCase()));
      return entities;
    };

    const entitiesA = extractEntities(questionA);
    const entitiesB = extractEntities(questionB);

    // If both have crypto asset mentions, they must share at least one
    const cryptoA = [...entitiesA].filter(e => ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'dogecoin', 'doge', 'cardano', 'ada'].includes(e));
    const cryptoB = [...entitiesB].filter(e => ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'dogecoin', 'doge', 'cardano', 'ada'].includes(e));
    if (cryptoA.length > 0 && cryptoB.length > 0) {
      // Normalize BTC→bitcoin, ETH→ethereum for comparison
      const normCrypto = (c: string) => {
        const map: Record<string, string> = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', ada: 'cardano', doge: 'dogecoin' };
        return map[c] || c;
      };
      const normA = new Set(cryptoA.map(normCrypto));
      const normB = new Set(cryptoB.map(normCrypto));
      const hasSharedCrypto = [...normA].some(a => normB.has(a));
      if (!hasSharedCrypto) return false; // Different crypto assets
    }

    // If both have dollar amounts, at least one must match
    const dollarsA = [...entitiesA].filter(e => e.startsWith('$'));
    const dollarsB = [...entitiesB].filter(e => e.startsWith('$'));
    if (dollarsA.length > 0 && dollarsB.length > 0) {
      const hasSharedDollar = dollarsA.some(a => dollarsB.includes(a));
      if (!hasSharedDollar) return false; // Different price targets
    }

    return true;
  }

  /** Set pair status (from dashboard or API) */
  setPairStatus(pairId: string, status: PairStatus): void {
    this.pairStatuses.set(pairId, status);
    log.info(`Pair status updated`, { pairId, status });
  }

  /** Get pair status */
  getPairStatus(pairId: string): PairStatus | undefined {
    return this.pairStatuses.get(pairId);
  }

  /** Get all pair statuses */
  getAllPairStatuses(): Map<string, PairStatus> {
    return new Map(this.pairStatuses);
  }

  /** Load pair statuses from DB (called at startup) */
  loadPairStatuses(statuses: Map<string, PairStatus>): void {
    this.pairStatuses = statuses;
    log.info(`Loaded ${statuses.size} pair statuses from DB`);
  }

  /** Load LLM verification results from DB */
  loadLLMResults(results: Map<string, LLMVerificationResult>): void {
    this.llmResults = results;
    log.info(`Loaded ${results.size} LLM verification results from DB`);
  }

  /** Add a manual pair match */
  addManualPair(marketAId: string, marketBId: string): string {
    const pairId = MarketMatcher.pairId(marketAId, marketBId);
    this.manualPairs.set(pairId, { marketAId, marketBId });
    this.pairStatuses.set(pairId, 'approved');
    log.info('Manual pair added', { pairId, marketAId, marketBId });
    return pairId;
  }

  /** Remove a manual pair match */
  removeManualPair(pairId: string): void {
    this.manualPairs.delete(pairId);
    log.info('Manual pair removed', { pairId });
  }

  /** Reset all in-memory pair data */
  reset(): void {
    this.pairStatuses.clear();
    this.manualPairs.clear();
    log.info('Market matcher state reset');
  }

  /**
   * Find matching market pairs across two sets of markets.
   * Returns pairs sorted by confidence (highest first).
   */
  async findPairs(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
  ): Promise<MarketPair[]> {
    const pairs: MarketPair[] = [];
    const usedA = new Set<string>();
    const usedB = new Set<string>();

    // Build lookup maps
    const mapA = new Map(marketsA.map(m => [m.id, m]));
    const mapB = new Map(marketsB.map(m => [m.id, m]));

    // ─── Pass 0: Manual pairs ──────────────────────────────────────────
    for (const [pairId, { marketAId, marketBId }] of this.manualPairs) {
      const a = mapA.get(marketAId) || mapB.get(marketAId);
      const b = mapB.get(marketBId) || mapA.get(marketBId);
      if (a && b) {
        pairs.push({
          pairId,
          marketA: a.platform === 'polymarket' ? a : b,
          marketB: a.platform === 'polymarket' ? b : a,
          confidence: 1.0,
          matchMethod: 'manual',
          status: this.pairStatuses.get(pairId) || 'approved',
        });
        usedA.add(a.id);
        usedB.add(b.id);
      }
    }

    // ─── Pass 1: Cross-reference matching ──────────────────────────────
    // Supports multiple cross-reference fields:
    //   - predict.fun → Polymarket: polymarketConditionIds[] ↔ conditionId
    //   - predict.fun → Kalshi:     kalshiMarketTicker ↔ ticker
    //   - Polymarket  → Kalshi:     conditionId (if Kalshi provides it)
    //
    // We build lookup maps from both sides and check all known cross-ref fields.

    // Build condition/ticker lookup maps from BOTH sides
    const polyConditionMap = new Map<string, NormalizedMarket>(); // conditionId → market
    const kalshiTickerMap = new Map<string, NormalizedMarket>();   // ticker → market

    for (const m of [...marketsA, ...marketsB]) {
      if (usedA.has(m.id) || usedB.has(m.id)) continue;
      const raw = m.raw as Record<string, unknown> | undefined;
      if (!raw) continue;

      // Polymarket markets have conditionId
      if (raw.conditionId && typeof raw.conditionId === 'string') {
        polyConditionMap.set(raw.conditionId.toLowerCase(), m);
      }
      // Kalshi markets are keyed by ticker (= market.id for Kalshi)
      if (m.platform === 'kalshi') {
        kalshiTickerMap.set(m.id.toLowerCase(), m);
      }
    }

    // Check cross-references from both marketsA and marketsB
    const allMarketsList = [
      { markets: marketsA, usedSet: usedA, otherUsed: usedB },
      { markets: marketsB, usedSet: usedB, otherUsed: usedA },
    ];

    for (const { markets, usedSet, otherUsed } of allMarketsList) {
      for (const m of markets) {
        if (usedSet.has(m.id)) continue;
        const raw = m.raw as Record<string, unknown> | undefined;
        if (!raw) continue;

        // predict.fun → Polymarket cross-reference
        const polyIds = raw.polymarketConditionIds as string[] | undefined;
        if (polyIds && Array.isArray(polyIds)) {
          for (const condId of polyIds) {
            const match = polyConditionMap.get(condId.toLowerCase());
            if (match && match.id !== m.id && !otherUsed.has(match.id) && !usedSet.has(match.id)) {
              const pairId = MarketMatcher.pairId(m.id, match.id);
              pairs.push({
                pairId,
                marketA: match, // Polymarket side
                marketB: m,     // predict.fun side
                confidence: 1.0,
                matchMethod: 'cross_reference',
                status: this.pairStatuses.get(pairId) || 'approved',
              });
              usedSet.add(m.id);
              otherUsed.add(match.id);
              break;
            }
          }
        }

        if (usedSet.has(m.id)) continue;

        // predict.fun → Kalshi cross-reference via kalshiMarketTicker
        const kalshiTicker = raw.kalshiMarketTicker as string | null | undefined;
        if (kalshiTicker && typeof kalshiTicker === 'string') {
          const match = kalshiTickerMap.get(kalshiTicker.toLowerCase());
          if (match && match.id !== m.id && !otherUsed.has(match.id) && !usedSet.has(match.id)) {
            const pairId = MarketMatcher.pairId(m.id, match.id);
            pairs.push({
              pairId,
              marketA: m,     // predict.fun side
              marketB: match, // Kalshi side
              confidence: 1.0,
              matchMethod: 'cross_reference',
              status: this.pairStatuses.get(pairId) || 'approved',
            });
            usedSet.add(m.id);
            otherUsed.add(match.id);
          }
        }
      }
    }

    const crossRefCount = pairs.length;
    log.info(`Pass 0+1: ${crossRefCount} pairs from cross-reference + manual`);
    eventBus.emit('discovery:match_pass', { pass: 'cross-ref', pairs: crossRefCount, remaining: marketsA.length + marketsB.length - usedA.size - usedB.size });

    // ─── Pass 2: Exact slug matching (Map-based O(n+m)) ────────────────
    const slugBIndex = new Map<string, NormalizedMarket>();
    for (const b of marketsB) {
      if (usedB.has(b.id) || !b.slug) continue;
      const normSlug = this.normalizeSlug(b.slug);
      if (normSlug && !slugBIndex.has(normSlug)) {
        slugBIndex.set(normSlug, b);
      }
    }
    for (const a of marketsA) {
      if (usedA.has(a.id) || !a.slug) continue;
      const normSlug = this.normalizeSlug(a.slug);
      if (!normSlug) continue;
      const slugMatch = slugBIndex.get(normSlug);
      if (slugMatch && !usedB.has(slugMatch.id)) {
        const pairId = MarketMatcher.pairId(a.id, slugMatch.id);
        pairs.push({
          pairId,
          marketA: a,
          marketB: slugMatch,
          confidence: 0.95,
          matchMethod: 'exact_slug',
          status: this.pairStatuses.get(pairId) || 'approved',
        });
        usedA.add(a.id);
        usedB.add(slugMatch.id);
      }
    }

    log.info(`Pass 2: ${pairs.length - crossRefCount} pairs from slug match`);
    eventBus.emit('discovery:match_pass', { pass: 'slug', pairs: pairs.length - crossRefCount, remaining: marketsA.length + marketsB.length - usedA.size - usedB.size });

    // ─── Pass 3: Sports-specific normalization ──────────────────────────
    const unmatchedA3 = marketsA.filter(a => !usedA.has(a.id));
    const unmatchedB3 = marketsB.filter(b => !usedB.has(b.id));

    // Parse sports markets from side B and build a lookup
    const sportsBIndex = new Map<string, NormalizedMarket>();
    for (const b of unmatchedB3) {
      const parsed = parseSportsMarket(b.question, b.category);
      if (parsed) {
        sportsBIndex.set(sportsMatchKey(parsed), b);
      }
    }

    let sportsMatches = 0;
    for (const a of unmatchedA3) {
      if (usedA.has(a.id)) continue;
      const parsed = parseSportsMarket(a.question, a.category);
      if (!parsed) continue;

      const key = sportsMatchKey(parsed);
      const match = sportsBIndex.get(key);
      if (match && !usedB.has(match.id)) {
        const pairId = MarketMatcher.pairId(a.id, match.id);
        pairs.push({
          pairId,
          marketA: a,
          marketB: match,
          confidence: 0.9,
          matchMethod: 'sports_normalized',
          status: this.pairStatuses.get(pairId) || 'approved',
        });
        usedA.add(a.id);
        usedB.add(match.id);
        sportsMatches++;
      }
    }

    log.info(`Pass 3: ${sportsMatches} pairs from sports normalization`);
    eventBus.emit('discovery:match_pass', { pass: 'sports', pairs: sportsMatches, remaining: marketsA.length + marketsB.length - usedA.size - usedB.size });

    // ─── Pass 4: Fuzzy question matching ────────────────────────────────
    const unmatchedA4 = marketsA.filter(a => !usedA.has(a.id));
    const unmatchedB4 = marketsB.filter(b => !usedB.has(b.id));

    const fuzzyCandidates: Array<{
      marketA: NormalizedMarket;
      marketB: NormalizedMarket;
      fuzzyScore: number;
    }> = [];

    if (unmatchedA4.length > 0 && unmatchedB4.length > 0) {
      const fuse = new Fuse(unmatchedB4, this.fuseOptions);

      for (const a of unmatchedA4) {
        const results = fuse.search(a.question);
        if (results.length > 0) {
          const best = results[0];
          const fuseScore = 1 - (best.score ?? 1);
          const dateBoost = this.datesClose(a.endDate, best.item.endDate) ? 0.1 : 0;
          const categoryBoost = a.category === best.item.category ? 0.05 : 0;
          const keywordBoost = this.keywordOverlap(a.question, best.item.question);
          const confidence = Math.min(
            fuseScore + dateBoost + categoryBoost + keywordBoost,
            0.99,
          );

          if (confidence >= this.minConfidence && !usedB.has(best.item.id)) {
            fuzzyCandidates.push({
              marketA: a,
              marketB: best.item,
              fuzzyScore: confidence,
            });
            usedA.add(a.id);
            usedB.add(best.item.id);
          }
        }
      }
    }

    eventBus.emit('discovery:match_pass', { pass: 'fuzzy', pairs: fuzzyCandidates.length, remaining: marketsA.length + marketsB.length - usedA.size - usedB.size });

    // ─── Pass 5: LLM bucket-match for remaining unmatched ───────────────
    // Instead of dumping 50 random markets into the LLM, we:
    // 1. Use Fuse.js to find top fuzzy candidates for each A market
    // 2. Group into buckets: { marketA, candidates: [top B matches] }
    // 3. Send buckets to LLM for verification (much more targeted)
    const remainingA = marketsA.filter(a => !usedA.has(a.id));
    const remainingB = marketsB.filter(b => !usedB.has(b.id));

    if (this.llmVerifier.isEnabled && remainingA.length > 0 && remainingB.length > 0) {
      const llmPairs = await this.llmBucketMatch(remainingA, remainingB, usedA, usedB);
      for (const lp of llmPairs) {
        const pairId = MarketMatcher.pairId(lp.marketA.id, lp.marketB.id);
        const savedStatus = this.pairStatuses.get(pairId);
        pairs.push({
          pairId,
          marketA: lp.marketA,
          marketB: lp.marketB,
          confidence: lp.confidence,
          matchMethod: 'llm_matched',
          // LLM matches always start as 'pending' — require manual approval.
          status: savedStatus || 'pending',
          llmVerification: lp.llmResult,
        });
        usedA.add(lp.marketA.id);
        usedB.add(lp.marketB.id);
      }
      log.info(`Pass 5: ${llmPairs.length} pairs from LLM bucket-match`);
      eventBus.emit('discovery:match_pass', { pass: 'llm-done', pairs: llmPairs.length, remaining: marketsA.length + marketsB.length - usedA.size - usedB.size });
    } else if (!this.llmVerifier.isEnabled) {
      eventBus.emit('discovery:match_pass', { pass: 'llm-skip', pairs: 0, remaining: remainingA.length + remainingB.length });
    }

    // ─── Apply LLM verification to fuzzy candidates ─────────────────────
    if (fuzzyCandidates.length > 0) {
      const needsVerification: typeof fuzzyCandidates = [];
      const alreadyVerified: typeof fuzzyCandidates = [];

      for (const c of fuzzyCandidates) {
        const pairId = MarketMatcher.pairId(c.marketA.id, c.marketB.id);
        if (this.llmResults.has(pairId)) {
          alreadyVerified.push(c);
        } else {
          needsVerification.push(c);
        }
      }

      if (needsVerification.length > 0 && this.llmVerifier.isEnabled) {
        log.info(`Running LLM verification on ${needsVerification.length} fuzzy matches`);
        try {
          const verifications = await this.llmVerifier.verifyPairs(needsVerification);
          for (let i = 0; i < needsVerification.length; i++) {
            const pairId = MarketMatcher.pairId(
              needsVerification[i].marketA.id,
              needsVerification[i].marketB.id,
            );
            this.llmResults.set(pairId, verifications[i]);
          }
        } catch (err) {
          log.error('LLM verification failed', { error: (err as Error).message });
        }
      }

      // Build final pairs from fuzzy candidates with LLM results
      for (const c of fuzzyCandidates) {
        const pairId = MarketMatcher.pairId(c.marketA.id, c.marketB.id);
        const llmResult = this.llmResults.get(pairId);
        const savedStatus = this.pairStatuses.get(pairId);

        let confidence = c.fuzzyScore;
        let matchMethod: MarketPair['matchMethod'] = 'combined';
        let status: PairStatus = savedStatus || 'pending';

        if (llmResult) {
          if (llmResult.isSameMarket && llmResult.confidence >= 0.85) {
            confidence = Math.max(confidence, llmResult.confidence);
            matchMethod = 'llm_verified';
            // LLM-verified matches always stay pending — require manual approval.
            // Local LLMs can hallucinate high confidence on wrong matches.
          } else if (!llmResult.isSameMarket) {
            if (!savedStatus) {
              status = 'rejected';
            }
            confidence = Math.min(confidence, 0.3);
          }
        }

        pairs.push({
          pairId,
          marketA: c.marketA,
          marketB: c.marketB,
          confidence,
          matchMethod,
          status,
          llmVerification: llmResult,
        });
      }
    }

    pairs.sort((a, b) => b.confidence - a.confidence);

    log.info(`Found ${pairs.length} market pairs`, {
      crossRef: pairs.filter(p => p.matchMethod === 'cross_reference').length,
      manual: pairs.filter(p => p.matchMethod === 'manual').length,
      exactSlug: pairs.filter(p => p.matchMethod === 'exact_slug').length,
      sports: pairs.filter(p => p.matchMethod === 'sports_normalized').length,
      llmMatched: pairs.filter(p => p.matchMethod === 'llm_matched').length,
      llmVerified: pairs.filter(p => p.matchMethod === 'llm_verified').length,
      fuzzy: pairs.filter(p => p.matchMethod === 'combined').length,
      approved: pairs.filter(p => p.status === 'approved').length,
      pending: pairs.filter(p => p.status === 'pending').length,
      rejected: pairs.filter(p => p.status === 'rejected').length,
    });

    return pairs;
  }

  // ─── LLM Batch-Match ──────────────────────────────────────────────────

  /**
   * Instead of verifying pre-matched pairs, give the LLM a mixed list of
   * unmatched markets from both platforms and ask it to identify which ones
   * are the same market. This finds pairs that fuzzy matching missed.
   *
   * Optimized for minimal LLM calls by batching.
   */
  /**
   * LLM bucket-match: fuzzy pre-grouping → candidate buckets → LLM verify.
   *
   * Instead of randomly dumping markets into the LLM, we:
   * 1. Use Fuse.js to find top-3 fuzzy candidates for each A market in B
   * 2. Filter to only buckets with a reasonable fuzzy score (>= 0.3)
   * 3. Sort buckets by best fuzzy score (most likely matches first)
   * 4. Send top N buckets to LLM for verification
   *
   * This is much more targeted: the LLM only sees plausible candidate pairs.
   */
  private async llmBucketMatch(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
    usedA: Set<string>,
    usedB: Set<string>,
  ): Promise<Array<{
    marketA: NormalizedMarket;
    marketB: NormalizedMarket;
    confidence: number;
    llmResult: LLMVerificationResult;
  }>> {
    const MAX_BUCKETS = 20; // Max buckets per LLM call
    const CANDIDATES_PER_BUCKET = 3; // Top fuzzy candidates per A market
    const MIN_FUZZY_SCORE = 0.3; // Minimum fuzzy score to even bother with LLM

    if (marketsA.length === 0 || marketsB.length === 0) return [];

    // ── Step 1: Fuzzy pre-grouping ────────────────────────────────────────
    // For each A market, find its top fuzzy candidates in B
    const bucketFuse = new Fuse(marketsB, {
      keys: ['question'],
      threshold: 0.7,
      includeScore: true,
    });

    const buckets: Array<{
      marketA: NormalizedMarket;
      candidates: NormalizedMarket[];
      bestScore: number;
    }> = [];

    for (const a of marketsA) {
      if (usedA.has(a.id)) continue;
      const results = bucketFuse.search(a.question);

      const topCandidates: NormalizedMarket[] = [];
      let bestScore = 0;

      for (const r of results.slice(0, CANDIDATES_PER_BUCKET)) {
        if (usedB.has(r.item.id)) continue;
        const score = 1 - (r.score ?? 1);
        if (score >= MIN_FUZZY_SCORE) {
          topCandidates.push(r.item);
          bestScore = Math.max(bestScore, score);
        }
      }

      if (topCandidates.length > 0) {
        buckets.push({ marketA: a, candidates: topCandidates, bestScore });
      }
    }

    // Sort by best fuzzy score descending — prioritize most likely matches
    buckets.sort((a, b) => b.bestScore - a.bestScore);
    const selectedBuckets = buckets.slice(0, MAX_BUCKETS);

    log.info(`LLM bucket-match: ${marketsA.length} A × ${marketsB.length} B → ${buckets.length} buckets → ${selectedBuckets.length} sent to LLM`);

    if (selectedBuckets.length === 0) {
      eventBus.emit('discovery:match_pass', { pass: 'llm-skip', pairs: 0, remaining: marketsA.length + marketsB.length });
      return [];
    }

    eventBus.emit('discovery:match_pass', { pass: 'llm-start', pairs: 0, remaining: selectedBuckets.length });

    // ── Step 2: Send buckets to LLM ───────────────────────────────────────
    const llmPairs: Array<{
      marketA: NormalizedMarket;
      marketB: NormalizedMarket;
      confidence: number;
      llmResult: LLMVerificationResult;
    }> = [];

    try {
      const matches = await this.llmVerifier.batchMatchBuckets(
        selectedBuckets.map(b => ({ marketA: b.marketA, candidates: b.candidates })),
      );

      // ── Step 3: Parse LLM results back to market pairs ────────────────
      for (const match of matches) {
        if (match.confidence < 0.90) continue;

        // Parse "A1" → bucket index 0, "B1.2" → bucket 0, candidate index 1
        const aIdx = parseInt(match.a.replace(/^A/i, '')) - 1;
        if (aIdx < 0 || aIdx >= selectedBuckets.length) continue;

        const bParts = match.b.replace(/^B/i, '').split('.');
        const bBucket = parseInt(bParts[0]) - 1;
        const bCandIdx = parseInt(bParts[1]) - 1;

        if (bBucket !== aIdx) {
          log.warn('LLM returned cross-bucket match, skipping', { a: match.a, b: match.b });
          continue;
        }

        const bucket = selectedBuckets[aIdx];
        if (bCandIdx < 0 || bCandIdx >= bucket.candidates.length) continue;

        const mA = bucket.marketA;
        const mB = bucket.candidates[bCandIdx];

        // Post-LLM sanity check
        if (!MarketMatcher.passesBasicSanityCheck(mA.question, mB.question)) {
          log.warn('LLM match REJECTED by sanity check', {
            a: mA.question.slice(0, 80),
            b: mB.question.slice(0, 80),
            llmConfidence: match.confidence,
          });
          continue;
        }

        const llmResult: LLMVerificationResult = {
          marketA: { id: mA.id, platform: mA.platform, question: mA.question },
          marketB: { id: mB.id, platform: mB.platform, question: mB.question },
          isSameMarket: true,
          confidence: match.confidence,
          reasoning: match.reasoning,
        };

        const pairId = MarketMatcher.pairId(mA.id, mB.id);
        this.llmResults.set(pairId, llmResult);

        llmPairs.push({ marketA: mA, marketB: mB, confidence: match.confidence, llmResult });
      }
    } catch (err) {
      log.error('LLM bucket-match failed', { error: (err as Error).message });
    }

    return llmPairs;
  }

  // ─── Sync version (no LLM calls) ─────────────────────────────────────

  /**
   * Synchronous version for backward compatibility.
   * Does not run LLM verification — uses cached results only.
   */
  findPairsSync(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
  ): MarketPair[] {
    const pairs: MarketPair[] = [];
    const usedA = new Set<string>();
    const usedB = new Set<string>();

    // Manual pairs
    const mapA = new Map(marketsA.map(m => [m.id, m]));
    const mapB = new Map(marketsB.map(m => [m.id, m]));
    for (const [pairId, { marketAId, marketBId }] of this.manualPairs) {
      const a = mapA.get(marketAId) || mapB.get(marketAId);
      const b = mapB.get(marketBId) || mapA.get(marketBId);
      if (a && b) {
        pairs.push({ pairId, marketA: a, marketB: b, confidence: 1.0, matchMethod: 'manual', status: this.pairStatuses.get(pairId) || 'approved' });
        usedA.add(a.id); usedB.add(b.id);
      }
    }

    // Cross-reference (polymarketConditionIds + kalshiMarketTicker)
    const polyConditionMap2 = new Map<string, NormalizedMarket>();
    const kalshiTickerMap2 = new Map<string, NormalizedMarket>();
    for (const m of [...marketsA, ...marketsB]) {
      if (usedA.has(m.id) || usedB.has(m.id)) continue;
      const raw = m.raw as Record<string, unknown> | undefined;
      if (raw?.conditionId && typeof raw.conditionId === 'string') polyConditionMap2.set(raw.conditionId.toLowerCase(), m);
      if (m.platform === 'kalshi') kalshiTickerMap2.set(m.id.toLowerCase(), m);
    }
    for (const m of [...marketsA, ...marketsB]) {
      if (usedA.has(m.id) || usedB.has(m.id)) continue;
      const raw = m.raw as Record<string, unknown> | undefined;
      if (!raw) continue;
      // polymarketConditionIds cross-ref
      const polyIds = raw.polymarketConditionIds as string[] | undefined;
      if (polyIds && Array.isArray(polyIds)) {
        for (const condId of polyIds) {
          const match = polyConditionMap2.get(condId.toLowerCase());
          if (match && match.id !== m.id && !usedA.has(match.id) && !usedB.has(match.id)) {
            const pairId = MarketMatcher.pairId(m.id, match.id);
            pairs.push({ pairId, marketA: match, marketB: m, confidence: 1.0, matchMethod: 'cross_reference', status: this.pairStatuses.get(pairId) || 'approved' });
            usedA.add(match.id); usedB.add(m.id); break;
          }
        }
      }
      if (usedA.has(m.id) || usedB.has(m.id)) continue;
      // kalshiMarketTicker cross-ref
      const kalshiTicker = raw.kalshiMarketTicker as string | null | undefined;
      if (kalshiTicker && typeof kalshiTicker === 'string') {
        const match = kalshiTickerMap2.get(kalshiTicker.toLowerCase());
        if (match && match.id !== m.id && !usedA.has(match.id) && !usedB.has(match.id)) {
          const pairId = MarketMatcher.pairId(m.id, match.id);
          pairs.push({ pairId, marketA: m, marketB: match, confidence: 1.0, matchMethod: 'cross_reference', status: this.pairStatuses.get(pairId) || 'approved' });
          usedA.add(m.id); usedB.add(match.id);
        }
      }
    }

    // Slug match (Map-based O(n+m))
    const slugBIndex2 = new Map<string, NormalizedMarket>();
    for (const b of marketsB) {
      if (usedB.has(b.id) || !b.slug) continue;
      const ns = this.normalizeSlug(b.slug);
      if (ns && !slugBIndex2.has(ns)) slugBIndex2.set(ns, b);
    }
    for (const a of marketsA) {
      if (usedA.has(a.id) || !a.slug) continue;
      const ns = this.normalizeSlug(a.slug);
      if (!ns) continue;
      const slugMatch = slugBIndex2.get(ns);
      if (slugMatch && !usedB.has(slugMatch.id)) {
        const pairId = MarketMatcher.pairId(a.id, slugMatch.id);
        pairs.push({ pairId, marketA: a, marketB: slugMatch, confidence: 0.95, matchMethod: 'exact_slug', status: this.pairStatuses.get(pairId) || 'approved' });
        usedA.add(a.id); usedB.add(slugMatch.id);
      }
    }

    // Sports matching
    const unmatchedA3 = marketsA.filter(a => !usedA.has(a.id));
    const unmatchedB3 = marketsB.filter(b => !usedB.has(b.id));
    const sportsBIndex = new Map<string, NormalizedMarket>();
    for (const b of unmatchedB3) {
      const parsed = parseSportsMarket(b.question, b.category);
      if (parsed) sportsBIndex.set(sportsMatchKey(parsed), b);
    }
    for (const a of unmatchedA3) {
      if (usedA.has(a.id)) continue;
      const parsed = parseSportsMarket(a.question, a.category);
      if (!parsed) continue;
      const match = sportsBIndex.get(sportsMatchKey(parsed));
      if (match && !usedB.has(match.id)) {
        const pairId = MarketMatcher.pairId(a.id, match.id);
        pairs.push({ pairId, marketA: a, marketB: match, confidence: 0.9, matchMethod: 'sports_normalized', status: this.pairStatuses.get(pairId) || 'approved' });
        usedA.add(a.id); usedB.add(match.id);
      }
    }

    // Fuzzy
    const unmatchedA4 = marketsA.filter(a => !usedA.has(a.id));
    const unmatchedB4 = marketsB.filter(b => !usedB.has(b.id));
    if (unmatchedA4.length > 0 && unmatchedB4.length > 0) {
      const fuse = new Fuse(unmatchedB4, this.fuseOptions);
      for (const a of unmatchedA4) {
        const results = fuse.search(a.question);
        if (results.length > 0) {
          const best = results[0];
          const fuseScore = 1 - (best.score ?? 1);
          const dateBoost = this.datesClose(a.endDate, best.item.endDate) ? 0.1 : 0;
          const categoryBoost = a.category === best.item.category ? 0.05 : 0;
          const keywordBoost = this.keywordOverlap(a.question, best.item.question);
          const confidence = Math.min(fuseScore + dateBoost + categoryBoost + keywordBoost, 0.99);

          if (confidence >= this.minConfidence && !usedB.has(best.item.id)) {
            const pairId = MarketMatcher.pairId(a.id, best.item.id);
            const llmResult = this.llmResults.get(pairId);
            pairs.push({
              pairId, marketA: a, marketB: best.item, confidence,
              matchMethod: llmResult?.isSameMarket ? 'llm_verified' : 'combined',
              status: this.pairStatuses.get(pairId) || 'pending',
              llmVerification: llmResult,
            });
            usedA.add(a.id); usedB.add(best.item.id);
          }
        }
      }
    }

    pairs.sort((a, b) => b.confidence - a.confidence);
    return pairs;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private normalizeSlug(s: string): string {
    if (!s) return '';
    return s.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private slugsMatch(slugA: string, slugB: string): boolean {
    if (!slugA || !slugB) return false;
    const normalize = (s: string) =>
      s.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return normalize(slugA) === normalize(slugB);
  }

  private datesClose(a: Date | null, b: Date | null): boolean {
    if (!a || !b) return false;
    const diffMs = Math.abs(a.getTime() - b.getTime());
    return diffMs < 7 * 24 * 60 * 60 * 1000;
  }

  private keywordOverlap(textA: string, textB: string): number {
    const extract = (text: string): Set<string> => {
      const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'will', 'be', 'to', 'in', 'of',
        'and', 'or', 'for', 'on', 'at', 'by', 'it', 'if', 'as', 'do',
        'this', 'that', 'with', 'from', 'has', 'have', 'was', 'were',
      ]);
      return new Set(
        text.toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w))
      );
    };

    const wordsA = extract(textA);
    const wordsB = extract(textB);
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }

    const jaccardIndex = overlap / (wordsA.size + wordsB.size - overlap);
    return jaccardIndex * 0.15;
  }
}
