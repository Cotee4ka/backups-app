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
  return findScriptByName('install.sh', 'BACKUPS_INSTALL_SCRIPT');
}

/** Mode 2 — Prod (read-only mirror через /host:ro). */
export function findInstallScriptV2(): string {
  return findScriptByName('install-v2.sh', 'BACKUPS_INSTALL_SCRIPT_V2');
}

/** Mode 1 — Projects (двухсторонняя git-синхронизация, без host mount). */
export function findInstallScriptProjects(): string {
  return findScriptByName('install-projects.sh', 'BACKUPS_INSTALL_SCRIPT_PROJECTS');
}

function findScriptByName(name: string, envVar: string): string {
  const fromEnv = process.env[envVar];
  // resourcesPath доступен только в Electron runtime
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;

  const candidates = [
    fromEnv,
    resourcesPath ? path.join(resourcesPath, name) : null,
    path.resolve(process.cwd(), `apps/server/scripts/${name}`),
    path.resolve(process.cwd(), `../server/scripts/${name}`),
    path.resolve(__dirname, `../../server/scripts/${name}`),
    path.resolve(__dirname, `../../../server/scripts/${name}`),
    path.resolve(__dirname, `../../apps/server/scripts/${name}`),
    path.resolve(__dirname, `../resources/${name}`),
  ].filter((x): x is string => !!x);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`${name} not found in any of: ${candidates.join(', ')}`);
}

// ============================================================================
//  v2 API — раздельные операции check / apply, со стримом фаз и
//  переиспользуемым SSH-помощником. Используется в ConnectServerWizard и
//  в version-gate (когда хост подтянулся к старой версии).
// ============================================================================

export interface SshAuth {
  host: string;
  port: number;
  username: string;
  /** Один из них должен быть задан. */
  password?: string;
  privateKey?: Buffer | string;
  privateKeyPassphrase?: string;
}

export interface CheckResult {
  installed: boolean;
  scriptVersion: string;
  serverVersion: string;
  imageRef: string;
  imageDigest: string;
  containerRunning: boolean;
  installDir: string;
}

export interface ApplyParams extends SshAuth {
  serverPort: number;
  adminUser?: string;
  publicUrl?: string;
  imageRef?: string;
  /** Целевая версия скрипта/сервера, которую клиент ожидает. */
  targetVersion: string;
  /** Локальный путь к install-v2.sh на машине клиента. */
  installScriptPath: string;
  /** Заливать ли bootstrap-bundle с исходниками (на случай fallback-сборки). */
  uploadSource?: boolean;
}

export interface ApplyResult {
  serverUrl: string;
  fingerprint: string;
  adminUsername: string;
  adminPassword: string;
  port: number;
  scriptVersion: string;
}

export type SshProgressKind = 'phase' | 'stdout' | 'stderr' | 'info';

export interface SshProgress {
  type: SshProgressKind;
  /** Заполнено когда type === 'phase' (например, 'pulling-image'). */
  phase?: string;
  line?: string;
}

const KNOWN_PHASES = [
  'connecting',
  'uploading-script',
  'uploading-source',
  'checking-prereqs',
  'installing-docker',
  'installing-compose',
  'preparing-dir',
  'writing-config',
  'pulling-image',
  'starting-container',
  'waiting-healthy',
  'done',
] as const;

export type InstallPhase = (typeof KNOWN_PHASES)[number];

/**
 * Подключиться к хосту и запустить `install-v2.sh --check`. Не делает
 * никаких изменений. Возвращает разобранный JSON-state.
 */
export function checkRemoteHost(
  params: SshAuth & { installScriptPath: string },
  onProgress: (p: SshProgress) => void,
): Promise<CheckResult> {
  return withSshConnection(params, onProgress, async (conn, helpers) => {
    onProgress({ type: 'phase', phase: 'uploading-script' });
    const remoteScriptPath = await helpers.uploadScript(params.installScriptPath);

    const isRoot = params.username === 'root';
    const cmd = isRoot
      ? `bash ${remoteScriptPath} --check`
      : `sudo -S -p '' bash ${remoteScriptPath} --check`;

    onProgress({ type: 'info', line: `running: ${cmd}` });

    const exec = await helpers.exec(cmd, {
      sudoPassword: isRoot ? undefined : params.password,
    });

    const resultLine = exec.markers['BACKUPS_CHECK_RESULT'];
    if (!resultLine) {
      throw new Error(
        `install-v2.sh --check exited with code ${exec.code} but produced no result`,
      );
    }
    let parsed: CheckResult;
    try {
      parsed = JSON.parse(resultLine) as CheckResult;
    } catch (e) {
      throw new Error(`bad check result JSON: ${resultLine}`);
    }
    // подчищаем temp-скрипт
    helpers.cleanup();
    return parsed;
  });
}

