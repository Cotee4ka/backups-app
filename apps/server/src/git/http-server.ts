import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AuthService } from '../auth.js';
import type { RepoStore } from './repo.js';
import type { DbContext } from '../db.js';
import { logAudit } from '../audit.js';
import type { ServerHub } from '../ws/hub.js';

/**
 * Minimal git smart-http transport using the system `git http-backend` CGI.
 *
 * Why not `node-git-server`? It is unmaintained and bundles its own auth model.
 * Spawning `git http-backend` (shipped inside the Docker image) is a few lines,
 * has no extra deps and matches git's protocol exactly.
 *
 * Mounted at /git/<projectId>.git/* and authenticated via Bearer JWT.
 *
 * Pre-receive auditing is implemented in two complementary ways:
 *   1) After a successful push (status 200 from the CGI on /git-receive-pack),
 *      we look up the new HEAD sha and write an audit row + broadcast WS event.
 *   2) The CGI itself writes nothing — pre-receive hooks are not used because
 *      bare repos created by us do not have pre-receive scripts. Doing it after
 *      the request is acceptable for v1 and avoids hook installation.
 */
export function registerGitHttpRoutes(opts: {
  app: FastifyInstance;
  repos: RepoStore;
  authService: AuthService;
  db: DbContext;
  hub: ServerHub;
}): void {
  const { app, repos, authService, db, hub } = opts;

  app.all('/git/:projectId\\.git/*', async (request, reply) => {
    await handle(request, reply);
  });
  // Variant where browsers/curl probe info/refs without the trailing path slash.
  app.all('/git/:projectId\\.git', async (request, reply) => {
    await handle(request, reply);
  });

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as { projectId: string; '*'?: string };
    const projectId = params.projectId;
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return reply.code(400).send('Invalid project id');
    }

    // Bearer auth — git supports it via http.extraHeader.
    const auth = request.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      reply.header('WWW-Authenticate', 'Bearer realm="backups-app"');
      return reply.code(401).send('Authentication required');
    }
    const payload = authService.verifyAccessToken(auth.slice(7).trim());
    if (!payload) {
      return reply.code(401).send('Invalid token');
    }

    if (!repos.exists(projectId)) {
      return reply.code(404).send('Repository not found');
    }

    const sub = params['*'] ?? '';
    const isPush = sub === 'git-receive-pack' || request.query && (request.query as Record<string, string>)['service'] === 'git-receive-pack';
    if (isPush && payload.role === 'viewer') {
      return reply.code(403).send('Push not allowed for viewer role');
    }

    const repoPath = repos.pathFor(projectId);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: repos.rootDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: '/' + projectId + '.git/' + sub,
      REQUEST_METHOD: request.method,
      QUERY_STRING: stringifyQuery(request.query),
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      CONTENT_LENGTH: request.headers['content-length'] ?? '',
      REMOTE_USER: payload.username,
      REMOTE_ADDR: request.ip,
      HTTP_GIT_PROTOCOL: (request.headers['git-protocol'] as string | undefined) ?? '',
    };

    if (!existsSync(repoPath)) {
      return reply.code(404).send('Repository missing on disk');
    }

    const child = spawn('git', ['http-backend'], { env });

    return new Promise<void>((resolve, reject) => {
      let headerBuffer = Buffer.alloc(0);
      let headersSent = false;
      let pushSucceeded = false;

      child.stdout.on('data', (chunk: Buffer) => {
        if (!headersSent) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          const sep = headerBuffer.indexOf('\r\n\r\n');
          if (sep === -1) return;
          const headerPart = headerBuffer.subarray(0, sep).toString('utf8');
          const bodyPart = headerBuffer.subarray(sep + 4);
          for (const line of headerPart.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const name = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === 'status') {
              reply.code(parseInt(value, 10));
            } else {
              reply.header(name, value);
            }
          }
          headersSent = true;
          reply.raw.write(bodyPart);
        } else {
          reply.raw.write(chunk);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        request.log.debug({ stderr: chunk.toString('utf8') }, 'git http-backend stderr');
      });

      child.on('close', async (code) => {
        if (!headersSent) {
          reply.code(500).send('git http-backend produced no output');
          return resolve();
        }
        reply.raw.end();
        if (code === 0 && isPush) {
          pushSucceeded = true;
          try {
            const sha = (await repos.headSha(projectId)) ?? undefined;
            const audit = logAudit(db, {
              projectId,
              userId: payload.sub,
              action: 'push',
              sha,
              details: { via: 'git-http' },
            });
            if (sha) {
              hub.broadcastRepoUpdated({
                projectId,
                sha,
                authorId: payload.sub,
                authorName: payload.username,
                changedFiles: 0,
                timestamp: audit.timestamp,
                exceptUserId: payload.sub,
              });
            }
          } catch (err) {
            request.log.warn({ err }, 'failed to log push audit');
          }
        }
        if (!pushSucceeded && isPush && code !== 0) {
          request.log.warn({ code }, 'git push CGI returned non-zero');
        }
        resolve();
      });

      child.on('error', reject);

      // Pipe the request body into the CGI.
      request.raw.pipe(child.stdin);
      request.raw.on('error', (err) => {
        child.kill('SIGTERM');
        reject(err);
      });
    });
  }
}

function stringifyQuery(q: unknown): string {
  if (!q || typeof q !== 'object') return '';
  const entries = Object.entries(q as Record<string, unknown>);
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
