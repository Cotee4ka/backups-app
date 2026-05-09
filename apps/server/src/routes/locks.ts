import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import { broadcastToProject } from '../ws/hub.js';
import type { ProjectLockState } from '@backups-app/shared';

/**
 * Координация Claude-агентов / пользователей при работе на одном проекте.
 *
 * Один лок на проект. Холдер каждые ~30 секунд шлёт heartbeat с
 * `currentlyEditing` — путями файлов, которые сейчас правит локально
 * (в Claude / в IDE). Сервер ретранслирует это всем подписчикам через WS,
 * ждущие агенты видят зону работы и решают: ждать или взять другую часть.
 *
 * После каждого push'а сервер дописывает в session_files то что прошло
 * через git-receive-pack — финальный список «что трогали за сессию».
 */

const DEFAULT_TTL_SEC = 15 * 60;
const MAX_TTL_SEC = 60 * 60;

interface LockRow {
  project_id: string;
  holder_user_id: string;
  holder_username: string;
  reason: string;
  acquired_at: number;
  expires_at: number;
  heartbeat_at: number;
  currently_editing: string;
  session_files: string;
}

function rowToState(row: LockRow): ProjectLockState {
  return {
    projectId: row.project_id,
    holderUserId: row.holder_user_id,
    holderUsername: row.holder_username,
    reason: row.reason,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    currentlyEditing: safeJsonArray(row.currently_editing),
    sessionFiles: safeJsonArray(row.session_files),
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function getActiveLock(projectId: string): LockRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM project_locks WHERE project_id = ?`)
    .get(projectId) as LockRow | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    // Истёкший лок чистим лениво и считаем «свободным».
    db.prepare(`DELETE FROM project_locks WHERE project_id = ?`).run(projectId);
    return null;
  }
  return row;
}

/**
 * Дописывает в session_files активного лока пути из только что прошедшего push'а.
 * Вызывается из git/http.ts после успешного git-receive-pack.
 */
export function recordLockSessionFiles(projectId: string, files: string[]): void {
  if (files.length === 0) return;
  const row = getActiveLock(projectId);
  if (!row) return;
  const existing = new Set(safeJsonArray(row.session_files));
  for (const f of files) existing.add(f);
  // Ограничим размер — иначе на больших проектах JSON может разрастись.
  const merged = Array.from(existing).slice(-500);
  getDb()
    .prepare(`UPDATE project_locks SET session_files = ? WHERE project_id = ?`)
    .run(JSON.stringify(merged), projectId);
  // Не шлём отдельный WS-event — это избыточно, push сам уже триггерит repo:updated.
}

export async function lockRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/projects/:id/lock — текущее состояние лока (или null).
  app.get('/projects/:id/lock', async (req) => {
    await requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = getActiveLock(id);
    return { lock: row ? rowToState(row) : null };
  });

  // POST /api/projects/:id/lock — acquire.
  // Body: { reason?: string, ttlSec?: number, force?: boolean }
  // force=true перетирает чужой активный лок (полезно если заметно что
  // часовой завис, но TTL ещё не истёк).
  app.post('/projects/:id/lock', async (req, reply) => {
    const me = await requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        reason: z.string().max(280).default(''),
        ttlSec: z.number().int().min(60).max(MAX_TTL_SEC).default(DEFAULT_TTL_SEC),
        force: z.boolean().default(false),
      })
      .parse(req.body ?? {});

    const project = getDb()
      .prepare(`SELECT id FROM projects WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const existing = getActiveLock(id);
    if (existing && !body.force) {
      // Если это сам холдер пере-acquire'ит — продлеваем как heartbeat.
      if (existing.holder_user_id === me.id) {
        const now = Date.now();
        const expires = now + body.ttlSec * 1000;
        getDb()
          .prepare(
            `UPDATE project_locks SET heartbeat_at = ?, expires_at = ?, reason = ? WHERE project_id = ?`,
          )
          .run(now, expires, body.reason || existing.reason, id);
        const refreshed = getActiveLock(id)!;
        const state = rowToState(refreshed);
        broadcastToProject(id, { type: 'lock:heartbeat', lock: state });
        return { ok: true, acquired: true, lock: state };
      }
      return reply.code(409).send({
        ok: false,
        error: 'locked',
        lock: rowToState(existing),
      });
    }

    const now = Date.now();
    const expires = now + body.ttlSec * 1000;
    getDb()
      .prepare(
        `INSERT INTO project_locks
           (project_id, holder_user_id, holder_username, reason,
            acquired_at, expires_at, heartbeat_at,
            currently_editing, session_files)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]')
         ON CONFLICT(project_id) DO UPDATE SET
           holder_user_id = excluded.holder_user_id,
           holder_username = excluded.holder_username,
           reason = excluded.reason,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at,
           heartbeat_at = excluded.heartbeat_at,
           currently_editing = '[]',
           session_files = '[]'`,
      )
      .run(id, me.id, me.username, body.reason, now, expires, now);

    const fresh = getActiveLock(id)!;
    const state = rowToState(fresh);
    broadcastToProject(id, { type: 'lock:acquired', lock: state });
    return { ok: true, acquired: true, lock: state };
  });

  // POST /api/projects/:id/lock/heartbeat
  // Body: { ttlSec?: number, currentlyEditing?: string[], reason?: string }
  app.post('/projects/:id/lock/heartbeat', async (req, reply) => {
    const me = await requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        ttlSec: z.number().int().min(60).max(MAX_TTL_SEC).default(DEFAULT_TTL_SEC),
        currentlyEditing: z.array(z.string()).max(200).default([]),
        reason: z.string().max(280).optional(),
      })
      .parse(req.body ?? {});

    const existing = getActiveLock(id);
    if (!existing) return reply.code(404).send({ error: 'No active lock' });
    if (existing.holder_user_id !== me.id)
      return reply.code(403).send({ error: 'Not your lock', lock: rowToState(existing) });

    const now = Date.now();
    const expires = now + body.ttlSec * 1000;
    getDb()
      .prepare(
        `UPDATE project_locks
           SET heartbeat_at = ?,
               expires_at = ?,
               currently_editing = ?,
               reason = COALESCE(?, reason)
         WHERE project_id = ?`,
      )
      .run(
        now,
        expires,
        JSON.stringify(body.currentlyEditing),
        body.reason ?? null,
        id,
      );

    const fresh = getActiveLock(id)!;
    const state = rowToState(fresh);
    broadcastToProject(id, { type: 'lock:heartbeat', lock: state });
    return { ok: true, lock: state };
  });

  // POST /api/projects/:id/lock/release
  // Body: { summary?: string }
  app.post('/projects/:id/lock/release', async (req, reply) => {
    const me = await requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ summary: z.string().max(2000).optional() })
      .parse(req.body ?? {});

    const existing = getActiveLock(id);
    if (!existing) return { ok: true, released: false };
    if (existing.holder_user_id !== me.id)
      return reply.code(403).send({ error: 'Not your lock' });

    const sessionFiles = safeJsonArray(existing.session_files);
    getDb().prepare(`DELETE FROM project_locks WHERE project_id = ?`).run(id);

    broadcastToProject(id, {
      type: 'lock:released',
      projectId: id,
      byUserId: me.id,
      summary: body.summary,
      sessionFiles,
    });
    return { ok: true, released: true };
  });
}
