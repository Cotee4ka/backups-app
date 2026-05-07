import crypto from 'node:crypto';
import type { Certificate } from 'electron';
import https from 'node:https';
import tls from 'node:tls';
import type { TLSSocket } from 'node:tls';

export function fingerprintFromCertObject(cert: Certificate): string | null {
  if (cert.fingerprint && cert.fingerprint.startsWith('sha256/')) {
    return normalizeHex(cert.fingerprint.slice('sha256/'.length));
  }
  if (cert.data) {
    try {
      const der = pemToDer(cert.data);
      return formatColons(crypto.createHash('sha256').update(der).digest('hex'));
    } catch {
      return null;
    }
  }
  return null;
}

export function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

export function formatColons(hexNoColons: string): string {
  const upper = hexNoColons.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return upper.match(/.{1,2}/g)?.join(':') ?? upper;
}

function normalizeHex(s: string): string {
  let inner = s;
  if (inner.includes(':')) {
    return inner.toUpperCase();
  }
  // Может быть base64 (sha256/<base64>) либо hex
  try {
    const buf = Buffer.from(inner, 'base64');
    if (buf.length === 32) {
      return formatColons(buf.toString('hex'));
    }
  } catch {
    /* ignore */
  }
  return formatColons(inner);
}

/**
 * Выполняет HTTPS-запрос к серверу, проверяя fingerprint.
 * Используется в IPC для всех взаимодействий клиента с серверным API.
 */
export interface PinnedRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  fingerprint: string;
  timeoutMs?: number;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export function pinnedRequest(opts: PinnedRequestOptions): Promise<PinnedResponse> {
  const u = new URL(opts.url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        rejectUnauthorized: false,
        // Проверка идентичности — в checkServerIdentity:
        checkServerIdentity: (_host, cert) => {
          const der =
            (cert as unknown as { raw?: Buffer }).raw ??
            pemToDer((cert as unknown as { pemEncoded?: string }).pemEncoded ?? '');
          if (!der || der.length === 0) {
            return new Error('No certificate');
          }
          const fp = formatColons(crypto.createHash('sha256').update(der).digest('hex'));
          if (!constantTimeEqual(fp, opts.fingerprint)) {
            return new Error(`TLS fingerprint mismatch: expected ${opts.fingerprint}, got ${fp}`);
          }
          return undefined;
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export interface PinnedStreamResult {
  headers: Record<string, string | string[] | number | undefined> & { status: number };
  stream: NodeJS.ReadableStream;
}

/**
 * То же, что pinnedRequest, но не буферизует тело — возвращает поток.
 * Подходит для скачивания больших/бинарных файлов.
 */
export function pinnedStream(opts: PinnedRequestOptions): Promise<PinnedStreamResult> {
  const u = new URL(opts.url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        rejectUnauthorized: false,
        checkServerIdentity: (_host, cert) => {
          const der =
            (cert as unknown as { raw?: Buffer }).raw ??
            pemToDer((cert as unknown as { pemEncoded?: string }).pemEncoded ?? '');
          if (!der || der.length === 0) {
            return new Error('No certificate');
          }
          const fp = formatColons(crypto.createHash('sha256').update(der).digest('hex'));
          if (!constantTimeEqual(fp, opts.fingerprint)) {
            return new Error(`TLS fingerprint mismatch: expected ${opts.fingerprint}, got ${fp}`);
          }
          return undefined;
        },
      },
      (res) => {
        resolve({
          headers: { status: res.statusCode ?? 0, ...res.headers },
          stream: res,
        });
      },
    );
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = a.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const y = b.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (x.length !== y.length || x.length === 0) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

export function tlsSocketFingerprint(socket: TLSSocket): string | null {
  const cert = socket.getPeerCertificate(true);
  if (!cert?.raw) return null;
  return formatColons(crypto.createHash('sha256').update(cert.raw).digest('hex'));
}

export function fetchServerFingerprint(url: string, timeoutMs = 15_000): Promise<string> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: u.hostname,
      port: Number(u.port || 443),
      servername: u.hostname,
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      socket.destroy(new Error('timeout'));
    }, timeoutMs);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = tlsSocketFingerprint(socket);
      socket.end();
      if (!fp) reject(new Error('Could not read server TLS fingerprint'));
      else resolve(fp);
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
