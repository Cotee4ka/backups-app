import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';

const createSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
  ttlSec: z.number().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
});

interface InviteRow {
  code: string;
  created_by: string;
  role: 'admin' | 'member' | 'viewer';
  expires_at: number;
  used_by: string | null;
  used_at: number | null;
  project_id: string | null;
  revoked: number;
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  // Server-level invite (без привязки к проекту) — выдаётся owner/admin'ом
  // сервера, новый юзер регистрируется и получает указанную роль.
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
    return reply.send({ code, expiresAt, role: body.role, projectId: null });
  });

  app.get('/invites', async (req, reply) => {
    const me = await requireAuth(req);
    if (me.role !== 'owner' && me.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const rows = getDb()
      .prepare(
        `SELECT code, role, expires_at as expiresAt, used_by as usedBy, used_at as usedAt,
                project_id as projectId, revoked
         FROM invites ORDER BY expires_at DESC LIMIT 200`,
      )
      .all();
    return reply.send({ invites: rows });
  });

  // Public — без auth. Клиент дёргает чтобы понять что это за инвайт
  // (роль, проект) ДО регистрации/логина и собрать UI приветствия.
  // Возвращает минимум, чтобы не утечь приватной информации.
  app.get('/invites/:code/info', async (req, reply) => {
    const params = req.params as { code: string };
    const row = getDb()
      .prepare(
        `SELECT i.code, i.role, i.expires_at as expiresAt, i.used_by as usedBy,
                i.project_id as projectId, i.revoked,
                p.name as projectName
         FROM invites i
         LEFT JOIN projects p ON p.id = i.project_id
         WHERE i.code = ?`,
      )
      .get(params.code) as
      | {
          code: string;
          role: string;
          expiresAt: number;
          usedBy: string | null;
          projectId: string | null;
          revoked: number;
          projectName: string | null;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'Invite not found' });
    if (row.revoked) return reply.code(410).send({ error: 'Invite revoked' });
    if (row.expiresAt < Date.now()) {
      return reply.code(410).send({ error: 'Invite expired' });
    }
    if (row.usedBy && !row.projectId) {
      // Server-level одноразовый инвайт уже использован.
      return reply.code(410).send({ error: 'Invite already used' });
    }
    return reply.send({
      code: row.code,
      role: row.role,
      expiresAt: row.expiresAt,
      projectId: row.projectId,
      projectName: row.projectName,
    });
  });

  // Отозвать инвайт. Может owner/admin сервера или создатель инвайта.
  app.delete('/invites/:code', async (req, reply) => {
    const me = await requireAuth(req);
    const params = req.params as { code: string };
    const row = getDb()
      .prepare(`SELECT created_by FROM invites WHERE code = ?`)
      .get(params.code) as { created_by: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Invite not found' });
    if (
      me.role !== 'owner' &&
      me.role !== 'admin' &&
      row.created_by !== me.id
    ) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    getDb().prepare(`UPDATE invites SET revoked = 1 WHERE code = ?`).run(params.code);
    return reply.send({ ok: true });
  });

  // Принять инвайт уже залогиненным юзером — присоединиться к проекту.
  // Используется когда юзер уже зарегистрирован на сервере и получил
  // ссылку-приглашение в другой проект на этом же сервере.
  app.post('/invites/:code/accept', async (req, reply) => {
    const me = await requireAuth(req);
    const params = req.params as { code: string };
    const inv = getDb()
      .prepare(
        `SELECT code, role, expires_at, used_by, project_id, revoked
         FROM invites WHERE code = ?`,
      )
      .get(params.code) as InviteRow | undefined;
    if (!inv) return reply.code(404).send({ error: 'Invite not found' });
    if (inv.revoked) return reply.code(410).send({ error: 'Invite revoked' });
    if (inv.expires_at < Date.now()) {
      return reply.code(410).send({ error: 'Invite expired' });
    }
    if (!inv.project_id) {
      return reply
        .code(400)
        .send({ error: 'Server-level invite cannot be accepted as project member' });
    }

    // Проверяем что проект существует (CASCADE мог не сработать если что).
    const projectExists = getDb()
      .prepare(`SELECT id FROM projects WHERE id = ?`)
      .get(inv.project_id) as { id: string } | undefined;
    if (!projectExists) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Идемпотентно — если уже мембер, просто ок.
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(inv.project_id, me.id, inv.role, Date.now());

    // Project-level инвайт многоразовый по умолчанию НЕ делаем — каждый
    // юзер «съедает» один инвайт. Это даёт owner'у контроль и аудит «кто
    // зашёл по какому коду».
    getDb()
      .prepare(`UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?`)
      .run(me.id, Date.now(), inv.code);

    return reply.send({
      ok: true,
      projectId: inv.project_id,
      role: inv.role,
    });
  });
}
