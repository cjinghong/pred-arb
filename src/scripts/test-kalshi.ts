#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Kalshi Trading Test Script
// Standalone test for placeOrder, cancelOrder, getBalance, getOpenOrders
//
// Usage:
//   npx tsx src/scripts/test-kalshi.ts [command]
//
// Commands:
//   balance     — Fetch USD balance
//   orders      — List open orders
//   positions   — List current positions
//   markets     — List active markets (to find tickers for testing)
//   fees        — Show fee calculations for sample prices
//   place       — Place a small test limit order (far from market, won't fill)
//   cancel <id> — Cancel a specific order
//   full-test   — Run full lifecycle: balance → place → check → cancel
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import { KalshiConnector } from '../connectors/kalshi';
import { OrderRequest } from '../types';

const connector = new KalshiConnector();

async function getBalance() {
  console.log('\n📊 Fetching Kalshi balance...');
  const balance = await connector.getBalance();
  console.log(`   USD Balance: $${balance.toFixed(2)}`);
  return balance;
}

async function getOrders() {
  console.log('\n📋 Fetching open orders...');
  const orders = await connector.getOpenOrders();
  if (orders.length === 0) {
    console.log('   No open orders.');
  } else {
    for (const o of orders) {
      console.log(`   ${o.id} | ${o.side} ${o.size} @ ${o.price} | ${o.status}`);
    }
  }
  return orders;
}

async function getPositionsList() {
  console.log('\n📈 Fetching positions...');
  const positions = await connector.getPositions();
  if (positions.length === 0) {
    console.log('   No positions.');
  } else {
    for (const p of positions) {
      console.log(`   ${p.marketId} | ${p.side} ${p.size} | entry: $${p.avgEntryPrice.toFixed(2)}`);
    }
  }
  return positions;
}

async function listMarkets() {
  console.log('\n🏪 Fetching active markets...');
  const markets = await connector.fetchMarkets({ limit: 10, activeOnly: true });
  for (const m of markets) {
    console.log(`   [${m.id}]`);
    console.log(`     Q: ${m.question}`);
    console.log(`     Prices: YES=${m.outcomePrices[0]?.toFixed(2)} NO=${m.outcomePrices[1]?.toFixed(2)}`);
    console.log(`     Volume: ${m.volume} | Liquidity: ${m.liquidity}`);
    console.log(`     Category: ${m.category}`);
    console.log('');
  }
  return markets;
}

function showFees() {
  console.log('\n💰 Kalshi Fee Calculations:');
  console.log('   Formula: $0.07 × P × (1-P) × count');
  console.log('   Min fee: $0.02 per contract\n');

  const prices = [0.10, 0.25, 0.50, 0.75, 0.90];
  for (const p of prices) {
    const fee1 = KalshiConnector.calculateTakerFee(p, 1);
    const fee10 = KalshiConnector.calculateTakerFee(p, 10);
    const fee100 = KalshiConnector.calculateTakerFee(p, 100);
    console.log(`   P=${p.toFixed(2)}: 1 contract=$${fee1.toFixed(4)}, 10 contracts=$${fee10.toFixed(4)}, 100 contracts=$${fee100.toFixed(4)}`);
  }
}

async function placeTestOrder() {
  console.log('\n🎯 Placing test order on Kalshi...');

  // Fetch a market to get a valid ticker
  const markets = await connector.fetchMarkets({ limit: 1, activeOnly: true });
  if (markets.length === 0) {
    console.log('   No active markets found!');
    return null;
  }

  const market = markets[0];
  console.log(`   Market: ${market.question}`);
  console.log(`   Ticker: ${market.id}`);
  console.log(`   Current YES price: ${market.outcomePrices[0]?.toFixed(2)}`);

  // Place a BUY YES order far from market price (won't fill, safe to test)
  const testPrice = 0.02; // 2 cents — very unlikely to fill
  const testSize = 1;     // Minimum: 1 contract

  const order: OrderRequest = {
    platform: 'kalshi',
    marketId: market.id,
    outcomeIndex: 0,    // YES
    side: 'BUY',
    type: 'LIMIT',
    price: testPrice,
    size: testSize,
  };

  console.log(`   Placing: BUY ${testSize} YES @ $${testPrice}`);
  const result = await connector.placeOrder(order);
  console.log(`   Result: ${result.id} | Status: ${result.status}`);
  if (result.status === 'FAILED') {
    console.log(`   ❌ Order failed:`, result.raw);
  }
  return result;
}

async function cancelOrder(orderId: string) {
  console.log(`\n🗑️  Cancelling order ${orderId}...`);
  const success = await connector.cancelOrder(orderId);
  console.log(`   ${success ? '✅ Cancelled' : '❌ Failed'}`);
  return success;
}

async function fullTest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  KALSHI TRADING — FULL LIFECYCLE TEST');
  console.log('═══════════════════════════════════════════════════');

  // Step 1: Balance
  const balance = await getBalance();
  if (balance <= 0) {
    console.log('\n⚠️  No balance! Cannot place orders.');
    console.log('   Fund your Kalshi account and check KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY.');
    return;
  }

  // Step 2: Show fees
  showFees();

  // Step 3: Place order
  const orderResult = await placeTestOrder();
  if (!orderResult || orderResult.status === 'FAILED') {
    console.log('\n⚠️  Order placement failed. Check credentials.');
    return;
  }

  // Step 4: Check it appears in open orders
  console.log('\n⏳ Waiting 2s for order to appear...');
  await new Promise(r => setTimeout(r, 2000));
  await getOrders();

  // Step 5: Cancel it
  await cancelOrder(orderResult.id);

  // Step 6: Verify cancelled
  console.log('\n⏳ Waiting 1s...');
  await new Promise(r => setTimeout(r, 1000));
  await getOrders();

  // Step 7: Final balance
  await getBalance();

  // Step 8: Positions
  await getPositionsList();

  console.log('\n✅ Full lifecycle test complete!');
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] || 'full-test';

  console.log('Connecting to Kalshi...');
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
        await getPositionsList();
        break;
      case 'markets':
        await listMarkets();
        break;
      case 'fees':
        showFees();
        break;
      case 'place':
        await placeTestOrder();
        break;
      case 'cancel':
        const id = process.argv[3];
        if (!id) {
          console.log('Usage: test-kalshi.ts cancel <orderId>');
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
