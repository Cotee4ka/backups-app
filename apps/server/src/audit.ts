import { nanoid } from 'nanoid';
import type { AuditEntry } from '@backups-app/shared';
import type { DbContext } from './db.js';

export interface LogAuditInput {
  projectId: string | null;
  userId: string;
  action: AuditEntry['action'];
  sha?: string;
  details?: Record<string, unknown>;
}

export function logAudit(db: DbContext, input: LogAuditInput): AuditEntry {
  const id = nanoid(16);
  const timestamp = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO audit_log (id, project_id, user_id, action, sha, details, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.userId,
      input.action,
      input.sha ?? null,
      input.details ? JSON.stringify(input.details) : null,
      timestamp,
    );

  // Hydrate username for return.
  const row = db.raw
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .get(input.userId) as { username: string } | undefined;

  return {
    id,
    projectId: input.projectId ?? '',
    userId: input.userId,
    username: row?.username ?? 'unknown',
    action: input.action,
    sha: input.sha,
    details: input.details,
    timestamp,
  };
}

export interface ListAuditFilters {
  projectId?: string;
  userId?: string;
  limit?: number;
  before?: string;
}

export function listAudit(db: DbContext, filters: ListAuditFilters): {
  entries: AuditEntry[];
  hasMore: boolean;
} {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.projectId) {
    where.push('a.project_id = ?');
    params.push(filters.projectId);
  }
  if (filters.userId) {
    where.push('a.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.before) {
    where.push('a.timestamp < ?');
    params.push(filters.before);
  }
  const sql = `
    SELECT a.id, a.project_id, a.user_id, u.username, a.action, a.sha, a.details, a.timestamp
    FROM audit_log a JOIN users u ON u.id = a.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.timestamp DESC
    LIMIT ?
  `;
  const rows = db.raw.prepare(sql).all(...params, limit + 1) as Array<{
    id: string;
    project_id: string | null;
    user_id: string;
    username: string;
    action: AuditEntry['action'];
    sha: string | null;
    details: string | null;
    timestamp: string;
  }>;
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map((row) => ({
    id: row.id,
    projectId: row.project_id ?? '',
    userId: row.user_id,
    username: row.username,
    action: row.action,
    sha: row.sha ?? undefined,
    details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : undefined,
    timestamp: row.timestamp,
  }));
  return { entries, hasMore };
}
