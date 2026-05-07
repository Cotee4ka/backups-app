import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';

interface AuditRow {
  id: number;
  timestamp: number;
  user_id: string;
  username: string;
  project_id: string | null;
  action: string;
  detail: string | null;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', async (req, reply) => {
    const me = await requireAuth(req);
    const query = z
      .object({
        projectId: z.string().optional(),
        userId: z.string().optional(),
        limit: z.coerce.number().min(1).max(500).default(100),
      })
      .parse(req.query);

    const where: string[] = [];
    const args: (string | number)[] = [];

    if (query.projectId) {
      const isMember = getDb()
        .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
        .get(query.projectId, me.id);
      if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      where.push('a.project_id = ?');
      args.push(query.projectId);
    } else if (me.role !== 'owner' && me.role !== 'admin') {
      where.push(
        `a.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`,
      );
      args.push(me.id);
    }

    if (query.userId) {
      where.push('a.user_id = ?');
      args.push(query.userId);
    }

    args.push(query.limit);

    const sql = `
      SELECT a.id, a.timestamp, a.user_id, u.username, a.project_id, a.action, a.detail
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.timestamp DESC
      LIMIT ?
    `;
    const rows = getDb().prepare(sql).all(...args) as AuditRow[];

    return reply.send({
      entries: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        userId: r.user_id,
        username: r.username,
        projectId: r.project_id,
        action: r.action,
        detail: r.detail ? JSON.parse(r.detail) : {},
      })),
    });
  });
}
