import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb, closeDb } from './db.js';
import { ensureTls } from './tls.js';
import { setupWebSocket } from './ws/hub.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { auditRoutes } from './routes/audit.js';
import { inviteRoutes } from './routes/invites.js';
import { gitHttpRoutes } from './git/http.js';
import { countUsers, hashPassword, upsertBootstrapUser } from './auth.js';
import { SERVER_VERSION, SERVER_FEATURES } from './version.js';

async function bootstrap() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.reposDir, { recursive: true });
  fs.mkdirSync(config.certsDir, { recursive: true });

  getDb();

  if (config.bootstrapAdminUser && config.bootstrapAdminPassword) {
    const hash = await hashPassword(config.bootstrapAdminPassword);
    upsertBootstrapUser(config.bootstrapAdminUser, hash, 'owner');
    console.log(`[bootstrap] ensured owner: ${config.bootstrapAdminUser}`);
  }

  const tls = config.tlsEnabled ? await ensureTls() : null;
  let rawServer: http.Server | https.Server | null = null;

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    serverFactory: (handler) => {
      rawServer = tls
        ? https.createServer({ key: tls.key, cert: tls.cert }, handler)
        : http.createServer(handler);
      return rawServer;
    },
  });
  setupWebSocket(app, rawServer ?? app.server);

  await app.register(sensible);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.jwtSecret });

  app.get('/api/health', async () => ({
    ok: true,
    version: SERVER_VERSION,
    features: SERVER_FEATURES,
    fingerprint: tls?.fingerprint ?? null,
  }));

  app.get('/api/info', async () => {
    const fpPath = path.join(config.certsDir, 'fingerprint.txt');
    let fp = tls?.fingerprint ?? null;
    if (!fp && fs.existsSync(fpPath)) fp = fs.readFileSync(fpPath, 'utf8').trim();
    return {
      version: SERVER_VERSION,
      features: SERVER_FEATURES,
      tls: !!tls,
      fingerprint: fp,
      requireInvite: countUsers() > 0,
    };
  });

  app.get('/api/version', async () => ({
    version: SERVER_VERSION,
    features: SERVER_FEATURES,
  }));

  await app.register(async (api) => {
    await authRoutes(api);
    await projectRoutes(api);
    await auditRoutes(api);
    await inviteRoutes(api);
  }, { prefix: '/api' });

  await app.register(gitHttpRoutes);

  const closeGracefully = async () => {
    console.log('shutting down...');
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', closeGracefully);
  process.on('SIGTERM', closeGracefully);

  await app.listen({ host: config.host, port: config.port });
  const proto = tls ? 'https' : 'http';
  console.log(`backups-app server listening on ${proto}://${config.host}:${config.port}`);
  if (tls) {
    console.log(`TLS fingerprint (SHA-256): ${tls.fingerprint}`);
  }
}

bootstrap().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
