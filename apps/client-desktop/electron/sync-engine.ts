import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  HARD_IGNORE_PATTERNS,
  PROJECT_CONFIG_FILENAME,
  SYNC_DEBOUNCE_MS,
  SYNC_PERIODIC_FLUSH_MS,
  buildGitignore,
} from '@backups-app/shared';
import { getServerStore } from './store';
import { ApiClient } from './api-client';
import {
  installForProject as installCoordHooks,
  uninstallForProject as uninstallCoordHooks,
  findHookScriptPaths,
} from './coord-installer';

/**
 * Sync engine — chokidar watcher + батчевые git push.
 *
 * КЛЮЧЕВОЕ:
 *  - Жёсткий ignore-лист (HARD_IGNORE_PATTERNS) применяется ВСЕГДА.
 *  - WebSocket НЕ передаёт содержимое файлов, только сигнал repo:updated после push.
 *  - Коммит = batch dirty-файлов, отправляется по idle-debounce / таймеру / явной кнопке.
 *  - Git push через https с использованием URL вида
 *    https://x-token:<JWT>@host:port/git/<projectId>.git
 *    + GIT_SSL_NO_VERIFY=true (т.к. self-signed) — небезопасно вообще, но
 *    по факту мы зависим от TLS pinning ниже: ставим GIT_SSL_CAINFO на путь
 *    к нашему сертификату или (proxy-вариант) проксируем git через
 *    локальный TLS-tunnel. Для v1: используем GIT_SSL_NO_VERIFY=true и
 *    ВЕРИФИЦИРУЕМ fingerprint один раз через pinned API health-check
 *    перед каждым push.
 */

export type SyncState = 'idle' | 'dirty' | 'pushing' | 'pulling' | 'error';

export type UploadPhase =
  | 'preparing'
  | 'cloning'
  | 'init'
  | 'scanning'
  | 'staging'
  | 'committing'
  | 'pushing'
  | 'done';

export interface UploadProgress {
  phase: UploadPhase;
  files?: number;
  totalBytes?: number;
  startedAt: number;
  etaSec?: number;
}

export interface SyncStatusUpdate {
  serverId: string;
  projectId: string;
  state: SyncState;
  detail?: string;
  dirtyFiles?: number;
  upload?: UploadProgress;
}

interface ProjectSync {
  serverId: string;
  projectId: string;
  projectName: string;
  localPath: string;
  watcher: FSWatcher | null;
  dirty: Set<string>;
  ignored: Set<string>;
  state: SyncState;
  debounceTimer: NodeJS.Timeout | null;
  periodicTimer: NodeJS.Timeout | null;
  isPushing: boolean;
  pendingPush: boolean;
  customIgnore: string[];
  applyingPull: boolean;
  upload: UploadProgress | null;
}

const active = new Map<string, ProjectSync>();
let onStatusCb: ((s: SyncStatusUpdate) => void) | null = null;

function key(serverId: string, projectId: string): string {
  return `${serverId}::${projectId}`;
}

export function setStatusCallback(cb: (s: SyncStatusUpdate) => void): void {
  onStatusCb = cb;
}

function emit(s: ProjectSync, override?: Partial<SyncStatusUpdate>): void {
  onStatusCb?.({
    serverId: s.serverId,
    projectId: s.projectId,
    state: s.state,
    dirtyFiles: s.dirty.size,
    upload: s.upload ?? undefined,
    ...override,
  });
}

