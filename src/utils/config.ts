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
    // Smart Wallet address — serves as both predictAccount (for SDK signing) and deposit address (for balance)
    smartWallet: process.env.PREDICTFUN_SMART_WALLET || '',
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
    /**
     * Market category filter. Restricts market fetching to a specific category.
     * Values: '' (all markets), 'sports', 'basketball', 'football', 'soccer',
     *         'baseball', 'hockey', 'mma', 'tennis', 'golf', 'motorsports', etc.
     * When set, fetches ALL markets in that category (pagination) instead of top-200 by volume.
     */
    marketCategory: (process.env.MARKET_CATEGORY || '').toLowerCase().trim(),
    /**
     * Comma-separated list of enabled platforms. Only these platforms will be connected and used.
     * Values: 'polymarket', 'predictfun', 'kalshi'
     * Default: 'polymarket,kalshi' (predict.fun disabled by default)
     * Set ENABLED_PLATFORMS=polymarket,predictfun,kalshi to enable all three.
     */
    enabledPlatforms: (process.env.ENABLED_PLATFORMS || 'polymarket,kalshi')
      .toLowerCase().split(',').map(p => p.trim()).filter(Boolean),
  },

  dashboard: {
    port: envInt('DASHBOARD_PORT', 3847),
    apiPort: envInt('API_PORT', 3848),
  },

  db: {
    path: env('DB_PATH', './data/pred-arb.db'),
  },

  kalshi: {
    apiKeyId: process.env.KALSHI_API_KEY_ID || '',
    // RSA private key — either inline (newlines as \n) or path to PEM file
    privateKey: process.env.KALSHI_PRIVATE_KEY || '',
    privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
    apiUrl: 'https://api.elections.kalshi.com/trade-api/v2',
    wsUrl: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
    // Demo/sandbox mode: use demo API endpoints
    useDemo: process.env.KALSHI_USE_DEMO === 'true',
    demoApiUrl: 'https://demo-api.kalshi.co/trade-api/v2',
    demoWsUrl: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },

  llm: {
    /** 'anthropic' (default), 'ollama' (native /api/generate), or 'openai' for OpenAI-compatible APIs */
    provider: (process.env.LLM_PROVIDER || 'anthropic') as 'anthropic' | 'ollama' | 'openai',
    /** Base URL for LLM API (Ollama default: http://localhost:11434) */
    baseUrl: process.env.LLM_BASE_URL || 'http://localhost:11434',
    /** Model name (e.g., 'llama3.1', 'mistral', 'qwen2.5') */
    model: process.env.LLM_MODEL || 'llama3.1',
    /** API key for OpenAI-compatible provider (not needed for Ollama) */
    apiKey: process.env.LLM_API_KEY || '',
  },

  logging: {
    level: env('LOG_LEVEL', 'info'),
  },
} as const;