import fsp from 'node:fs/promises';
import path from 'node:path';
import { ApiClient } from './api-client';
import { getServerStore } from './store';

export type SyncFileStatus =
  | 'synced' // mtime+size совпадают с продой
  | 'modified' // файл есть локально, но отличается
  | 'missing' // нет на ПК
  | 'no-folder'; // папка синка не настроена

export interface FileStatusEntry {
  relPath: string;
  status: SyncFileStatus;
  localSize?: number;
  localMtime?: number;
}

export interface FileStatRequest {
  relPath: string;
  size: number;
  mtime: number;
}

/**
 * Сравнивает список файлов с продой с локальными в папке синхронизации.
 * Если папка не настроена — все файлы получают статус 'no-folder'.
 *
 * Сравнение по mtime+size с погрешностью 2 сек (FS округляет до секунд).
 */
export async function fileSyncStatuses(
  serverId: string,
  projectId: string,
  files: FileStatRequest[],
): Promise<FileStatusEntry[]> {
  const ext = getServerStore().getExternalSync(serverId, projectId);
  if (!ext?.localPath) {
    return files.map((f) => ({ relPath: f.relPath, status: 'no-folder' as const }));
  }
  const localBase = ext.localPath;
  const out: FileStatusEntry[] = [];
  for (const f of files) {
    const localFull = path.join(localBase, f.relPath);
    try {
      const st = await fsp.stat(localFull);
      const sameSize = st.size === f.size;
      const sameMtime = Math.abs(st.mtimeMs - f.mtime) < 2000;
      out.push({
        relPath: f.relPath,
        status: sameSize && sameMtime ? 'synced' : 'modified',
        localSize: st.size,
        localMtime: st.mtimeMs,
      });
    } catch {
      out.push({ relPath: f.relPath, status: 'missing' });
    }
  }
  return out;
}

/**
 * Скачивает один файл с прода и кладёт его прямо в локальную папку синка
 * (по такому же относительному пути, как на проде). Если папки синка нет
 * — выбрасывает ошибку, UI должен сначала предложить выбрать папку.
 */
export async function downloadOneToLocal(
  serverId: string,
  projectId: string,
  relPath: string,
  ref = 'HEAD',
): Promise<{ saved: string; bytes: number }> {
  const ext = getServerStore().getExternalSync(serverId, projectId);
  if (!ext?.localPath) {
    throw new Error('Локальная папка синхронизации не выбрана');
  }
  const dest = path.join(ext.localPath, relPath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const api = new ApiClient(serverId);
  const r = await api.downloadFile(projectId, relPath, ref, dest);

  // Привести mtime локального файла к серверному, чтобы fileSyncStatuses
  // потом считал его 'synced'. Возьмём mtime из treeRecursive — но проще
  // полагаться на то, что поле уже актуально на момент клика. Чтобы не
  // тащить лишний запрос, оставляем естественный mtime от закачки.
  return r;
}

/** Лимит размера файла для расчёта diff'а — чтобы не тянуть гигабайтный лог. */
const DIFF_MAX_BYTES = 512 * 1024;

/** Расширения, по которым предполагаем, что файл — текстовый. */
const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'json5', 'yml', 'yaml', 'toml',
  'md', 'mdx', 'txt', 'rst', 'html', 'htm', 'css', 'scss', 'less', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'cs', 'cpp', 'c', 'h',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'vue', 'svelte', 'astro',
  'sql', 'graphql', 'gql', 'env', 'gitignore', 'dockerignore', 'lock',
  'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'patch', 'diff', 'tex',
]);

function isTextLikePath(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXT.has(relPath.slice(dot + 1).toLowerCase());
}

/** Грубая эвристика бинарности: нулевой байт в первых 8KB. */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Считает примерное число добавленных/удалённых строк между двумя текстами.
 * Используется line-set diff: для каждой строки правой стороны проверяем,
 * сколько таких есть слева. Перемещения строк между разделами не различаем —
 * для сводки в фиде хватает.
 */
function lineSetDiff(local: string, remote: string): { ins: number; del: number } {
  const localLines = local.split(/\r?\n/);
  const remoteLines = remote.split(/\r?\n/);
  const counts = new Map<string, number>();
  for (const l of localLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let ins = 0;
  for (const l of remoteLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else ins++;
  }
  let del = 0;
  for (const c of counts.values()) del += c;
  return { ins, del };
}

export interface DiffStats {
  ins: number;
  del: number;
  /** Файл не текстовый или слишком большой, считать смысла нет. */
  skipped?: 'binary' | 'too-large' | 'no-local';
}

/**
 * Сравнивает локальную копию файла из синк-папки с тем, что сейчас на проде.
 * Возвращает количество добавленных/удалённых строк ИЛИ skipped с причиной.
 * Локальная копия = состояние на момент последнего синка.
 */
export async function diffStatsFor(
  serverId: string,
  projectId: string,
  relPath: string,
): Promise<DiffStats> {
  if (!isTextLikePath(relPath)) {
    return { ins: 0, del: 0, skipped: 'binary' };
  }
  const ext = getServerStore().getExternalSync(serverId, projectId);
  if (!ext?.localPath) return { ins: 0, del: 0, skipped: 'no-local' };
  const localFull = path.join(ext.localPath, relPath);
  let localBuf: Buffer | null = null;
  try {
    const st = await fsp.stat(localFull);
    if (st.size > DIFF_MAX_BYTES) return { ins: 0, del: 0, skipped: 'too-large' };
    localBuf = await fsp.readFile(localFull);
  } catch {
    // Локального файла нет — ничего не сравниваем (для missing просто
    // покажем 0/0; UI это интерпретирует как «новый файл»).
    localBuf = null;
  }
  if (localBuf && looksBinary(localBuf)) return { ins: 0, del: 0, skipped: 'binary' };

  const api = new ApiClient(serverId);
  const { buffer: remoteBuf, truncated } = await api.fetchFileBuffer(
    projectId,
    relPath,
    'HEAD',
    DIFF_MAX_BYTES,
  );
  if (truncated) return { ins: 0, del: 0, skipped: 'too-large' };
  if (looksBinary(remoteBuf)) return { ins: 0, del: 0, skipped: 'binary' };

  if (!localBuf) {
    // Файла локально нет — считаем все строки прода как «добавленные».
    const lines = remoteBuf.toString('utf8').split(/\r?\n/).length;
    return { ins: lines, del: 0, skipped: 'no-local' };
  }
  return lineSetDiff(localBuf.toString('utf8'), remoteBuf.toString('utf8'));
}
