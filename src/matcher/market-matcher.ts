// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Market Matcher
// Fuzzy-matches markets across platforms to find equivalent pairs
// Uses Fuse.js for fuzzy text matching + custom heuristics
// ═══════════════════════════════════════════════════════════════════════════

import Fuse, { IFuseOptions } from 'fuse.js';
import { NormalizedMarket, Platform } from '../types';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('matcher');

export interface MarketPair {
  /** Market on platform A */
  marketA: NormalizedMarket;
  /** Market on platform B */
  marketB: NormalizedMarket;
  /** Confidence score [0..1] */
  confidence: number;
  /** How the match was determined */
  matchMethod: 'exact_slug' | 'fuzzy_question' | 'combined';
}

/**
 * MarketMatcher finds equivalent markets across different platforms.
 *
 * Matching strategy (layered):
 *  1. Exact slug match (highest confidence)
 *  2. Fuzzy question text match using Fuse.js
 *  3. Category + date + keyword overlap (refinement)
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

  /**
   * Find matching market pairs across two sets of markets.
   * Returns pairs sorted by confidence (highest first).
   */
  findPairs(
    marketsA: NormalizedMarket[],
    marketsB: NormalizedMarket[],
  ): MarketPair[] {
    const pairs: MarketPair[] = [];
    const usedB = new Set<string>();

    // Pass 1: Exact slug matching
    for (const a of marketsA) {
      const slugMatch = marketsB.find(
        b => !usedB.has(b.id) && this.slugsMatch(a.slug, b.slug)
      );
      if (slugMatch) {
        pairs.push({
          marketA: a,
          marketB: slugMatch,
          confidence: 0.95,
          matchMethod: 'exact_slug',
        });
        usedB.add(slugMatch.id);
      }
    }

    // Pass 2: Fuzzy question matching for unmatched markets
    const unmatchedA = marketsA.filter(
      a => !pairs.some(p => p.marketA.id === a.id)
    );
    const unmatchedB = marketsB.filter(b => !usedB.has(b.id));

    if (unmatchedA.length > 0 && unmatchedB.length > 0) {
      const fuse = new Fuse(unmatchedB, this.fuseOptions);

      for (const a of unmatchedA) {
        const results = fuse.search(a.question);
        if (results.length > 0) {
          const best = results[0];
          const fuseScore = 1 - (best.score ?? 1); // Fuse score is 0=perfect

          // Boost confidence based on additional signals
          const dateBoost = this.datesClose(a.endDate, best.item.endDate) ? 0.1 : 0;
          const categoryBoost = a.category === best.item.category ? 0.05 : 0;
          const keywordBoost = this.keywordOverlap(a.question, best.item.question);

          const confidence = Math.min(
            fuseScore + dateBoost + categoryBoost + keywordBoost,
            0.99,
          );

          if (confidence >= this.minConfidence && !usedB.has(best.item.id)) {
            pairs.push({
              marketA: a,
              marketB: best.item,
              confidence,
              matchMethod: 'combined',
            });
            usedB.add(best.item.id);
          }
        }
      }
    }

    // Sort by confidence descending
    pairs.sort((a, b) => b.confidence - a.confidence);

    log.info(`Found ${pairs.length} market pairs`, {
      exact: pairs.filter(p => p.matchMethod === 'exact_slug').length,
      fuzzy: pairs.filter(p => p.matchMethod !== 'exact_slug').length,
    });

    return pairs;
  }

  /** Normalize and compare slugs */
  private slugsMatch(slugA: string, slugB: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return normalize(slugA) === normalize(slugB);
  }

  /** Check if two dates are within 7 days of each other */
  private datesClose(a: Date | null, b: Date | null): boolean {
    if (!a || !b) return false;
    const diffMs = Math.abs(a.getTime() - b.getTime());
    return diffMs < 7 * 24 * 60 * 60 * 1000;
  }

  /** Calculate keyword overlap score */
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
    return jaccardIndex * 0.15; // Max 0.15 boost
  }
}