/**
 * Подключиться к хосту и запустить `install-v2.sh --apply`. Стримит фазы
 * через onProgress, возвращает разобранный результат.
 */
export function applyRemoteHost(
  params: ApplyParams,
  onProgress: (p: SshProgress) => void,
): Promise<ApplyResult> {
  return withSshConnection(params, onProgress, async (conn, helpers) => {
    onProgress({ type: 'phase', phase: 'uploading-script' });
    const remoteScriptPath = await helpers.uploadScript(params.installScriptPath);

    let remoteSourceDir = '';
    if (params.uploadSource ?? true) {
      onProgress({ type: 'phase', phase: 'uploading-source' });
      remoteSourceDir = `/tmp/backups-app-source-${Date.now()}`;
      await uploadBootstrapSource(helpers.sftp, remoteSourceDir);
    }

    const args: string[] = [
      '--apply',
      `--port ${params.serverPort}`,
      `--target-version ${shellQuote(params.targetVersion)}`,
    ];
    if (params.adminUser) args.push(`--admin-user ${shellQuote(params.adminUser)}`);
    if (params.publicUrl) args.push(`--public-url ${shellQuote(params.publicUrl)}`);
    if (params.imageRef) args.push(`--image ${shellQuote(params.imageRef)}`);
    if (remoteSourceDir) args.push(`--source-dir ${shellQuote(remoteSourceDir)}`);

    const isRoot = params.username === 'root';
    const cmd = isRoot
      ? `bash ${remoteScriptPath} ${args.join(' ')}`
      : `sudo -S -p '' bash ${remoteScriptPath} ${args.join(' ')}`;

    onProgress({ type: 'info', line: `running: ${cmd}` });

    const exec = await helpers.exec(cmd, {
      sudoPassword: isRoot ? undefined : params.password,
    });

    const resultLine = exec.markers['BACKUPS_INSTALL_RESULT'];
    if (!resultLine) {
      throw new Error(
        `install-v2.sh --apply exited with code ${exec.code} but produced no result`,
      );
    }
    let raw: {
      v: number;
      url: string;
      fp: string;
      u: string;
      pw: string;
      scriptVersion: string;
    };
    try {
      raw = JSON.parse(resultLine);
    } catch (e) {
      throw new Error(`bad apply result JSON: ${resultLine}`);
    }

    helpers.cleanup();

    return {
      serverUrl: raw.url,
      fingerprint: raw.fp,
      adminUsername: raw.u,
      adminPassword: raw.pw,
      port: params.serverPort,
      scriptVersion: raw.scriptVersion,
    };
  });
}

/**
 * Заливает публичный SSH-ключ в `~/.ssh/authorized_keys` юзера.
 * Используется опционально, чтобы будущие auto-update проходили без пароля.
 */
export function installSshPublicKey(
  params: SshAuth,
  publicKey: string,
  onProgress?: (p: SshProgress) => void,
): Promise<void> {
  const progress = onProgress ?? (() => undefined);
  return withSshConnection(params, progress, async (_conn, helpers) => {
    const trimmed = publicKey.trim();
    if (!trimmed.startsWith('ssh-')) {
      throw new Error('Public key must be in OpenSSH format (ssh-rsa / ssh-ed25519 ...)');
    }
    // Используем стандартный паттерн ssh-copy-id'а: создаём ~/.ssh с правами,
    // дописываем ключ только если его там ещё нет.
    const escaped = shellQuote(trimmed);
    const script = [
      'mkdir -p ~/.ssh',
      'chmod 700 ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      'chmod 600 ~/.ssh/authorized_keys',
      `if ! grep -qxF ${escaped} ~/.ssh/authorized_keys; then echo ${escaped} >> ~/.ssh/authorized_keys; fi`,
    ].join(' && ');

    progress({ type: 'info', line: 'installing public key into ~/.ssh/authorized_keys' });
    await helpers.exec(script);
    helpers.cleanup();
  });
}

