import argon2 from 'argon2';
import { nanoid } from 'nanoid';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { getDb } from './db.js';
import type { UserRole } from '@backups-app/shared';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface AccessTokenPayload {
  sub: string;
  username: string;
  role: UserRole;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function createUser(
  username: string,
  passwordHash: string,
  role: UserRole = 'member',
): AuthUser {
  const db = getDb();
  const id = nanoid();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, username, passwordHash, role, createdAt);
  return { id, username, role };
}

export function getUserByUsername(username: string): (AuthUser & { passwordHash: string }) | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, username, password_hash as passwordHash, role
       FROM users WHERE username = ?`,
    )
    .get(username) as
    | { id: string; username: string; passwordHash: string; role: UserRole }
    | undefined;
  return row ?? null;
}

export function getUserById(id: string): AuthUser | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT id, username, role FROM users WHERE id = ?`)
    .get(id) as { id: string; username: string; role: UserRole } | undefined;
  return row ?? null;
}

export function listUsers(): AuthUser[] {
  const db = getDb();
  return db
    .prepare(`SELECT id, username, role FROM users ORDER BY username`)
    .all() as AuthUser[];
}

export function countUsers(): number {
  const db = getDb();
  const r = db.prepare(`SELECT COUNT(*) as c FROM users`).get() as { c: number };
  return r.c;
}

export async function issueTokens(
  app: FastifyInstance,
  user: AuthUser,
): Promise<{
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const accessExp = now + config.accessTokenTtlSec;
  const refreshExp = now + config.refreshTokenTtlSec;

  const accessToken = await app.jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      type: 'access',
    } satisfies AccessTokenPayload,
    { expiresIn: config.accessTokenTtlSec },
  );

  const jti = nanoid();
  const refreshToken = await app.jwt.sign(
    {
      sub: user.id,
      jti,
      type: 'refresh',
    } satisfies RefreshTokenPayload,
    { expiresIn: config.refreshTokenTtlSec },
  );

  getDb()
    .prepare(
      `INSERT INTO refresh_tokens (jti, user_id, issued_at, expires_at, revoked)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(jti, user.id, now * 1000, refreshExp * 1000);

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: accessExp * 1000,
    refreshExpiresAt: refreshExp * 1000,
  };
}

export function revokeRefresh(jti: string): void {
  getDb().prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?`).run(jti);
}

export function isRefreshValid(jti: string): boolean {
  const row = getDb()
    .prepare(`SELECT revoked, expires_at FROM refresh_tokens WHERE jti = ?`)
    .get(jti) as { revoked: number; expires_at: number } | undefined;
  if (!row) return false;
  if (row.revoked) return false;
  if (row.expires_at < Date.now()) return false;
  return true;
}

export async function authenticate(
  req: FastifyRequest,
): Promise<AuthUser | null> {
  try {
    await req.jwtVerify();
    const payload = req.user as unknown as AccessTokenPayload;
    if (payload.type !== 'access') return null;
    const user = getUserById(payload.sub);
    return user;
  } catch {
    return null;
  }
}

export async function requireAuth(req: FastifyRequest): Promise<AuthUser> {
  const u = await authenticate(req);
  if (!u) {
    const err: Error & { statusCode?: number } = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return u;
}
