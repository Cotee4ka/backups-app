import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import AutoLaunch from 'auto-launch';
import { getServerStore, type StoredServer } from './store';
import { ApiClient, loginToServer, registerOnServer } from './api-client';
import {
  disconnectAll,
  ensureConnection,
  setEventCallback,
  subscribeProject,
  unsubscribeProject,
} from './ws-client';
import { fetchServerFingerprint } from './tls-pin';

let getWin: () => BrowserWindow | null = () => null;
let autoLaunch: AutoLaunch | null = null;
let syncEnginePromise: Promise<typeof import('./sync-engine')> | null = null;
let syncStatusHookInstalled = false;

function getSyncEngine() {
  if (!syncEnginePromise) {
    syncEnginePromise = import('./sync-engine');
  }
  return syncEnginePromise;
}

async function ensureSyncEngine() {
  const sync = await getSyncEngine();
  if (!syncStatusHookInstalled) {
    sync.setStatusCallback((s) => {
      getWin()?.webContents.send('sync:status', s);
    });
    syncStatusHookInstalled = true;
  }
  return sync;
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow;

  setEventCallback((event, payload) => {
    getWin()?.webContents.send(`event:${event}`, payload);
  });

  // ---------- Local account ----------
  ipcMain.handle('account:has', async () => getServerStore().hasAccount());
  ipcMain.handle('account:create', async (_e, { username, password }) => {
    if (typeof username !== 'string' || username.length < 2) throw new Error('Username too short');
    if (typeof password !== 'string' || password.length < 4) throw new Error('Password too short');
    getServerStore().createAccount(username, password);
    return { ok: true };
  });
  ipcMain.handle('account:verify', async (_e, { username, password }) => ({
    ok: getServerStore().verifyAccount(username, password),
  }));
  ipcMain.handle('account:reset', async () => {
    disconnectAll();
    getServerStore().resetAccount();
    return { ok: true };
  });

  // ---------- Servers ----------
  ipcMain.handle('servers:list', async () =>
    getServerStore().listServers().map(stripSecrets),
  );

  ipcMain.handle('servers:install', async (_e, params) => {
    // IMPORTANT: ssh2 is only required for the "create server" wizard.
    // Lazy-load to avoid crashing app startup if optional SSH deps are missing
    // in a portable package.
    const { findInstallScript, runSshInstall } = await import('./ssh-installer');
    const installScriptPath = findInstallScript();
    const win = getWin();
    const result = await runSshInstall(
      {
        host: params.sshHost,
        port: params.sshPort ?? 22,
        username: params.sshUser,
        password: params.sshPassword,
        serverPort: params.serverPort ?? 8443,
        adminUser: params.adminUser ?? 'owner',
        installScriptPath,
      },
      (msg) => {
        win?.webContents.send('servers:install:log', msg);
      },
    );

    // Сохраняем pending fingerprint, чтобы pinning одобрил первое подключение.
    const origin = new URL(result.serverUrl).origin;
    getServerStore().setPendingFingerprint(origin, result.fingerprint);

    // Создаём аккаунт-владельца на сервере (или логинимся, если он уже есть).
    let auth;
    try {
      auth = await registerOnServer({
        url: result.serverUrl,
        fingerprint: result.fingerprint,
        username: result.adminUsername,
        password: result.adminPassword,
      });
    } catch {
      auth = await loginToServer({
        url: result.serverUrl,
        fingerprint: result.fingerprint,
        username: result.adminUsername,
        password: result.adminPassword,
      });
    }

    const stored: StoredServer = {
      id: crypto.randomUUID(),
      name: new URL(result.serverUrl).hostname,
      url: result.serverUrl,
      origin,
      fingerprint: result.fingerprint,
      username: auth.user.username,
      accessToken: auth.tokens.accessToken,
      refreshToken: auth.tokens.refreshToken,
      accessExpiresAt: auth.tokens.accessExpiresAt,
      refreshExpiresAt: auth.tokens.refreshExpiresAt,
      lastConnectedAt: Date.now(),
      syncedFolders: [],
    };
    getServerStore().upsertServer(stored);
    getServerStore().clearPendingFingerprint(origin);
    ensureConnection(stored.id);

    return {
      server: stripSecrets(stored),
      adminUsername: result.adminUsername,
      adminPassword: result.adminPassword,
    };
  });

  ipcMain.handle('servers:connect', async (_e, params) => {
    const url: string = params.url.replace(/\/$/, '');
    const origin = new URL(url).origin;
    const fingerprint = await fetchServerFingerprint(url);
    getServerStore().setPendingFingerprint(origin, fingerprint);

    const auth = await loginToServer({
      url,
      fingerprint,
      username: params.username,
      password: params.password,
    });
    const stored: StoredServer = {
      id: crypto.randomUUID(),
      name: new URL(url).hostname,
      url,
      origin,
      fingerprint,
      username: auth.user.username,
      accessToken: auth.tokens.accessToken,
      refreshToken: auth.tokens.refreshToken,
      accessExpiresAt: auth.tokens.accessExpiresAt,
      refreshExpiresAt: auth.tokens.refreshExpiresAt,
      lastConnectedAt: Date.now(),
      syncedFolders: [],
    };
    getServerStore().upsertServer(stored);
    getServerStore().clearPendingFingerprint(origin);
    ensureConnection(stored.id);
    return { server: stripSecrets(stored) };
  });

  ipcMain.handle('servers:delete', async (_e, id: string) => {
    getServerStore().deleteServer(id);
    return { ok: true };
  });

  ipcMain.handle('servers:rename', async (_e, { serverId, name }: { serverId: string; name: string }) => {
    const store = getServerStore();
    const server = store.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const updated = { ...server, name: name.trim() || server.name };
    store.upsertServer(updated);
    return stripSecrets(updated);
  });

  // ---------- Projects (proxy to server API) ----------
  ipcMain.handle('projects:list', async (_e, serverId: string) => {
    return new ApiClient(serverId).listProjects();
  });
  ipcMain.handle('projects:create', async (_e, { serverId, name, description }) => {
    return new ApiClient(serverId).createProject(name, description);
  });
  ipcMain.handle(
    'projects:createExternal',
    async (_e, { serverId, name, hostPath, description }) => {
      return new ApiClient(serverId).createExternalProject(name, hostPath, description);
    },
  );
  ipcMain.handle('projects:browseHost', async (_e, { serverId, hostPath }) => {
    return new ApiClient(serverId).browseHost(hostPath);
  });

  // ---------- External one-way sync ----------

  ipcMain.handle('externalSync:get', async (_e, { serverId, projectId }: { serverId: string; projectId: string }) => {
    return getServerStore().getExternalSync(serverId, projectId) ?? null;
  });

  ipcMain.handle('externalSync:chooseFolder', async () => {
    const win = getWin();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Выбрать папку для синхронизации с проды',
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('externalSync:openFolder', async (_e, { localPath }: { localPath: string }) => {
    if (localPath) await shell.openPath(localPath);
    return { ok: true };
  });

  ipcMain.handle(
    'externalSync:run',
    async (
      _e,
      params: {
        serverId: string;
        projectId: string;
        localPath: string;
        includeHeavy: boolean;
        manualPaths?: string[];
        excludedPaths?: string[];
        manualHeavyPaths?: string[];
        prune?: boolean;
      },
    ) => {
      const { syncExternalProject } = await import('./external-sync');
      return syncExternalProject({
        ...params,
        onProgress: (p) => {
          getWin()?.webContents.send('externalSync:progress', {
            serverId: params.serverId,
            projectId: params.projectId,
            ...p,
          });
        },
      });
    },
  );

  ipcMain.handle(
    'externalSync:listHeavy',
    async (_e, { serverId, projectId }: { serverId: string; projectId: string }) => {
      const { listHeavyCandidates } = await import('./external-sync');
      return listHeavyCandidates(serverId, projectId);
    },
  );

  ipcMain.handle(
    'externalSync:fileStatuses',
    async (
      _e,
      {
        serverId,
        projectId,
        files,
      }: {
        serverId: string;
        projectId: string;
        files: Array<{ relPath: string; size: number; mtime: number }>;
      },
    ) => {
      const { fileSyncStatuses } = await import('./local-sync-ops');
      return fileSyncStatuses(serverId, projectId, files);
    },
  );

  ipcMain.handle(
    'externalSync:downloadToLocal',
    async (
      _e,
      {
        serverId,
        projectId,
        path: p,
        ref,
      }: { serverId: string; projectId: string; path: string; ref?: string },
    ) => {
      const { downloadOneToLocal } = await import('./local-sync-ops');
      return downloadOneToLocal(serverId, projectId, p, ref ?? 'HEAD');
    },
  );

  ipcMain.handle(
    'externalSync:detectDataStore',
    async (_e, { serverId, projectId }: { serverId: string; projectId: string }) => {
      // Серверная автодетекция (есть только в server >= 0.2.0).
      // На старом сервере (404) возвращаем null — клиент сам сделает фоллбэк
      // на listHeavy (клиентский регексп без размеров и причин).
      try {
        return await new ApiClient(serverId).detectDataStore(projectId);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (msg.includes('HTTP 404')) return null;
        throw e;
      }
    },
  );

  ipcMain.handle(
    'servers:checkVersion',
    async (_e, { serverId }: { serverId: string }) => {
      try {
        const v = await new ApiClient(serverId).getServerVersion();
        return v;
      } catch (e) {
        return { version: '0.0.0', features: [], error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    'externalSync:setRules',
    async (
      _e,
      params: {
        serverId: string;
        projectId: string;
        manualPaths?: string[];
        excludedPaths?: string[];
        manualHeavyPaths?: string[];
      },
    ) => {
      const store = getServerStore();
      const existing = store.getExternalSync(params.serverId, params.projectId);
      if (!existing) return null;
      store.setExternalSync(params.serverId, {
        ...existing,
        manualPaths: params.manualPaths ?? existing.manualPaths,
        excludedPaths: params.excludedPaths ?? existing.excludedPaths,
        manualHeavyPaths: params.manualHeavyPaths ?? existing.manualHeavyPaths ?? [],
      });
      return store.getExternalSync(params.serverId, params.projectId);
    },
  );
  ipcMain.handle('projects:delete', async (_e, { serverId, projectId }) => {
    return new ApiClient(serverId).deleteProject(projectId);
  });
  ipcMain.handle('projects:history', async (_e, { serverId, projectId, limit }) => {
    return new ApiClient(serverId).history(projectId, limit ?? 100);
  });
  ipcMain.handle('projects:commit', async (_e, { serverId, projectId, sha }) => {
    return new ApiClient(serverId).commit(projectId, sha);
  });
  ipcMain.handle('projects:restore', async (_e, { serverId, projectId, sha, strategy }) => {
    return new ApiClient(serverId).restore(projectId, sha, strategy);
  });
  ipcMain.handle('projects:members', async (_e, { serverId, projectId }) => {
    return new ApiClient(serverId).members(projectId);
  });
  ipcMain.handle('projects:addMember', async (_e, { serverId, projectId, username, role }) => {
    return new ApiClient(serverId).addMember(projectId, username, role);
  });

  // ---------- File browser ----------
  ipcMain.handle(
    'projects:tree',
    async (_e, { serverId, projectId, path: p, ref }: { serverId: string; projectId: string; path?: string; ref?: string }) => {
      return new ApiClient(serverId).tree(projectId, p ?? '', ref ?? 'HEAD');
    },
  );
  ipcMain.handle(
    'projects:fileHistory',
    async (_e, { serverId, projectId, path: p, limit }: { serverId: string; projectId: string; path: string; limit?: number }) => {
      return new ApiClient(serverId).fileHistory(projectId, p, limit ?? 100);
    },
  );
  ipcMain.handle(
    'projects:downloadFile',
    async (
      _e,
      {
        serverId,
        projectId,
        path: p,
        ref,
        suggestedName,
      }: { serverId: string; projectId: string; path: string; ref?: string; suggestedName?: string },
    ) => {
      const win = getWin();
      if (!win) throw new Error('no window');
      const baseName =
        suggestedName ?? p.split('/').pop() ?? 'file';
      const result = await dialog.showSaveDialog(win, {
        defaultPath: path.join(os.homedir(), 'Downloads', baseName),
        title: 'Сохранить файл',
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const r = await new ApiClient(serverId).downloadFile(
        projectId,
        p,
        ref ?? 'HEAD',
        result.filePath,
      );
      return { canceled: false, ...r };
    },
  );
  ipcMain.handle(
    'projects:openFileLocally',
    async (
      _e,
      {
        serverId,
        projectId,
        path: p,
        ref,
      }: { serverId: string; projectId: string; path: string; ref?: string },
    ) => {
      const baseName = p.split('/').pop() ?? 'file';
      const tmpDir = await import('node:fs').then((fs) =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), 'backups-app-view-')),
      );
      const dest = path.join(tmpDir, baseName);
      await new ApiClient(serverId).downloadFile(projectId, p, ref ?? 'HEAD', dest);
      await shell.openPath(dest);
      return { ok: true, path: dest };
    },
  );

  // ---------- Sync ----------
  ipcMain.handle('sync:chooseFolder', async (_e, opts?: { mode?: 'download' | 'upload' | 'auto'; suggestedName?: string }) => {
    const win = getWin();
    if (!win) return null;
    const mode = opts?.mode ?? 'auto';
    const sync = await ensureSyncEngine();
    const defaultPath =
      mode === 'download' && opts?.suggestedName
        ? sync.suggestDefaultLocalPath(opts.suggestedName)
        : undefined;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title:
        mode === 'upload'
          ? 'Выберите локальную папку, чтобы загрузить её на сервер'
          : mode === 'download'
            ? 'Выберите пустую папку, в которую скачать проект с сервера'
            : 'Выберите папку для синхронизации',
      defaultPath,
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('sync:start', async (_e, { serverId, projectId, localPath, mode }) => {
    const sync = await ensureSyncEngine();
    const projects = await new ApiClient(serverId).listProjects();
    const project = projects.projects.find((p) => p.id === projectId);
    const projectName = project?.name ?? projectId;
    const folder = localPath || sync.suggestDefaultLocalPath(projectName);
    ensureConnection(serverId);
    await sync.startSync({ serverId, projectId, projectName, localPath: folder, mode });
    subscribeProject(serverId, projectId);
    getServerStore().pushRecent(serverId, projectId, projectName);
    return { ok: true, localPath: folder };
  });
  ipcMain.handle('sync:stop', async (_e, { serverId, projectId }) => {
    const sync = await ensureSyncEngine();
    await sync.stopSync(serverId, projectId);
    unsubscribeProject(serverId, projectId);
    return { ok: true };
  });
  ipcMain.handle('sync:flushNow', async (_e, { serverId, projectId }) => {
    const sync = await ensureSyncEngine();
    await sync.flushNow(serverId, projectId);
    return { ok: true };
  });
  ipcMain.handle('sync:listSynced', async (_e, serverId: string) => {
    const sync = await ensureSyncEngine();
    const s = getServerStore().getServer(serverId);
    return {
      synced: s?.syncedFolders ?? [],
      active: sync.listActive().filter((a) => a.serverId === serverId),
    };
  });

  // ---------- Audit ----------
  ipcMain.handle('audit:list', async (_e, { serverId, ...opts }) => {
    return new ApiClient(serverId).audit(opts);
  });

  // ---------- Settings ----------
  ipcMain.handle('settings:get', async () => getServerStore().getSettings());
  ipcMain.handle('settings:update', async (_e, patch) => getServerStore().updateSettings(patch));
  ipcMain.handle('settings:autoLaunch', async (_e, enabled: boolean) => {
    if (!autoLaunch) {
      autoLaunch = new AutoLaunch({
        name: 'Backups App',
        path: app.getPath('exe'),
        isHidden: true,
      });
    }
    if (enabled) await autoLaunch.enable();
    else await autoLaunch.disable();
    getServerStore().updateSettings({ autoLaunch: enabled });
    return { ok: true };
  });
  ipcMain.handle('shell:openExternal', async (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('shell:showItemInFolder', async (_e, p: string) => shell.showItemInFolder(p));

  // ---------- App info ----------
  ipcMain.handle('app:version', async () => app.getVersion());

  // After init, ensure WS-connections to all known servers.
  setImmediate(() => {
    for (const s of getServerStore().listServers()) {
      ensureConnection(s.id);
    }
  });
}

function stripSecrets(s: StoredServer) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    fingerprint: s.fingerprint,
    username: s.username,
    lastConnectedAt: s.lastConnectedAt,
    syncedFolders: s.syncedFolders,
  };
}
