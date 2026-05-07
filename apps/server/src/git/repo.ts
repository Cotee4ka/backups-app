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

export async function deleteRepo(projectId: string): Promise<void> {
  const repo = repoPath(projectId);
  await fs.rm(repo, { recursive: true, force: true });
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
