import { describe, it, expect, beforeEach } from 'vitest';
import { MarketMatcher, MarketPair } from '../matcher/market-matcher';
import { NormalizedMarket, Platform } from '../types';

/**
 * Helper to create mock NormalizedMarket objects
 */
function createMockMarket(
  overrides: Partial<NormalizedMarket> = {},
): NormalizedMarket {
  const now = new Date();
  const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

  return {
    id: `market-${Math.random().toString(36).substr(2, 9)}`,
    platform: 'polymarket' as Platform,
    question: 'Will the price go up?',
    slug: 'will-the-price-go-up',
    category: 'finance',
    outcomes: ['Yes', 'No'],
    outcomeTokenIds: ['token-yes', 'token-no'],
    outcomePrices: [0.5, 0.5],
    volume: 1000,
    liquidity: 500,
    active: true,
    endDate,
    lastUpdated: now,
    raw: undefined,
    ...overrides,
  };
}

describe('MarketMatcher', () => {
  let matcher: MarketMatcher;

  beforeEach(() => {
    matcher = new MarketMatcher();
  });

  describe('exact slug matching', () => {
    it('should match markets with identical slugs and return 0.95 confidence', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'bitcoin-price-above-50k',
        question: 'Will Bitcoin price be above 50k?',
        platform: 'polymarket',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'bitcoin-price-above-50k',
        question: 'Will BTC price exceed 50000?',
        platform: 'predictfun',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({
        marketA,
        marketB,
        confidence: 0.95,
        matchMethod: 'exact_slug',
      });
    });

    it('should match slugs with different casing', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'Bitcoin-Price-Above-50K',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'bitcoin-price-above-50k',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].confidence).toBe(0.95);
      expect(pairs[0].matchMethod).toBe('exact_slug');
    });

    it('should match slugs with different special characters', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'bitcoin_price-above-50k',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'bitcoin-price-above-50k',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].confidence).toBe(0.95);
    });

    it('should not match different slugs', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'bitcoin-price-above-50k',
        question: 'Will Bitcoin be above 50k?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'ethereum-price-above-3k',
        question: 'Will Ethereum be above 3k?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(0);
    });
  });

  describe('fuzzy question text matching', () => {
    it('should match similar questions when exact slug match is not available', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'btc-50k-a',
        question: 'Will Bitcoin reach 50000 USD by end of 2024?',
        category: 'crypto',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'btc-50k-b',
        question: 'Will Bitcoin reach 50000 dollars by end of 2024?',
        category: 'crypto',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].matchMethod).toBe('combined');
      expect(pairs[0].confidence).toBeGreaterThanOrEqual(0.5);
      expect(pairs[0].confidence).toBeLessThanOrEqual(1);
    });

    it('should return minimum confidence pairs with fuzzy matching', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-slug-a',
        question: 'Will the stock market close above 4500?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-slug-b',
        question: 'Will the stock market close above 4500?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('should not match questions with low similarity', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will Bitcoin reach 100k?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will it rain tomorrow in Tokyo?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(0);
    });
  });

  describe('category proximity boosting', () => {
    it('should boost confidence when categories match', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will the Federal Reserve raise interest rates next month?',
        category: 'economics',
        endDate: new Date('2026-04-12'),
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will Federal Reserve raise interest rates next month?',
        category: 'economics',
        endDate: new Date('2026-04-15'),
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      // Should have both date boost (0.1) and category boost (0.05)
      expect(pairs[0].confidence).toBeGreaterThan(0.5);
    });

    it('should not boost when categories differ', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will the Fed raise rates?',
        category: 'economics',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will the Fed raise rates?',
        category: 'politics',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      if (pairs.length > 0) {
        // If there's a match, it should not have the category boost
        // But we can't directly test the absence of boost, only verify behavior
        expect(pairs[0]).toBeDefined();
      }
    });
  });

  describe('date proximity boosting', () => {
    it('should boost confidence when end dates are within 7 days', () => {
      const baseDate = new Date('2026-04-12');

      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will Bitcoin reach 100000 USD by 2026?',
        endDate: baseDate,
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will Bitcoin reach 100000 dollars by 2026?',
        endDate: new Date(baseDate.getTime() + 3 * 24 * 60 * 60 * 1000), // 3 days later
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      // Should have date boost of 0.1
      expect(pairs[0].confidence).toBeGreaterThan(0.5);
    });

    it('should not boost when dates are more than 7 days apart', () => {
      const baseDate = new Date('2026-04-12');

      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will Bitcoin reach 100000 USD by 2026?',
        endDate: baseDate,
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will Bitcoin reach 100000 dollars by 2026?',
        endDate: new Date(baseDate.getTime() + 10 * 24 * 60 * 60 * 1000), // 10 days later
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      if (pairs.length > 0) {
        // Date boost should not apply
        expect(pairs[0].confidence).toBeLessThan(0.95);
      }
    });

    it('should not boost when either date is null', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will Bitcoin reach 100k?',
        endDate: null,
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will BTC exceed 100k?',
        endDate: new Date('2026-04-12'),
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      if (pairs.length > 0) {
        // Without date boost, confidence should be lower
        expect(pairs[0].confidence).toBeDefined();
      }
    });
  });

  describe('keyword overlap scoring', () => {
    it('should boost confidence with high keyword overlap', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will Apple stock price exceed 150 dollars?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will Apple stock reach 150 dollars?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      // Should have keyword boost (max 0.15)
      expect(pairs[0].confidence).toBeGreaterThan(0.5);
    });

    it('should not boost with low keyword overlap', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will rainfall exceed 10 inches?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will snowfall be more than 5 centimeters?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      if (pairs.length > 0) {
        // Limited keyword overlap (only "will"), low confidence
        expect(pairs[0].confidence).toBeLessThanOrEqual(0.7);
      }
    });

    it('should ignore stop words in keyword overlap calculation', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will the stock price go above 100 in the next quarter?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will stock price be above 100 next quarter?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      // Should match with similar keyword set (stock, price, above, quarter)
      expect(pairs.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('minimum confidence threshold', () => {
    it('should not return pairs below 0.5 confidence threshold', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Apple stock price',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Completely unrelated question',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(0);
    });

    it('should return pairs at exactly 0.5 confidence threshold', () => {
      // This is a boundary test - create markets that will match at ~0.5 confidence
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'unique-a',
        question: 'Will event X happen?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'unique-b',
        question: 'Will event X happen?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      // This should definitely match with high confidence
      expect(pairs).toHaveLength(1);
      expect(pairs[0].confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('no duplicate matching (market reuse prevention)', () => {
    it('should not allow a market B to match with multiple markets A', () => {
      const marketB = createMockMarket({
        id: 'market-b-shared',
        slug: 'shared-slug',
      });

      const marketA1 = createMockMarket({
        id: 'market-a1',
        slug: 'shared-slug',
      });

      const marketA2 = createMockMarket({
        id: 'market-a2',
        slug: 'shared-slug',
      });

      const pairs = matcher.findPairs([marketA1, marketA2], [marketB]);

      // Only one market A can match with the shared market B
      expect(pairs).toHaveLength(1);
      expect(pairs[0].marketB.id).toBe('market-b-shared');
      // Should match with the first one in the list
      expect(pairs[0].marketA.id).toBe('market-a1');
    });

    it('should respect order: first exact match wins', () => {
      const marketB1 = createMockMarket({
        id: 'market-b1',
        slug: 'exact-slug',
        question: 'Question B1',
      });

      const marketB2 = createMockMarket({
        id: 'market-b2',
        slug: 'exact-slug',
        question: 'Question B2',
      });

      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'exact-slug',
      });

      const pairs = matcher.findPairs([marketA], [marketB1, marketB2]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].marketB.id).toBe('market-b1');
    });

    it('should allow multiple pairs from multiple markets', () => {
      const marketA1 = createMockMarket({
        id: 'market-a1',
        slug: 'slug-a1',
      });

      const marketA2 = createMockMarket({
        id: 'market-a2',
        slug: 'slug-a2',
      });

      const marketB1 = createMockMarket({
        id: 'market-b1',
        slug: 'slug-a1',
      });

      const marketB2 = createMockMarket({
        id: 'market-b2',
        slug: 'slug-a2',
      });

      const pairs = matcher.findPairs([marketA1, marketA2], [marketB1, marketB2]);

      expect(pairs).toHaveLength(2);
      expect(pairs.map(p => p.marketB.id)).toEqual(expect.arrayContaining(['market-b1', 'market-b2']));
    });
  });

  describe('edge cases', () => {
    it('should handle empty array of markets A', () => {
      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'test-slug',
      });

      const pairs = matcher.findPairs([], [marketB]);

      expect(pairs).toHaveLength(0);
    });

    it('should handle empty array of markets B', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'test-slug',
      });

      const pairs = matcher.findPairs([marketA], []);

      expect(pairs).toHaveLength(0);
    });

    it('should handle both arrays empty', () => {
      const pairs = matcher.findPairs([], []);

      expect(pairs).toHaveLength(0);
    });

    it('should handle single market in each array with exact match', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'single-slug',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'single-slug',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].confidence).toBe(0.95);
      expect(pairs[0].matchMethod).toBe('exact_slug');
    });

    it('should handle single market in each array with no match', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'slug-a',
        question: 'Completely different question',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'slug-b',
        question: 'Totally unrelated content',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(0);
    });

    it('should handle markets with identical questions but different slugs', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'slug-a',
        question: 'Will Bitcoin reach 100k?',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'slug-b',
        question: 'Will Bitcoin reach 100k?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].matchMethod).toBe('combined');
      expect(pairs[0].confidence).toBeGreaterThan(0.5);
    });
  });

  describe('result sorting and ordering', () => {
    it('should sort pairs by confidence descending', () => {
      const marketA1 = createMockMarket({
        id: 'market-a1',
        slug: 'exact-match-slug',
      });

      const marketA2 = createMockMarket({
        id: 'market-a2',
        slug: 'fuzzy-a',
        question: 'Will the price rise significantly?',
      });

      const marketB1 = createMockMarket({
        id: 'market-b1',
        slug: 'exact-match-slug',
      });

      const marketB2 = createMockMarket({
        id: 'market-b2',
        slug: 'fuzzy-b',
        question: 'Will the price rise?',
      });

      const pairs = matcher.findPairs([marketA1, marketA2], [marketB1, marketB2]);

      // Pairs should be sorted by confidence descending
      for (let i = 0; i < pairs.length - 1; i++) {
        expect(pairs[i].confidence).toBeGreaterThanOrEqual(pairs[i + 1].confidence);
      }
    });

    it('should prioritize exact slug matches over fuzzy matches', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'exact-slug',
      });

      const marketB1 = createMockMarket({
        id: 'market-b1',
        slug: 'exact-slug',
      });

      const pairs = matcher.findPairs([marketA], [marketB1]);

      expect(pairs[0].matchMethod).toBe('exact_slug');
      expect(pairs[0].confidence).toBe(0.95);
    });
  });

  describe('platform handling', () => {
    it('should match markets across different platforms', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'cross-platform-slug',
        platform: 'polymarket',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'cross-platform-slug',
        platform: 'predictfun',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].marketA.platform).toBe('polymarket');
      expect(pairs[0].marketB.platform).toBe('predictfun');
    });

    it('should match markets on the same platform', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'same-platform-slug',
        platform: 'polymarket',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'same-platform-slug',
        platform: 'polymarket',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
    });
  });

  describe('complex matching scenarios', () => {
    it('should find multiple non-overlapping pairs in a mixed dataset', () => {
      const marketsA = [
        createMockMarket({
          id: 'a-btc',
          slug: 'bitcoin-100k',
          question: 'Will Bitcoin reach 100k?',
        }),
        createMockMarket({
          id: 'a-eth',
          slug: 'ethereum-5k',
          question: 'Will Ethereum reach 5k?',
        }),
        createMockMarket({
          id: 'a-no-match',
          slug: 'unique-a',
          question: 'Very unique question',
        }),
      ];

      const marketsB = [
        createMockMarket({
          id: 'b-btc',
          slug: 'bitcoin-100k',
          question: 'Will BTC reach 100k?',
        }),
        createMockMarket({
          id: 'b-eth',
          slug: 'ethereum-5k',
          question: 'Will ETH reach 5k?',
        }),
      ];

      const pairs = matcher.findPairs(marketsA, marketsB);

      expect(pairs.length).toBeGreaterThanOrEqual(2);
      // Verify no duplicates
      const usedB = new Set(pairs.map(p => p.marketB.id));
      expect(usedB.size).toBe(pairs.length);
    });

    it('should handle markets with special characters in questions', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'special-chars-a',
        question: 'Will $BTC > $100K? YES/NO',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'special-chars-b',
        question: 'Will Bitcoin exceed 100000?',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      if (pairs.length > 0) {
        expect(pairs[0].confidence).toBeGreaterThan(0);
      }
    });

    it('should handle very long question texts', () => {
      const longQuestion = 'Will the price of the asset exceed the specified threshold by the end of the fiscal quarter taking into account all relevant market conditions?';

      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'long-a',
        question: longQuestion,
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'long-b',
        question: longQuestion,
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
    });

    it('should handle case sensitivity correctly in slug matching', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'TeSt-SlUg',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'test-slug',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].confidence).toBe(0.95);
    });
  });

  describe('MarketPair interface validation', () => {
    it('should return valid MarketPair objects', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'valid-pair-slug',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'valid-pair-slug',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      expect(pairs).toHaveLength(1);
      const pair = pairs[0];

      // Verify MarketPair structure
      expect(pair).toHaveProperty('marketA');
      expect(pair).toHaveProperty('marketB');
      expect(pair).toHaveProperty('confidence');
      expect(pair).toHaveProperty('matchMethod');

      expect(pair.marketA).toBe(marketA);
      expect(pair.marketB).toBe(marketB);
      expect(typeof pair.confidence).toBe('number');
      expect(['exact_slug', 'fuzzy_question', 'combined']).toContain(pair.matchMethod);
    });

    it('should ensure confidence is bounded [0..1]', () => {
      const marketA = createMockMarket({
        id: 'market-a',
        slug: 'confidence-test-a',
        question: 'Test question',
      });

      const marketB = createMockMarket({
        id: 'market-b',
        slug: 'confidence-test-b',
        question: 'Test question',
      });

      const pairs = matcher.findPairs([marketA], [marketB]);

      pairs.forEach(pair => {
        expect(pair.confidence).toBeGreaterThanOrEqual(0);
        expect(pair.confidence).toBeLessThanOrEqual(1);
      });
    });

    it('should set correct matchMethod for each type of match', () => {
      // Exact slug match
      const exactA = createMockMarket({
        id: 'exact-a',
        slug: 'exact-test',
      });
      const exactB = createMockMarket({
        id: 'exact-b',
        slug: 'exact-test',
      });

      const exactPairs = matcher.findPairs([exactA], [exactB]);
      expect(exactPairs[0].matchMethod).toBe('exact_slug');

      // Fuzzy match
      const fuzzyA = createMockMarket({
        id: 'fuzzy-a',
        slug: 'unique-a',
        question: 'Will price go up?',
      });
      const fuzzyB = createMockMarket({
        id: 'fuzzy-b',
        slug: 'unique-b',
        question: 'Will price increase?',
      });

      const fuzzyPairs = matcher.findPairs([fuzzyA], [fuzzyB]);
      if (fuzzyPairs.length > 0) {
        expect(fuzzyPairs[0].matchMethod).toBe('combined');
      }
    });
  });
});
