import { Client as SshClient } from 'ssh2';
import fs from 'node:fs';
import path from 'node:path';

export interface SshInstallParams {
  host: string;
  port: number;
  username: string;
  password: string;
  serverPort: number;
  adminUser: string;
  publicUrl?: string;
  imageRef?: string;
  installScriptPath: string; // путь на диске клиента к install.sh
}

export interface InstallProgress {
  type: 'stdout' | 'stderr' | 'info';
  line: string;
}

export interface InstallResult {
  serverUrl: string;
  fingerprint: string;
  adminUsername: string;
  adminPassword: string;
  port: number;
}

/**
 * Подключается к удалённому серверу по SSH с логином/паролем,
 * загружает install.sh и запускает его. Стримит вывод в onProgress
 * и возвращает распарсенный JSON-результат из последней строки скрипта.
 */
export function runSshInstall(
  params: SshInstallParams,
  onProgress: (p: InstallProgress) => void,
): Promise<InstallResult> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let resolved = false;
    const safeReject = (e: Error) => {
      if (!resolved) {
        resolved = true;
        try {
          conn.end();
        } catch {
          /* noop */
        }
        reject(e);
      }
    };
    const safeResolve = (r: InstallResult) => {
      if (!resolved) {
        resolved = true;
        try {
          conn.end();
        } catch {
          /* noop */
        }
        resolve(r);
      }
    };

    conn.on('ready', () => {
      onProgress({ type: 'info', line: 'SSH connected, uploading installer...' });

      const remotePath = `/tmp/backups-app-install-${Date.now()}.sh`;
      const remoteSourceDir = `/tmp/backups-app-source-${Date.now()}`;
      const scriptBody = fs
        .readFileSync(params.installScriptPath, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

      conn.sftp((err, sftp) => {
        if (err) return safeReject(err);
        onProgress({ type: 'info', line: 'Uploading server source bundle...' });
        uploadBootstrapSource(sftp, remoteSourceDir)
          .then(() => uploadInstallerScript())
          .catch((e) => safeReject(e as Error));

        function uploadInstallerScript() {
        const ws = sftp.createWriteStream(remotePath, { mode: 0o700 });
        ws.on('error', safeReject);
        ws.on('close', () => {
          const args = [
            `--port ${params.serverPort}`,
            `--admin-user ${shellQuote(params.adminUser)}`,
            `--source-dir ${shellQuote(remoteSourceDir)}`,
          ];
          if (params.publicUrl) args.push(`--public-url ${shellQuote(params.publicUrl)}`);
          if (params.imageRef) args.push(`--image ${shellQuote(params.imageRef)}`);

          // Если пользователь не root — используем sudo с stdin паролем.
          const isRoot = params.username === 'root';
          const cmd = isRoot
            ? `bash ${remotePath} ${args.join(' ')}`
            : `sudo -S -p '' bash ${remotePath} ${args.join(' ')}`;

          onProgress({ type: 'info', line: `running: ${cmd}` });

          conn.exec(cmd, { pty: true }, (err2, stream) => {
            if (err2) return safeReject(err2);

            if (!isRoot) {
              // отправим пароль для sudo сразу после подключения
              stream.write(`${params.password}\n`);
            }

            let buffer = '';
            let result: InstallResult | null = null;

            const handleLine = (line: string, stderr: boolean) => {
              if (line.length === 0) return;
              if (line.startsWith('BACKUPS_INSTALL_RESULT=')) {
                const json = line.slice('BACKUPS_INSTALL_RESULT='.length).trim();
                try {
                  result = JSON.parse(json) as InstallResult;
                  onProgress({ type: 'info', line: 'install complete' });
                } catch (e) {
                  onProgress({ type: 'stderr', line: `bad result line: ${json}` });
                }
                return;
              }
              onProgress({ type: stderr ? 'stderr' : 'stdout', line });
            };

            const ingest = (chunk: Buffer, stderr: boolean) => {
              buffer += chunk.toString('utf8');
              let idx;
              while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).replace(/\r$/, '');
                buffer = buffer.slice(idx + 1);
                handleLine(line, stderr);
              }
            };

            stream.on('data', (d: Buffer) => ingest(d, false));
            stream.stderr.on('data', (d: Buffer) => ingest(d, true));

            stream.on('close', (code: number) => {
              if (buffer.length > 0) {
                handleLine(buffer.replace(/\r$/, ''), false);
                buffer = '';
              }
              // подчищаем temp-скрипт
              conn.exec(`rm -f ${remotePath}`, () => undefined);
              if (result) {
                safeResolve(result);
              } else {
                safeReject(new Error(`Installer exited with code ${code} but produced no result`));
              }
            });
          });
        });
        ws.end(scriptBody, 'utf8');
        }
      });
    });

    conn.on('error', safeReject);

    conn.connect({
      host: params.host,
      port: params.port,
      username: params.username,
      password: params.password,
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
    });
  });
}

