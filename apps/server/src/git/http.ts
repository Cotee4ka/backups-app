import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { ensureRepo } from './repo.js';
import { getDb } from '../db.js';
import type { AccessTokenPayload } from '../auth.js';
import { broadcastToProject } from '../ws/hub.js';

/**
 * Smart-HTTP git endpoint: GET /git/:projectId/info/refs?service=...
 *                         POST /git/:projectId/git-upload-pack
 *                         POST /git/:projectId/git-receive-pack
 *
 * Авторизация — Bearer JWT в заголовке Authorization. Контроль доступа — по
 * project_members. После успешного push шлём WS-сигнал repo:updated.
 *
 * Использует git binary (`git http-backend`) — это самый надёжный способ
 * хостить git smart-http внутри Node. Контейнер сервера обязан содержать
 * пакет `git`.
 */

export async function gitHttpRoutes(app: FastifyInstance): Promise<void> {
  // ВАЖНО: НЕ буферизируем тело git-запросов в память. Раньше тут стоял
  // `parseAs: 'buffer'`, что упирало большие push'ы в дефолтный bodyLimit
  // Fastify (1 MB) — у юзера 230 MB push получал «Connection reset» прямо
  // на этом месте.
  //
  // Хэндлер делает `req.raw.pipe(child.stdin)` для git http-backend —
  // т.е. обрабатывает stream напрямую без копий. Регистрируем no-op
  // парсеры (Fastify иначе вернёт 415), которые не трогают payload, и
  // тело течёт прямо к git-у.
  const noopParser: import('fastify').FastifyContentTypeParser = (_req, _payload, done) => {
    done(null, undefined);
  };
  app.addContentTypeParser('application/x-git-upload-pack-request', noopParser);
  app.addContentTypeParser('application/x-git-receive-pack-request', noopParser);

  const handler = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    const params = req.params as { projectId: string; '*': string };
    const projectId = params.projectId;
    const subpath = params['*'];

    const auth = req.headers['authorization'];
    let token: string | null = null;
    if (auth?.startsWith('Bearer ')) {
      token = auth.slice('Bearer '.length).trim();
    } else if (auth?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice('Basic '.length).trim(), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep !== -1) {
          token = decoded.slice(sep + 1);
          try {
            token = decodeURIComponent(token);
          } catch {
            /* keep raw */
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!token) {
      reply.header('WWW-Authenticate', 'Basic realm="backups-app"');
      return reply.code(401).send('Unauthorized');
    }

    let user: AccessTokenPayload;
    try {
      user = (await app.jwt.verify(token)) as AccessTokenPayload;
      if (user.type !== 'access') throw new Error('not access');
    } catch {
      reply.header('WWW-Authenticate', 'Basic realm="backups-app"');
      return reply.code(401).send('Invalid token');
    }

    const project = getDb()
      .prepare(`SELECT id, default_branch, external_path FROM projects WHERE id = ?`)
      .get(projectId) as
      | { id: string; default_branch: string; external_path: string | null }
      | undefined;
    if (!project) return reply.code(404).send('Project not found');
    if (project.external_path) {
      return reply.code(400).send('Git access not available for external projects');
    }

    const member = getDb()
      .prepare(
        `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`,
      )
      .get(projectId, user.sub) as { role: string } | undefined;
    if (!member && user.role !== 'owner' && user.role !== 'admin') {
      return reply.code(403).send('Forbidden');
    }

    const isPush =
      subpath === 'git-receive-pack' ||
      (subpath === 'info/refs' &&
        (req.query as { service?: string })?.service === 'git-receive-pack');

    if (isPush) {
      const role = member?.role ?? user.role;
      if (role === 'viewer') return reply.code(403).send('Read-only');
    }

    const repo = await ensureRepo(projectId);
    await runGitHttpBackend(req.raw, reply.raw, repo, subpath, req.query as Record<string, string | undefined>, {
      userId: user.sub,
      username: user.username,
      projectId,
    });
  };

  app.get('/git/:projectId/*', handler);
  app.post('/git/:projectId/*', handler);
}

interface RequestCtx {
  userId: string;
  username: string;
  projectId: string;
}

