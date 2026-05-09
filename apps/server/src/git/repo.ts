import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import { config } from '../config.js';
import type { CommitInfo, CommitDetail, FileDiff } from '@backups-app/shared';

function repoPath(projectId: string): string {
  return path.join(config.reposDir, `${projectId}.git`);
}

function gitFor(repo: string): SimpleGit {
  return simpleGit({ baseDir: repo });
}

/**
 * Slugify имени проекта для имени worktree-папки. Оставляем латиницу/цифры
 * и `-`, остальное → `-`. Кириллицу транслитерировать не будем — просто
 * нормализуем в lowercase (`encodeURIComponent` сделает кириллицу процентами,
 * мы их выкинем). Если имя пустое после нормализации, fallback на `project`.
 */
function slugify(name: string): string {
  const trimmed = (name || '').trim().toLowerCase();
  const safe = trimmed
    .replace(/[^\w\d-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safe || 'project';
}

/**
 * Путь к worktree-зеркалу проекта. Имя папки — `<slug>-<short8>` чтобы
 * читалось при `ls /srv/projects/` и не коллизилось при дубликате имён.
 */
export function worktreePath(projectId: string, projectName: string): string {
  const slug = slugify(projectName);
  const short = projectId.replace(/-/g, '').slice(0, 8);
  return path.join(config.worktreesDir, `${slug}-${short}`);
}

export async function ensureRepo(projectId: string): Promise<string> {
  const repo = repoPath(projectId);
  try {
    await fs.access(repo);
  } catch {
    await fs.mkdir(repo, { recursive: true });
    const g = gitFor(repo);
    await g.init(['--bare', '--initial-branch=main']);
  }
  return repo;
}

/**
 * Создаёт (или обновляет) worktree-зеркало проекта и устанавливает
 * post-receive хук в bare-репо. Безопасно вызывать многократно: если
 * worktree уже есть, мы просто переустанавливаем хук (идемпотентно).
 *
 * Worktree пустой до первого push'а — так и должно быть (после init
 * в bare-репо нет ни одного коммита, чекаут будет no-op).
 */
export async function ensureWorktreeMirror(
  projectId: string,
  projectName: string,
): Promise<string> {
  const repo = await ensureRepo(projectId);
  const work = worktreePath(projectId, projectName);
  await fs.mkdir(config.worktreesDir, { recursive: true });
  await fs.mkdir(work, { recursive: true });

  // Hook: после успешного push в bare-репо переключаем worktree на свежий HEAD.
  // GIT_DIR указывает на bare, GIT_WORK_TREE — куда чекаутить файлы.
  const hookPath = path.join(repo, 'hooks', 'post-receive');
  const hookBody = [
    '#!/usr/bin/env bash',
    '# Backups App: автоматический worktree-mirror.',
    '# Обновляет рабочую копию в /data/worktrees/... после каждого push.',
    '# Сгенерировано сервером — НЕ редактировать, перезаписывается на старте.',
    'set -eu',
    `WORKTREE=${shellEscape(work)}`,
    'unset GIT_DIR GIT_WORK_TREE GIT_QUARANTINE_PATH',
    'mkdir -p "$WORKTREE"',
    `cd ${shellEscape(repo)}`,
    '# Чекаут default-ветки. Если репо пустой (refs/heads/main отсутствует)',
    '# — checkout молча падает, не валим push.',
    'git --work-tree="$WORKTREE" checkout -f main 2>/dev/null || true',
    '',
  ].join('\n');
  await fs.writeFile(hookPath, hookBody, { mode: 0o755 });
  // На всякий случай проставляем executable явно (writeFile mode не везде работает на Linux под shared volume).
  try {
    await fs.chmod(hookPath, 0o755);
  } catch {
    /* ignore */
  }

  return work;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function deleteRepo(projectId: string): Promise<void> {
  const repo = repoPath(projectId);
  await fs.rm(repo, { recursive: true, force: true });
}

/**
 * Удаление worktree-зеркала. Имя слага мы можем не помнить (проект уже
 * удалён из БД к моменту очистки), поэтому берём все папки в
 * worktreesDir и удаляем те, что заканчиваются на `-<short8>` нашего id.
 */
export async function deleteWorktreeMirror(projectId: string): Promise<void> {
  const short = projectId.replace(/-/g, '').slice(0, 8);
  let entries: string[];
  try {
    entries = await fs.readdir(config.worktreesDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.endsWith(`-${short}`)) {
      await fs.rm(path.join(config.worktreesDir, name), {
        recursive: true,
        force: true,
      });
    }
  }
}

export async function repoExists(projectId: string): Promise<boolean> {
  try {
    await fs.access(repoPath(projectId));
    return true;
  } catch {
    return false;
  }
}

export async function listCommits(
  projectId: string,
  limit = 100,
): Promise<CommitInfo[]> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);

  let logs;
  try {
    logs = await g.log({ maxCount: limit, '--all': null });
  } catch {
    return [];
  }

  const commits: CommitInfo[] = [];
  for (const c of logs.all) {
    const stats = await getCommitStats(repo, c.hash).catch(() => ({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    }));

    const parents = await g
      .raw(['rev-list', '--parents', '-n', '1', c.hash])
      .then((s) => s.trim().split(/\s+/).slice(1))
      .catch(() => [] as string[]);

    const [authorId, ...rest] = (c.author_name ?? '').split('|');
    const authorName = rest.join('|') || c.author_name || 'unknown';

    commits.push({
      sha: c.hash,
      parentShas: parents,
      message: c.message,
      authorId: authorId || 'unknown',
      authorName,
      timestamp: new Date(c.date).getTime(),
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
    });
  }
  return commits;
}

async function getCommitStats(
  repo: string,
  sha: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const g = gitFor(repo);
  const out = await g.raw(['show', '--stat', '--format=', sha]);
  const lines = out.trim().split('\n');
  const summary = lines[lines.length - 1] ?? '';
  const filesM = /(\d+)\s+files?\s+changed/.exec(summary);
  const insM = /(\d+)\s+insertions?/.exec(summary);
  const delM = /(\d+)\s+deletions?/.exec(summary);
  return {
    filesChanged: filesM ? Number(filesM[1]) : Math.max(0, lines.length - 1),
    insertions: insM ? Number(insM[1]) : 0,
    deletions: delM ? Number(delM[1]) : 0,
  };
}

export async function getCommitDetail(
  projectId: string,
  sha: string,
): Promise<CommitDetail> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);

  const showOut = await g.raw([
    'show',
    '--no-color',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%B',
    sha,
  ]);

  const headerEnd = showOut.indexOf('\n');
  const header = showOut.slice(0, headerEnd);
  const [hash, parents, authorName, authorEmail, dateIso, , bodyMaybe] =
    header.split('\u0000');

  const [authorId, ...nameRest] = (authorName ?? '').split('|');

  const numstat = await g.raw(['show', '--numstat', '--format=', sha]);
  const files: FileDiff[] = numstat
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [insStr, delStr, p] = line.split('\t');
      return {
        path: p ?? '',
        status: 'modified' as const,
        insertions: insStr === '-' ? 0 : Number(insStr),
        deletions: delStr === '-' ? 0 : Number(delStr),
      };
    });

  return {
    sha: hash ?? sha,
    parentShas: (parents ?? '').trim() ? parents!.trim().split(/\s+/) : [],
    message: bodyMaybe ?? '',
    authorId: authorId || authorEmail || 'unknown',
    authorName: nameRest.join('|') || authorName || 'unknown',
    timestamp: new Date(dateIso ?? Date.now()).getTime(),
    filesChanged: files.length,
    insertions: files.reduce((a, f) => a + f.insertions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    files,
  };
}

