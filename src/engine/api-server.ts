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
} from '../db/database';
import { BotState } from '../types';

const log = createChildLogger('api');

export class ApiServer {
  private app = express();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  private getBotState: () => BotState;
  private setBotState: (state: BotState) => void;

  constructor(
    getBotState: () => BotState,
    setBotState: (state: BotState) => void,
  ) {
    this.getBotState = getBotState;
    this.setBotState = setBotState;
    this.setupRoutes();
    this.setupEventForwarding();
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
      });
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
            this.handleClientMessage(msg);
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

  private handleClientMessage(msg: { type: string; data?: unknown }): void {
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