async function uploadBootstrapSource(
  sftp: import('ssh2').SFTPWrapper,
  remoteRoot: string,
): Promise<void> {
  const localRoot = findBootstrapSourceRoot();

  const filesToUpload = [
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'apps/server/package.json',
    'apps/server/tsconfig.json',
    'apps/server/Dockerfile',
    'apps/server/.dockerignore',
    'apps/server/src/index.ts',
    'apps/server/src/config.ts',
    'apps/server/src/db.ts',
    'apps/server/src/auth.ts',
    'apps/server/src/tls.ts',
    'apps/server/src/audit.ts',
    'apps/server/src/git/http.ts',
    'apps/server/src/git/repo.ts',
    'apps/server/src/routes/auth.ts',
    'apps/server/src/routes/projects.ts',
    'apps/server/src/routes/audit.ts',
    'apps/server/src/routes/invites.ts',
    'apps/server/src/ws/hub.ts',
    'packages/shared/package.json',
    'packages/shared/tsconfig.json',
    ...listSourceFiles(localRoot, 'packages/shared/src'),
  ];

  const dockerfilePath = path.join(localRoot, 'apps/server/Dockerfile');
  if (!fs.existsSync(dockerfilePath)) {
    throw new Error(`bootstrap source is missing Dockerfile: ${dockerfilePath}`);
  }

  await mkdirpSftp(sftp, remoteRoot);
  let uploadedCount = 0;
  for (const rel of filesToUpload) {
    const localPath = path.join(localRoot, rel);
    if (!fs.existsSync(localPath)) {
      throw new Error(`bootstrap source file not found: ${localPath}`);
    }
    const remotePath = toPosix(path.join(remoteRoot, rel));
    await mkdirpSftp(sftp, path.posix.dirname(remotePath));
    await writeFileSftp(sftp, localPath, remotePath);
    uploadedCount += 1;
  }

  if (uploadedCount === 0) {
    throw new Error('no bootstrap source files were uploaded');
  }
}

function listSourceFiles(localRoot: string, relativeDir: string): string[] {
  const dir = path.join(localRoot, relativeDir);
  if (!fs.existsSync(dir)) {
    throw new Error(`bootstrap source directory not found: ${dir}`);
  }

  const result: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        result.push(path.relative(localRoot, fullPath).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir);
  return result;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function mkdirpSftp(
  sftp: import('ssh2').SFTPWrapper,
  remoteDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parts = toPosix(remoteDir).split('/').filter(Boolean);
    let cur = remoteDir.startsWith('/') ? '/' : '';
    const next = (i: number) => {
      if (i >= parts.length) return resolve();
      cur = cur === '/' ? `/${parts[i]}` : `${cur}/${parts[i]}`;
      sftp.mkdir(cur, { mode: 0o755 }, (err) => {
        if (err && !String(err.message).toLowerCase().includes('failure')) {
          // ignore "already exists"
          const msg = String(err.message).toLowerCase();
          if (!msg.includes('exists')) return reject(err);
        }
        next(i + 1);
      });
    };
    next(0);
  });
}

function writeFileSftp(
  sftp: import('ssh2').SFTPWrapper,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(localPath);
    const ws = sftp.createWriteStream(remotePath, { mode: 0o644 });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('close', () => resolve());
    rs.pipe(ws);
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function findInstallScript(): string {
  const fromEnv = process.env.BACKUPS_INSTALL_SCRIPT;
  // resourcesPath доступен только в Electron runtime
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;

  const candidates = [
    fromEnv,
    resourcesPath ? path.join(resourcesPath, 'install.sh') : null,
    path.resolve(process.cwd(), 'apps/server/scripts/install.sh'),
    path.resolve(process.cwd(), '../server/scripts/install.sh'),
    path.resolve(__dirname, '../../server/scripts/install.sh'),
    path.resolve(__dirname, '../../../server/scripts/install.sh'),
    path.resolve(__dirname, '../../apps/server/scripts/install.sh'),
    path.resolve(__dirname, '../resources/install.sh'),
  ].filter((x): x is string => !!x);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`install.sh not found in any of: ${candidates.join(', ')}`);
}

function findBootstrapSourceRoot(): string {
  const fromEnv = process.env.BACKUPS_SERVER_SOURCE_ROOT;
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    fromEnv,
    resourcesPath ? path.join(resourcesPath, 'server-source') : null,
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), '..', '..'),
    path.resolve(__dirname, '../../..'),
  ].filter((x): x is string => !!x);

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'apps/server/Dockerfile'))) {
      return c;
    }
  }
  throw new Error(`server bootstrap source not found in any of: ${candidates.join(', ')}`);
}
