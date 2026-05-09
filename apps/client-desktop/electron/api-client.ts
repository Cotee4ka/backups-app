import { pinnedRequest } from './tls-pin';
import { getServerStore, type StoredServer } from './store';

export class ServerApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

export class ApiClient {
  constructor(private serverId: string) {}

  private mustServer(): StoredServer {
    const s = getServerStore().getServer(this.serverId);
    if (!s) throw new Error(`Server not found: ${this.serverId}`);
    return s;
  }

  private async request<T = unknown>(
    pathname: string,
    opts: { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const server = this.mustServer();
    const url = `${server.url.replace(/\/$/, '')}${pathname}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    let token: string | null = null;
    if (opts.auth !== false) {
      token = await this.ensureAccessToken();
      headers['authorization'] = `Bearer ${token}`;
    }

    const res = await pinnedRequest({
      url,
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      fingerprint: server.fingerprint,
      timeoutMs: 30_000,
    });

    let parsed: unknown;
    try {
      parsed = res.body.length ? JSON.parse(res.body.toString('utf8')) : null;
    } catch {
      parsed = res.body.toString('utf8');
    }
    if (res.status >= 200 && res.status < 300) return parsed as T;

    if (res.status === 401 && opts.auth !== false) {
      const refreshed = await this.refresh();
      if (refreshed) {
        headers['authorization'] = `Bearer ${refreshed}`;
        const retry = await pinnedRequest({
          url,
          method: opts.method ?? 'GET',
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          fingerprint: server.fingerprint,
          timeoutMs: 30_000,
        });
        if (retry.status >= 200 && retry.status < 300) {
          return JSON.parse(retry.body.toString('utf8')) as T;
        }
        throw new ServerApiError(retry.status, JSON.parse(retry.body.toString('utf8')));
      }
    }
    throw new ServerApiError(res.status, parsed);
  }

  private async ensureAccessToken(): Promise<string> {
    const s = this.mustServer();
    if (s.accessExpiresAt - 30_000 > Date.now()) return s.accessToken;
    const refreshed = await this.refresh();
    if (refreshed) return refreshed;
    return s.accessToken;
  }

  /** Public wrapper for sync engine: gives a fresh access token. */
  async getFreshAccessToken(): Promise<string> {
    return this.ensureAccessToken();
  }

  private async refresh(): Promise<string | null> {
    const s = this.mustServer();
    try {
      const res = await pinnedRequest({
        url: `${s.url.replace(/\/$/, '')}/api/auth/refresh`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
        fingerprint: s.fingerprint,
        timeoutMs: 15_000,
      });
      if (res.status >= 200 && res.status < 300) {
        const body = JSON.parse(res.body.toString('utf8')) as {
          tokens: {
            accessToken: string;
            refreshToken: string;
            accessExpiresAt: number;
            refreshExpiresAt: number;
          };
        };
        s.accessToken = body.tokens.accessToken;
        s.refreshToken = body.tokens.refreshToken;
        s.accessExpiresAt = body.tokens.accessExpiresAt;
        s.refreshExpiresAt = body.tokens.refreshExpiresAt;
        getServerStore().upsertServer(s);
        return s.accessToken;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  // ---------- Public API methods ----------

  async health(): Promise<{ ok: boolean; fingerprint?: string }> {
    return this.request('/api/health', { auth: false });
  }

  async info(): Promise<{ requireInvite: boolean; fingerprint: string | null }> {
    return this.request('/api/info', { auth: false });
  }

  async listProjects(): Promise<{
    projects: Array<{
      id: string;
      name: string;
      description?: string;
      createdAt: number;
      createdBy: string;
      defaultBranch: string;
      /** Если задан — это external (read-only) проект-зеркало с проды. */
      externalPath?: string;
    }>;
  }> {
    return this.request('/api/projects');
  }

  async createProject(name: string, description?: string) {
    return this.request<{ project: { id: string; name: string } }>('/api/projects', {
      method: 'POST',
      body: { name, description },
    });
  }

  async createExternalProject(name: string, hostPath: string, description?: string) {
    return this.request<{
      project: { id: string; name: string; externalPath: string };
    }>('/api/projects/external', {
      method: 'POST',
      body: { name, hostPath, description },
    });
  }

  async browseHost(hostPath: string) {
    const qs = new URLSearchParams({ path: hostPath });
    return this.request<{
      root: string;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        type: 'file' | 'dir';
        size: number | null;
        mtime: number;
      }>;
    }>(`/api/host/browse?${qs.toString()}`);
  }

  async deleteProject(projectId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  }

  async history(projectId: string, limit = 100) {
    return this.request<{ commits: unknown[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/history?limit=${limit}`,
    );
  }

