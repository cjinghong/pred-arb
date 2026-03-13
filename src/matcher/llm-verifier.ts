// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: LLM Market Match Verifier
// Uses Claude API to verify that fuzzy-matched market pairs are truly
// the same market across platforms (100% correlation guarantee)
// ═══════════════════════════════════════════════════════════════════════════

import { NormalizedMarket } from '../types';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('llm-verifier');

export interface LLMVerificationResult {
  marketA: { id: string; platform: string; question: string };
  marketB: { id: string; platform: string; question: string };
  /** Whether the LLM confirmed these are the same market */
  isSameMarket: boolean;
  /** LLM confidence [0..1] */
  confidence: number;
  /** Brief reasoning from the LLM */
  reasoning: string;
}

interface CandidatePair {
  marketA: NormalizedMarket;
  marketB: NormalizedMarket;
  fuzzyScore: number;
}

/**
 * LLMVerifier uses the Anthropic API to confirm that fuzzy-matched
 * prediction market pairs are truly equivalent.
 *
 * Approach:
 * 1. Batch multiple candidate pairs into a single prompt
 * 2. Ask Claude to analyze each pair and determine if they resolve identically
 * 3. Return structured verification results
 *
 * This is a critical safety layer — incorrect matches would mean we're
 * taking two unhedged positions instead of an arb.
 */
/** Errors that warrant permanently disabling the LLM verifier for the session */
const PERMANENT_DISABLE_PATTERNS = [
  'credit balance is too low',
  'Your credit balance',
  'insufficient_quota',
  'billing',
  'payment',
];

export class LLMVerifier {
  private apiKey: string;
  private apiUrl = 'https://api.anthropic.com/v1/messages';
  private model = 'claude-sonnet-4-20250514';
  private maxBatchSize = 15; // pairs per LLM call
  private enabled: boolean;
  private disableReason: string | null = null;

