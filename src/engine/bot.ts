// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Bot Orchestrator
// Main loop that coordinates connectors, strategies, execution, and the API.
//
// Scanning is event-driven: WebSocket order book updates trigger immediate
// arb checks on affected pairs. A background timer still refreshes the
// market pair list periodically.
// ═══════════════════════════════════════════════════════════════════════════

import { BotState, Platform } from '../types';
import { MarketConnector } from '../types/connector';
import { Strategy } from '../types/strategy';
import { PolymarketConnector } from '../connectors/polymarket';
import { PredictFunConnector } from '../connectors/predictfun';
import { CrossPlatformArbStrategy } from '../strategies/cross-platform-arb';
import { ExecutionEngine } from './execution-engine';
import { RiskManager } from './risk-manager';
import { ApiServer } from './api-server';
import { initializeDatabase, setBotStateKV } from '../db/database';
import { config } from '../utils/config';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';

const log = createChildLogger('bot');

export class Bot {
  private state: BotState = 'STOPPED';
  private connectors = new Map<Platform, MarketConnector>();
  private strategies = new Map<string, Strategy>();
  private executionEngine: ExecutionEngine;
  private riskManager: RiskManager;
  private apiServer: ApiServer;
  private pairRefreshTimer: NodeJS.Timeout | null = null;
  private startTime = Date.now();

  constructor() {
    // Initialize components
    this.riskManager = new RiskManager();
    this.executionEngine = new ExecutionEngine(this.riskManager, /* dryRun */ true);
    this.apiServer = new ApiServer(
      () => this.state,
      (s) => this.setState(s),
    );
  }

  async start(): Promise<void> {
    log.info('═══════════════════════════════════════════════════════');
    log.info('  PRED-ARB :: Prediction Market Arbitrage Bot');
    log.info('═══════════════════════════════════════════════════════');
    log.info('Initializing...');

    // 1. Initialize database
    initializeDatabase();

    // 2. Create and connect connectors
    const polymarket = new PolymarketConnector();
    const predictfun = new PredictFunConnector();

    this.connectors.set('polymarket', polymarket);
    this.connectors.set('predictfun', predictfun);

    // Connect to all platforms
    const connectResults = await Promise.allSettled([
      polymarket.connect(),
      predictfun.connect(),
    ]);

    for (const [i, result] of connectResults.entries()) {
      const platform = i === 0 ? 'polymarket' : 'predictfun';
      if (result.status === 'rejected') {
        log.error(`Failed to connect to ${platform}`, { error: result.reason });
      } else {
        eventBus.emit('connector:connected', { platform });
      }
    }

    // 3. Initialize strategies
    const xPlatformArb = new CrossPlatformArbStrategy();
    await xPlatformArb.initialize(this.connectors);
    this.strategies.set(xPlatformArb.id, xPlatformArb);

    // 4. Initialize execution engine + risk manager
    this.riskManager.initialize(this.connectors);
    this.executionEngine.initialize(this.connectors, this.strategies);

    // 5. Load persisted pair statuses and wire up dashboard handlers
    xPlatformArb.loadPersistedPairs();
    this.apiServer.setMarketsSummaryGetter(() => xPlatformArb.getMarketsSummary());
    this.apiServer.setConnectors(this.connectors);
    this.apiServer.setPairStatusHandler((pairId, status) => {
      xPlatformArb.setPairStatus(pairId, status as import('../matcher/market-matcher').PairStatus);
    });
    this.apiServer.setManualPairHandler((marketAId, marketBId) => {
      return xPlatformArb.addManualPair(marketAId, marketBId);
    });

    // 6. Start API server
    await this.apiServer.start();

    // 7. Wire up event-driven execution: opportunity:found → execution engine
    eventBus.on('opportunity:found', async (opp) => {
      if (this.state !== 'RUNNING') return;
      try {
        await this.executionEngine.submit(opp);
      } catch (err) {
        log.error('Failed to submit opportunity', { error: (err as Error).message });
      }
    });

    // 8. Start the bot
    this.setState('RUNNING');
    this.startTime = Date.now();

    // Run initial pair refresh + first scan, then enable event-driven scanning
    await xPlatformArb.refreshPairsIfNeeded().catch(err =>
      log.error('Initial pair refresh failed', { error: err.message })
    );
    // Run one full scan to log diagnostics on startup
    await xPlatformArb.scan().catch(err =>
      log.error('Initial scan failed', { error: err.message })
    );

    // Enable event-driven scanning: book updates trigger arb checks
    xPlatformArb.startEventDrivenScanning();

    // Periodically refresh market pairs (not scanning — just re-matching)
    this.pairRefreshTimer = setInterval(() => {
      if (this.state === 'RUNNING') {
        xPlatformArb.refreshPairsIfNeeded().catch(err =>
          log.error('Pair refresh failed', { error: err.message })
        );
      }
    }, config.bot.pairRefreshIntervalMs);

    log.info('Bot is RUNNING (event-driven mode)', {
      platforms: Array.from(this.connectors.keys()),
      strategies: Array.from(this.strategies.keys()),
      pairRefreshInterval: `${config.bot.pairRefreshIntervalMs}ms`,
      minProfitBps: config.bot.minProfitBps,
      minDepthUsd: config.bot.minDepthUsd,
    });
  }

  async stop(): Promise<void> {
    log.info('Shutting down...');
    this.setState('STOPPED');

    if (this.pairRefreshTimer) {
      clearInterval(this.pairRefreshTimer);
      this.pairRefreshTimer = null;
    }

    // Shutdown strategies (also stops event-driven scanning)
    for (const strategy of this.strategies.values()) {
      await strategy.shutdown();
    }

    // Disconnect connectors
    for (const connector of this.connectors.values()) {
      await connector.disconnect();
    }

    // Stop API server
    await this.apiServer.stop();

    log.info('Bot stopped');
  }

  private setState(newState: BotState): void {
    const oldState = this.state;
    this.state = newState;
    setBotStateKV('state', newState);
    eventBus.emit('bot:state_change', { from: oldState, to: newState });
    log.info(`State: ${oldState} → ${newState}`);
  }
}
