// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Configuration
// Centralized config loaded from environment variables
// ═══════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY || '',
    apiSecret: process.env.POLYMARKET_API_SECRET || '',
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
    proxyAddress: process.env.POLYMARKET_PROXY_ADDRESS || '',
    gammaUrl: 'https://gamma-api.polymarket.com',
    clobUrl: 'https://clob.polymarket.com',
    wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  },

  predictfun: {
    apiKey: process.env.PREDICTFUN_API_KEY || '',
    privateKey: process.env.PREDICTFUN_PRIVATE_KEY || '',
    apiUrl: 'https://api.predict.fun',
    testnetUrl: 'https://api-testnet.predict.fun',
    // WebSocket lives on a separate subdomain from the REST API.
    // REST → api.predict.fun   WebSocket → ws.predict.fun
    wsUrl: 'wss://ws.predict.fun/ws',
    wsTestnetUrl: 'wss://ws-testnet.predict.fun/ws',
    useTestnet: process.env.PREDICTFUN_USE_TESTNET === 'true',
  },

  bot: {
    minProfitBps: envInt('MIN_PROFIT_BPS', 150),
    maxPositionUsd: envInt('MAX_POSITION_USD', 500),
    scanIntervalMs: envInt('SCAN_INTERVAL_MS', 10000),
    maxTotalExposureUsd: envInt('MAX_TOTAL_EXPOSURE_USD', 5000),
    /** Minimum order book depth in USD to consider an opportunity executable. Set to 0 for testing. */
    minDepthUsd: envInt('MIN_DEPTH_USD', 50),
    /** Interval for refreshing market pairs (ms). Pair matching is separate from opportunity scanning. */
    pairRefreshIntervalMs: envInt('PAIR_REFRESH_INTERVAL_MS', 300000),
    /** Dry-run mode: when true, no real trades are placed. Default: true (safe). */
    dryRun: process.env.DRY_RUN !== 'false',
  },

  dashboard: {
    port: envInt('DASHBOARD_PORT', 3847),
    apiPort: envInt('API_PORT', 3848),
  },

  db: {
    path: env('DB_PATH', './data/pred-arb.db'),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },

  logging: {
    level: env('LOG_LEVEL', 'info'),
  },
} as const;