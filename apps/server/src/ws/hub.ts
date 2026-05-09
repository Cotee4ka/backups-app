import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { FastifyInstance } from 'fastify';
import type {
  ClientMessage,
  ServerMessage,
  RepoUpdatedMessage,
  ProjectRestoredMessage,
  ProjectDeletedMessage,
  LockAcquiredMessage,
  LockHeartbeatMessage,
  LockReleasedMessage,
} from '@backups-app/shared';
import { WS_PATH } from '@backups-app/shared';
import type { AccessTokenPayload } from '../auth.js';
import { getDb } from '../db.js';

interface Client {
  ws: WebSocket;
  userId: string;
  username: string;
  projects: Set<string>;
}

const clients = new Set<Client>();
const projectIndex = new Map<string, Set<Client>>();

let wss: WebSocketServer | null = null;

export function broadcastToProject(
  projectId: string,
  msg:
    | RepoUpdatedMessage
    | ProjectRestoredMessage
    | ProjectDeletedMessage
    | LockAcquiredMessage
    | LockHeartbeatMessage
    | LockReleasedMessage,
  exceptUserId?: string,
): void {
  const subs = projectIndex.get(projectId);
  if (!subs) return;
  const data = JSON.stringify(msg);
  for (const c of subs) {
    if (exceptUserId && c.userId === exceptUserId) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function attachClient(client: Client, projectId: string): void {
  client.projects.add(projectId);
  let s = projectIndex.get(projectId);
  if (!s) {
    s = new Set();
    projectIndex.set(projectId, s);
  }
  s.add(client);

  for (const other of s) {
    if (other === client) continue;
    send(other.ws, {
      type: 'presence:join',
      projectId,
      userId: client.userId,
      username: client.username,
    });
  }
  send(client.ws, {
    type: 'presence:list',
    projectId,
    users: Array.from(s).map((c) => ({ userId: c.userId, username: c.username })),
  });
}

function detachClient(client: Client, projectId: string): void {
  client.projects.delete(projectId);
  const s = projectIndex.get(projectId);
  if (!s) return;
  s.delete(client);
  if (s.size === 0) projectIndex.delete(projectId);
  for (const other of s) {
    send(other.ws, {
      type: 'presence:leave',
      projectId,
      userId: client.userId,
    });
  }
}

function isMember(projectId: string, userId: string, role: string): boolean {
  if (role === 'owner' || role === 'admin') return true;
  const r = getDb()
    .prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
    .get(projectId, userId);
  return !!r;
}

export function setupWebSocket(
  app: FastifyInstance,
  server: HttpServer | HttpsServer,
): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith(WS_PATH)) {
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    let client: Client | null = null;
    let authTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!client) {
        send(ws, { type: 'auth:error', reason: 'auth timeout' });
        ws.close();
      }
    }, 10_000);

    ws.on('message', async (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', code: 'BAD_JSON', message: 'Invalid JSON' });
        return;
      }

      if (msg.type === 'auth') {
        try {
          const decoded = (await app.jwt.verify(msg.accessToken)) as AccessTokenPayload;
          if (decoded.type !== 'access') throw new Error('not access');
          client = {
            ws,
            userId: decoded.sub,
            username: decoded.username,
            projects: new Set(),
          };
          clients.add(client);
          if (authTimer) {
            clearTimeout(authTimer);
            authTimer = null;
          }
          send(ws, { type: 'auth:ok', userId: decoded.sub });
        } catch {
          send(ws, { type: 'auth:error', reason: 'invalid token' });
          ws.close();
        }
        return;
      }

      if (!client) {
        send(ws, { type: 'auth:error', reason: 'auth required' });
        return;
      }

      switch (msg.type) {
        case 'project:subscribe': {
          const role = getUserRole(client.userId) ?? 'member';
          if (!isMember(msg.projectId, client.userId, role)) {
            send(ws, { type: 'error', code: 'FORBIDDEN', message: 'No access' });
            return;
          }
          attachClient(client, msg.projectId);
          break;
        }
        case 'project:unsubscribe': {
          detachClient(client, msg.projectId);
          break;
        }
        case 'repo:pushed': {
          // клиент сообщает о push (как fallback); сервер всё равно сам узнает из http-backend
          break;
        }
        case 'presence:ping': {
          send(ws, { type: 'auth:ok', userId: client.userId });
          break;
        }
        default:
          send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: 'Unknown message' });
      }
    });

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      if (!client) return;
      for (const pid of [...client.projects]) detachClient(client, pid);
      clients.delete(client);
    });
  });
}

function getUserRole(userId: string): string | null {
  const u = getDb()
    .prepare(`SELECT role FROM users WHERE id = ?`)
    .get(userId) as { role: string } | undefined;
  return u ? u.role : null;
}
