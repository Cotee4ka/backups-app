import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';

const createSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
  ttlSec: z.number().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
});

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/invites', async (req, reply) => {
    const me = await requireAuth(req);
    if (me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = createSchema.parse(req.body);
    const code = nanoid(16);
    const expiresAt = Date.now() + body.ttlSec * 1000;
    getDb()
      .prepare(
        `INSERT INTO invites (code, created_by, role, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .run(code, me.id, body.role, expiresAt);
    return reply.send({ code, expiresAt, role: body.role });
  });

  app.get('/invites', async (req, reply) => {
    const me = await requireAuth(req);
    if (me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const rows = getDb()
      .prepare(
        `SELECT code, role, expires_at as expiresAt, used_by as usedBy, used_at as usedAt
         FROM invites ORDER BY expires_at DESC LIMIT 100`,
      )
      .all();
    return reply.send({ invites: rows });
  });
}
