import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      external_path TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      jti TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      expires_at INTEGER NOT NULL,
      used_by TEXT,
      used_at INTEGER,
      project_id TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (used_by) REFERENCES users(id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_invites_project ON invites(project_id);
  `);

  // Дроп старой таблицы локов (была введена в 0.5.0 для координации Claude-агентов,
  // отказались от подхода в 0.6.0 — заменяется на простой last-author lookup).
  db.exec(`DROP TABLE IF EXISTS project_locks;`);

  const projectCols = db
    .prepare(`PRAGMA table_info(projects)`)
    .all() as { name: string }[];
  if (!projectCols.some((c) => c.name === 'external_path')) {
    db.exec(`ALTER TABLE projects ADD COLUMN external_path TEXT`);
  }

  // 0.7.0: invites привязываются к проекту опционально + revoked-флаг.
  // Для существующих БД делаем ALTER, новые БД получают сразу через CREATE выше.
  const inviteCols = db
    .prepare(`PRAGMA table_info(invites)`)
    .all() as { name: string }[];
  if (!inviteCols.some((c) => c.name === 'project_id')) {
    db.exec(`ALTER TABLE invites ADD COLUMN project_id TEXT`);
  }
  if (!inviteCols.some((c) => c.name === 'revoked')) {
    db.exec(`ALTER TABLE invites ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_invites_project ON invites(project_id);`);

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
