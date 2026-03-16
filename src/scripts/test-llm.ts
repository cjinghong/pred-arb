#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: LLM Integration Test Script
// Tests the LLM verifier with both Anthropic and Ollama/OpenAI-compatible APIs.
//
// Usage:
//   npx tsx src/scripts/test-llm.ts [command]
//
// Commands:
//   ping        — Check if the LLM API is reachable and responds
//   verify      — Test pair verification with sample prediction markets
//   bucket      — Test bucket-match with realistic market lists (the real pipeline)
//   full-test   — Run all tests
//
// Configuration (via .env):
//   LLM_PROVIDER=anthropic         # or 'ollama', 'openai'
//   ANTHROPIC_API_KEY=sk-...
//   # Or: LLM_BASE_URL=http://localhost:11434/v1  LLM_MODEL=llama3.1
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import { LLMVerifier } from '../matcher/llm-verifier';
import { MarketMatcher } from '../matcher/market-matcher';
import { config } from '../utils/config';
import { NormalizedMarket, Platform } from '../types';

const verifier = new LLMVerifier();

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<NormalizedMarket> & { id: string; question: string; platform: Platform }): NormalizedMarket {
  return {
    slug: '',
    category: '',
    outcomes: ['Yes', 'No'],
    outcomeTokenIds: [],
    outcomePrices: [0.5, 0.5],
    volume: 1000,
    liquidity: 500,
    active: true,
    endDate: null,
    lastUpdated: new Date(),
    raw: {},
    ...overrides,
  };
}

function printConfig() {
  console.log('\n⚙️  LLM Configuration:');
  console.log(`   Provider:  ${config.llm.provider}`);
  if (config.llm.provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY || '';
    console.log(`   API Key:   ${key ? key.slice(0, 10) + '...' : '(not set)'}`);
    console.log(`   Model:     claude-sonnet-4-20250514`);
    console.log(`   Mode:      tool_use (forced JSON)`);
  } else {
    console.log(`   Base URL:  ${config.llm.baseUrl}`);
    console.log(`   Model:     ${config.llm.model}`);
    console.log(`   API Key:   ${config.llm.apiKey ? config.llm.apiKey.slice(0, 10) + '...' : '(none needed)'}`);
  }
  console.log(`   Enabled:   ${verifier.isEnabled}`);
}

// ─── Test: Ping ─────────────────────────────────────────────────────────

async function testPing() {
  console.log('\n🏓 Ping — testing basic LLM connectivity...');
  const startMs = Date.now();

  try {
    const response = await verifier.callLLM(
      'Respond with exactly this JSON and nothing else: {"status": "ok", "message": "hello"}',
      256,
    );

    const elapsed = Date.now() - startMs;
    console.log(`   Response (${elapsed}ms): ${response.trim().slice(0, 200)}`);

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(response.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''));
      if (parsed.status === 'ok') {
        console.log('   ✅ LLM is reachable and responding with valid JSON');
      } else {
        console.log('   ⚠️  LLM responded but JSON structure unexpected:', parsed);
      }
    } catch {
      console.log('   ⚠️  LLM responded but output is not valid JSON. This may cause issues with market matching.');
      console.log('   💡 Tip: Try a larger model (e.g., qwen2.5:14b) for better JSON compliance.');
    }
  } catch (err) {
    console.log(`   ❌ Failed: ${(err as Error).message}`);
    if (config.llm.provider === 'ollama') {
      console.log('\n   💡 Troubleshooting:');
      console.log('      1. Is Ollama running? → ollama serve');
      console.log(`      2. Is the model pulled? → ollama pull ${config.llm.model}`);
      console.log(`      3. Is the URL correct? → curl ${config.llm.baseUrl}/api/tags`);
    }
  }
}

// ─── Test: Pair Verification ────────────────────────────────────────────

