import { WebSocket } from 'ws';
import https from 'node:https';
import crypto from 'node:crypto';
import { pemToDer, formatColons } from './tls-pin';
import { getServerStore } from './store';
import type { ServerMessage } from '@backups-app/shared';

interface Conn {
  ws: WebSocket;
  serverId: string;
  subs: Set<string>;
  reconnectTimer: NodeJS.Timeout | null;
  alive: boolean;
}

const conns = new Map<string, Conn>();
let onEventCb: ((event: string, payload: unknown) => void) | null = null;
let syncEnginePromise: Promise<typeof import('./sync-engine')> | null = null;

function getSyncEngine() {
  if (!syncEnginePromise) {
    syncEnginePromise = import('./sync-engine');
  }
  return syncEnginePromise;
}

export function setEventCallback(cb: (event: string, payload: unknown) => void): void {
  onEventCb = cb;
}

export function ensureConnection(serverId: string): void {
  if (conns.has(serverId)) return;
  connect(serverId);
}

function connect(serverId: string): void {
  const server = getServerStore().getServer(serverId);
  if (!server) return;

  const wsUrl = server.url.replace(/^http/, 'ws') + '/ws';

  const ws = new WebSocket(wsUrl, {
    rejectUnauthorized: false,
    agent: new https.Agent({
      rejectUnauthorized: false,
      checkServerIdentity: (_h, cert) => {
        const der =
          (cert as unknown as { raw?: Buffer }).raw ??
          pemToDer((cert as unknown as { pemEncoded?: string }).pemEncoded ?? '');
        if (!der || !der.length) return new Error('no cert');
        const fp = formatColons(crypto.createHash('sha256').update(der).digest('hex'));
        const expected = server.fingerprint;
        if (!constantTimeEqual(fp, expected)) {
          return new Error(`TLS fingerprint mismatch: expected ${expected}, got ${fp}`);
        }
        return undefined;
      },
    }),
  });

  const conn: Conn = {
    ws,
    serverId,
    subs: new Set(),
    reconnectTimer: null,
    alive: true,
  };
  conns.set(serverId, conn);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', accessToken: server.accessToken }));
    // re-subscribe to known synced projects
    const stored = getServerStore().getServer(serverId);
    if (stored) {
      for (const f of stored.syncedFolders) {
        if (f.enabled) {
          conn.subs.add(f.projectId);
          ws.send(JSON.stringify({ type: 'project:subscribe', projectId: f.projectId }));
        }
      }
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      handleMessage(serverId, msg);
    } catch (e) {
      console.error('ws bad message:', e);
    }
  });

  ws.on('close', () => {
    conns.delete(serverId);
    conn.reconnectTimer = setTimeout(() => connect(serverId), 5_000);
  });

  ws.on('error', (e) => {
    console.error('[ws]', serverId, e.message);
  });
}

function handleMessage(serverId: string, msg: ServerMessage): void {
  switch (msg.type) {
    case 'auth:ok':
      // ok
      break;
    case 'auth:error':
      console.warn('[ws] auth error:', msg.reason);
      break;
    case 'repo:updated':
      void getSyncEngine()
        .then((sync) => sync.applyRemoteUpdate(serverId, msg.projectId))
        .catch((e) => console.error('apply remote update error:', e));
      onEventCb?.('repo:updated', { serverId, ...msg });
      break;
    case 'project:restored':
      void getSyncEngine()
        .then((sync) => sync.applyRemoteUpdate(serverId, msg.projectId))
        .catch((e) => console.error('apply restore error:', e));
      onEventCb?.('project:restored', { serverId, ...msg });
      break;
    case 'project:deleted':
      onEventCb?.('project:deleted', { serverId, ...msg });
      break;
    case 'presence:join':
    case 'presence:leave':
    case 'presence:list':
      onEventCb?.(msg.type, { serverId, ...msg });
      break;
    case 'error':
      console.warn('[ws] error message:', msg);
      break;
    default:
      break;
  }
}

export function subscribeProject(serverId: string, projectId: string): void {
  const conn = conns.get(serverId);
  if (!conn) {
    ensureConnection(serverId);
    setTimeout(() => subscribeProject(serverId, projectId), 500);
    return;
  }
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.subs.add(projectId);
    conn.ws.send(JSON.stringify({ type: 'project:subscribe', projectId }));
  }
}

export function unsubscribeProject(serverId: string, projectId: string): void {
  const conn = conns.get(serverId);
  if (!conn) return;
  conn.subs.delete(projectId);
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify({ type: 'project:unsubscribe', projectId }));
  }
}

export function disconnectAll(): void {
  for (const c of conns.values()) {
    if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
    try {
      c.ws.close();
    } catch {
      /* noop */
    }
  }
  conns.clear();
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = a.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const y = b.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (x.length !== y.length || x.length === 0) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}
