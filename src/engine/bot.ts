// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Bot Orchestrator
// Main loop that coordinates connectors, strategies, execution, and the API
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
  private scanTimer: NodeJS.Timeout | null = null;
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

    // 5. Start API server
    await this.apiServer.start();

    // 6. Start scanning
    this.setState('RUNNING');
    this.startScanLoop();
    this.startTime = Date.now();

    log.info('Bot is RUNNING', {
      platforms: Array.from(this.connectors.keys()),
      strategies: Array.from(this.strategies.keys()),
      scanInterval: `${config.bot.scanIntervalMs}ms`,
    });
  }

  async stop(): Promise<void> {
    log.info('Shutting down...');
    this.setState('STOPPED');

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    // Shutdown strategies
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

  private startScanLoop(): void {
    // Run first scan immediately
    this.runScan().catch(err => log.error('Initial scan failed', { error: err.message }));

    // Then run on interval
    this.scanTimer = setInterval(() => {
      if (this.state === 'RUNNING') {
        this.runScan().catch(err => log.error('Scan failed', { error: err.message }));
      }
    }, config.bot.scanIntervalMs);
  }

  private async runScan(): Promise<void> {
    if (this.state !== 'RUNNING') return;

    const scanStart = Date.now();
    eventBus.emit('bot:scan_start', { timestamp: new Date() });

    let totalOpportunities = 0;

    for (const strategy of this.strategies.values()) {
      if (!strategy.config.enabled) continue;

      try {
        const opportunities = await strategy.scan();
        totalOpportunities += opportunities.length;

        // Submit profitable opportunities to execution engine
        for (const opp of opportunities) {
          await this.executionEngine.submit(opp);
        }
      } catch (err) {
        log.error(`Strategy "${strategy.id}" scan failed`, {
          error: (err as Error).message,
        });
      }
    }

    const duration = Date.now() - scanStart;
    eventBus.emit('bot:scan_complete', {
      timestamp: new Date(),
      durationMs: duration,
      opportunitiesFound: totalOpportunities,
    });
  }
}
