// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: API Server
// Express + WebSocket server for dashboard communication
// ═══════════════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { config } from '../utils/config';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';
import {
  getDashboardMetrics,
  getRecentOpportunities,
  getRecentTrades,
  getBotStateKV,
  setBotStateKV,
  resetAllData,
} from '../db/database';
import { BotState, Platform } from '../types';
import { MarketConnector } from '../types/connector';

const log = createChildLogger('api');

export class ApiServer {
  private app = express();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  private getBotState: () => BotState;
  private setBotState: (state: BotState) => void;
  private getMarketsSummary: (() => unknown) | null = null;
  private setPairStatus: ((pairId: string, status: string) => void) | null = null;
  private addManualPair: ((marketAId: string, marketBId: string) => string | null) | null = null;
  private getPositions: (() => unknown[]) | null = null;
  private resetStrategy: (() => void | Promise<void>) | null = null;
  private connectors = new Map<Platform, MarketConnector>();

  constructor(
    getBotState: () => BotState,
    setBotState: (state: BotState) => void,
  ) {
    this.getBotState = getBotState;
    this.setBotState = setBotState;
    this.setupRoutes();
    this.setupEventForwarding();
  }

  /** Wire up market summary getter after strategies are initialized */
  setMarketsSummaryGetter(fn: () => unknown): void {
    this.getMarketsSummary = fn;
  }

  /** Wire up pair status setter for dashboard controls */
  setPairStatusHandler(fn: (pairId: string, status: string) => void): void {
    this.setPairStatus = fn;
  }

  /** Wire up manual pair creation handler */
  setManualPairHandler(fn: (marketAId: string, marketBId: string) => string | null): void {
    this.addManualPair = fn;
  }

  /** Wire up positions getter from risk manager */
  setPositionsGetter(fn: () => unknown[]): void {
    this.getPositions = fn;
  }

  /** Wire up strategy reset handler */
  setResetHandler(fn: () => void | Promise<void>): void {
    this.resetStrategy = fn;
  }

  /** Wire up connectors for order book fetching */
  setConnectors(connectors: Map<Platform, MarketConnector>): void {
    this.connectors = connectors;
  }

