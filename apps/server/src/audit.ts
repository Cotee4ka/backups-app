import type { AuditEntry } from '@backups-app/shared';
import type Database from 'better-sqlite3';

export interface LogAuditInput {
  projectId: string | null;
  userId: string;
  action: AuditEntry['action'];
  sha?: string;
  details?: Record<string, unknown>;
}

export function logAudit(db: Database.Database, input: LogAuditInput): AuditEntry {
  const timestamp = Date.now();
  const detail = input.details ?? {};
  if (input.sha) detail.sha = input.sha;
  const result = db
    .prepare(
      `INSERT INTO audit_log (timestamp, user_id, project_id, action, detail)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(timestamp, input.userId, input.projectId, input.action, JSON.stringify(detail));

  // Hydrate username for return.
  const row = db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .get(input.userId) as { username: string } | undefined;

  return {
    id: Number(result.lastInsertRowid),
    projectId: input.projectId ?? '',
    userId: input.userId,
    username: row?.username ?? 'unknown',
    action: input.action,
    detail,
    timestamp,
  };
}

export interface ListAuditFilters {
  projectId?: string;
  userId?: string;
  limit?: number;
  before?: string;
}

export function listAudit(db: Database.Database, filters: ListAuditFilters): {
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
    SELECT a.id, a.project_id, a.user_id, u.username, a.action, a.detail, a.timestamp
    FROM audit_log a JOIN users u ON u.id = a.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.timestamp DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit + 1) as Array<{
    id: number;
    project_id: string | null;
    user_id: string;
    username: string;
    action: AuditEntry['action'];
    detail: string | null;
    timestamp: number;
  }>;
  const hasMore = rows.length > limit;
  const entries: AuditEntry[] = rows.slice(0, limit).map((row) => ({
    id: row.id,
    projectId: row.project_id ?? '',
    userId: row.user_id,
    username: row.username,
    action: row.action,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {},
    timestamp: row.timestamp,
  }));
  return { entries, hasMore };
}
