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

    // ─── Pass 1: Cross-reference via polymarketConditionIds ─────────────
    // predict.fun markets have polymarketConditionIds[] that map to Polymarket conditionIds
    const polyConditionMap = new Map<string, NormalizedMarket>();
    for (const a of marketsA) {
      if (usedA.has(a.id)) continue;
      const raw = a.raw as { conditionId?: string } | undefined;
      if (raw?.conditionId) {
        polyConditionMap.set(raw.conditionId.toLowerCase(), a);
      }
    }

    for (const b of marketsB) {
      if (usedB.has(b.id)) continue;
      const raw = b.raw as { polymarketConditionIds?: string[] } | undefined;
      const polyIds = raw?.polymarketConditionIds || [];
      for (const condId of polyIds) {
        const match = polyConditionMap.get(condId.toLowerCase());
        if (match && !usedA.has(match.id)) {
          const pairId = MarketMatcher.pairId(match.id, b.id);
          pairs.push({
            pairId,
            marketA: match,
            marketB: b,
            confidence: 1.0,
            matchMethod: 'cross_reference',
            status: this.pairStatuses.get(pairId) || 'approved',
          });
          usedA.add(match.id);
          usedB.add(b.id);
          break;
        }
      }
    }

    const crossRefCount = pairs.length;
    log.info(`Pass 0+1: ${crossRefCount} pairs from cross-reference + manual`);

    // ─── Pass 2: Exact slug matching ───────────────────────────────────
    for (const a of marketsA) {
      if (usedA.has(a.id)) continue;
      const slugMatch = marketsB.find(
        b => !usedB.has(b.id) && this.slugsMatch(a.slug, b.slug)
      );
      if (slugMatch) {
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

    // ─── Pass 5: LLM batch-match for remaining unmatched ────────────────
    const remainingA = marketsA.filter(a => !usedA.has(a.id));
    const remainingB = marketsB.filter(b => !usedB.has(b.id));

    if (this.llmVerifier.isEnabled && remainingA.length > 0 && remainingB.length > 0) {
      const llmPairs = await this.llmBatchMatch(remainingA, remainingB);
      for (const lp of llmPairs) {
        const pairId = MarketMatcher.pairId(lp.marketA.id, lp.marketB.id);
        const savedStatus = this.pairStatuses.get(pairId);
        pairs.push({
          pairId,
          marketA: lp.marketA,
          marketB: lp.marketB,
          confidence: lp.confidence,
          matchMethod: 'llm_matched',
          status: savedStatus || (lp.confidence >= 0.95 ? 'approved' : 'pending'),
          llmVerification: lp.llmResult,
        });
        usedA.add(lp.marketA.id);
        usedB.add(lp.marketB.id);
      }
      log.info(`Pass 5: ${llmPairs.length} pairs from LLM batch-match`);
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
            if (!savedStatus) {
              status = llmResult.confidence >= 0.95 ? 'approved' : 'pending';
            }
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
  private async llmBatchMatch(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
  ): Promise<Array<{
    marketA: NormalizedMarket;
    marketB: NormalizedMarket;
    confidence: number;
    llmResult: LLMVerificationResult;
  }>> {
    // Cap the number of markets sent to the LLM to control cost
    const MAX_PER_SIDE = 50;
    const subsetA = marketsA.slice(0, MAX_PER_SIDE);
    const subsetB = marketsB.slice(0, MAX_PER_SIDE);

    if (subsetA.length === 0 || subsetB.length === 0) return [];

    log.info(`LLM batch-match: ${subsetA.length} from A, ${subsetB.length} from B`);

    const llmPairs: Array<{
      marketA: NormalizedMarket;
      marketB: NormalizedMarket;
      confidence: number;
      llmResult: LLMVerificationResult;
    }> = [];

    // Build the prompt with numbered market lists
    const listA = subsetA.map((m, i) => {
      const cat = m.category ? ` [${m.category}]` : '';
      const end = m.endDate ? ` [ends: ${m.endDate.toISOString().split('T')[0]}]` : '';
      return `  A${i + 1}. "${m.question}"${cat}${end} (id: ${m.id})`;
    }).join('\n');

    const listB = subsetB.map((m, i) => {
      const cat = m.category ? ` [${m.category}]` : '';
      const end = m.endDate ? ` [ends: ${m.endDate.toISOString().split('T')[0]}]` : '';
      return `  B${i + 1}. "${m.question}"${cat}${end} (id: ${m.id})`;
    }).join('\n');

    const prompt = `You are a prediction market analyst. Below are two lists of prediction markets from different platforms. Your job is to identify which markets from LIST A are THE SAME MARKET as a market in LIST B.

Two markets are "the same" if they would resolve identically — same event, same resolution criteria, same timeframe. Be careful with similar-but-different questions (e.g., "by end of 2026" vs "by March 2026" are NOT the same).

LIST A (Platform: Polymarket):
${listA}

LIST B (Platform: predict.fun):
${listB}

Return ONLY a JSON array of matched pairs. If a market has no match, omit it. For each match include your confidence (0.0-1.0) and brief reasoning:
[
  { "a": "A1", "b": "B3", "confidence": 0.98, "reasoning": "Both ask if BTC hits $100k by end of 2026" },
  ...
]

Only include matches you're confident about (>= 0.85). Return [] if no matches found.`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.llmVerifier['apiKey'] || process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        log.error('LLM batch-match API error', { status: response.status, error: errText.slice(0, 200) });
        return [];
      }

      const data = await response.json() as {
        content: Array<{ type: string; text: string }>;
      };

      let text = data.content?.[0]?.text || '[]';
      if (text.trim().startsWith('```')) {
        text = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed: Array<{ a: string; b: string; confidence: number; reasoning: string }> = JSON.parse(text);

      for (const match of parsed) {
        // Parse "A1" → index 0, "B3" → index 2
        const aIdx = parseInt(match.a.replace(/^A/i, '')) - 1;
        const bIdx = parseInt(match.b.replace(/^B/i, '')) - 1;

        if (aIdx < 0 || aIdx >= subsetA.length || bIdx < 0 || bIdx >= subsetB.length) continue;
        if (match.confidence < 0.85) continue;

        const mA = subsetA[aIdx];
        const mB = subsetB[bIdx];

        const llmResult: LLMVerificationResult = {
          marketA: { id: mA.id, platform: mA.platform, question: mA.question },
          marketB: { id: mB.id, platform: mB.platform, question: mB.question },
          isSameMarket: true,
          confidence: match.confidence,
          reasoning: match.reasoning,
        };

        const pairId = MarketMatcher.pairId(mA.id, mB.id);
        this.llmResults.set(pairId, llmResult);

        llmPairs.push({
          marketA: mA,
          marketB: mB,
          confidence: match.confidence,
          llmResult,
        });
      }
    } catch (err) {
      log.error('LLM batch-match failed', { error: (err as Error).message });
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

    // Cross-reference
    const polyConditionMap = new Map<string, NormalizedMarket>();
    for (const a of marketsA) {
      if (usedA.has(a.id)) continue;
      const raw = a.raw as { conditionId?: string } | undefined;
      if (raw?.conditionId) polyConditionMap.set(raw.conditionId.toLowerCase(), a);
    }
    for (const b of marketsB) {
      if (usedB.has(b.id)) continue;
      const raw = b.raw as { polymarketConditionIds?: string[] } | undefined;
      for (const condId of (raw?.polymarketConditionIds || [])) {
        const match = polyConditionMap.get(condId.toLowerCase());
        if (match && !usedA.has(match.id)) {
          const pairId = MarketMatcher.pairId(match.id, b.id);
          pairs.push({ pairId, marketA: match, marketB: b, confidence: 1.0, matchMethod: 'cross_reference', status: this.pairStatuses.get(pairId) || 'approved' });
          usedA.add(match.id); usedB.add(b.id); break;
        }
      }
    }

    // Slug match
    for (const a of marketsA) {
      if (usedA.has(a.id)) continue;
      const slugMatch = marketsB.find(b => !usedB.has(b.id) && this.slugsMatch(a.slug, b.slug));
      if (slugMatch) {
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
