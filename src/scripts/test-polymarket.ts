#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Polymarket Trading Test Script
// Standalone test for placeOrder, cancelOrder, getBalance, getOpenOrders
//
// Usage:
//   npx ts-node src/scripts/test-polymarket.ts [command]
//
// Commands:
//   balance     — Fetch USDC balance
//   orders      — List open orders
//   markets     — List active markets (to get a token ID for testing)
//   place       — Place a small test limit order (far from market, won't fill)
//   cancel <id> — Cancel a specific order
//   cancel-all  — Cancel all open orders
//   full-test   — Run full lifecycle: balance → place → check → cancel
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import { PolymarketConnector } from '../connectors/polymarket';
import { OrderRequest } from '../types';

const connector = new PolymarketConnector();

async function getBalance() {
  console.log('\n📊 Fetching Polymarket balance...');
  const balance = await connector.getBalance();
  console.log(`   USDC Balance: $${balance.toFixed(2)}`);
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

async function listMarkets() {
  console.log('\n🏪 Fetching active markets...');
  const markets = await connector.fetchMarkets({ limit: 5, activeOnly: true });
  for (const m of markets) {
    console.log(`   [${m.id}]`);
    console.log(`     Q: ${m.question}`);
    console.log(`     Prices: YES=${m.outcomePrices[0]?.toFixed(2)} NO=${m.outcomePrices[1]?.toFixed(2)}`);
    console.log(`     TokenIDs: YES=${m.outcomeTokenIds[0]?.slice(0, 20)}... NO=${m.outcomeTokenIds[1]?.slice(0, 20)}...`);
    console.log(`     Volume: $${m.volume.toFixed(0)} | Liquidity: $${m.liquidity.toFixed(0)}`);
    console.log('');
  }
  return markets;
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
  console.log(`   Current YES price: ${market.outcomePrices[0]?.toFixed(2)}`);

  // Place a BUY YES order far from market price (won't fill, safe to test)
  const testPrice = 0.01; // 1 cent — very unlikely to fill
  const testSize = 5;     // Minimum order size on Polymarket

  const order: OrderRequest = {
    platform: 'polymarket',
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

async function cancelAll() {
  console.log('\n🗑️  Cancelling all orders...');
  const success = await connector.cancelAllOrders();
  console.log(`   ${success ? '✅ All cancelled' : '❌ Failed'}`);
  return success;
}

async function fullTest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  POLYMARKET TRADING — FULL LIFECYCLE TEST');
  console.log('═══════════════════════════════════════════════════');

  // Step 1: Balance
  const balance = await getBalance();
  if (balance <= 0) {
    console.log('\n⚠️  No balance! Cannot place orders.');
    console.log('   Fund your wallet or check POLYMARKET_PRIVATE_KEY.');
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

  // Step 6: Final balance
  await getBalance();

  console.log('\n✅ Full lifecycle test complete!');
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] || 'full-test';

  console.log('Connecting to Polymarket...');
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
      case 'markets':
        await listMarkets();
        break;
      case 'place':
        await placeTestOrder();
        break;
      case 'cancel':
        const id = process.argv[3];
        if (!id) {
          console.log('Usage: test-polymarket.ts cancel <orderId>');
          process.exit(1);
        }
        await cancelOrder(id);
        break;
      case 'cancel-all':
        await cancelAll();
        break;
      case 'full-test':
        await fullTest();
        break;
      default:
        console.log(`Unknown command: ${cmd}`);
        console.log('Commands: balance, orders, markets, place, cancel <id>, cancel-all, full-test');
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