  async commit(projectId: string, sha: string) {
    return this.request<{ commit: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/commits/${encodeURIComponent(sha)}`,
    );
  }

  async restore(projectId: string, sha: string, strategy: 'revert' | 'reset') {
    return this.request<{ sha: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/restore`,
      { method: 'POST', body: { sha, strategy } },
    );
  }

  async members(projectId: string) {
    return this.request<{ members: Array<{ userId: string; username: string; role: string; joinedAt: number }> }>(
      `/api/projects/${encodeURIComponent(projectId)}/members`,
    );
  }

  async addMember(projectId: string, username: string, role: string) {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST',
      body: { username, role },
    });
  }

  async audit(opts: { projectId?: string; userId?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (opts.projectId) qs.set('projectId', opts.projectId);
    if (opts.userId) qs.set('userId', opts.userId);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return this.request<{ entries: unknown[] }>(`/api/audit?${qs.toString()}`);
  }

  async tree(
    projectId: string,
    pathInRepo = '',
    ref = 'HEAD',
  ): Promise<{
    ref: string;
    path: string;
    entries: Array<{
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
    }>;
  }> {
    const qs = new URLSearchParams({ ref, path: pathInRepo });
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tree?${qs.toString()}`,
    );
  }

  async fileHistory(
    projectId: string,
    pathInRepo: string,
    limit = 100,
  ): Promise<{
    path: string;
    history: Array<{
      sha: string;
      shortSha: string;
      message: string;
      authorId: string;
      authorName: string;
      timestamp: number;
      insertions: number;
      deletions: number;
      changeType: string;
      oldPath?: string;
    }>;
  }> {
    const qs = new URLSearchParams({ path: pathInRepo, limit: String(limit) });
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/file/history?${qs.toString()}`,
    );
  }

  async treeRecursive(
    projectId: string,
    subPath = '',
    opts: { includeJunk?: boolean } = {},
  ): Promise<{
    path: string;
    truncated: boolean;
    entries: Array<{ relPath: string; size: number; mtime: number }>;
    /** Имена «junk»-директорий (node_modules, .git, dist), пропущенных сервером. */
    prunedDirs?: Array<{ relPath: string; size: number; fileCount: number }>;
  }> {
    const qs = new URLSearchParams({ path: subPath });
    if (opts.includeJunk) qs.set('includeJunk', '1');
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tree-recursive?${qs.toString()}`,
    );
  }

  async detectDataStore(
    projectId: string,
    subPath = '',
  ): Promise<{
    files: Array<{
      relPath: string;
      size: number;
      mtime: number;
      reasons: Array<'extension' | 'name' | 'size'>;
      labels: string[];
    }>;
    junkDirs: Array<{
      relPath: string;
      size: number;
      fileCount: number;
      name: string;
      category: 'dependencies' | 'build' | 'cache' | 'vcs' | 'ide' | 'temp';
    }>;
    totalScanned: number;
    truncated: boolean;
    totalDataBytes: number;
    totalJunkBytes: number;
  }> {
    const qs = new URLSearchParams({ path: subPath });
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/data-store?${qs.toString()}`,
    );
  }

  async getServerVersion(): Promise<{
    version: string;
    features?: string[];
  }> {
    // /api/version появился в 0.2.0. На старых серверах — fallback на /api/health.
    try {
      return await this.request('/api/version', { auth: false });
    } catch (e) {
      if (e instanceof ServerApiError && e.status === 404) {
        const health = await this.request<{ version?: string; features?: string[] }>(
          '/api/health',
          { auth: false },
        );
        return { version: health.version ?? '0.0.0', features: health.features };
      }
      throw e;
    }
  }

  /**
   * Скачивает бинарный blob файла на указанный путь.
   * Возвращает количество байт, записанных на диск.
   */
  async downloadFile(
    projectId: string,
    pathInRepo: string,
    ref: string,
    destPath: string,
  ): Promise<{ bytes: number; saved: string }> {
    const server = this.mustServer();
    const token = await this.ensureAccessToken();
    const qs = new URLSearchParams({ path: pathInRepo, ref, download: '1' });
    const url =
      `${server.url.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/file/raw?${qs.toString()}`;

    const fs = await import('node:fs');
    const path = await import('node:path');
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    const { pinnedStream } = await import('./tls-pin');
    const { headers, stream } = await pinnedStream({
      url,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      fingerprint: server.fingerprint,
    });
    if (!headers.status || headers.status < 200 || headers.status >= 300) {
      throw new Error(`Download failed: HTTP ${headers.status}`);
    }

    const out = fs.createWriteStream(destPath);
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      stream.pipe(out);
    });
    return { bytes, saved: destPath };
  }

  /**
   * Тянет содержимое файла в память (без записи на диск). Используется для
   * подсчёта diff'ов в фиде «История изменений». Лимит maxBytes — чтобы не
   * утянуть случайно гигабайтный лог.
   */
  async fetchFileBuffer(
    projectId: string,
    pathInRepo: string,
    ref: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; truncated: boolean }> {
    const server = this.mustServer();
    const token = await this.ensureAccessToken();
    const qs = new URLSearchParams({ path: pathInRepo, ref });
    const url =
      `${server.url.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/file/raw?${qs.toString()}`;

    const { pinnedStream } = await import('./tls-pin');
    const { headers, stream } = await pinnedStream({
      url,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      fingerprint: server.fingerprint,
      timeoutMs: 10_000,
    });
    if (!headers.status || headers.status < 200 || headers.status >= 300) {
      throw new Error(`Fetch failed: HTTP ${headers.status}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const destroy = () =>
      (stream as unknown as { destroy?: () => void }).destroy?.();
    await new Promise<void>((resolve, reject) => {
      // Доп. защита от подвисшего стрима — общий таймаут на чтение тела.
      const timer = setTimeout(() => {
        destroy();
        reject(new Error(`Fetch body timeout: ${pathInRepo}`));
      }, 15_000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      stream.on('data', (chunk: Buffer) => {
        if (truncated) return;
        if (total + chunk.length > maxBytes) {
          truncated = true;
          destroy();
          finish();
          return;
        }
        total += chunk.length;
        chunks.push(chunk);
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      stream.on('end', finish);
      stream.on('close', finish);
    });
    return { buffer: Buffer.concat(chunks), truncated };
  }
}

export async function loginToServer(params: {
  url: string;
  fingerprint: string;
  username: string;
  password: string;
}): Promise<{
  user: { id: string; username: string; role: string };
  tokens: {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  };
}> {
  const res = await pinnedRequest({
    url: `${params.url.replace(/\/$/, '')}/api/auth/login`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: params.username, password: params.password }),
    fingerprint: params.fingerprint,
    timeoutMs: 15_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ServerApiError(res.status, JSON.parse(res.body.toString('utf8')));
  }
  return JSON.parse(res.body.toString('utf8'));
}

export async function registerOnServer(params: {
  url: string;
  fingerprint: string;
  username: string;
  password: string;
  inviteCode?: string;
}): Promise<{
  user: { id: string; username: string; role: string };
  tokens: {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  };
}> {
  const res = await pinnedRequest({
    url: `${params.url.replace(/\/$/, '')}/api/auth/register`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: params.username,
      password: params.password,
      inviteCode: params.inviteCode,
    }),
    fingerprint: params.fingerprint,
    timeoutMs: 15_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ServerApiError(res.status, JSON.parse(res.body.toString('utf8')));
  }
  return JSON.parse(res.body.toString('utf8'));
}
