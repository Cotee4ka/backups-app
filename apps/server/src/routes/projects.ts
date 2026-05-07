import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import {
  ensureRepo,
  getCommitDetail,
  listCommits,
  restoreToCommit,
  deleteRepo,
  listTree,
  fileHistory,
  readBlob,
  fileExistsAt,
} from '../git/repo.js';
import { broadcastToProject } from '../ws/hub.js';
import {
  HOST_ROOT,
  InvalidHostPathError,
  browseHost,
  externalFileExists,
  listExternalTree,
  listExternalTreeRecursive,
  resolveHostPath,
  statExternalFile,
} from '../host-fs.js';
import { detectDataStore } from '../data-store-detector.js';

const createSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
});

const createExternalSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  hostPath: z.string().min(1).max(4096),
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
  external_path: string | null;
}

function rowToProject(r: ProjectRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    defaultBranch: r.default_branch,
    createdAt: r.created_at,
    createdBy: r.created_by,
    externalPath: r.external_path ?? undefined,
  };
}

function getProject(id: string): ProjectRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(id) as ProjectRow | undefined;
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

  app.post('/projects/external', async (req, reply) => {
    const me = await requireAuth(req);
    if (me.role !== 'owner') {
      return reply.code(403).send({ error: 'Only owner can attach host folders' });
    }
    const body = createExternalSchema.parse(req.body);

    let resolved: string;
    try {
      resolved = await resolveHostPath(body.hostPath);
    } catch (e) {
      if (e instanceof InvalidHostPathError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }

    const id = nanoid();
    const now = Date.now();
    const db = getDb();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, name, description, default_branch, created_at, created_by, external_path)
         VALUES (?, ?, ?, 'main', ?, ?, ?)`,
      ).run(id, body.name, body.description ?? null, now, me.id, resolved);

      db.prepare(
        `INSERT INTO project_members (project_id, user_id, role, joined_at)
         VALUES (?, ?, 'owner', ?)`,
      ).run(id, me.id, now);

      db.prepare(
        `INSERT INTO audit_log (timestamp, user_id, project_id, action, detail)
         VALUES (?, ?, ?, 'project.create', ?)`,
      ).run(now, me.id, id, JSON.stringify({ name: body.name, externalPath: resolved }));
    });
    tx();

    return reply.send({
      project: {
        id,
        name: body.name,
        description: body.description,
        defaultBranch: 'main',
        createdAt: now,
        createdBy: me.id,
        externalPath: resolved,
      },
    });
  });

  app.get('/host/browse', async (req, reply) => {
    const me = await requireAuth(req);
    if (me.role !== 'owner') {
      return reply.code(403).send({ error: 'Only owner can browse host filesystem' });
    }
    const query = z
      .object({ path: z.string().default(HOST_ROOT) })
      .parse(req.query);
    let resolved: string;
    try {
      resolved = await resolveHostPath(query.path);
    } catch (e) {
      if (e instanceof InvalidHostPathError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
    try {
      const entries = await browseHost(resolved);
      return reply.send({ root: HOST_ROOT, path: resolved, entries });
    } catch (e) {
      if (e instanceof InvalidHostPathError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
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
    const row = getProject(params.id);
    if (!row) return reply.code(404).send({ error: 'Not found' });

    if (row.created_by !== me.id && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(params.id);
    if (!row.external_path) {
      await deleteRepo(params.id);
    }
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

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (project.external_path) {
      return reply.send({ commits: [] });
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

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });
    if (project.external_path) {
      return reply.code(400).send({ error: 'Restore not available for external projects' });
    }

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

  // ---------- File browser ----------

  app.get('/projects/:id/tree', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({
        ref: z.string().default('HEAD'),
        path: z.string().default(''),
      })
      .parse(req.query);

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (project.external_path) {
      try {
        const entries = await listExternalTree(project.external_path, query.path);
        return reply.send({
          ref: query.ref,
          path: query.path,
          entries: entries.map((e) => ({
            name: e.name,
            path: query.path
              ? `${query.path.replace(/\/+$/, '')}/${e.name}`
              : e.name,
            type: e.type,
            size: e.size,
            mtime: e.mtime,
            mode: '',
            oid: '',
          })),
        });
      } catch (e) {
        if (e instanceof InvalidHostPathError) {
          return reply.code(400).send({ error: e.message });
        }
        throw e;
      }
    }

    const entries = await listTree(params.id, query.ref, query.path, true);
    return reply.send({ ref: query.ref, path: query.path, entries });
  });

  app.get('/projects/:id/tree-recursive', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const query = z.object({ path: z.string().default('') }).parse(req.query);

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (!project.external_path) {
      return reply.code(400).send({ error: 'Recursive tree only for external projects' });
    }

    try {
      const result = await listExternalTreeRecursive(project.external_path, query.path);
      return reply.send({ path: query.path, entries: result.entries, truncated: result.truncated });
    } catch (e) {
      if (e instanceof InvalidHostPathError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  // Серверная автодетекция «хранилища данных» (БД, бэкапы, архивы, логи).
  // Применяет эвристики из data-store-detector: расширения, триггер-слова в
  // путях, размер файла. Клиент использует этот endpoint в визарде первой
  // синхронизации, чтобы юзер сразу видел причины и мог поправить руками.
  app.get('/projects/:id/data-store', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const query = z.object({ path: z.string().default('') }).parse(req.query);

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (!project.external_path) {
      return reply.code(400).send({ error: 'Data-store detector only for external projects' });
    }

    try {
      const report = await detectDataStore(project.external_path, query.path);
      return reply.send(report);
    } catch (e) {
      if (e instanceof InvalidHostPathError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  app.get('/projects/:id/file/history', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({
        path: z.string().min(1),
        limit: z.coerce.number().min(1).max(500).default(100),
      })
      .parse(req.query);

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (project.external_path) {
      return reply.send({ path: query.path, history: [] });
    }

    const history = await fileHistory(params.id, query.path, query.limit);
    return reply.send({ path: query.path, history });
  });

  app.get('/projects/:id/file/raw', async (req, reply) => {
    const me = await requireAuth(req);
    const params = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({
        path: z.string().min(1),
        ref: z.string().default('HEAD'),
        download: z.coerce.number().optional(),
      })
      .parse(req.query);

    const project = getProject(params.id);
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const isMember = getDb()
      .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(params.id, me.id);
    if (!isMember && me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const baseName = query.path.split('/').pop() ?? 'file';
    const setHeaders = (size: number) => {
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', size.toString());
      const disposition = query.download ? 'attachment' : 'inline';
      reply.header(
        'content-disposition',
        `${disposition}; filename="${encodeURIComponent(baseName)}"`,
      );
    };

    if (project.external_path) {
      if (!(await externalFileExists(project.external_path, query.path))) {
        return reply.code(404).send({ error: 'File not found' });
      }
      try {
        const { size, stream } = await statExternalFile(
          project.external_path,
          query.path,
        );
        setHeaders(size);
        return reply.send(stream);
      } catch (e) {
        if (e instanceof InvalidHostPathError) {
          return reply.code(400).send({ error: e.message });
        }
        throw e;
      }
    }

    if (!(await fileExistsAt(params.id, query.ref, query.path))) {
      return reply.code(404).send({ error: 'File not found at ref' });
    }

    const { size, stream } = await readBlob(params.id, query.ref, query.path);
    setHeaders(size);
    return reply.send(stream);
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
