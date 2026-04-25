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
import { countUsers, createUser, hashPassword } from './auth.js';

async function bootstrap() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.reposDir, { recursive: true });
  fs.mkdirSync(config.certsDir, { recursive: true });

  getDb();

  if (
    config.bootstrapAdminUser &&
    config.bootstrapAdminPassword &&
    countUsers() === 0
  ) {
    const hash = await hashPassword(config.bootstrapAdminPassword);
    createUser(config.bootstrapAdminUser, hash, 'owner');
    console.log(`[bootstrap] created owner: ${config.bootstrapAdminUser}`);
  }

  const tls = config.tlsEnabled ? await ensureTls() : null;

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    serverFactory: (handler) => {
      const server = tls
        ? https.createServer({ key: tls.key, cert: tls.cert }, handler)
        : http.createServer(handler);
      setupWebSocket(app, server);
      return server;
    },
  });

  await app.register(sensible);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.jwtSecret });

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    fingerprint: tls?.fingerprint ?? null,
  }));

  app.get('/api/info', async () => {
    const fpPath = path.join(config.certsDir, 'fingerprint.txt');
    let fp = tls?.fingerprint ?? null;
    if (!fp && fs.existsSync(fpPath)) fp = fs.readFileSync(fpPath, 'utf8').trim();
    return {
      version: '0.1.0',
      tls: !!tls,
      fingerprint: fp,
      requireInvite: countUsers() > 0,
    };
  });

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