  private setupRoutes(): void {
    this.app.use(cors());
    this.app.use(express.json());

    // Serve dashboard static files (Next.js static export → out/)
    this.app.use(express.static(path.join(__dirname, '../../dashboard/out')));

    // ─── REST Endpoints ────────────────────────────────────────────────

    this.app.get('/api/status', (_req, res) => {
      res.json({
        state: this.getBotState(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/api/metrics', (_req, res) => {
      res.json(getDashboardMetrics());
    });

    this.app.get('/api/opportunities', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(getRecentOpportunities(limit));
    });

    this.app.get('/api/trades', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json(getRecentTrades(limit));
    });

    this.app.get('/api/config', (_req, res) => {
      res.json({
        minProfitBps: config.bot.minProfitBps,
        maxPositionUsd: config.bot.maxPositionUsd,
        maxTotalExposureUsd: config.bot.maxTotalExposureUsd,
        scanIntervalMs: config.bot.scanIntervalMs,
        minDepthUsd: config.bot.minDepthUsd,
      });
    });

    this.app.get('/api/markets', (_req, res) => {
      if (!this.getMarketsSummary) {
        res.json({ platforms: {}, matchedPairs: [] });
        return;
      }
      res.json(this.getMarketsSummary());
    });

    this.app.get('/api/positions', (_req, res) => {
      if (!this.getPositions) {
        res.json([]);
        return;
      }
      res.json(this.getPositions());
    });

    // ─── Order Book Endpoint ──────────────────────────────────────────

    this.app.get('/api/orderbook/:platform/:marketId', async (req, res) => {
      const { platform, marketId } = req.params;
      const outcomeIndex = parseInt(req.query.outcome as string) || 0;

      const connector = this.connectors.get(platform as Platform);
      if (!connector) {
        res.status(404).json({ error: `Unknown platform: ${platform}` });
        return;
      }

      try {
        const book = await connector.fetchOrderBook(marketId, outcomeIndex);
        res.json(book);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ─── Pair Management ─────────────────────────────────────────────────

    this.app.post('/api/pairs/:pairId/status', (req, res) => {
      const { pairId } = req.params;
      const { status } = req.body;
      const validStatuses = ['pending', 'approved', 'paused', 'rejected'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        return;
      }
      if (!this.setPairStatus) {
        res.status(503).json({ error: 'Pair management not initialized' });
        return;
      }
      this.setPairStatus(pairId, status);
      log.info(`Pair status changed via API`, { pairId, status });
      res.json({ pairId, status });
    });

    this.app.post('/api/pairs/:pairId/approve', (req, res) => {
      if (!this.setPairStatus) { res.status(503).json({ error: 'Not initialized' }); return; }
      this.setPairStatus(req.params.pairId, 'approved');
      res.json({ pairId: req.params.pairId, status: 'approved' });
    });

    this.app.post('/api/pairs/:pairId/pause', (req, res) => {
      if (!this.setPairStatus) { res.status(503).json({ error: 'Not initialized' }); return; }
      this.setPairStatus(req.params.pairId, 'paused');
      res.json({ pairId: req.params.pairId, status: 'paused' });
    });

    this.app.post('/api/pairs/:pairId/reject', (req, res) => {
      if (!this.setPairStatus) { res.status(503).json({ error: 'Not initialized' }); return; }
      this.setPairStatus(req.params.pairId, 'rejected');
      res.json({ pairId: req.params.pairId, status: 'rejected' });
    });

    // ─── Manual Pair Creation ─────────────────────────────────────────────

    this.app.post('/api/pairs/manual', (req, res) => {
      const { marketAId, marketBId } = req.body;
      if (!marketAId || !marketBId) {
        res.status(400).json({ error: 'marketAId and marketBId are required' });
        return;
      }
      if (!this.addManualPair) {
        res.status(503).json({ error: 'Manual pair creation not initialized' });
        return;
      }
      const pairId = this.addManualPair(marketAId, marketBId);
      if (!pairId) {
        res.status(404).json({ error: 'One or both markets not found in loaded data' });
        return;
      }
      log.info('Manual pair created via API', { pairId, marketAId, marketBId });
      res.json({ pairId, marketAId, marketBId, status: 'approved' });
    });

    // ─── Bot Control ───────────────────────────────────────────────────

    this.app.post('/api/bot/pause', (_req, res) => {
      this.setBotState('PAUSED');
      setBotStateKV('state', 'PAUSED');
      log.info('Bot paused via API');
      res.json({ state: 'PAUSED' });
    });

    this.app.post('/api/bot/resume', (_req, res) => {
      this.setBotState('RUNNING');
      setBotStateKV('state', 'RUNNING');
      log.info('Bot resumed via API');
      res.json({ state: 'RUNNING' });
    });

    this.app.post('/api/bot/stop', (_req, res) => {
      this.setBotState('STOPPED');
      setBotStateKV('state', 'STOPPED');
      log.info('Bot stopped via API');
      res.json({ state: 'STOPPED' });
    });

    this.app.post('/api/bot/reset', async (_req, res) => {
      try {
        // Stop the bot
        this.setBotState('STOPPED');
        // Clear database
        resetAllData();
        log.info('Full reset triggered via API — clearing data and restarting');
        // Reset in-memory strategy state + auto-restart
        if (this.resetStrategy) await this.resetStrategy();
        this.broadcast({ type: 'state_change', data: { state: this.getBotState() }, timestamp: new Date().toISOString() });
        res.json({ success: true, state: this.getBotState() });
      } catch (err) {
        log.error('Reset failed', { error: (err as Error).message });
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // SPA fallback (Next.js static export)
    this.app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, '../../dashboard/out/index.html'));
    });
  }

  private setupEventForwarding(): void {
    // Forward all interesting events to connected dashboard clients
    const forward = (type: string) => (data: unknown) => {
      this.broadcast({ type, data, timestamp: new Date().toISOString() });
    };

    eventBus.on('opportunity:found', forward('opportunity'));
    eventBus.on('trade:pending', forward('trade_pending'));
    eventBus.on('trade:executed', forward('trade_executed'));
    eventBus.on('trade:failed', forward('trade_failed'));
    eventBus.on('bot:scan_complete', forward('scan_complete'));
    eventBus.on('bot:state_change', forward('state_change'));
    eventBus.on('risk:limit_breach', forward('risk_alert'));

    // Forward book updates so the dashboard can live-update orderbook views
    eventBus.on('book:update', forward('book_update'));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(this.app);

      // WebSocket server on the same HTTP server
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        log.info('Dashboard client connected', { total: this.clients.size });

        // Send initial state
        ws.send(JSON.stringify({
          type: 'init',
          data: {
            state: this.getBotState(),
            metrics: getDashboardMetrics(),
            recentTrades: getRecentTrades(20),
            recentOpportunities: getRecentOpportunities(20),
          },
          timestamp: new Date().toISOString(),
        }));

        ws.on('close', () => {
          this.clients.delete(ws);
          log.info('Dashboard client disconnected', { total: this.clients.size });
        });

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.handleClientMessage(msg, ws);
          } catch {
            log.warn('Invalid WS message received');
          }
        });
      });

      this.server.listen(config.dashboard.apiPort, () => {
        log.info(`API server listening on port ${config.dashboard.apiPort}`);
        log.info(`Dashboard: http://localhost:${config.dashboard.apiPort}`);
        resolve();
      });
    });
  }

  private handleClientMessage(msg: { type: string; data?: unknown }, ws: WebSocket): void {
    switch (msg.type) {
      case 'pause':
        this.setBotState('PAUSED');
        break;
      case 'resume':
        this.setBotState('RUNNING');
        break;
      case 'request_update':
        this.broadcast({
          type: 'update',
          data: {
            metrics: getDashboardMetrics(),
            state: this.getBotState(),
          },
          timestamp: new Date().toISOString(),
        });
        break;
      case 'subscribe_book': {
        // Dashboard client wants live book updates for a specific market.
        // The book:update events are already being forwarded.
        // Client sends: { type: 'subscribe_book', data: { platform, marketId } }
        // We could track per-client subscriptions for efficiency,
        // but for now all book:update events go to all clients.
        break;
      }
    }
  }

  private broadcast(data: unknown): void {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.wss) {
      for (const client of this.clients) client.close();
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    log.info('API server stopped');
  }
}