async function testVerify() {
  console.log('\n🔍 Verify — testing pair verification (tool_use for Anthropic)...');

  const candidates = [
    {
      // Should match: same question across platforms
      marketA: makeMarket({
        id: 'poly-trump-2028',
        platform: 'polymarket' as Platform,
        question: 'Will Donald Trump win the 2028 presidential election?',
        category: 'Politics',
        endDate: new Date('2028-11-10'),
      }),
      marketB: makeMarket({
        id: 'kalshi-trump-2028',
        platform: 'kalshi' as Platform,
        question: 'Will Trump win the 2028 US presidential election?',
        category: 'Politics',
        endDate: new Date('2028-11-10'),
      }),
      fuzzyScore: 0.85,
    },
    {
      // Should NOT match: different timeframes
      marketA: makeMarket({
        id: 'poly-btc-100k-2026',
        platform: 'polymarket' as Platform,
        question: 'Will Bitcoin hit $100,000 by end of 2026?',
        category: 'Crypto',
        endDate: new Date('2026-12-31'),
      }),
      marketB: makeMarket({
        id: 'kalshi-btc-100k-mar',
        platform: 'kalshi' as Platform,
        question: 'Will Bitcoin reach $100,000 by March 31, 2026?',
        category: 'Crypto',
        endDate: new Date('2026-03-31'),
      }),
      fuzzyScore: 0.75,
    },
    {
      // Should match: same event, slightly different wording
      marketA: makeMarket({
        id: 'poly-fed-rate',
        platform: 'polymarket' as Platform,
        question: 'Will the Federal Reserve cut interest rates in June 2026?',
        category: 'Economics',
        endDate: new Date('2026-06-30'),
      }),
      marketB: makeMarket({
        id: 'kalshi-fed-rate',
        platform: 'kalshi' as Platform,
        question: 'Fed interest rate cut at June 2026 FOMC meeting?',
        category: 'Economics',
        endDate: new Date('2026-06-20'),
      }),
      fuzzyScore: 0.70,
    },
  ];

  const startMs = Date.now();
  try {
    const results = await verifier.verifyPairs(candidates);
    const elapsed = Date.now() - startMs;

    console.log(`\n   Results (${elapsed}ms):`);
    for (const r of results) {
      const icon = r.isSameMarket ? '✅' : '❌';
      console.log(`\n   ${icon} ${r.marketA.question.slice(0, 50)}...`);
      console.log(`      ↔ ${r.marketB.question.slice(0, 50)}...`);
      console.log(`      Same market: ${r.isSameMarket} | Confidence: ${r.confidence.toFixed(2)} | ${r.reasoning}`);
    }

    // Check expected outcomes
    const [trump, btc, fed] = results;
    let score = 0;
    if (trump.isSameMarket && trump.confidence >= 0.85) { score++; console.log('\n   ✅ Trump 2028: correctly matched'); }
    else { console.log('\n   ⚠️  Trump 2028: expected match with high confidence'); }

    if (!btc.isSameMarket || btc.confidence < 0.85) { score++; console.log('   ✅ BTC $100k: correctly rejected (different timeframes)'); }
    else { console.log('   ⚠️  BTC $100k: should NOT match (end of 2026 vs March 2026)'); }

    if (fed.isSameMarket && fed.confidence >= 0.80) { score++; console.log('   ✅ Fed rate: correctly matched'); }
    else { console.log('   ⚠️  Fed rate: expected match (same FOMC meeting)'); }

    console.log(`\n   Score: ${score}/3 correct`);
  } catch (err) {
    console.log(`   ❌ Failed: ${(err as Error).message}`);
  }
}

// ─── Test: Bucket Match (realistic pipeline) ───────────────────────────
// This test mirrors the real pipeline: lots of markets on each side,
// fuzzy pre-grouping into buckets, then LLM verification per bucket.

