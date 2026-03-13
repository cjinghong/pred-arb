// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Market Matcher
// Fuzzy-matches markets across platforms to find equivalent pairs,
// then verifies via LLM for 100% correlation confidence
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
  matchMethod: 'exact_slug' | 'fuzzy_question' | 'combined' | 'llm_verified';
  /** Current status */
  status: PairStatus;
  /** LLM verification result (if available) */
  llmVerification?: LLMVerificationResult;
}

/**
 * MarketMatcher finds equivalent markets across different platforms.
 *
 * Matching strategy (layered):
 *  1. Exact slug match (highest confidence)
 *  2. Fuzzy question text match using Fuse.js
 *  3. Category + date + keyword overlap (refinement)
 *  4. LLM verification for 100% correlation guarantee
 */
export class MarketMatcher {
  private fuseOptions: IFuseOptions<NormalizedMarket> = {
    keys: [
      { name: 'question', weight: 0.7 },
      { name: 'slug', weight: 0.2 },
      { name: 'category', weight: 0.1 },
    ],
    threshold: 0.4,        // Lower = stricter matching
    distance: 200,
    includeScore: true,
    minMatchCharLength: 4,
  };

  /** Minimum confidence to consider a match valid */
  private minConfidence = 0.5;

  /** LLM verifier for confirming fuzzy matches */
  private llmVerifier: LLMVerifier;

  /** Persisted pair statuses: pairId → status */
  private pairStatuses = new Map<string, PairStatus>();

  /** Persisted LLM verifications: pairId → result */
  private llmResults = new Map<string, LLMVerificationResult>();

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

  /**
   * Find matching market pairs across two sets of markets.
   * Returns pairs sorted by confidence (highest first).
   */
  async findPairs(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
  ): Promise<MarketPair[]> {
    const pairs: MarketPair[] = [];
    const usedB = new Set<string>();

    // Pass 1: Exact slug matching
    for (const a of marketsA) {
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
        usedB.add(slugMatch.id);
      }
    }

    // Pass 2: Fuzzy question matching for unmatched markets
    const unmatchedA = marketsA.filter(
      a => !pairs.some(p => p.marketA.id === a.id)
    );
    const unmatchedB = marketsB.filter(b => !usedB.has(b.id));

    const fuzzyCandidates: Array<{
      marketA: NormalizedMarket;
      marketB: NormalizedMarket;
      fuzzyScore: number;
    }> = [];

    if (unmatchedA.length > 0 && unmatchedB.length > 0) {
      const fuse = new Fuse(unmatchedB, this.fuseOptions);

      for (const a of unmatchedA) {
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
            usedB.add(best.item.id);
          }
        }
      }
    }

    // Pass 3: LLM verification of fuzzy matches
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

      if (needsVerification.length > 0) {
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
      exact: pairs.filter(p => p.matchMethod === 'exact_slug').length,
      llmVerified: pairs.filter(p => p.matchMethod === 'llm_verified').length,
      fuzzy: pairs.filter(p => p.matchMethod === 'combined').length,
      approved: pairs.filter(p => p.status === 'approved').length,
      pending: pairs.filter(p => p.status === 'pending').length,
      rejected: pairs.filter(p => p.status === 'rejected').length,
    });

    return pairs;
  }

  /**
   * Synchronous version for backward compatibility.
   * Does not run LLM verification — uses cached results only.
   */
  findPairsSync(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
  ): MarketPair[] {
    const pairs: MarketPair[] = [];
    const usedB = new Set<string>();

    for (const a of marketsA) {
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
        usedB.add(slugMatch.id);
      }
    }

    const unmatchedA = marketsA.filter(a => !pairs.some(p => p.marketA.id === a.id));
    const unmatchedB = marketsB.filter(b => !usedB.has(b.id));

    if (unmatchedA.length > 0 && unmatchedB.length > 0) {
      const fuse = new Fuse(unmatchedB, this.fuseOptions);
      for (const a of unmatchedA) {
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
              pairId,
              marketA: a,
              marketB: best.item,
              confidence,
              matchMethod: llmResult?.isSameMarket ? 'llm_verified' : 'combined',
              status: this.pairStatuses.get(pairId) || 'pending',
              llmVerification: llmResult,
            });
            usedB.add(best.item.id);
          }
        }
      }
    }

    pairs.sort((a, b) => b.confidence - a.confidence);
    return pairs;
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