// ============================================================================
//  Низкоуровневый SSH-помощник: одно соединение, exec со стримом, sftp,
//  парсинг "BACKUPS_PHASE=" / "BACKUPS_*_RESULT=" маркеров.
// ============================================================================

interface ExecOptions {
  sudoPassword?: string;
}
interface ExecOutcome {
  code: number;
  markers: Record<string, string>;
}
interface SshHelpers {
  sftp: import('ssh2').SFTPWrapper;
  uploadScript: (localPath: string) => Promise<string>;
  exec: (cmd: string, opts?: ExecOptions) => Promise<ExecOutcome>;
  cleanup: () => void;
}

function withSshConnection<T>(
  params: SshAuth,
  onProgress: (p: SshProgress) => void,
  body: (conn: SshClient, helpers: SshHelpers) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = new SshClient();
    const tempPaths: string[] = [];
    let settled = false;
    const safeReject = (e: Error) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* noop */
      }
      reject(e);
    };
    const safeResolve = (v: T) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* noop */
      }
      resolve(v);
    };

    onProgress({ type: 'phase', phase: 'connecting' });

    conn.on('error', safeReject);
    conn.on('ready', () => {
      onProgress({ type: 'info', line: 'SSH connected' });
      conn.sftp((err, sftp) => {
        if (err) return safeReject(err);

        const helpers: SshHelpers = {
          sftp,
          uploadScript: async (localPath) => {
            const remotePath = `/tmp/backups-app-install-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}.sh`;
            tempPaths.push(remotePath);
            const body = fs
              .readFileSync(localPath, 'utf8')
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n');
            await new Promise<void>((res, rej) => {
              const ws = sftp.createWriteStream(remotePath, { mode: 0o700 });
              ws.on('error', rej);
              ws.on('close', () => res());
              ws.end(body, 'utf8');
            });
            return remotePath;
          },
          exec: (cmd, opts) =>
            new Promise<ExecOutcome>((res, rej) => {
              conn.exec(cmd, { pty: true }, (err2, stream) => {
                if (err2) return rej(err2);
                if (opts?.sudoPassword) {
                  stream.write(`${opts.sudoPassword}\n`);
                }
                let buffer = '';
                const markers: Record<string, string> = {};

                const handleLine = (raw: string, isStderr: boolean) => {
                  if (raw.length === 0) return;
                  // BACKUPS_PHASE=<phase>
                  if (raw.startsWith('BACKUPS_PHASE=')) {
                    const phase = raw.slice('BACKUPS_PHASE='.length).trim();
                    onProgress({ type: 'phase', phase });
                    return;
                  }
                  // BACKUPS_*_RESULT=<json>  — собираем по ключу.
                  const m = /^(BACKUPS_[A-Z_]+_RESULT)=(.*)$/.exec(raw);
                  if (m && m[1] !== undefined && m[2] !== undefined) {
                    const key = m[1];
                    markers[key] = m[2].trim();
                    onProgress({
                      type: 'info',
                      line: `${key} captured`,
                    });
                    return;
                  }
                  onProgress({ type: isStderr ? 'stderr' : 'stdout', line: raw });
                };

                const ingest = (chunk: Buffer, isStderr: boolean) => {
                  buffer += chunk.toString('utf8');
                  let idx;
                  while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx).replace(/\r$/, '');
                    buffer = buffer.slice(idx + 1);
                    handleLine(line, isStderr);
                  }
                };

                stream.on('data', (d: Buffer) => ingest(d, false));
                stream.stderr.on('data', (d: Buffer) => ingest(d, true));
                stream.on('close', (code: number) => {
                  if (buffer.length > 0) handleLine(buffer.replace(/\r$/, ''), false);
                  res({ code: code ?? 0, markers });
                });
              });
            }),
          cleanup: () => {
            for (const p of tempPaths) {
              conn.exec(`rm -f ${p}`, () => undefined);
            }
          },
        };

        body(conn, helpers).then(safeResolve, safeReject);
      });
    });

    const connectOpts: import('ssh2').ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
    };
    if (params.privateKey) {
      connectOpts.privateKey = params.privateKey;
      connectOpts.passphrase = params.privateKeyPassphrase;
    } else if (params.password) {
      connectOpts.password = params.password;
    } else {
      safeReject(new Error('Either password or privateKey must be provided'));
      return;
    }
    conn.connect(connectOpts);
  });
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
