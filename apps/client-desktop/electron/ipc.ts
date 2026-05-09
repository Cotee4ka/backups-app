import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import AutoLaunch from 'auto-launch';
import {
  EXPECTED_SERVER_VERSION,
  EXPECTED_INSTALL_SCRIPT_VERSION,
} from '@backups-app/shared';
import { getServerStore, type StoredServer } from './store';
import { ApiClient, loginToServer, registerOnServer, fetchInviteInfo } from './api-client';
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
      // CreateServerWizard всегда поднимает наш бэкап-сервер для двухсторонней
      // git-синхронизации проектов. Mode 1.
      kind: (params.kind as 'projects' | 'prod') ?? 'projects',
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
      // ConnectServerWizard работает с уже поднятым сервером — обычно это
      // прода (Mode 2, read-only mirror через `/host:ro`). Wizard передаёт
      // явный kind; default 'prod' тоже разумный, но оставим строгим — пусть
      // wizard всегда явно передаёт.
      kind: (params.kind as 'projects' | 'prod') ?? 'prod',
      syncedFolders: [],
    };
    getServerStore().upsertServer(stored);
    getServerStore().clearPendingFingerprint(origin);
    ensureConnection(stored.id);
    return { server: stripSecrets(stored) };
  });

  /**
   * Перепомечает kind существующего сервера. Используется как для ручного
   * переключения юзером, так и для авто-детекта на странице Server.tsx
   * (если есть external-проекты — сервер по факту 'prod').
   */
  ipcMain.handle(
    'servers:setKind',
    async (
      _e,
      { serverId, kind }: { serverId: string; kind: 'projects' | 'prod' },
    ) => {
      const store = getServerStore();
      const server = store.getServer(serverId);
      if (!server) throw new Error('Server not found');
      if (server.kind === kind) return stripSecrets(server);
      const updated = { ...server, kind };
      store.upsertServer(updated);
      return stripSecrets(updated);
    },
  );

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
    'externalSync:listAllFiles',
    async (
      _e,
      { serverId, projectId }: { serverId: string; projectId: string },
    ) => {
      // Серверный treeRecursive прунит junk-папки по умолчанию (>=0.3.0).
      const tree = await new ApiClient(serverId).treeRecursive(projectId, '');
      return tree.entries;
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
    'externalSync:diffStats',
    async (
      _e,
      {
        serverId,
        projectId,
        path: p,
      }: { serverId: string; projectId: string; path: string },
    ) => {
      const { diffStatsFor } = await import('./local-sync-ops');
      return diffStatsFor(serverId, projectId, p);
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

  /**
   * Version gate: сверяет версию хоста (по /api/version) с тем, что ожидает
   * клиент (`EXPECTED_SERVER_VERSION`). Используется UI для блокировки
   * входа на устаревший хост.
   *
   * Возвращает `{ ok: true }` если хост актуален, иначе
   * `{ ok: false, reason, current, expected }`. Сетевую ошибку трактуем как
   * `unreachable` — даём UI решать что показывать.
   */
  ipcMain.handle(
    'servers:verifyCurrent',
    async (_e, { serverId }: { serverId: string }) => {
      try {
        const v = (await new ApiClient(serverId).getServerVersion()) as {
          version: string;
          installScriptVersion?: string;
          features?: string[];
        };
        const cmpServer = compareSemver(v.version ?? '0.0.0', EXPECTED_SERVER_VERSION);
        const cmpScript = v.installScriptVersion
          ? compareSemver(v.installScriptVersion, EXPECTED_INSTALL_SCRIPT_VERSION)
          : -1; // нет поля — считаем устаревшим (старая версия сервера)
        if (cmpServer >= 0 && cmpScript >= 0) {
          return {
            ok: true as const,
            current: v.version,
            currentScript: v.installScriptVersion ?? null,
            expected: EXPECTED_SERVER_VERSION,
            expectedScript: EXPECTED_INSTALL_SCRIPT_VERSION,
          };
        }
        return {
          ok: false as const,
          reason: 'outdated' as const,
          current: v.version ?? '0.0.0',
          currentScript: v.installScriptVersion ?? null,
          expected: EXPECTED_SERVER_VERSION,
          expectedScript: EXPECTED_INSTALL_SCRIPT_VERSION,
        };
      } catch (e) {
        return {
          ok: false as const,
          reason: 'unreachable' as const,
          error: (e as Error).message,
          expected: EXPECTED_SERVER_VERSION,
          expectedScript: EXPECTED_INSTALL_SCRIPT_VERSION,
        };
      }
    },
  );

  // ============================================================
  //  v2 installer — раздельные SSH-операции check/apply.
  //  Используются ConnectServerWizard'ом и version-gate'ом для
  //  обновления устаревшего хоста.
  // ============================================================

  ipcMain.handle(
    'installer:check',
    async (
      _e,
      params: {
        sshHost: string;
        sshPort: number;
        sshUser: string;
        sshPassword: string;
      },
    ) => {
      const { findInstallScriptV2, checkRemoteHost } = await import('./ssh-installer');
      const installScriptPath = findInstallScriptV2();
      const win = getWin();
      const result = await checkRemoteHost(
        {
          host: params.sshHost,
          port: params.sshPort ?? 22,
          username: params.sshUser,
          password: params.sshPassword,
          installScriptPath,
        },
        (p) => {
          win?.webContents.send('installer:progress', p);
        },
      );
      // Дополним результат планом, который посчитан клиентом — UI сразу
      // видит, что нужно делать.
      const plan = computeInstallPlan(result);
      return { ...result, plan, expected: { server: EXPECTED_SERVER_VERSION, script: EXPECTED_INSTALL_SCRIPT_VERSION } };
    },
  );

  ipcMain.handle(
    'installer:apply',
    async (
      _e,
      params: {
        sshHost: string;
        sshPort: number;
        sshUser: string;
        sshPassword: string;
        serverPort: number;
        adminUser?: string;
        publicUrl?: string;
        imageRef?: string;
        /** Если true — после успешного apply сразу логинимся и сохраняем сервер. */
        autoConnect?: boolean;
        /**
         * 'projects' — wizard «Создать сервер» (двухсторонняя git-синк).
         * 'prod'     — wizard «Подключиться к проде» (read-only mirror).
         * По умолчанию 'projects' для обратной совместимости со старыми вызовами.
         */
        kind?: 'projects' | 'prod';
      },
    ) => {
      const { findInstallScriptV2, findInstallScriptProjects, applyRemoteHost } =
        await import('./ssh-installer');
      // Mode 1 (Projects) — install-projects.sh, без host mount.
      // Mode 2 (Prod, default) — install-v2.sh с /host:ro.
      const installScriptPath =
        params.kind === 'projects' ? findInstallScriptProjects() : findInstallScriptV2();
      const win = getWin();
      const applied = await applyRemoteHost(
        {
          host: params.sshHost,
          port: params.sshPort ?? 22,
          username: params.sshUser,
          password: params.sshPassword,
          serverPort: params.serverPort ?? 8443,
          adminUser: params.adminUser ?? 'owner',
          publicUrl: params.publicUrl,
          imageRef: params.imageRef,
          targetVersion: EXPECTED_SERVER_VERSION,
          installScriptPath,
        },
        (p) => {
          win?.webContents.send('installer:progress', p);
        },
      );

      if (!params.autoConnect) {
        return { applied, server: null };
      }

      // Сохраняем pending fingerprint и логинимся (или регистрируемся).
      const origin = new URL(applied.serverUrl).origin;
      getServerStore().setPendingFingerprint(origin, applied.fingerprint);

      let auth;
      try {
        auth = await registerOnServer({
          url: applied.serverUrl,
          fingerprint: applied.fingerprint,
          username: applied.adminUsername,
          password: applied.adminPassword,
        });
      } catch {
        auth = await loginToServer({
          url: applied.serverUrl,
          fingerprint: applied.fingerprint,
          username: applied.adminUsername,
          password: applied.adminPassword,
        });
      }

      const stored: StoredServer = {
        id: crypto.randomUUID(),
        name: new URL(applied.serverUrl).hostname,
        url: applied.serverUrl,
        origin,
        fingerprint: applied.fingerprint,
        username: auth.user.username,
        accessToken: auth.tokens.accessToken,
        refreshToken: auth.tokens.refreshToken,
        accessExpiresAt: auth.tokens.accessExpiresAt,
        refreshExpiresAt: auth.tokens.refreshExpiresAt,
        lastConnectedAt: Date.now(),
        kind: params.kind ?? 'projects',
        syncedFolders: [],
      };
      getServerStore().upsertServer(stored);
      getServerStore().clearPendingFingerprint(origin);
      ensureConnection(stored.id);

      return {
        applied,
        server: stripSecrets(stored),
        adminUsername: applied.adminUsername,
        adminPassword: applied.adminPassword,
      };
    },
  );

  ipcMain.handle(
    'installer:installSshKey',
    async (
      _e,
      params: {
        sshHost: string;
        sshPort: number;
        sshUser: string;
        sshPassword: string;
        publicKey: string;
      },
    ) => {
      const { installSshPublicKey } = await import('./ssh-installer');
      const win = getWin();
      await installSshPublicKey(
        {
          host: params.sshHost,
          port: params.sshPort ?? 22,
          username: params.sshUser,
          password: params.sshPassword,
        },
        params.publicKey,
        (p) => win?.webContents.send('installer:progress', p),
      );
      return { ok: true };
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

  ipcMain.handle(
    'externalSync:setUiOverride',
    async (
      _e,
      params: {
        serverId: string;
        projectId: string;
        key: 'foldersBottom' | 'dataFilesBottom' | 'changeFeedAfterSyncOnly' | 'changeFeedShowDiff';
        /** boolean — выставить переопределение, null — сбросить (наследовать от глобала). */
        value: boolean | null;
      },
    ) => {
      const store = getServerStore();
      const existing = store.getExternalSync(params.serverId, params.projectId);
      // На внешний проект ExternalSync создаётся при первом синке. До этого
      // момента переопределений нет — храним их вместе с заглушкой записи,
      // чтобы юзер мог настроить тогглы заранее.
      const base = existing ?? {
        projectId: params.projectId,
        localPath: '',
        excludedPaths: [],
        manualPaths: [],
        manualHeavyPaths: [],
      };
      const overrides = { ...(base.uiOverrides ?? {}) };
      if (params.value === null) {
        delete overrides[params.key];
      } else {
        overrides[params.key] = params.value;
      }
      store.setExternalSync(params.serverId, {
        ...base,
        uiOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      return store.getExternalSync(params.serverId, params.projectId);
    },
  );
  ipcMain.handle(
    'projects:delete',
    async (
      _e,
      {
        serverId,
        projectId,
        deleteLocalFolder,
      }: { serverId: string; projectId: string; deleteLocalFolder?: boolean },
    ) => {
      // Сначала запоминаем путь до локальной папки — после removeSyncedFolder
      // мы его уже не достанем. Берём из syncedFolders или из externalSyncs.
      const store = getServerStore();
      const srv = store.getServer(serverId);
      const synced = srv?.syncedFolders.find((f) => f.projectId === projectId);
      const ext = srv?.externalSyncs?.find((e) => e.projectId === projectId);
      const localPath = synced?.localPath || ext?.localPath || null;

      // Останавливаем активную синхронизацию (если есть), чистим watcher'ы.
      try {
        const sync = await ensureSyncEngine();
        await sync.stopSync(serverId, projectId);
        unsubscribeProject(serverId, projectId);
      } catch {
        /* sync мог быть не активен — это ок */
      }
      // Локальные записи: и обычный sync, и external read-only.
      store.removeSyncedFolder(serverId, projectId);
      store.removeExternalSync(serverId, projectId);

      // Серверный delete: удалит row + project_members (cascade) + bare repo.
      const apiResult = await new ApiClient(serverId).deleteProject(projectId);

      // Опционально rm -rf локальной папки. Делаем последним, чтобы если
      // юзер сказал «и локально тоже» — мы уже точно отвязали watcher.
      let localFolderRemoved = false;
      if (deleteLocalFolder && localPath) {
        try {
          await fsPromises.rm(localPath, { recursive: true, force: true });
          localFolderRemoved = true;
        } catch (e) {
          // Не валим всю операцию — серверная часть уже удалена.
          console.warn('failed to remove local folder', localPath, e);
        }
      }

      return { ...apiResult, localFolderRemoved };
    },
  );
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
  ipcMain.handle(
    'projects:removeMember',
    async (
      _e,
      { serverId, projectId, userId }: { serverId: string; projectId: string; userId: string },
    ) => {
      return new ApiClient(serverId).removeMember(projectId, userId);
    },
  );
  ipcMain.handle(
    'projects:setMemberRole',
    async (
      _e,
      {
        serverId,
        projectId,
        userId,
        role,
      }: {
        serverId: string;
        projectId: string;
        userId: string;
        role: 'admin' | 'member' | 'viewer';
      },
    ) => {
      return new ApiClient(serverId).setMemberRole(projectId, userId, role);
    },
  );

  // ---------- Invite links (per-project & server-level) ----------
  /**
   * Создаёт project-invite на сервере и сразу собирает строку-токен `bapi.…`
   * для копирования в UI. Токен включает url+fingerprint текущего сервера —
   * друг сможет подключиться без предварительной настройки.
   */
  ipcMain.handle(
    'invites:createProject',
    async (
      _e,
      params: {
        serverId: string;
        projectId: string;
        role: 'admin' | 'member' | 'viewer';
        ttlSec: number;
      },
    ) => {
      const server = getServerStore().getServer(params.serverId);
      if (!server) throw new Error('Server not found');
      const r = await new ApiClient(params.serverId).createProjectInvite(
        params.projectId,
        { role: params.role, ttlSec: params.ttlSec },
      );
      // Собираем токен прямо в main, чтобы renderer не лез в base64-логику.
      const json = JSON.stringify({
        v: 1,
        url: server.url,
        fp: server.fingerprint,
        code: r.code,
        role: r.role,
        projectName: r.projectName,
      });
      const b64 = Buffer.from(json, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const token = `bapi.${b64}`;
      return {
        code: r.code,
        token,
        expiresAt: r.expiresAt,
        role: r.role,
        projectId: r.projectId,
        projectName: r.projectName,
      };
    },
  );
  ipcMain.handle(
    'invites:listProject',
    async (_e, { serverId, projectId }: { serverId: string; projectId: string }) => {
      return new ApiClient(serverId).listProjectInvites(projectId);
    },
  );
  ipcMain.handle(
    'invites:revoke',
    async (_e, { serverId, code }: { serverId: string; code: string }) => {
      return new ApiClient(serverId).revokeInvite(code);
    },
  );
  ipcMain.handle(
    'invites:accept',
    async (_e, { serverId, code }: { serverId: string; code: string }) => {
      return new ApiClient(serverId).acceptInvite(code);
    },
  );
  /**
   * Прочитать публичную информацию об инвайте без авторизации. Для UI до
   * подключения: «Вас приглашают в проект X с ролью member».
   */
  ipcMain.handle(
    'invites:info',
    async (_e, { url, fingerprint, code }: { url: string; fingerprint: string; code: string }) => {
      return fetchInviteInfo({ url, fingerprint, code });
    },
  );
  /**
   * Подключиться к серверу по invite-токену: регистрирует нового юзера с
   * указанным кодом, после чего сервер автоматически добавляет его в проект
   * (логика в /auth/register). Сохраняем нового StoredServer и возвращаем
   * joinedProjectId для редиректа.
   */
  ipcMain.handle(
    'servers:joinByInvite',
    async (
      _e,
      params: {
        url: string;
        fingerprint: string;
        code: string;
        username: string;
        password: string;
      },
    ) => {
      const url = params.url.replace(/\/$/, '');
      const origin = new URL(url).origin;
      // Если уже есть сервер с таким origin — login + accept-invite (юзер
      // уже зарегистрирован), иначе register.
      const store = getServerStore();
      const existing = store.listServers().find((s) => s.origin === origin);
      let auth: Awaited<ReturnType<typeof registerOnServer>>;
      if (existing) {
        auth = await loginToServer({
          url,
          fingerprint: params.fingerprint,
          username: params.username,
          password: params.password,
        });
        // Поднимаем валидный access — accept-invite требует Bearer.
        // Сохраним токены сразу в store, чтобы ApiClient мог их использовать.
        const updated: StoredServer = {
          ...existing,
          accessToken: auth.tokens.accessToken,
          refreshToken: auth.tokens.refreshToken,
          accessExpiresAt: auth.tokens.accessExpiresAt,
          refreshExpiresAt: auth.tokens.refreshExpiresAt,
          username: auth.user.username,
          lastConnectedAt: Date.now(),
        };
        store.upsertServer(updated);
        const acc = await new ApiClient(updated.id).acceptInvite(params.code);
        ensureConnection(updated.id);
        return {
          server: stripSecrets(updated),
          joinedProjectId: acc.projectId,
        };
      } else {
        auth = await registerOnServer({
          url,
          fingerprint: params.fingerprint,
          username: params.username,
          password: params.password,
          inviteCode: params.code,
        });
        const stored: StoredServer = {
          id: crypto.randomUUID(),
          name: new URL(url).hostname,
          url,
          origin,
          fingerprint: params.fingerprint,
          username: auth.user.username,
          accessToken: auth.tokens.accessToken,
          refreshToken: auth.tokens.refreshToken,
          accessExpiresAt: auth.tokens.accessExpiresAt,
          refreshExpiresAt: auth.tokens.refreshExpiresAt,
          lastConnectedAt: Date.now(),
          // По умолчанию инвайт ведёт в Mode 1 (двусторонний синк).
          // Если на сервере есть внешние проекты — auto-detect позже
          // переключит в 'prod'.
          kind: 'projects',
          syncedFolders: [],
        };
        store.upsertServer(stored);
        ensureConnection(stored.id);
        return {
          server: stripSecrets(stored),
          joinedProjectId: auth.joinedProjectId ?? null,
        };
      }
    },
  );

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
  ipcMain.handle(
    'sync:dirtyFiles',
    async (_e, { serverId, projectId }: { serverId: string; projectId: string }) => {
      const sync = await ensureSyncEngine();
      return { files: sync.getDirtyFiles(serverId, projectId) };
    },
  );

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
    // Авто-детект kind для legacy-серверов (добавленных до появления поля).
    // Делаем один раз на старте: если у сервера kind ещё не задан, спрашиваем
    // его список проектов и решаем — есть ли external (Mode 2 / 'prod') или
    // только обычные (Mode 1 / 'projects'). Сетевые ошибки игнорим.
    void (async () => {
      const store = getServerStore();
      let changed = false;
      for (const s of store.listServers()) {
        if (s.kind) continue;
        try {
          const r = await new ApiClient(s.id).listProjects();
          const hasExternal = r.projects.some((p) => !!p.externalPath);
          const detected: 'projects' | 'prod' = hasExternal ? 'prod' : 'projects';
          store.upsertServer({ ...s, kind: detected });
          changed = true;
        } catch {
          /* offline / token expired — оставляем без kind, попробуем в следующий старт */
        }
      }
      if (changed) {
        getWin()?.webContents.send('servers:listChanged', { reason: 'auto-kind-detect' });
      }
    })();
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
    kind: s.kind ?? ('projects' as const),
  };
}

/**
 * Сравнение semver-строк. Возвращает -1/0/+1 как стандартный compareFn.
 * Префикс 'v' обрезается, нечисловые сегменты считаются 0. Этого
 * достаточно для наших версий вида X.Y.Z.
 */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.+-]/, 4)
      .slice(0, 3)
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const av = norm(a);
  const bv = norm(b);
  for (let i = 0; i < 3; i++) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai !== bi) return ai > bi ? 1 : -1;
  }
  return 0;
}

