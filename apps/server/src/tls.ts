import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { config } from './config.js';

export interface TlsBundle {
  key: Buffer;
  cert: Buffer;
  fingerprint: string;
}

function tryOpenSsl(certsDir: string, host: string): boolean {
  try {
    fs.mkdirSync(certsDir, { recursive: true });
    const keyPath = path.join(certsDir, 'server.key');
    const crtPath = path.join(certsDir, 'server.crt');
    if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) return true;

    const subj = `/CN=${host}`;
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${crtPath}" -days 3650 -nodes -subj "${subj}" -addext "subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1"`,
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

async function nodeSelfSign(certsDir: string, host: string): Promise<void> {
  // Node-only fallback: используется selfsigned если openssl недоступен
  const sf = await import('selfsigned');
  const pems = sf.generate(
    [
      { name: 'commonName', value: host },
    ],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: host },
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    },
  );
  fs.mkdirSync(certsDir, { recursive: true });
  fs.writeFileSync(path.join(certsDir, 'server.key'), pems.private);
  fs.writeFileSync(path.join(certsDir, 'server.crt'), pems.cert);
}

export async function ensureTls(): Promise<TlsBundle> {
  const certsDir = config.certsDir;
  const host = config.publicUrl
    ? new URL(config.publicUrl).hostname
    : config.host;

  if (!tryOpenSsl(certsDir, host)) {
    try {
      await nodeSelfSign(certsDir, host);
    } catch (err) {
      throw new Error(
        `Failed to generate TLS certificate (no openssl, no selfsigned): ${(err as Error).message}`,
      );
    }
  }

  const key = fs.readFileSync(path.join(certsDir, 'server.key'));
  const cert = fs.readFileSync(path.join(certsDir, 'server.crt'));
  const fingerprint = computeFingerprint(cert);
  fs.writeFileSync(path.join(certsDir, 'fingerprint.txt'), fingerprint);
  return { key, cert, fingerprint };
}

export function computeFingerprint(certPem: Buffer): string {
  const der = pemToDer(certPem.toString('utf8'));
  const hash = crypto.createHash('sha256').update(der).digest('hex');
  return hash
    .toUpperCase()
    .match(/.{1,2}/g)!
    .join(':');
}

function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}