export async function restoreToCommit(
  projectId: string,
  sha: string,
  strategy: 'revert' | 'reset',
  author: { authorId: string; authorName: string },
): Promise<string> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);

  // Делаем во временной рабочей копии: bare-репо нельзя так просто менять.
  const work = path.join(config.reposDir, `.work-${projectId}-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const wg = simpleGit({ baseDir: work });
    await wg.clone(repo, work);
    await wg.addConfig('user.name', author.authorName);
    await wg.addConfig('user.email', `${author.authorId}@backups-app.local`);

    if (strategy === 'reset') {
      // создаём новый коммит с содержимым старого: безопаснее, чем force-push reset
      await wg.raw(['read-tree', sha]);
      await wg.raw(['checkout-index', '-a', '-f']);
      await wg.add('-A');
      await wg.commit(
        `${author.authorId}|${author.authorName}: restore to ${sha.slice(0, 8)}`,
        ['--allow-empty'],
      );
    } else {
      // revert (создаёт коммит с обратными изменениями)
      try {
        await wg.raw(['revert', '--no-edit', sha]);
      } catch {
        // если в одном коммите были merge или конфликты — fallback к снапшоту
        await wg.raw(['read-tree', sha]);
        await wg.raw(['checkout-index', '-a', '-f']);
        await wg.add('-A');
        await wg.commit(
          `${author.authorId}|${author.authorName}: restore to ${sha.slice(0, 8)}`,
          ['--allow-empty'],
        );
      }
    }

    await wg.push('origin', 'main');
    const newHead = (await g.revparse(['HEAD'])).trim();
    return newHead;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export async function getHeadSha(projectId: string): Promise<string | null> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);
  try {
    return (await g.revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

export function reposBaseDir(): string {
  return config.reposDir;
}

export function repoDirFor(projectId: string): string {
  return repoPath(projectId);
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mode: string;
  oid: string;
  lastCommit?: {
    sha: string;
    shortSha: string;
    message: string;
    authorId: string;
    authorName: string;
    timestamp: number;
  };
}

export async function hasAnyCommits(projectId: string): Promise<boolean> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);
  try {
    await g.revparse(['HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function listTree(
  projectId: string,
  ref: string,
  subPath: string,
  withLastCommit = true,
): Promise<TreeEntry[]> {
  const repo = await ensureRepo(projectId);
  if (!(await hasAnyCommits(projectId))) return [];

  const g = gitFor(repo);
  const safePath = subPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const target = safePath ? `${ref}:${safePath}` : `${ref}:`;
  let raw: string;
  try {
    raw = await g.raw(['ls-tree', '--long', target]);
  } catch {
    return [];
  }

  const entries: TreeEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Format: <mode> SP <type> SP <oid> SP <size|->\t<name>
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = line.slice(0, tabIdx).trim().split(/\s+/);
    const name = line.slice(tabIdx + 1);
    if (meta.length < 4) continue;
    const mode = meta[0]!;
    const type = meta[1]!;
    const oid = meta[2]!;
    const sizeStr = meta[3]!;
    if (type !== 'blob' && type !== 'tree') continue;
    entries.push({
      name,
      path: safePath ? `${safePath}/${name}` : name,
      type: type === 'blob' ? 'file' : 'dir',
      size: type === 'blob' && sizeStr !== '-' ? Number(sizeStr) : null,
      mode,
      oid,
    });
  }

  if (withLastCommit) {
    await Promise.all(
      entries.map(async (e) => {
        try {
          const log = await g.raw([
            'log',
            '-1',
            `--format=%H%x00%an%x00%aI%x00%s`,
            ref,
            '--',
            e.path,
          ]);
          const trimmed = log.trim();
          if (!trimmed) return;
          const [sha, authorRaw, dateIso, message] = trimmed.split('\u0000');
          if (!sha) return;
          const [authorId, ...rest] = (authorRaw ?? '').split('|');
          e.lastCommit = {
            sha,
            shortSha: sha.slice(0, 7),
            message: message ?? '',
            authorId: authorId || 'unknown',
            authorName: rest.join('|') || authorRaw || 'unknown',
            timestamp: new Date(dateIso ?? Date.now()).getTime(),
          };
        } catch {
          /* ignore */
        }
      }),
    );
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

export interface FileHistoryEntry {
  sha: string;
  shortSha: string;
  message: string;
  authorId: string;
  authorName: string;
  timestamp: number;
  insertions: number;
  deletions: number;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}

export async function fileHistory(
  projectId: string,
  filePath: string,
  limit = 100,
): Promise<FileHistoryEntry[]> {
  const repo = await ensureRepo(projectId);
  if (!(await hasAnyCommits(projectId))) return [];

  const g = gitFor(repo);
  const out = await g
    .raw([
      'log',
      `-${limit}`,
      '--follow',
      '--numstat',
      '--format=%x01%H%x00%an%x00%aI%x00%s',
      '--',
      filePath,
    ])
    .catch(() => '');

  const entries: FileHistoryEntry[] = [];
  const blocks = out.split('\u0001').filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines.shift() ?? '';
    const [sha, authorRaw, dateIso, message] = header.split('\u0000');
    if (!sha) continue;
    const [authorId, ...rest] = (authorRaw ?? '').split('|');
    let insertions = 0;
    let deletions = 0;
    let oldPath: string | undefined;
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const parts = ln.split('\t');
      if (parts.length < 3) continue;
      const ins = parts[0] === '-' ? 0 : Number(parts[0]);
      const del = parts[1] === '-' ? 0 : Number(parts[1]);
      insertions += isNaN(ins) ? 0 : ins;
      deletions += isNaN(del) ? 0 : del;
      // Parse rename like "old => new"
      const arrowed = parts.slice(2).join('\t');
      const m = /^(.*) => (.*)$/.exec(arrowed);
      if (m) {
        oldPath = (m[1] ?? '').replace(/[{}]/g, '');
      }
    }
    entries.push({
      sha,
      shortSha: sha.slice(0, 7),
      message: message ?? '',
      authorId: authorId || 'unknown',
      authorName: rest.join('|') || authorRaw || 'unknown',
      timestamp: new Date(dateIso ?? Date.now()).getTime(),
      insertions,
      deletions,
      changeType: 'modified',
      oldPath,
    });
  }
  return entries;
}

/**
 * Стримит содержимое файла из репозитория наружу. Безопасно для больших и
 * бинарных файлов. Бросает, если путь указывает не на blob.
 */
export async function readBlob(
  projectId: string,
  ref: string,
  filePath: string,
): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);
  const safePath = filePath.replace(/^\/+/, '');
  // size from cat-file -s
  const sizeRaw = await g.raw(['cat-file', '-s', `${ref}:${safePath}`]);
  const size = Number(sizeRaw.trim());
  // stream content
  const proc = spawn('git', ['cat-file', 'blob', `${ref}:${safePath}`], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { size, stream: proc.stdout };
}

export async function fileExistsAt(
  projectId: string,
  ref: string,
  filePath: string,
): Promise<boolean> {
  const repo = await ensureRepo(projectId);
  const g = gitFor(repo);
  try {
    const out = await g.raw([
      'cat-file',
      '-t',
      `${ref}:${filePath.replace(/^\/+/, '')}`,
    ]);
    return out.trim() === 'blob';
  } catch {
    return false;
  }
}
