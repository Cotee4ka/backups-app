import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import { ensureRepo, getCommitDetail, listCommits, restoreToCommit, deleteRepo } from '../git/repo.js';
import { broadcastToProject } from '../ws/hub.js';

const createSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
});

const restoreSchema = z.object({
  sha: z.string().min(7).max(64),
  strategy: z.enum(['revert', 'reset']).default('revert'),
});

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  default_branch: string;
  created_at: number;
  created_by: string;
}

function rowToProject(r: ProjectRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    defaultBranch: r.default_branch,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (req, reply) => {
    const me = await requireAuth(req);
    const db = getDb();
    let rows: ProjectRow[];
    if (me.role === 'owner' || me.role === 'admin') {
      rows = db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as ProjectRow[];
    } else {
      rows = db
        .prepare(
          `SELECT p.* FROM projects p
           JOIN project_members m ON m.project_id = p.id
           WHERE m.user_id = ?
           ORDER BY p.created_at DESC`,
        )
        .all(me.id) as ProjectRow[];
    }
    return reply.send({ projects: rows.map(rowToProject) });
  });

  app.post('/projects', async (req, reply) => {
    const me = await requireAuth(req);
    const body = createSchema.parse(req.body);

    const id = nanoid();
    const now = Date.now();
    const db = getDb();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, name, description, default_branch, created_at, created_by)
         VALUES (?, ?, ?, 'main', ?, ?)`,
      ).run(id, body.name, body.description ?? null, now, me.id);

      db.prepare(
        `INSERT INTO project_members (project_id, user_id, role, joined_at)
         VALUES (?, ?, 'owner', ?)`,
      ).run(id, me.id, now);

      db.prepare(
        `INSERT INTO audit_log (timestamp, user_id, project_id, action, detail)
         VALUES (?, ?, ?, 'project.create', ?)`,
      ).run(now, me.id, id, JSON.stringify({ name: body.name }));
    });
    tx();

    await ensureRepo(id);

    return reply.send({
      project: {
        id,
        name: body.name,
        description: body.description,
        defaultBranch: 'main',
        createdAt: now,
        createdBy: me.id,
      },
    });
  });

  app.get('/projects/:id', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const row = getDb()
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(params.id) as ProjectRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    return reply.send({ project: rowToProject(row) });
  });

  app.delete('/projects/:id', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const row = getDb()
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(params.id) as ProjectRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });

    if (row.created_by !== me.id && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(params.id);
    await deleteRepo(params.id);
    broadcastToProject(params.id, {
      type: 'project:deleted',
      projectId: params.id,
    });
    return reply.send({ ok: true });
  });

  app.get('/projects/:id/history', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().min(1).max(500).default(100) })
      .parse(req.query);

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const commits = await listCommits(params.id, query.limit);
    return reply.send({ commits });
  });

  app.get('/projects/:id/commits/:sha', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string(), sha: z.string() }).parse(req.params);
    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const detail = await getCommitDetail(params.id, params.sha);
    return reply.send({ commit: detail });
  });

  app.post('/projects/:id/restore', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = restoreSchema.parse(req.body);

    const isMember = getDb()
      .prepare(
        `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`,
      )
      .get(params.id, me.id) as { role: string } | undefined;
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    if (
      isMember &&
      isMember.role === 'viewer' &&
      me.role !== 'owner' &&
      me.role !== 'admin'
    ) {
      return reply.code(403).send({ error: 'Read-only role' });
    }

    const newSha = await restoreToCommit(params.id, body.sha, body.strategy, {
      authorId: me.id,
      authorName: me.username,
    });

    getDb()
      .prepare(
        `INSERT INTO audit_log (timestamp, user_id, project_id, action, detail)
         VALUES (?, ?, ?, 'restore', ?)`,
      )
      .run(Date.now(), me.id, params.id, JSON.stringify({ sha: body.sha, newSha, strategy: body.strategy }));

    broadcastToProject(params.id, {
      type: 'project:restored',
      projectId: params.id,
      sha: newSha,
      byUserId: me.id,
    });
    return reply.send({ sha: newSha });
  });

  app.get('/projects/:id/members', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const members = getDb()
      .prepare(
        `SELECT u.id as userId, u.username as username, m.role as role, m.joined_at as joinedAt
         FROM project_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ?
         ORDER BY m.joined_at`,
      )
      .all(params.id);

    return reply.send({ members });
  });

  app.post('/projects/:id/members', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        username: z.string(),
        role: z.enum(['admin', 'member', 'viewer']).default('member'),
      })
      .parse(req.body);

    const myRole = getDb()
      .prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id) as { role: string } | undefined;
    if (
      (!myRole || (myRole.role !== 'owner' && myRole.role !== 'admin')) &&
      me.role !== 'owner'
    ) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const u = getDb()
      .prepare(`SELECT id FROM users WHERE username = ?`)
      .get(body.username) as { id: string } | undefined;
    if (!u) return reply.code(404).send({ error: 'User not found' });

    getDb()
      .prepare(
        `INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(params.id, u.id, body.role, Date.now());
    return reply.send({ ok: true });
  });
}