async function runGitHttpBackend(
  req: IncomingMessage,
  res: ServerResponse,
  repoPath: string,
  subpath: string,
  query: Record<string, string | undefined>,
  ctx: RequestCtx,
): Promise<void> {
  // Снимаем HEAD ДО запуска git-receive-pack, чтобы потом посчитать
  // дельту: какие файлы реально пришли в этом push'е. Используется для
  // audit_log и WS broadcast'а repo:updated (счётчик filesChanged).
  const prevHead =
    subpath === 'git-receive-pack' ? await readHeadSafe(repoPath) : null;
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: path.dirname(repoPath),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${path.basename(repoPath)}/${subpath}`,
      REQUEST_METHOD: req.method ?? 'GET',
      QUERY_STRING: query.service ? `service=${query.service}` : '',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: req.headers['content-length'] ?? '',
      REMOTE_USER: ctx.username,
      REMOTE_ADDR: req.socket.remoteAddress ?? '',
      // Для коммитов через push uploadpack используется уже подписанный коммит
      // от клиента; данные authorId|authorName зашиваются в commit message клиентом.
    };

    const child = spawn('git', ['http-backend'], { env });

    child.on('error', (err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(`git binary not available: ${err.message}`);
      } else {
        res.end();
      }
      resolve();
    });

    let headerBuf = Buffer.alloc(0);
    let headersWritten = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (headersWritten) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf('\r\n\r\n');
      if (sep === -1) return;

      const headPart = headerBuf.slice(0, sep).toString('utf8');
      const body = headerBuf.slice(sep + 4);
      const lines = headPart.split('\r\n');
      let status = 200;
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k.toLowerCase() === 'status') {
          status = parseInt(v, 10) || 200;
        } else {
          res.setHeader(k, v);
        }
      }
      res.statusCode = status;
      headersWritten = true;
      if (body.length) res.write(body);
    });

    child.stderr.on('data', (b: Buffer) => {
      process.stderr.write(b);
    });

    child.on('close', () => {
      if (!headersWritten) {
        res.statusCode = 500;
        res.end('git http-backend produced no output');
      } else {
        res.end();
      }

      // post-receive: если был git-receive-pack успешный — оповещаем подписчиков.
      if (subpath === 'git-receive-pack') {
        // читаем актуальный HEAD (асинхронно, не блокируя ответ)
        readHeadSafe(repoPath).then(async (sha) => {
          if (!sha) return;

          // Считаем список файлов, которые пришли в этом push'е, чтобы
          // дописать в session_files активного lock'а (если есть).
          let pushedFiles: string[] = [];
          if (prevHead && prevHead !== sha) {
            try {
              const { simpleGit } = await import('simple-git');
              const g = simpleGit({ baseDir: repoPath });
              const out = await g.raw([
                'diff',
                '--name-only',
                `${prevHead}..${sha}`,
              ]);
              pushedFiles = out
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
            } catch {
              /* dropped — не блокируем repo:updated из-за этого */
            }
          } else if (!prevHead) {
            // Первый push в пустой репо — берём все файлы свежего HEAD.
            try {
              const { simpleGit } = await import('simple-git');
              const g = simpleGit({ baseDir: repoPath });
              const out = await g.raw(['ls-tree', '-r', '--name-only', sha]);
              pushedFiles = out
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
            } catch {
              /* ignore */
            }
          }

          broadcastToProject(ctx.projectId, {
            type: 'repo:updated',
            projectId: ctx.projectId,
            sha,
            authorId: ctx.userId,
            authorName: ctx.username,
            filesChanged: pushedFiles.length,
            message: '',
            timestamp: Date.now(),
          });
          getDb()
            .prepare(
              `INSERT INTO audit_log (timestamp, user_id, project_id, action, detail)
               VALUES (?, ?, ?, 'push', ?)`,
            )
            .run(
              Date.now(),
              ctx.userId,
              ctx.projectId,
              JSON.stringify({ sha, files: pushedFiles.slice(0, 50) }),
            );
        });
      }
      resolve();
    });

    req.pipe(child.stdin);
  });
}

async function readHeadSafe(repoPath: string): Promise<string | null> {
  try {
    const { simpleGit } = await import('simple-git');
    const g = simpleGit({ baseDir: repoPath });
    return (await g.revparse(['HEAD'])).trim();
  } catch {
    try {
      const head = fs.readFileSync(path.join(repoPath, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) {
        const ref = head.slice(5).trim();
        const refPath = path.join(repoPath, ref);
        return fs.readFileSync(refPath, 'utf8').trim();
      }
      return head;
    } catch {
      return null;
    }
  }
}