async function testBucketMatch() {
  console.log('\n📋 Bucket Match — testing fuzzy pre-group → LLM verify pipeline...');
  console.log('   This uses the REAL matching pipeline with realistic market counts.\n');

  // Simulate Polymarket politics markets (list A)
  const marketsA: NormalizedMarket[] = [
    makeMarket({ id: 'poly-trump-2028', platform: 'polymarket', question: 'Will Donald Trump win the 2028 presidential election?', category: 'Politics', endDate: new Date('2028-11-10') }),
    makeMarket({ id: 'poly-dem-house-2026', platform: 'polymarket', question: 'Will Democrats win control of the House in 2026 midterms?', category: 'Politics', endDate: new Date('2026-11-03') }),
    makeMarket({ id: 'poly-ukraine-ceasefire', platform: 'polymarket', question: 'Will there be a ceasefire in the Russia-Ukraine war by end of 2026?', category: 'Politics', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'poly-fed-rate-june', platform: 'polymarket', question: 'Will the Federal Reserve cut interest rates in June 2026?', category: 'Economics', endDate: new Date('2026-06-30') }),
    makeMarket({ id: 'poly-btc-100k-eoy', platform: 'polymarket', question: 'Will Bitcoin reach $100,000 by end of 2026?', category: 'Crypto', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'poly-tiktok-ban', platform: 'polymarket', question: 'Will TikTok be banned in the US by end of 2026?', category: 'Tech', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'poly-scotus-term', platform: 'polymarket', question: 'Will a Supreme Court justice retire in 2026?', category: 'Politics', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'poly-iran-deal', platform: 'polymarket', question: 'Will the US reach a nuclear deal with Iran by 2027?', category: 'Politics', endDate: new Date('2027-01-01') }),
    makeMarket({ id: 'poly-newsom-pres', platform: 'polymarket', question: 'Will Gavin Newsom run for president in 2028?', category: 'Politics', endDate: new Date('2028-06-30') }),
    makeMarket({ id: 'poly-debt-ceiling', platform: 'polymarket', question: 'Will the US hit the debt ceiling in 2026?', category: 'Economics', endDate: new Date('2026-12-31') }),
    // Noise / no-match markets
    makeMarket({ id: 'poly-ca-quake', platform: 'polymarket', question: 'Will California experience a magnitude 7+ earthquake in 2026?', category: 'Science', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'poly-ai-consciousness', platform: 'polymarket', question: 'Will an AI system pass the Turing test by 2027?', category: 'Tech', endDate: new Date('2027-01-01') }),
    makeMarket({ id: 'poly-mars-mission', platform: 'polymarket', question: 'Will SpaceX launch a crewed Mars mission by 2030?', category: 'Science', endDate: new Date('2030-12-31') }),
    makeMarket({ id: 'poly-etf-approval', platform: 'polymarket', question: 'Will an Ethereum spot ETF be approved in 2026?', category: 'Crypto', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'poly-recession-2026', platform: 'polymarket', question: 'Will the US enter a recession in 2026?', category: 'Economics', endDate: new Date('2026-12-31') }),
  ];

  // Simulate Kalshi politics markets (list B) — some match, some don't
  const marketsB: NormalizedMarket[] = [
    makeMarket({ id: 'kal-trump-2028', platform: 'kalshi', question: 'Trump to win the 2028 US presidential election?', category: 'Politics', endDate: new Date('2028-11-10') }),
    makeMarket({ id: 'kal-house-2026', platform: 'kalshi', question: 'Democrats to win the House of Representatives in 2026?', category: 'Politics', endDate: new Date('2026-11-05') }),
    makeMarket({ id: 'kal-ukraine-ceasefire', platform: 'kalshi', question: 'Russia-Ukraine ceasefire before January 1, 2027?', category: 'Politics', endDate: new Date('2027-01-01') }),
    makeMarket({ id: 'kal-fed-rate-june', platform: 'kalshi', question: 'Federal Reserve rate cut at June 2026 FOMC?', category: 'Economics', endDate: new Date('2026-06-20') }),
    makeMarket({ id: 'kal-btc-100k-eoy', platform: 'kalshi', question: 'Bitcoin above $100,000 at end of 2026?', category: 'Crypto', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'kal-tiktok-ban', platform: 'kalshi', question: 'TikTok banned in the United States by December 31, 2026?', category: 'Tech', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'kal-recession-2026', platform: 'kalshi', question: 'US recession in 2026?', category: 'Economics', endDate: new Date('2026-12-31') }),
    // Markets that DON'T match anything in A
    makeMarket({ id: 'kal-btc-60k-mar', platform: 'kalshi', question: 'Bitcoin above $60,000 on March 19, 2026?', category: 'Crypto', endDate: new Date('2026-03-19') }),
    makeMarket({ id: 'kal-eth-4k', platform: 'kalshi', question: 'Ethereum above $4,000 on March 21, 2026?', category: 'Crypto', endDate: new Date('2026-03-21') }),
    makeMarket({ id: 'kal-fed-rate-sept', platform: 'kalshi', question: 'Federal Reserve rate cut at September 2026 FOMC?', category: 'Economics', endDate: new Date('2026-09-20') }),
    makeMarket({ id: 'kal-china-taiwan', platform: 'kalshi', question: 'Will China invade Taiwan by 2027?', category: 'Politics', endDate: new Date('2027-01-01') }),
    makeMarket({ id: 'kal-elon-ceo', platform: 'kalshi', question: 'Will Elon Musk step down as Tesla CEO in 2026?', category: 'Tech', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'kal-housing-crash', platform: 'kalshi', question: 'US housing prices to drop 10%+ in 2026?', category: 'Economics', endDate: new Date('2026-12-31') }),
    makeMarket({ id: 'kal-dem-senate-2026', platform: 'kalshi', question: 'Democrats to win the Senate in 2026?', category: 'Politics', endDate: new Date('2026-11-05') }),
    makeMarket({ id: 'kal-world-cup', platform: 'kalshi', question: 'USA to win the 2026 FIFA World Cup?', category: 'Sports', endDate: new Date('2026-07-19') }),
  ];

  // Expected matches (by question similarity):
  // poly-trump-2028 ↔ kal-trump-2028 (Trump 2028)
  // poly-dem-house-2026 ↔ kal-house-2026 (Dems House 2026)
  // poly-ukraine-ceasefire ↔ kal-ukraine-ceasefire (Ukraine ceasefire)
  // poly-fed-rate-june ↔ kal-fed-rate-june (Fed rate June)
  // poly-btc-100k-eoy ↔ kal-btc-100k-eoy (BTC $100k EOY)
  // poly-tiktok-ban ↔ kal-tiktok-ban (TikTok ban)
  // poly-recession-2026 ↔ kal-recession-2026 (US recession)
  //
  // Expected NON-matches:
  // poly-btc-100k-eoy should NOT match kal-btc-60k-mar (different price + date)
  // poly-fed-rate-june should NOT match kal-fed-rate-sept (different FOMC meeting)
  // poly-dem-house-2026 should NOT match kal-dem-senate-2026 (House ≠ Senate)

  const expectedMatches = [
    { a: 'poly-trump-2028', b: 'kal-trump-2028', label: 'Trump 2028' },
    { a: 'poly-dem-house-2026', b: 'kal-house-2026', label: 'Dems House 2026' },
    { a: 'poly-ukraine-ceasefire', b: 'kal-ukraine-ceasefire', label: 'Ukraine ceasefire' },
    { a: 'poly-fed-rate-june', b: 'kal-fed-rate-june', label: 'Fed rate June' },
    { a: 'poly-btc-100k-eoy', b: 'kal-btc-100k-eoy', label: 'BTC $100k EOY' },
    { a: 'poly-tiktok-ban', b: 'kal-tiktok-ban', label: 'TikTok ban' },
    { a: 'poly-recession-2026', b: 'kal-recession-2026', label: 'US recession' },
  ];

  const expectedNonMatches = [
    { a: 'poly-btc-100k-eoy', b: 'kal-btc-60k-mar', label: 'BTC $100k ≠ $60k Mar' },
    { a: 'poly-fed-rate-june', b: 'kal-fed-rate-sept', label: 'Fed June ≠ Sept' },
    { a: 'poly-dem-house-2026', b: 'kal-dem-senate-2026', label: 'House ≠ Senate' },
  ];

  console.log(`   Markets: ${marketsA.length} A × ${marketsB.length} B`);
  console.log(`   Expected: ${expectedMatches.length} matches, ${expectedNonMatches.length} non-matches\n`);

  const startMs = Date.now();

  try {
    // Use the REAL pipeline: MarketMatcher.findPairs() runs all 5 passes
    const matcher = new MarketMatcher();
    const pairs = await matcher.findPairs(marketsA, marketsB);
    const elapsed = Date.now() - startMs;

    console.log(`\n   Pipeline complete (${elapsed}ms): ${pairs.length} pairs found\n`);

    // Show all found pairs
    for (const p of pairs) {
      const icon = p.matchMethod === 'llm_matched' ? '🤖' : p.matchMethod === 'llm_verified' ? '🔍' : '⚡';
      console.log(`   ${icon} [${p.matchMethod}] (conf: ${p.confidence.toFixed(2)}, status: ${p.status})`);
      console.log(`      A: "${p.marketA.question.slice(0, 60)}..."`);
      console.log(`      B: "${p.marketB.question.slice(0, 60)}..."\n`);
    }

    // Score: check expected matches
    let correctMatches = 0;
    for (const exp of expectedMatches) {
      const found = pairs.find(p =>
        (p.marketA.id === exp.a && p.marketB.id === exp.b) ||
        (p.marketA.id === exp.b && p.marketB.id === exp.a)
      );
      if (found) {
        correctMatches++;
        console.log(`   ✅ ${exp.label}: matched (${found.matchMethod}, conf: ${found.confidence.toFixed(2)})`);
      } else {
        console.log(`   ⚠️  ${exp.label}: MISSED — expected ${exp.a} ↔ ${exp.b}`);
      }
    }

    // Score: check expected non-matches
    let correctNonMatches = 0;
    for (const exp of expectedNonMatches) {
      const found = pairs.find(p =>
        (p.marketA.id === exp.a && p.marketB.id === exp.b) ||
        (p.marketA.id === exp.b && p.marketB.id === exp.a)
      );
      if (!found) {
        correctNonMatches++;
        console.log(`   ✅ ${exp.label}: correctly NOT matched`);
      } else {
        console.log(`   ❌ ${exp.label}: FALSE MATCH — ${exp.a} ↔ ${exp.b} should NOT match`);
      }
    }

    const total = expectedMatches.length + expectedNonMatches.length;
    const correct = correctMatches + correctNonMatches;
    console.log(`\n   Score: ${correct}/${total} correct (${correctMatches}/${expectedMatches.length} matches, ${correctNonMatches}/${expectedNonMatches.length} non-matches)`);

    // Pipeline breakdown
    const byMethod = new Map<string, number>();
    for (const p of pairs) {
      byMethod.set(p.matchMethod, (byMethod.get(p.matchMethod) || 0) + 1);
    }
    console.log('\n   Pipeline breakdown:');
    for (const [method, count] of byMethod) {
      console.log(`     ${method}: ${count} pairs`);
    }

  } catch (err) {
    console.log(`   ❌ Failed: ${(err as Error).message}`);
    console.error(err);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2] || 'full-test';

  printConfig();

  if (!verifier.isEnabled) {
    console.log('\n❌ LLM verifier is not enabled. Check your configuration:');
    if (config.llm.provider === 'anthropic') {
      console.log('   Set ANTHROPIC_API_KEY in your .env file');
    } else {
      console.log(`   Set LLM_BASE_URL for ${config.llm.provider} in your .env file`);
      console.log(`   Make sure ${config.llm.provider} is running and the model is available`);
    }
    process.exit(1);
  }

  switch (command) {
    case 'ping':
      await testPing();
      break;
    case 'verify':
      await testVerify();
      break;
    case 'bucket':
    case 'batch-match':
      await testBucketMatch();
      break;
    case 'full-test':
      await testPing();
      await testVerify();
      await testBucketMatch();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Commands: ping, verify, bucket, full-test');
      process.exit(1);
  }

  console.log('\n🏁 Done.\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
