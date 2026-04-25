import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  countUsers,
  createUser,
  getUserByUsername,
  hashPassword,
  isRefreshValid,
  issueTokens,
  requireAuth,
  revokeRefresh,
  verifyPassword,
} from '../auth.js';
import { getDb } from '../db.js';
import type { RefreshTokenPayload } from '../auth.js';

const registerSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(256),
  inviteCode: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    handler: async (req, reply) => {
      const body = registerSchema.parse(req.body);

      if (getUserByUsername(body.username)) {
        return reply.code(409).send({ error: 'Username already taken' });
      }

      const isFirstUser = countUsers() === 0;
      let role: 'owner' | 'admin' | 'member' = 'member';

      if (isFirstUser) {
        role = 'owner';
      } else {
        if (!body.inviteCode) {
          return reply.code(403).send({ error: 'Invite code required' });
        }
        const invite = getDb()
          .prepare(
            `SELECT code, role, expires_at, used_by FROM invites WHERE code = ?`,
          )
          .get(body.inviteCode) as
          | { code: string; role: 'admin' | 'member' | 'viewer'; expires_at: number; used_by: string | null }
          | undefined;

        if (!invite || invite.used_by || invite.expires_at < Date.now()) {
          return reply.code(403).send({ error: 'Invalid or expired invite code' });
        }
        role = invite.role === 'viewer' ? 'member' : invite.role;
      }

      const hash = await hashPassword(body.password);
      const user = createUser(body.username, hash, role);

      if (!isFirstUser) {
        getDb()
          .prepare(`UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?`)
          .run(user.id, Date.now(), body.inviteCode!);
      }

      const tokens = await issueTokens(app, user);
      return reply.send({
        user: { id: user.id, username: user.username, role: user.role, createdAt: Date.now() },
        tokens,
      });
    },
  });

  app.post('/auth/login', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    handler: async (req, reply) => {
      const body = loginSchema.parse(req.body);
      const u = getUserByUsername(body.username);
      if (!u) return reply.code(401).send({ error: 'Invalid credentials' });

      const ok = await verifyPassword(u.passwordHash, body.password);
      if (!ok) return reply.code(401).send({ error: 'Invalid credentials' });

      const tokens = await issueTokens(app, {
        id: u.id,
        username: u.username,
        role: u.role,
      });
      return reply.send({
        user: { id: u.id, username: u.username, role: u.role, createdAt: Date.now() },
        tokens,
      });
    },
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    try {
      const decoded = (await app.jwt.verify(body.refreshToken)) as RefreshTokenPayload;
      if (decoded.type !== 'refresh') {
        return reply.code(401).send({ error: 'Invalid token type' });
      }
      if (!isRefreshValid(decoded.jti)) {
        return reply.code(401).send({ error: 'Refresh token revoked' });
      }
      revokeRefresh(decoded.jti);

      const userRow = getDb()
        .prepare(`SELECT id, username, role FROM users WHERE id = ?`)
        .get(decoded.sub) as { id: string; username: string; role: 'owner' | 'admin' | 'member' } | undefined;

      if (!userRow) return reply.code(401).send({ error: 'User not found' });

      const tokens = await issueTokens(app, userRow);
      return reply.send({ tokens });
    } catch {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const body = z.object({ refreshToken: z.string() }).parse(req.body);
    try {
      const decoded = (await app.jwt.verify(body.refreshToken)) as RefreshTokenPayload;
      revokeRefresh(decoded.jti);
    } catch {
      // ignore
    }
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (req, reply) => {
    const me = await requireAuth(req);
    return reply.send({ user: me });
  });
}
