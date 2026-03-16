// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: LLM Market Match Verifier
// Uses an LLM to verify that fuzzy-matched market pairs are truly
// the same market across platforms (100% correlation guarantee).
//
// Supports:
// - Anthropic API (Claude) — default, uses ANTHROPIC_API_KEY + tool_use for forced JSON
// - Ollama / OpenAI-compatible — set LLM_PROVIDER=ollama, LLM_BASE_URL, LLM_MODEL
// ═══════════════════════════════════════════════════════════════════════════

import { NormalizedMarket } from '../types';
import { config } from '../utils/config';
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

export interface CandidatePair {
  marketA: NormalizedMarket;
  marketB: NormalizedMarket;
  fuzzyScore: number;
}

/** Errors that warrant permanently disabling the LLM verifier for the session */
const PERMANENT_DISABLE_PATTERNS = [
  'credit balance is too low',
  'Your credit balance',
  'insufficient_quota',
  'billing',
  'payment',
];

type LLMProvider = 'anthropic' | 'ollama' | 'openai';

// ─── Anthropic tool_use schema ────────────────────────────────────────────
// Forces Claude to return structured JSON via tool_use instead of freeform text.

const VERIFY_PAIRS_TOOL = {
  name: 'submit_verification_results',
  description: 'Submit the verification results for market pairs.',
  input_schema: {
    type: 'object' as const,
    properties: {
      results: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            pair: { type: 'number' as const, description: 'Pair number (1-indexed)' },
            isSameMarket: { type: 'boolean' as const, description: 'Whether both markets resolve identically' },
            confidence: { type: 'number' as const, description: 'Confidence 0.0–1.0' },
            reasoning: { type: 'string' as const, description: 'Brief explanation' },
          },
          required: ['pair', 'isSameMarket', 'confidence', 'reasoning'],
        },
      },
    },
    required: ['results'],
  },
};

const BATCH_MATCH_TOOL = {
  name: 'submit_matches',
  description: 'Submit the matched market pairs found between list A and list B.',
  input_schema: {
    type: 'object' as const,
    properties: {
      matches: {
        type: 'array' as const,
        description: 'Array of matched pairs. Empty array if no matches found.',
        items: {
          type: 'object' as const,
          properties: {
            a: { type: 'string' as const, description: 'Market ID from list A (e.g., "A1")' },
            b: { type: 'string' as const, description: 'Market ID from list B (e.g., "B3")' },
            confidence: { type: 'number' as const, description: 'Confidence 0.0–1.0. Only include if >= 0.90' },
            reasoning: { type: 'string' as const, description: 'Brief explanation of why these match' },
          },
          required: ['a', 'b', 'confidence', 'reasoning'],
        },
      },
    },
    required: ['matches'],
  },
};

/**
 * LLMVerifier uses an LLM API to confirm that fuzzy-matched
 * prediction market pairs are truly equivalent.
 *
 * Supports two provider modes:
 * - 'anthropic': Anthropic Messages API (Claude) with tool_use for guaranteed JSON
 * - 'ollama' / 'openai': OpenAI-compatible chat completions (Ollama, vLLM, etc.)
 */
export class LLMVerifier {
  private apiKey: string;
  private provider: LLMProvider;
  private anthropicApiUrl = 'https://api.anthropic.com/v1/messages';
  private anthropicModel = 'claude-sonnet-4-20250514';
  private ollamaBaseUrl: string;
  private ollamaModel: string;
  private ollamaApiKey: string;
  private maxBatchSize = 15; // pairs per LLM call
  private enabled: boolean;
  private disableReason: string | null = null;

  /** Cache: `${marketA.id}:${marketB.id}` → result */
  private cache = new Map<string, LLMVerificationResult>();