function setUpload(s: ProjectSync, patch: Partial<UploadProgress>): void {
  if (!s.upload) {
    s.upload = { phase: 'preparing', startedAt: Date.now(), ...patch };
  } else {
    s.upload = { ...s.upload, ...patch };
  }
  if (s.upload.totalBytes && s.upload.totalBytes > 0) {
    const elapsed = (Date.now() - s.upload.startedAt) / 1000;
    const phase = s.upload.phase;
    // Очень грубая оценка: считаем средние ~3 МБ/с при пуше + 1 сек на init/scanning.
    const mb = s.upload.totalBytes / (1024 * 1024);
    let remainingSec = 0;
    if (phase === 'preparing' || phase === 'cloning' || phase === 'init') {
      remainingSec = mb / 3 + 5;
    } else if (phase === 'scanning' || phase === 'staging' || phase === 'committing') {
      remainingSec = mb / 4 + 2;
    } else if (phase === 'pushing') {
      remainingSec = Math.max(1, mb / 3 - elapsed);
    }
    s.upload.etaSec = Math.max(0, Math.round(remainingSec));
  }
}

function gitOriginUrl(serverUrl: string, projectId: string, jwt: string): string {
  const u = new URL(serverUrl);
  u.username = 'x-token';
  u.password = encodeURIComponent(jwt);
  u.pathname = `/git/${projectId}`;
  return u.toString();
}

async function freshJwt(serverId: string): Promise<string> {
  return new ApiClient(serverId).getFreshAccessToken();
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSL_NO_VERIFY: 'true', // fingerprint pinning делается отдельно через pinnedRequest
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Backups User',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'user@backups-app.local',
    GIT_COMMITTER_NAME: process.env.GIT_AUTHOR_NAME ?? 'Backups User',
    GIT_COMMITTER_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'user@backups-app.local',
  };
}

function gitFor(local: string): SimpleGit {
  // simple-git .env accepts an env object (Record-like). Filter undefineds.
  const env = gitEnv();
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') cleanEnv[k] = v;
  }
  return simpleGit({ baseDir: local }).env(cleanEnv);
}

async function readProjectConfig(localPath: string): Promise<{ ignore?: string[] }> {
  const p = path.join(localPath, PROJECT_CONFIG_FILENAME);
  try {
    const j = JSON.parse(await fs.promises.readFile(p, 'utf8')) as { ignore?: string[] };
    return j;
  } catch {
    return {};
  }
}

export type SyncMode = 'auto' | 'download' | 'upload';

