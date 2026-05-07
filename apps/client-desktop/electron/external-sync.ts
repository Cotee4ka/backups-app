import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ApiClient } from './api-client';
import { getServerStore, type ExternalSync } from './store';

/**
 * Триггеры для "тяжёлых" файлов: бэкапы БД, дампы, статистика, архивы.
 * Эти файлы по умолчанию НЕ синхронизируются автоматически — только по
 * отдельной кнопке "Синхр. тяжёлые".
 */
const HEAVY_PATTERNS: RegExp[] = [
  /\.sql(\.gz|\.bz2|\.zst)?$/i,
  /\.dump$/i,
  /\.bak$/i,
  /\.backup$/i,
  /\.sqlite3?$/i,
  /\.db$/i,
  /\.tar(\.gz|\.bz2|\.zst|\.xz)?$/i,
  /\.zip$/i,
  /\.7z$/i,
  /\.rar$/i,
  /\bbackup[s]?\b/i,
  /\bdump[s]?\b/i,
  /\bsnapshots?\b/i,
  /\bstats?\b/i,
  /\banalytics\b/i,
  /\.log$/i,
  /\.log\.\d+$/i,
];

export function isHeavyPath(relPath: string): boolean {
  return HEAVY_PATTERNS.some((p) => p.test(relPath));
}

export interface SyncProgress {
  phase: 'listing' | 'comparing' | 'downloading' | 'cleaning' | 'done' | 'error';
  totalFiles?: number;
  processedFiles?: number;
  totalBytes?: number;
  downloadedBytes?: number;
  currentFile?: string;
  error?: string;
}

export interface SyncOptions {
  serverId: string;
  projectId: string;
  localPath: string;
  includeHeavy: boolean;
  /** Файлы, которые юзер пометил как "manual": включать даже если совпали с heavy */
  manualPaths?: string[];
  /** Файлы, которые юзер явно исключил */
  excludedPaths?: string[];
  /** Удалять файлы локально, которых уже нет на сервере */
  prune?: boolean;
  onProgress?: (p: SyncProgress) => void;
}

export interface SyncResult {
  totalFiles: number;
  downloaded: number;
  skipped: number;
  bytes: number;
  durationMs: number;
}

/**
 * Скачивает все файлы из external project в локальную папку. Сравнивает
 * mtime+size — если совпадает с локальным, пропускает. Опционально удаляет
 * локальные файлы, которых нет на сервере.
 */
export async function syncExternalProject(opts: SyncOptions): Promise<SyncResult> {
  const startedAt = Date.now();
  const emit = opts.onProgress ?? (() => undefined);
  const manualSet = new Set(opts.manualPaths ?? []);
  const excludedSet = new Set(opts.excludedPaths ?? []);

  emit({ phase: 'listing' });

  await fsp.mkdir(opts.localPath, { recursive: true });

  const api = new ApiClient(opts.serverId);
  const tree = await api.treeRecursive(opts.projectId, '');

  const candidates = tree.entries.filter((e) => {
    if (excludedSet.has(e.relPath)) return false;
    const heavy = isHeavyPath(e.relPath);
    if (heavy && !manualSet.has(e.relPath)) {
      // тяжёлый файл — пропускаем, если не запросили включение
      return opts.includeHeavy;
    }
    return true;
  });

  emit({
    phase: 'comparing',
    totalFiles: candidates.length,
    totalBytes: candidates.reduce((a, c) => a + c.size, 0),
  });

  const toDownload: typeof candidates = [];
  for (const f of candidates) {
    const localFull = path.join(opts.localPath, f.relPath);
    let needs = true;
    try {
      const st = await fsp.stat(localFull);
      // mtime сравниваем с погрешностью 2 сек (FS часто округляет до секунд)
      if (st.size === f.size && Math.abs(st.mtimeMs - f.mtime) < 2000) {
        needs = false;
      }
    } catch {
      /* not exists, must download */
    }
    if (needs) toDownload.push(f);
  }

  let downloadedBytes = 0;
  let processed = 0;
  emit({
    phase: 'downloading',
    totalFiles: toDownload.length,
    processedFiles: 0,
    totalBytes: toDownload.reduce((a, c) => a + c.size, 0),
    downloadedBytes: 0,
  });

  for (const f of toDownload) {
    const localFull = path.join(opts.localPath, f.relPath);
    emit({
      phase: 'downloading',
      totalFiles: toDownload.length,
      processedFiles: processed,
      downloadedBytes,
      currentFile: f.relPath,
    });
    try {
      await api.downloadFile(opts.projectId, f.relPath, 'HEAD', localFull);
      // Привести mtime локального к серверному, чтобы повторный sync не качал заново
      await fsp.utimes(localFull, new Date(f.mtime), new Date(f.mtime));
      downloadedBytes += f.size;
    } catch (err) {
      // не валим всю синхронизацию из-за одного файла
      console.error(`[external-sync] failed ${f.relPath}:`, err);
    }
    processed++;
  }

  if (opts.prune) {
    emit({ phase: 'cleaning' });
    const expected = new Set(candidates.map((c) => c.relPath));
    await pruneLocal(opts.localPath, '', expected);
  }

  // Сохраняем метаданные синхронизации
  const existing = getServerStore().getExternalSync(opts.serverId, opts.projectId);
  const updated: ExternalSync = {
    projectId: opts.projectId,
    localPath: opts.localPath,
    excludedPaths: opts.excludedPaths ?? existing?.excludedPaths ?? [],
    manualPaths: opts.manualPaths ?? existing?.manualPaths ?? [],
    lastSyncAt: Date.now(),
    lastSyncIncludedHeavy: opts.includeHeavy,
  };
  getServerStore().setExternalSync(opts.serverId, updated);

  emit({ phase: 'done' });

  return {
    totalFiles: candidates.length,
    downloaded: toDownload.length,
    skipped: candidates.length - toDownload.length,
    bytes: downloadedBytes,
    durationMs: Date.now() - startedAt,
  };
}

async function pruneLocal(rootDir: string, relBase: string, expected: Set<string>): Promise<void> {
  const abs = path.join(rootDir, relBase);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) {
      await pruneLocal(rootDir, rel, expected);
      // remove dir if empty
      try {
        const left = await fsp.readdir(full);
        if (left.length === 0) await fsp.rmdir(full);
      } catch {
        /* ignore */
      }
    } else if (e.isFile()) {
      if (!expected.has(rel)) {
        try {
          await fsp.unlink(full);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
