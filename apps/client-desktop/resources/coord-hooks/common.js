/* eslint-disable no-console */
// Shared utilities for Backups App Claude Code hooks (PreToolUse, Stop).
// Pure Node, нет внешних зависимостей — запускается каждый раз заново.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

/** Читает stdin payload (JSON), безопасно. */
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
    // Если stdin пустой/закрыт — резолвим быстро.
    setTimeout(() => resolve({}), 200);
  });
}

/**
 * Поднимается вверх от cwd, ищет .claude/backups-app.local.json — это
 * наш машинно-зависимый файл-маркер, который Electron-app кладёт в корень
 * каждого синкаемого проекта. Содержит serverId, projectId, projectName.
 *
 * НЕ путать с .backupsapp.json (юзерский конфиг с ignore-паттернами).
 */
function findProjectConfig(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const cfg = path.join(dir, '.claude', 'backups-app.local.json');
    if (fs.existsSync(cfg)) {
      try {
        const raw = fs.readFileSync(cfg, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...parsed, projectDir: dir };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Читает ~/.backups-app/credentials.json, возвращает запись для serverId. */
function readServerCreds(serverId) {
  try {
    const file = path.join(os.homedir(), '.backups-app', 'credentials.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.servers)) return null;
    return data.servers.find((s) => s.id === serverId) || null;
  } catch {
    return null;
  }
}

/**
 * HTTPS-запрос с TLS-pinning по SHA-256 fingerprint'у. Самоподписные серты
 * нашего сервера не верифицируются стандартным CA, поэтому проверяем по
 * fingerprint'у — как делает основное приложение.
 */
function apiRequest(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, server.url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.accessToken}`,
      },
      // Принимаем самоподписной серт, но проверим fingerprint руками ниже.
      rejectUnauthorized: false,
    };
    const req = lib.request(options, (res) => {
      // TLS-pinning
      if (isHttps && server.fingerprint) {
        const sock = res.socket;
        const cert = sock && sock.getPeerCertificate
          ? sock.getPeerCertificate(false)
          : null;
        if (cert && cert.raw) {
          const actual = crypto
            .createHash('sha256')
            .update(cert.raw)
            .digest('hex')
            .toUpperCase()
            .match(/.{2}/g)
            .join(':');
          const expected = server.fingerprint.toUpperCase();
          if (actual !== expected) {
            req.destroy();
            return reject(
              new Error(`TLS fingerprint mismatch: expected ${expected}, got ${actual}`),
            );
          }
        }
      }
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = chunks ? JSON.parse(chunks) : null;
        } catch {
          /* keep parsed=null */
        }
        resolve({ status: res.statusCode || 0, body: parsed, raw: chunks });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

module.exports = {
  readStdin,
  findProjectConfig,
  readServerCreds,
  apiRequest,
};
