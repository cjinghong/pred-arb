#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: predict.fun Trading Test Script
// Standalone test for placeOrder, cancelOrder, getBalance, getOpenOrders
//
// Usage:
//   npx ts-node src/scripts/test-predictfun.ts [command]
//
// Commands:
//   balance     — Fetch USDT balance
//   orders      — List open orders
//   positions   — List current positions
//   markets     — List active markets
//   fees        — Show fee calculation examples
//   place       — Place a small test limit order (far from market, won't fill)
//   cancel <id> — Cancel a specific order
//   full-test   — Run full lifecycle: balance → place → check → cancel
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import { PredictFunConnector } from '../connectors/predictfun';
import { OrderRequest } from '../types';

const connector = new PredictFunConnector();

async function getBalance() {
  console.log('\n📊 Fetching predict.fun balance...');
  const balance = await connector.getBalance();
  console.log(`   USDT Balance: $${balance.toFixed(2)}`);
  return balance;
}

async function getOrders() {
  console.log('\n📋 Fetching open orders...');
  const orders = await connector.getOpenOrders();
  if (orders.length === 0) {
    console.log('   No open orders.');
  } else {
    for (const o of orders) {
      console.log(`   ${o.id.slice(0, 16)}... | ${o.side} ${o.size} @ ${o.price} | ${o.status}`);
    }
  }
  return orders;
}

async function getPositions() {
  console.log('\n📈 Fetching positions...');
  const positions = await connector.getPositions();
  if (positions.length === 0) {
    console.log('   No positions.');
  } else {
    for (const p of positions) {
      console.log(`   ${p.marketQuestion.slice(0, 50)}...`);
      console.log(`     ${p.side} | Size: ${p.size} | Entry: ${p.avgEntryPrice} | PnL: ${p.unrealizedPnl}`);
    }
  }
  return positions;
}

async function listMarkets() {
  console.log('\n🏪 Fetching active markets...');
  const markets = await connector.fetchMarkets({ limit: 5, activeOnly: true });
  for (const m of markets) {
    console.log(`   [${m.id}] ${m.question.slice(0, 60)}`);
    console.log(`     Outcomes: ${m.outcomes.join(', ')}`);
    console.log(`     TokenIDs: ${m.outcomeTokenIds.map(t => t.slice(0, 16)).join(', ')}...`);
    console.log('');
  }
  return markets;
}

function showFeeExamples() {
  console.log('\n💰 predict.fun Fee Calculation Examples:');
  console.log('   Formula: rawFee = 0.02 × min(price, 1-price) × shares\n');

  const examples = [
    { price: 0.20, shares: 100 },
    { price: 0.50, shares: 100 },
    { price: 0.65, shares: 50 },
    { price: 0.80, shares: 100 },
    { price: 0.95, shares: 200 },
  ];

  for (const { price, shares } of examples) {
    const fee = PredictFunConnector.calculateTakerFee(price, shares);
    const feeDiscounted = PredictFunConnector.calculateTakerFee(price, shares, true);
    const pct = (fee / (price * shares) * 100).toFixed(3);
    console.log(`   ${shares} shares @ $${price.toFixed(2)} → Fee: $${fee.toFixed(4)} (${pct}%) | Discounted: $${feeDiscounted.toFixed(4)}`);
  }
}

async function placeTestOrder() {
  console.log('\n🎯 Placing test order...');

  // Fetch a market to get a valid token ID
  const markets = await connector.fetchMarkets({ limit: 1, activeOnly: true });
  if (markets.length === 0) {
    console.log('   No active markets found!');
    return null;
  }

  const market = markets[0];
  console.log(`   Market: ${market.question}`);
  console.log(`   Market ID: ${market.id}`);

  // Place a BUY YES order far from market price (won't fill, safe to test)
  // predict.fun has min order of $1 USDT
  const testPrice = 0.01; // 1 cent — very unlikely to fill
  const testSize = 100;   // 100 shares @ $0.01 = $1.00 (minimum order)

  const order: OrderRequest = {
    platform: 'predictfun',
    marketId: market.id,
    outcomeIndex: 0,    // YES
    side: 'BUY',
    type: 'LIMIT',
    price: testPrice,
    size: testSize,
  };

  const fee = PredictFunConnector.calculateTakerFee(testPrice, testSize);
  console.log(`   Placing: BUY ${testSize} YES @ $${testPrice} (fee: $${fee.toFixed(4)})`);

  const result = await connector.placeOrder(order);
  console.log(`   Result: ${result.id.slice(0, 20)}... | Status: ${result.status}`);
  if (result.status === 'FAILED') {
    console.log(`   ❌ Order failed:`, result.raw);
  }
  return result;
}

async function cancelOrder(orderId: string) {
  console.log(`\n🗑️  Cancelling order ${orderId.slice(0, 20)}...`);
  const success = await connector.cancelOrder(orderId);
  console.log(`   ${success ? '✅ Cancelled' : '❌ Failed'}`);
  return success;
}

async function fullTest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  PREDICT.FUN TRADING — FULL LIFECYCLE TEST');
  console.log('═══════════════════════════════════════════════════');

  // Step 0: Fee examples
  showFeeExamples();

  // Step 1: Balance
  const balance = await getBalance();
  if (balance <= 0) {
    console.log('\n⚠️  No balance! Cannot place orders.');
    console.log('   Fund your wallet or check PREDICTFUN_PRIVATE_KEY.');
    return;
  }

  // Step 2: Place order
  const orderResult = await placeTestOrder();
  if (!orderResult || orderResult.status === 'FAILED') {
    console.log('\n⚠️  Order placement failed. Check credentials.');
    return;
  }

  // Step 3: Check it appears in open orders
  console.log('\n⏳ Waiting 2s for order to appear...');
  await new Promise(r => setTimeout(r, 2000));
  await getOrders();

  // Step 4: Cancel it
  await cancelOrder(orderResult.id);

  // Step 5: Verify cancelled
  console.log('\n⏳ Waiting 1s...');
  await new Promise(r => setTimeout(r, 1000));
  await getOrders();

  // Step 6: Final balance + positions
  await getBalance();
  await getPositions();

  console.log('\n✅ Full lifecycle test complete!');
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] || 'full-test';

  console.log('Connecting to predict.fun...');
  await connector.connect();
  console.log('Connected!\n');

  try {
    switch (cmd) {
      case 'balance':
        await getBalance();
        break;
      case 'orders':
        await getOrders();
        break;
      case 'positions':
        await getPositions();
        break;
      case 'markets':
        await listMarkets();
        break;
      case 'fees':
        showFeeExamples();
        break;
      case 'place':
        await placeTestOrder();
        break;
      case 'cancel':
        const id = process.argv[3];
        if (!id) {
          console.log('Usage: test-predictfun.ts cancel <orderId>');
          process.exit(1);
        }
        await cancelOrder(id);
        break;
      case 'full-test':
        await fullTest();
        break;
      default:
        console.log(`Unknown command: ${cmd}`);
        console.log('Commands: balance, orders, positions, markets, fees, place, cancel <id>, full-test');
    }
  } catch (err) {
    console.error('\n❌ Error:', (err as Error).message);
    console.error((err as Error).stack);
  }

  await connector.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
