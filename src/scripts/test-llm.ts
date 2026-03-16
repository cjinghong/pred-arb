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
//   batch-match — Test batch matching with two lists of markets
//   full-test   — Run all tests
//
// Configuration (via .env):
//   LLM_PROVIDER=ollama           # or 'anthropic', 'openai'
//   LLM_BASE_URL=http://localhost:11434/v1
//   LLM_MODEL=llama3.1
//   # Or: ANTHROPIC_API_KEY=sk-...
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import { LLMVerifier } from '../matcher/llm-verifier';
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
  console.log('\n🔍 Verify — testing pair verification with sample markets...');

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

// ─── Test: Batch Match ──────────────────────────────────────────────────

async function testBatchMatch() {
  console.log('\n📋 Batch Match — testing market list matching...');

  const prompt = `You are a prediction market analyst. Below are two lists of prediction markets from different platforms. Your job is to identify which markets from LIST A are THE SAME MARKET as a market in LIST B.

Two markets are "the same" if they would resolve identically — same event, same resolution criteria, same timeframe. Be careful with similar-but-different questions (e.g., "by end of 2026" vs "by March 2026" are NOT the same).

LIST A:
  A1. "Will the Democrats win the 2026 midterm elections?" [Politics] [ends: 2026-11-03] (id: poly-midterm-2026)
  A2. "Will there be a ceasefire in the Russia-Ukraine war by end of 2026?" [Politics] [ends: 2026-12-31] (id: poly-ukraine-ceasefire)
  A3. "Will Ethereum reach $10,000 by December 2026?" [Crypto] [ends: 2026-12-31] (id: poly-eth-10k)
  A4. "Will California experience a magnitude 7+ earthquake in 2026?" [Science] [ends: 2026-12-31] (id: poly-ca-earthquake)

LIST B:
  B1. "Ethereum to hit $10,000 by year-end 2026?" [Crypto] [ends: 2026-12-31] (id: kalshi-eth-10k)
  B2. "Democrats to win control of Congress in 2026 midterms?" [Politics] [ends: 2026-11-05] (id: kalshi-midterm-2026)
  B3. "Russia-Ukraine ceasefire before January 1, 2027?" [Politics] [ends: 2027-01-01] (id: kalshi-ukraine-ceasefire)
  B4. "Will TikTok be banned in the US by end of 2026?" [Tech] [ends: 2026-12-31] (id: kalshi-tiktok-ban)

Return ONLY a JSON array of matched pairs. If a market has no match, omit it. For each match include your confidence (0.0-1.0) and brief reasoning:
[
  { "a": "A1", "b": "B3", "confidence": 0.98, "reasoning": "Both ask about the same event" },
  ...
]

Only include matches you're confident about (>= 0.85). Return [] if no matches found.`;

  const startMs = Date.now();
  try {
    let text = await verifier.callLLM(prompt, 2048);
    const elapsed = Date.now() - startMs;

    console.log(`\n   Raw response (${elapsed}ms):`);
    console.log(`   ${text.trim().slice(0, 500)}`);

    // Parse
    if (text.trim().startsWith('```')) {
      text = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(text.trim()) as Array<{ a: string; b: string; confidence: number; reasoning: string }>;
      console.log(`\n   Parsed ${parsed.length} matches:`);
      for (const m of parsed) {
        console.log(`     ${m.a} ↔ ${m.b} (confidence: ${m.confidence}) — ${m.reasoning}`);
      }

      // Check expected: A1↔B2 (midterms), A2↔B3 (Ukraine), A3↔B1 (ETH)
      const expectedPairs = [
        { a: 'A1', b: 'B2', label: 'Midterms' },
        { a: 'A2', b: 'B3', label: 'Ukraine ceasefire' },
        { a: 'A3', b: 'B1', label: 'ETH $10k' },
      ];

      let score = 0;
      for (const exp of expectedPairs) {
        const found = parsed.find(p =>
          p.a.toUpperCase() === exp.a && p.b.toUpperCase() === exp.b
        );
        if (found && found.confidence >= 0.85) {
          score++;
          console.log(`   ✅ ${exp.label}: matched (${found.confidence})`);
        } else {
          console.log(`   ⚠️  ${exp.label}: expected ${exp.a}↔${exp.b} match`);
        }
      }

      // A4 (earthquake) and B4 (TikTok) should NOT match anything
      const falseMatch = parsed.find(p => p.a === 'A4' || p.b === 'B4');
      if (!falseMatch) {
        score++;
        console.log('   ✅ No false matches (earthquake/TikTok correctly excluded)');
      } else {
        console.log(`   ⚠️  Unexpected match: ${falseMatch.a}↔${falseMatch.b}`);
      }

      console.log(`\n   Score: ${score}/4 correct`);
    } catch {
      console.log('\n   ❌ Failed to parse response as JSON');
      console.log('   💡 Your model may need more guidance for JSON output. Try a larger model.');
    }
  } catch (err) {
    console.log(`   ❌ Failed: ${(err as Error).message}`);
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
    case 'batch-match':
      await testBatchMatch();
      break;
    case 'full-test':
      await testPing();
      await testVerify();
      await testBatchMatch();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Commands: ping, verify, batch-match, full-test');
      process.exit(1);
  }

  console.log('\n🏁 Done.\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
