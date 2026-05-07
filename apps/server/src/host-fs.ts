import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';

export const HOST_ROOT = '/host';

export class InvalidHostPathError extends Error {
  statusCode = 400;
}

/**
 * Нормализует и валидирует путь, который пользователь хочет открыть как
 * external project или просмотреть в host browser.
 *
 * Любой путь должен лежать внутри HOST_ROOT после resolve symlink'ов.
 * Это единственный гейт между API и реальной ФС VPS — обходить его нельзя.
 */
export async function resolveHostPath(input: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0) {
    throw new InvalidHostPathError('Path is required');
  }
  if (input.includes('\0')) {
    throw new InvalidHostPathError('Invalid path');
  }
  const absolute = path.resolve(input);
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    // realpath проваливается, если папки нет — это сигнал, что путь
    // невалиден. external project к несуществующей папке не разрешаем.
    throw new InvalidHostPathError('Path does not exist');
  }
  const rootReal = await fs.realpath(HOST_ROOT).catch(() => HOST_ROOT);
  const rel = path.relative(rootReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InvalidHostPathError(`Path must be inside ${HOST_ROOT}`);
  }
  return real;
}

export interface HostBrowseEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime: number;
}

export async function browseHost(absPath: string): Promise<HostBrowseEntry[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      throw new InvalidHostPathError('Path is not a directory');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new InvalidHostPathError('Permission denied');
    }
    throw err;
  }

  const result: HostBrowseEntry[] = [];
  for (const e of entries) {
    if (!e.isFile() && !e.isDirectory()) continue;
    const full = path.join(absPath, e.name);
    let size: number | null = null;
    let mtime = 0;
    try {
      const st = await fs.stat(full);
      size = e.isFile() ? st.size : null;
      mtime = st.mtimeMs;
    } catch {
      /* ignore */
    }
    result.push({
      name: e.name,
      path: full,
      type: e.isDirectory() ? 'dir' : 'file',
      size,
      mtime,
    });
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

/**
 * Список файлов/папок одного уровня под subPath относительно external_path
 * проекта. subPath — пользовательский ввод, всегда нормализуется и
 * проверяется на побег из external_path.
 */
export async function listExternalTree(
  externalPath: string,
  subPath: string,
): Promise<HostBrowseEntry[]> {
  const target = resolveSubPath(externalPath, subPath);
  return browseHost(target);
}

export function resolveSubPath(externalPath: string, subPath: string): string {
  const clean = subPath.replace(/^\/+/, '').replace(/\\+/g, '/');
  const target = path.resolve(externalPath, clean);
  const rel = path.relative(externalPath, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InvalidHostPathError('subPath escapes external root');
  }
  return target;
}

export async function statExternalFile(
  externalPath: string,
  subPath: string,
): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  const target = resolveSubPath(externalPath, subPath);
  const st = await fs.stat(target);
  if (!st.isFile()) {
    throw new InvalidHostPathError('Not a regular file');
  }
  return { size: st.size, stream: createReadStream(target) };
}

export interface ExternalFileEntry {
  relPath: string;
  size: number;
  mtime: number;
}

export interface PrunedDirInfo {
  relPath: string;
  size: number;
  fileCount: number;
}

export interface RecursiveTreeOpts {
  maxEntries?: number;
  maxDepth?: number;
  /**
   * Имена директорий, в которые НЕ заходим вглубь — например, node_modules,
   * .git, dist. Их размер и количество файлов всё равно агрегируется
   * (отдельно, в prunedDirs), чтобы клиент мог честно показать «эта папка
   * весит N МБ, мы в неё не лезли».
   */
  pruneDirNames?: Set<string>;
}

/**
 * Рекурсивный обход external project. Возвращает плоский список файлов с
 * относительными путями. Жёсткие лимиты — защита от symlink-петель и от
 * случайно подключённой / на VPS.
 *
 * Если передан `pruneDirNames`, в эти директории не углубляемся, но их
 * размер агрегируется и возвращается отдельно — это нужно для детекции
 * мусорных папок типа node_modules / .git / dist.
 */
export async function listExternalTreeRecursive(
  externalPath: string,
  subPath: string,
  opts: RecursiveTreeOpts = {},
): Promise<{
  entries: ExternalFileEntry[];
  prunedDirs: PrunedDirInfo[];
  truncated: boolean;
}> {
  const maxEntries = opts.maxEntries ?? 200_000;
  const maxDepth = opts.maxDepth ?? 24;
  const pruneSet = opts.pruneDirNames ?? new Set<string>();
  const root = resolveSubPath(externalPath, subPath);
  const entries: ExternalFileEntry[] = [];
  const prunedDirs: PrunedDirInfo[] = [];
  let truncated = false;

  /** Агрегирует размер и количество файлов внутри pruned-директории. */
  async function aggregateDir(absPath: string): Promise<{ size: number; fileCount: number }> {
    let size = 0;
    let fileCount = 0;
    async function walk(p: string, depth: number): Promise<void> {
      if (depth > maxDepth) return;
      let dir: import('node:fs').Dirent[];
      try {
        dir = await fs.readdir(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of dir) {
        const full = path.join(p, e.name);
        if (e.isFile()) {
          try {
            const st = await fs.stat(full);
            size += st.size;
            fileCount += 1;
          } catch {
            /* skip */
          }
        } else if (e.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    }
    await walk(absPath, 0);
    return { size, fileCount };
  }

  async function walk(absPath: string, relBase: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) return;
    let dir: import('node:fs').Dirent[];
    try {
      dir = await fs.readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dir) {
      if (truncated) return;
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const full = path.join(absPath, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          entries.push({ relPath: rel, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skip */
        }
      } else if (e.isDirectory()) {
        if (pruneSet.has(e.name)) {
          // мусорная директория — агрегируем и не идём вглубь
          const agg = await aggregateDir(full);
          prunedDirs.push({ relPath: rel, size: agg.size, fileCount: agg.fileCount });
          continue;
        }
        await walk(full, rel, depth + 1);
      }
    }
  }
  await walk(root, '', 0);
  return { entries, prunedDirs, truncated };
}

export async function externalFileExists(
  externalPath: string,
  subPath: string,
): Promise<boolean> {
  try {
    const target = resolveSubPath(externalPath, subPath);
    const st = await fs.stat(target);
    return st.isFile();
  } catch {
    return false;
  }
}