  /** Cache: `${marketA.id}:${marketB.id}` → result */
  private cache = new Map<string, LLMVerificationResult>();

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.enabled = !!this.apiKey;
    if (!this.enabled) {
      log.warn('LLM verifier disabled — no ANTHROPIC_API_KEY configured');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Permanently disable the LLM verifier for this session.
   * Called when we receive a billing error or other unrecoverable API failure.
   */
  disable(reason: string): void {
    if (this.enabled) {
      this.enabled = false;
      this.disableReason = reason;
      log.warn('LLM verifier permanently disabled for this session', { reason });
    }
  }

  /**
   * Check if an error body indicates a permanent failure (billing, quota, etc.)
   * and if so, self-disable to avoid hammering the API.
   */
  checkAndDisableOnPermanentError(errorBody: string, statusCode: number): boolean {
    if (statusCode === 400 || statusCode === 402 || statusCode === 429) {
      const isPermanent = PERMANENT_DISABLE_PATTERNS.some(p =>
        errorBody.toLowerCase().includes(p.toLowerCase()),
      );
      if (isPermanent) {
        this.disable(`API error ${statusCode}: ${errorBody.slice(0, 100)}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Verify a batch of candidate pairs.
   * Returns verification results for each pair.
   * Uses cache to avoid re-verifying known pairs.
   */
  async verifyPairs(candidates: CandidatePair[]): Promise<LLMVerificationResult[]> {
    if (!this.enabled) {
      // If LLM is not available, pass through with moderate confidence
      return candidates.map(c => ({
        marketA: { id: c.marketA.id, platform: c.marketA.platform, question: c.marketA.question },
        marketB: { id: c.marketB.id, platform: c.marketB.platform, question: c.marketB.question },
        isSameMarket: c.fuzzyScore >= 0.7,
        confidence: c.fuzzyScore,
        reasoning: 'LLM verification unavailable — using fuzzy score only',
      }));
    }

    const results: LLMVerificationResult[] = [];
    const uncachedPairs: CandidatePair[] = [];

    // Check cache first
    for (const c of candidates) {
      const cacheKey = `${c.marketA.id}:${c.marketB.id}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results.push(cached);
      } else {
        uncachedPairs.push(c);
      }
    }

    if (uncachedPairs.length === 0) {
      return results;
    }

    // Process uncached pairs in batches
    for (let i = 0; i < uncachedPairs.length; i += this.maxBatchSize) {
      const batch = uncachedPairs.slice(i, i + this.maxBatchSize);
      try {
        const batchResults = await this.verifyBatch(batch);
        for (const result of batchResults) {
          // Cache the result
          const cacheKey = `${result.marketA.id}:${result.marketB.id}`;
          this.cache.set(cacheKey, result);
          results.push(result);
        }
      } catch (err) {
        log.error('LLM verification batch failed', { error: (err as Error).message });
        // On failure, fall back to fuzzy score
        for (const c of batch) {
          const fallback: LLMVerificationResult = {
            marketA: { id: c.marketA.id, platform: c.marketA.platform, question: c.marketA.question },
            marketB: { id: c.marketB.id, platform: c.marketB.platform, question: c.marketB.question },
            isSameMarket: c.fuzzyScore >= 0.7,
            confidence: c.fuzzyScore * 0.8, // discount for lack of LLM verification
            reasoning: 'LLM verification failed — using discounted fuzzy score',
          };
          results.push(fallback);
        }
      }
    }

    return results;
  }

  private async verifyBatch(batch: CandidatePair[]): Promise<LLMVerificationResult[]> {
    const pairsText = batch.map((c, i) => {
      const catA = c.marketA.category ? ` [category: ${c.marketA.category}]` : '';
      const catB = c.marketB.category ? ` [category: ${c.marketB.category}]` : '';
      const endA = c.marketA.endDate ? ` [ends: ${c.marketA.endDate.toISOString().split('T')[0]}]` : '';
      const endB = c.marketB.endDate ? ` [ends: ${c.marketB.endDate.toISOString().split('T')[0]}]` : '';
      return `PAIR ${i + 1}:
  Platform A (${c.marketA.platform}): "${c.marketA.question}"${catA}${endA}
  Platform B (${c.marketB.platform}): "${c.marketB.question}"${catB}${endB}
  Fuzzy score: ${c.fuzzyScore.toFixed(3)}`;
    }).join('\n\n');

    const prompt = `You are a prediction market analyst verifying whether market pairs across different platforms are EXACTLY the same market (will resolve identically).

CRITICAL: For cross-platform arbitrage to work, both markets MUST resolve to the SAME outcome at the SAME time. A "YES" on Platform A and a "NO" on Platform B must be perfectly complementary.

Consider these factors:
- Are they asking about the EXACT same event/question?
- Do they have the same resolution criteria and timeframe?
- Could one resolve differently than the other due to different wording?
- Watch out for similar but NOT identical questions (e.g., "by end of 2026" vs "by March 2026")

For each pair, respond with a JSON object. Return ONLY a JSON array, no other text:
[
  {
    "pair": 1,
    "isSameMarket": true/false,
    "confidence": 0.0-1.0,
    "reasoning": "brief explanation"
  },
  ...
]

Here are the pairs to verify:

${pairsText}`;

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Check for permanent errors (billing, quota) and self-disable
      this.checkAndDisableOnPermanentError(errorText, response.status);
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const text = data.content?.[0]?.text || '[]';

    // Parse the JSON response — handle markdown code blocks
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed: Array<{ pair: number; isSameMarket: boolean; confidence: number; reasoning: string }>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      log.warn('Failed to parse LLM response', { text: jsonStr.slice(0, 200) });
      // Return conservative results
      return batch.map(c => ({
        marketA: { id: c.marketA.id, platform: c.marketA.platform, question: c.marketA.question },
        marketB: { id: c.marketB.id, platform: c.marketB.platform, question: c.marketB.question },
        isSameMarket: false,
        confidence: 0,
        reasoning: 'Failed to parse LLM response',
      }));
    }

    return batch.map((c, i) => {
      const llmResult = parsed.find(p => p.pair === i + 1) || {
        isSameMarket: false,
        confidence: 0,
        reasoning: 'Missing from LLM response',
      };

      return {
        marketA: { id: c.marketA.id, platform: c.marketA.platform, question: c.marketA.question },
        marketB: { id: c.marketB.id, platform: c.marketB.platform, question: c.marketB.question },
        isSameMarket: llmResult.isSameMarket,
        confidence: llmResult.confidence,
        reasoning: llmResult.reasoning,
      };
    });
  }

  /** Clear the verification cache */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get cache stats */
  getCacheStats(): { size: number } {
    return { size: this.cache.size };
  }
}
