import type { FastifyInstance } from 'fastify';
import { statfsSync } from 'node:fs';
import type { ServerStatusResponse } from '@backups-app/shared';
import type { ServerConfig } from '../config.js';

export function registerStatusRoutes(app: FastifyInstance, config: ServerConfig): void {
  const startedAt = Date.now();

  app.get('/status', async (_request, reply) => {
    let diskFree: number | undefined;
    let diskTotal: number | undefined;
    try {
      const stats = statfsSync(config.dataDir);
      diskFree = Number(stats.bavail) * Number(stats.bsize);
      diskTotal = Number(stats.blocks) * Number(stats.bsize);
    } catch {
      // optional
    }
    const response: ServerStatusResponse = {
      serverId: config.serverId,
      version: config.serverVersion,
      protocolVersion: config.protocolVersion,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      diskFreeBytes: diskFree,
      diskTotalBytes: diskTotal,
    };
    return reply.send(response);
  });

  // Lightweight liveness probe used by docker healthcheck.
  app.get('/healthz', async (_request, reply) => reply.send({ ok: true }));
}
