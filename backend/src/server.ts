/**
 * ATMOS Protocol (Sui Edition) — Fastify Server
 * ─────────────────────────────────────────────
 * Identical to Solana version except:
 *  - imports setWebSocketEmitter from mrv_sui
 *  - healthHandler checks Sui + Walrus instead of Solana
 */

import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import cors       from '@fastify/cors';
import helmet     from '@fastify/helmet';
import rateLimit  from '@fastify/rate-limit';
import multipart  from '@fastify/multipart';
import crypto     from 'crypto';
import { logger } from './utils/logger';
import { registerRoutes } from './routes/api';
import { connectDB } from './db/pool';
import { setWebSocketEmitter } from './services/mrv_sui';

// ── WebSocket client registry ────────────────────────
const wsClients = new Map<string, Set<any>>();

function broadcastToProject(event: string, data: object): void {
  const [, projectId] = event.split(':');
  const clients = wsClients.get(projectId);
  if (!clients) return;
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  clients.forEach(ws => { try { ws.send(msg); } catch { /* disconnected */ } });
}

// ── Build Fastify app ────────────────────────────────
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, requestTimeout: 30000 });

  await app.register(helmet, { crossOriginEmbedderPolicy: false, contentSecurityPolicy: false });

  await app.register(cors, {
    origin: process.env.NODE_ENV === 'production'
      ? (process.env.ALLOWED_ORIGINS || 'http://localhost:19006').split(',')
      : true,
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  });

  await app.register(rateLimit, {
    max:        parseInt(process.env.RATE_LIMIT_MAX || '200'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    keyGenerator: (req) => req.headers.authorization?.substring(7,27) || req.ip,
    errorResponseBuilder: () => ({ error: 'Too Many Requests', message: 'Rate limit exceeded. Please try again.' }),
  });

  await app.register(multipart, { limits: { fileSize: 50*1024*1024, files: 10 } });

  // Request/response logging
  app.addHook('onRequest',  async (req) => logger.debug('→', { method: req.method, url: req.url }));
  app.addHook('onResponse', async (req, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug';
    logger[level]('←', { method: req.method, url: req.url, status: reply.statusCode });
  });

  // Error handler
  app.setErrorHandler(async (err: any, req, reply) => {
    if (err?.name === 'ZodError') return reply.status(400).send({ error: 'Validation Error', issues: err.issues });
    if (err?.statusCode === 429) return reply.status(429).send(err);
    logger.error('Unhandled error', { url: req.url, error: err?.message });
    return reply.status(err?.statusCode || 500).send({
      error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err?.message,
    });
  });

  await registerRoutes(app);

  // Manual WebSocket upgrade
  app.server.on('upgrade', (req, socket) => {
    const url       = new URL(req.url || '/', `http://${req.headers.host}`);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) { socket.destroy(); return; }

    const key    = req.headers['sec-websocket-key'] as string;
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    if (!wsClients.has(projectId)) wsClients.set(projectId, new Set());
    wsClients.get(projectId)!.add(socket);
    socket.on('close', () => wsClients.get(projectId)?.delete(socket));
    socket.on('error', () => wsClients.get(projectId)?.delete(socket));
    logger.debug('WS connected', { projectId });
  });

  setWebSocketEmitter(broadcastToProject);
  return app;
}

// ── Start ────────────────────────────────────────────
async function start() {
  await connectDB();
  const app  = await buildApp();
  const port = parseInt(process.env.PORT || '3000');

  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info(`🌿 ATMOS (Sui Edition) running on port ${port}`, { env: process.env.NODE_ENV, sui: process.env.SUI_NETWORK || 'testnet' });
  } catch (err) {
    logger.error('Failed to start', { error: (err as Error).message });
    process.exit(1);
  }

  const shutdown = async (sig: string) => {
    logger.info(`${sig} — shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();