/**
 * На основании check-результата с хоста и ожидаемой клиентом версии решает,
 * что нужно делать: full-install / script-update / image-update / nothing.
 */
function computeInstallPlan(check: {
  installed: boolean;
  scriptVersion: string;
  serverVersion: string;
  containerRunning: boolean;
}): {
  action: 'full-install' | 'script-update' | 'image-update' | 'restart' | 'nothing';
  reason: string;
} {
  if (!check.installed) {
    return { action: 'full-install', reason: 'Хост ещё не настраивался' };
  }
  const scriptCmp = check.scriptVersion
    ? compareSemver(check.scriptVersion, EXPECTED_INSTALL_SCRIPT_VERSION)
    : -1;
  if (scriptCmp < 0) {
    return {
      action: 'script-update',
      reason: `Скрипт ${check.scriptVersion || '0.0.0'} < ${EXPECTED_INSTALL_SCRIPT_VERSION}`,
    };
  }
  const serverCmp = check.serverVersion
    ? compareSemver(check.serverVersion, EXPECTED_SERVER_VERSION)
    : -1;
  if (serverCmp < 0) {
    return {
      action: 'image-update',
      reason: `Сервер ${check.serverVersion || '0.0.0'} < ${EXPECTED_SERVER_VERSION}`,
    };
  }
  if (!check.containerRunning) {
    return { action: 'restart', reason: 'Контейнер не запущен' };
  }
  return { action: 'nothing', reason: 'Хост актуален' };
}