  constructor(apiKey?: string) {
    this.provider = config.llm.provider;
    this.ollamaBaseUrl = config.llm.baseUrl;
    this.ollamaModel = config.llm.model;
    this.ollamaApiKey = config.llm.apiKey;

    // For backward compat: if provider is anthropic, use ANTHROPIC_API_KEY
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';

    if (this.provider === 'anthropic') {
      this.enabled = !!this.apiKey;
      if (!this.enabled) {
        log.warn('LLM verifier disabled — no ANTHROPIC_API_KEY configured');
      } else {
        log.info('LLM verifier using Anthropic API (tool_use)', { model: this.anthropicModel });
      }
    } else {
      // Ollama / OpenAI-compatible — enabled if we have a base URL
      this.enabled = !!this.ollamaBaseUrl;
      if (this.enabled) {
        log.info('LLM verifier using OpenAI-compatible API', {
          provider: this.provider,
          baseUrl: this.ollamaBaseUrl,
          model: this.ollamaModel,
        });
      } else {
        log.warn(`LLM verifier disabled — no LLM_BASE_URL configured for ${this.provider}`);
      }
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

  // ─── Core LLM Call ─────────────────────────────────────────────────────

  /**
   * Send a prompt to the configured LLM and return the text response.
   * For plain text responses (e.g., ping test). Does NOT use tool_use.
   */
  async callLLM(prompt: string, maxTokens = 2048): Promise<string> {
    if (this.provider === 'anthropic') {
      return this.callAnthropic(prompt, maxTokens);
    } else if (this.provider === 'ollama') {
      return this.callOllama(prompt, maxTokens);
    } else {
      return this.callOpenAICompatible(prompt, maxTokens);
    }
  }

  /**
   * Call Anthropic with tool_use to force structured JSON output.
   * The model MUST call the specified tool, which guarantees valid JSON.
   */
  async callAnthropicWithTool<T>(
    prompt: string,
    tool: { name: string; description: string; input_schema: Record<string, unknown> },
    maxTokens = 2048,
  ): Promise<T> {
    const response = await fetch(this.anthropicApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.anthropicModel,
        max_tokens: maxTokens,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.checkAndDisableOnPermanentError(errorText, response.status);
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; name?: string; input?: T; text?: string }>;
    };

    // Find the tool_use content block
    const toolBlock = data.content?.find(c => c.type === 'tool_use');
    if (toolBlock?.input) {
      return toolBlock.input;
    }

    throw new Error('Anthropic response missing tool_use block');
  }

  private async callAnthropic(prompt: string, maxTokens: number): Promise<string> {
    const response = await fetch(this.anthropicApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.anthropicModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.checkAndDisableOnPermanentError(errorText, response.status);
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };

    return data.content?.[0]?.text || '[]';
  }

  private async callOllama(prompt: string, maxTokens: number): Promise<string> {
    const url = `${this.ollamaBaseUrl}/api/generate`;

    const systemPrefix = 'You are a prediction market analyst. Always respond with valid JSON only, no markdown formatting or extra text.\n\n';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.ollamaModel,
        prompt: systemPrefix + prompt,
        stream: false,
        options: {
          temperature: 0.1, // Low temperature for structured JSON output
          num_predict: maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      response: string;
      done: boolean;
    };

    return data.response || '[]';
  }

  private async callOpenAICompatible(prompt: string, maxTokens: number): Promise<string> {
    const url = `${this.ollamaBaseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.ollamaApiKey) {
      headers['Authorization'] = `Bearer ${this.ollamaApiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.ollamaModel,
        max_tokens: maxTokens,
        temperature: 0.1, // Low temperature for structured JSON output
        messages: [
          {
            role: 'system',
            content: 'You are a prediction market analyst. Always respond with valid JSON only, no markdown formatting or extra text.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.provider} API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices?.[0]?.message?.content || '[]';
  }

  // ─── Pair Verification ────────────────────────────────────────────────

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

    const prompt = `You are verifying whether prediction market pairs are EXACTLY the same market for cross-platform arbitrage.

STRICT MATCHING RULES — ALL must be true for isSameMarket=true:
1. SAME ASSET/ENTITY: "Bitcoin" ≠ "Ethereum". "Trump" ≠ "Biden". "Morgan Wallen" ≠ "Ethereum".
2. SAME TARGET/THRESHOLD: "$100,000" ≠ "$60,000". "above 4000" ≠ "above 1600".
3. SAME DATE/TIMEFRAME: "by December 31, 2026" ≠ "on March 17". "end of year" ≠ "end of month".
4. SAME DIRECTION: "Will X happen?" and "Will X happen?" = same. "reach" vs "stay below" = different.

If ANY of these differ, isSameMarket MUST be false. When in doubt, say false.

Here are the pairs to verify:

${pairsText}

Call the submit_verification_results tool with your analysis.`;

    // ── Anthropic: use tool_use for guaranteed JSON ──────────────────────
    if (this.provider === 'anthropic') {
      type ToolResult = { results: Array<{ pair: number; isSameMarket: boolean; confidence: number; reasoning: string }> };
      const toolResult = await this.callAnthropicWithTool<ToolResult>(prompt, VERIFY_PAIRS_TOOL, 2048);

      return batch.map((c, i) => {
        const llmResult = toolResult.results?.find(p => p.pair === i + 1) || {
          isSameMarket: false, confidence: 0, reasoning: 'Missing from LLM response',
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

    // ── Ollama/OpenAI: text-based with JSON parsing ─────────────────────
    const textPrompt = prompt.replace(
      'Call the submit_verification_results tool with your analysis.',
      `Return ONLY a JSON array:\n[\n  { "pair": 1, "isSameMarket": false, "confidence": 0.0, "reasoning": "Different topics" }\n]`,
    );

    const text = await this.callLLM(textPrompt, 2048);

    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed: Array<{ pair: number; isSameMarket: boolean; confidence: number; reasoning: string }>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      log.warn('Failed to parse LLM response', { text: jsonStr.slice(0, 200) });
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
        isSameMarket: false, confidence: 0, reasoning: 'Missing from LLM response',
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

  // ─── Batch Match (with tool_use) ─────────────────────────────────────

  /**
   * Batch-match candidate buckets using the LLM.
   * Each bucket = one market from A + its top fuzzy candidates from B.
   * For Anthropic: uses tool_use for guaranteed JSON.
   */
  async batchMatchBuckets(
    buckets: Array<{ marketA: NormalizedMarket; candidates: NormalizedMarket[] }>,
  ): Promise<Array<{ a: string; b: string; confidence: number; reasoning: string }>> {
    // Build compact prompt: for each bucket, show A market + its candidate Bs
    const bucketsText = buckets.map((bucket, i) => {
      const catA = bucket.marketA.category ? ` [${bucket.marketA.category}]` : '';
      const endA = bucket.marketA.endDate ? ` [ends: ${bucket.marketA.endDate.toISOString().split('T')[0]}]` : '';
      const candidatesText = bucket.candidates.map((c, j) => {
        const cat = c.category ? ` [${c.category}]` : '';
        const end = c.endDate ? ` [ends: ${c.endDate.toISOString().split('T')[0]}]` : '';
        return `    B${i + 1}.${j + 1}. "${c.question}"${cat}${end} (id: ${c.id})`;
      }).join('\n');

      return `BUCKET ${i + 1}:
  A${i + 1}. "${bucket.marketA.question}"${catA}${endA} (id: ${bucket.marketA.id})
  Candidates:
${candidatesText}`;
    }).join('\n\n');

    const prompt = `You are a prediction market matching engine. For each bucket below, determine if any candidate from B is THE EXACT SAME MARKET as the A market.

STRICT RULES — ALL must be true:
1. SAME ASSET/ENTITY: "Bitcoin" ≠ "Ethereum". "Trump" ≠ "Biden".
2. SAME THRESHOLD: "$100,000" ≠ "$60,000". "above 4000" ≠ "above 1600".
3. SAME DATE/TIMEFRAME: "by December 31, 2026" ≠ "on March 17".
4. SAME DIRECTION: "Will X happen?" = "Will X happen?". "reach" ≠ "stay below".

If ANY differ, do NOT match. When in doubt, do NOT match.

${bucketsText}

For each bucket, pick AT MOST ONE best match from its candidates (or none). Use format "A1" for the first bucket's A market, "B1.2" for the 2nd candidate in bucket 1.
Call submit_matches with your results. Include ONLY matches with confidence >= 0.90. Return empty matches array if no exact matches found.`;

    if (this.provider === 'anthropic') {
      type ToolResult = { matches: Array<{ a: string; b: string; confidence: number; reasoning: string }> };
      const toolResult = await this.callAnthropicWithTool<ToolResult>(prompt, BATCH_MATCH_TOOL, 4096);
      return toolResult.matches || [];
    }

    // ── Ollama/OpenAI fallback ──────────────────────────────────────────
    const textPrompt = prompt.replace(
      'Call submit_matches with your results. Include ONLY matches with confidence >= 0.90. Return empty matches array if no exact matches found.',
      `Return ONLY a JSON array of matches. Confidence >= 0.90 only. Return [] if none.\n[\n  { "a": "A1", "b": "B1.2", "confidence": 0.95, "reasoning": "Same event, same date" }\n]`,
    );

    let text = await this.callLLM(textPrompt, 4096);
    if (text.trim().startsWith('```')) {
      text = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      return JSON.parse(text.trim());
    } catch {
      log.warn('Failed to parse LLM batch-match response', { text: text.slice(0, 200) });
      return [];
    }
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
