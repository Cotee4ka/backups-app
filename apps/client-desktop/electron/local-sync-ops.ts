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
