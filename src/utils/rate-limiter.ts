// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Rate Limiter
// Token-bucket rate limiter for platform API calls.
// Each platform gets its own bucket with configurable requests/sec.
// ═══════════════════════════════════════════════════════════════════════════

import { Platform } from '../types';

interface Bucket {
  tokens: number;
  maxTokens: number;
  refillRate: number; // tokens per second
  lastRefill: number; // timestamp ms
}

const buckets = new Map<string, Bucket>();

/** Default rate limits per platform (requests per second) */
const DEFAULT_LIMITS: Record<Platform, number> = {
  polymarket: 8,   // Polymarket CLOB: ~10 req/s, be conservative
  predictfun: 5,   // predict.fun: ~8 req/s, be conservative
};

/**
 * Initialize a rate limiter bucket for a platform.
 * Called automatically on first use if not already set up.
 */
export function initRateLimiter(key: string, requestsPerSecond?: number): void {
  const rps = requestsPerSecond ?? DEFAULT_LIMITS[key as Platform] ?? 5;
  buckets.set(key, {
    tokens: rps,
    maxTokens: rps,
    refillRate: rps,
    lastRefill: Date.now(),
  });
}

/**
 * Wait until a token is available, then consume it.
 * Returns the number of ms waited (0 if no wait was needed).
 */
export async function rateLimit(key: string): Promise<number> {
  if (!buckets.has(key)) {
    initRateLimiter(key);
  }

  const bucket = buckets.get(key)!;
  let waited = 0;

  // Refill tokens based on elapsed time
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;

  // If no tokens available, wait for one
  if (bucket.tokens < 1) {
    const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    waited = waitMs;

    // Refill after waiting
    const afterWait = Date.now();
    const elapsedAfter = (afterWait - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsedAfter * bucket.refillRate);
    bucket.lastRefill = afterWait;
  }

  // Consume one token
  bucket.tokens -= 1;
  return waited;
}

/**
 * Check if a request can proceed immediately without waiting.
 */
export function canProceed(key: string): boolean {
  if (!buckets.has(key)) return true;
  const bucket = buckets.get(key)!;

  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  const currentTokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
  return currentTokens >= 1;
}