export async function cloneProject(params: {
  serverId: string;
  projectId: string;
  projectName: string;
  localPath: string;
  mode?: SyncMode;
}): Promise<void> {
  const mode: SyncMode = params.mode ?? 'auto';
  const server = getServerStore().getServer(params.serverId);
  if (!server) throw new Error('server not found');

  await fs.promises.mkdir(params.localPath, { recursive: true });

  const dirEntries = await fs.promises.readdir(params.localPath);
  const isEmpty = dirEntries.length === 0;
  const isAlreadyRepo = dirEntries.includes('.git');

  const jwt = await freshJwt(params.serverId);
  const url = gitOriginUrl(server.url, params.projectId, jwt);

  if (mode === 'download' && !isEmpty && !isAlreadyRepo) {
    throw new Error(
      'Целевая папка не пустая. Для загрузки с сервера выберите пустую папку (или нажмите «Загрузить на сервер», чтобы залить содержимое локальной папки).',
    );
  }

  if (isAlreadyRepo) {
    const g = gitFor(params.localPath);
    await g.remote(['set-url', 'origin', url]);
    try {
      await g.fetch('origin');
      await g.pull('origin', 'main', ['--ff-only']);
    } catch {
      /* первый клон может быть пустой — ок */
    }
    return;
  }

  if (mode === 'upload' || (mode === 'auto' && !isEmpty)) {
    const g = gitFor(params.localPath);
    await g.init(['-b', 'main']);
    await g.addRemote('origin', url);
    await ensureGitignore(params.localPath);
    if (mode === 'auto') {
      try {
        await g.fetch('origin');
        const branches = await g.branch(['-r']);
        if (Object.keys(branches.branches).length > 0) {
          await g.raw(['reset', '--soft', 'FETCH_HEAD']);
        }
      } catch {
        /* ok: пустой удалённый репо */
      }
    }
    return;
  }

  // Пустая папка — клонируем с сервера
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', url, '.'], {
      cwd: params.localPath,
      env: gitEnv(),
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git clone failed (code ${code}): ${stderr.trim()}`)),
    );
  });
}

export async function startSync(params: {
  serverId: string;
  projectId: string;
  projectName: string;
  localPath: string;
  mode?: SyncMode;
}): Promise<void> {
  const k = key(params.serverId, params.projectId);
  if (active.has(k)) return;

  // Регистрируем "сырой" объект ДО cloneProject, чтобы можно было
  // эмитить статус загрузки во время инициализации.
  const ps: ProjectSync = {
    serverId: params.serverId,
    projectId: params.projectId,
    projectName: params.projectName,
    localPath: params.localPath,
    watcher: null,
    dirty: new Set(),
    ignored: new Set(),
    state: 'idle',
    debounceTimer: null,
    periodicTimer: null,
    isPushing: false,
    pendingPush: false,
    customIgnore: [],
    applyingPull: false,
    upload: null,
  };

  if (params.mode === 'upload') {
    ps.upload = { phase: 'preparing', startedAt: Date.now() };
    ps.state = 'pushing';
    emit(ps, { detail: 'подготовка...' });
  } else if (params.mode === 'download') {
    ps.upload = { phase: 'cloning', startedAt: Date.now() };
    ps.state = 'pulling';
    emit(ps, { detail: 'скачивание с сервера...' });
  }
  active.set(k, ps);

  try {
    await cloneProject(params);
  } catch (e) {
    active.delete(k);
    ps.state = 'error';
    ps.upload = null;
    emit(ps, { detail: (e as Error).message });
    throw e;
  }

  const cfg = await readProjectConfig(params.localPath);
  ps.customIgnore = cfg.ignore ?? [];

  // Координация Claude-агентов: ставим .claude/settings.local.json с PreToolUse
  // и Stop хуками + блок в CLAUDE.md. Per-project, никаких глобальных правок.
  // Best-effort — провал установки не должен ломать sync.
  try {
    const hooks = findHookScriptPaths();
    if (hooks) {
      installCoordHooks({
        projectDir: params.localPath,
        serverId: params.serverId,
        projectId: params.projectId,
        projectName: params.projectName,
        hookCheckPath: hooks.check,
        hookReleasePath: hooks.release,
      });
    } else {
      console.warn('[sync] coord hook scripts not found, skipping installation');
    }
  } catch (e) {
    console.warn('[sync] coord install failed:', e);
  }

  const ignored = [...HARD_IGNORE_PATTERNS, ...ps.customIgnore];

  const watcher = chokidar.watch(params.localPath, {
    ignored,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    followSymlinks: false,
  });

  const onChange = (file: string) => {
    if (ps.applyingPull) return;
    ps.dirty.add(path.relative(params.localPath, file).replace(/\\/g, '/'));
    ps.state = 'dirty';
    emit(ps);
    scheduleFlush(ps);
  };

  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', onChange);
  watcher.on('addDir', () => undefined);
  watcher.on('unlinkDir', onChange);

  ps.watcher = watcher;

  ps.periodicTimer = setInterval(() => {
    if (ps.dirty.size > 0) flush(ps).catch((e) => console.error('periodic flush error:', e));
  }, getServerStore().getSettings().syncPeriodicMs ?? SYNC_PERIODIC_FLUSH_MS);

  // Сохраняем в store
  getServerStore().setSyncedFolder(params.serverId, {
    projectId: params.projectId,
    projectName: params.projectName,
    localPath: params.localPath,
    enabled: true,
    addedAt: Date.now(),
  });

  if (params.mode === 'upload') {
    try {
      setUpload(ps, { phase: 'scanning' });
      emit(ps, { detail: 'сканирование файлов...' });
      const { files, totalBytes } = await listAllFilesWithSize(params.localPath);
      for (const rel of files) ps.dirty.add(rel);
      setUpload(ps, { phase: 'staging', files: files.length, totalBytes });
      ps.state = 'dirty';
      emit(ps, {
        detail: `${files.length} файлов · ${formatBytes(totalBytes)} · подготовка к загрузке`,
      });
      if (ps.dirty.size > 0) {
        await flush(ps);
      }
      setUpload(ps, { phase: 'done' });
      emit(ps, { detail: 'загрузка завершена' });
      ps.upload = null;
    } catch (e) {
      ps.state = 'error';
      emit(ps, { detail: `initial upload failed: ${(e as Error).message}` });
      ps.upload = null;
    }
  } else if (params.mode === 'download') {
    setUpload(ps, { phase: 'done' });
    emit(ps, { detail: 'скачано с сервера' });
    ps.upload = null;
  } else {
    emit(ps);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function ensureGitignore(root: string): Promise<void> {
  const p = path.join(root, '.gitignore');
  try {
    await fs.promises.access(p);
  } catch {
    await fs.promises.writeFile(p, buildGitignore(), 'utf8');
  }
}

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'bower_components',
  'jspm_packages',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '.vs',
  '.Trash',
  '$RECYCLE.BIN',
  'tmp',
  '.tmp',
]);

async function listAllFilesWithSize(root: string): Promise<{ files: string[]; totalBytes: number }> {
  const files: string[] = [];
  let totalBytes = 0;
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        try {
          const st = await fs.promises.stat(full);
          totalBytes += st.size;
        } catch {
          /* ignore */
        }
        files.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  await walk(root);
  return { files, totalBytes };
}

export async function stopSync(serverId: string, projectId: string): Promise<void> {
  const k = key(serverId, projectId);
  const ps = active.get(k);
  if (!ps) return;
  if (ps.debounceTimer) clearTimeout(ps.debounceTimer);
  if (ps.periodicTimer) clearInterval(ps.periodicTimer);
  await ps.watcher?.close();
  // Снимаем coord-хуки и блок CLAUDE.md, чтобы Claude'ы перестали ходить в
  // мёртвый сервер. Best-effort.
  try {
    uninstallCoordHooks(ps.localPath);
  } catch (e) {
    console.warn('[sync] coord uninstall failed:', e);
  }
  active.delete(k);
  getServerStore().removeSyncedFolder(serverId, projectId);
}

function scheduleFlush(ps: ProjectSync): void {
  const settings = getServerStore().getSettings();
  if (ps.debounceTimer) clearTimeout(ps.debounceTimer);
  ps.debounceTimer = setTimeout(() => {
    flush(ps).catch((e) => console.error('debounce flush error:', e));
  }, settings.syncDebounceMs ?? SYNC_DEBOUNCE_MS);
}

export async function flushNow(serverId: string, projectId: string): Promise<void> {
  const k = key(serverId, projectId);
  const ps = active.get(k);
  if (!ps) return;
  await flush(ps);
}

async function flush(ps: ProjectSync): Promise<void> {
  if (ps.isPushing) {
    ps.pendingPush = true;
    return;
  }
  if (ps.dirty.size === 0) return;

  ps.isPushing = true;
  ps.state = 'pushing';
  const filesCount = ps.dirty.size;
  emit(ps, { detail: `committing ${filesCount} files` });

  try {
    const server = getServerStore().getServer(ps.serverId);
    if (!server) throw new Error('server gone');

    const account = getServerStore().getAccount();
    const authorName = account?.username ?? 'unknown';
    const authorId = server.username || authorName;

    const jwt = await freshJwt(ps.serverId);
    const url = gitOriginUrl(server.url, ps.projectId, jwt);

    const g = gitFor(ps.localPath);
    await g.addConfig('user.name', `${authorId}|${authorName}`);
    await g.addConfig('user.email', `${authorId}@backups-app.local`);
    await g.remote(['set-url', 'origin', url]);

    await g.add('.');

    const status = await g.status();
    if (status.files.length === 0) {
      ps.dirty.clear();
      ps.state = 'idle';
      emit(ps);
      return;
    }

    const message = `${authorId}|${authorName}: ${status.files.length} files (${status.files
      .slice(0, 3)
      .map((f) => f.path)
      .join(', ')}${status.files.length > 3 ? '…' : ''})`;
    if (ps.upload) {
      setUpload(ps, { phase: 'committing' });
      emit(ps, { detail: 'создание коммита...' });
    }
    await g.commit(message);

    if (ps.upload) {
      setUpload(ps, { phase: 'pushing' });
      emit(ps, {
        detail: ps.upload.totalBytes
          ? `загрузка на сервер: ${formatBytes(ps.upload.totalBytes)}`
          : 'загрузка на сервер...',
      });
    }

    try {
      await g.push('origin', 'main');
    } catch (firstPushErr) {
      const firstMsg = (firstPushErr as Error).message;
      // Проверяем, есть ли вообще ветка main на remote. Если нет — recovery
      // через pull --rebase невозможен (на пустом репо нет ref'а main), и
      // нужно показать оригинальную ошибку push'а, а не вторичную.
      let remoteHasMain = false;
      try {
        const remoteRefs = await g.listRemote(['--heads', 'origin', 'main']);
        remoteHasMain = remoteRefs.includes('refs/heads/main');
      } catch {
        /* listRemote сам мог упасть — считаем remote недоступным */
      }
      if (!remoteHasMain) {
        // Remote пустой: первый push упал по другой причине (сеть, auth,
        // таймаут, отвалилась JWT). Surface оригинальную ошибку.
        ps.state = 'error';
        emit(ps, { detail: `push failed: ${firstMsg}` });
        return;
      }
      // Remote имеет main → наш push был отвергнут как non-fast-forward,
      // ребейзимся и пробуем ещё раз.
      try {
        await g.pull('origin', 'main', ['--rebase']);
        await g.push('origin', 'main');
      } catch (e2) {
        ps.state = 'error';
        emit(ps, {
          detail: `push failed after rebase: ${(e2 as Error).message} (initial: ${firstMsg})`,
        });
        return;
      }
    }

    ps.dirty.clear();
    ps.state = 'idle';
    emit(ps, { detail: `pushed ${status.files.length} files` });
  } catch (e) {
    ps.state = 'error';
    emit(ps, { detail: (e as Error).message });
  } finally {
    ps.isPushing = false;
    if (ps.pendingPush) {
      ps.pendingPush = false;
      flush(ps).catch((err) => console.error('pending flush error:', err));
    }
  }
}

export async function applyRemoteUpdate(serverId: string, projectId: string): Promise<void> {
  const k = key(serverId, projectId);
  const ps = active.get(k);
  if (!ps) return;
  if (ps.isPushing) return;

  ps.applyingPull = true;
  ps.state = 'pulling';
  emit(ps);
  try {
    const server = getServerStore().getServer(serverId);
    if (!server) return;
    const jwt = await freshJwt(serverId);
    const url = gitOriginUrl(server.url, projectId, jwt);
    const g = gitFor(ps.localPath);
    await g.remote(['set-url', 'origin', url]);
    try {
      await g.fetch('origin');
      await g.merge(['origin/main', '--ff-only']);
    } catch {
      try {
        await g.pull('origin', 'main', ['--rebase']);
      } catch (e) {
        ps.state = 'error';
        emit(ps, { detail: `pull failed: ${(e as Error).message}` });
        return;
      }
    }
    ps.state = 'idle';
    emit(ps);
  } finally {
    ps.applyingPull = false;
  }
}

export function listActive(): { serverId: string; projectId: string; localPath: string; state: SyncState; dirtyFiles: number }[] {
  return Array.from(active.values()).map((ps) => ({
    serverId: ps.serverId,
    projectId: ps.projectId,
    localPath: ps.localPath,
    state: ps.state,
    dirtyFiles: ps.dirty.size,
  }));
}

export function suggestDefaultLocalPath(name: string): string {
  const base = path.join(os.homedir(), 'BackupsApp', sanitize(name));
  return base;
}

function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_');
}
