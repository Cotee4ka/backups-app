import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { UserRole } from '@backups-app/shared';
import type { AuthService } from '../auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; username: string; role: UserRole };
  }
}

/**
 * Adds `request.auth` for authenticated routes.
 *
 * Routes that require auth should call `fastify.authenticate` as a preHandler.
 */
export function registerAuthPlugin(app: FastifyInstance, authService: AuthService): void {
  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers.authorization;
      if (!header || !header.toLowerCase().startsWith('bearer ')) {
        await reply.code(401).send({
          error: { code: 'auth/missing-token', message: 'Authorization header required' },
        });
        return;
      }
      const token = header.slice(7).trim();
      const payload = authService.verifyAccessToken(token);
      if (!payload) {
        await reply.code(401).send({
          error: { code: 'auth/invalid-token', message: 'Invalid or expired token' },
        });
        return;
      }
      request.auth = {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
      };
    },
  );

  app.decorate(
    'requireRole',
    function requireRole(...roles: UserRole[]) {
      return async function (request: FastifyRequest, reply: FastifyReply) {
        if (!request.auth) {
          await reply.code(401).send({
            error: { code: 'auth/missing-token', message: 'Authentication required' },
          });
          return;
        }
        if (!roles.includes(request.auth.role)) {
          await reply.code(403).send({
            error: { code: 'auth/forbidden', message: 'Insufficient role' },
          });
        }
      };
    },
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
