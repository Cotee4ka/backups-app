import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // ---------- Local account ----------
  account: {
    has: () => ipcRenderer.invoke('account:has'),
    create: (username: string, password: string) =>
      ipcRenderer.invoke('account:create', { username, password }),
    verify: (username: string, password: string) =>
      ipcRenderer.invoke('account:verify', { username, password }),
    reset: () => ipcRenderer.invoke('account:reset'),
  },
  // ---------- Servers ----------
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    install: (params: {
      sshHost: string;
      sshPort: number;
      sshUser: string;
      sshPassword: string;
      serverPort: number;
      adminUser: string;
      kind?: 'projects' | 'prod';
    }) => ipcRenderer.invoke('servers:install', params),
    connect: (params: {
      url: string;
      username: string;
      password: string;
      kind?: 'projects' | 'prod';
    }) => ipcRenderer.invoke('servers:connect', params),
    delete: (id: string) => ipcRenderer.invoke('servers:delete', id),
    rename: (id: string, name: string) =>
      ipcRenderer.invoke('servers:rename', { serverId: id, name }),
    setKind: (id: string, kind: 'projects' | 'prod') =>
      ipcRenderer.invoke('servers:setKind', { serverId: id, kind }),
    checkVersion: (id: string) => ipcRenderer.invoke('servers:checkVersion', { serverId: id }),
    verifyCurrent: (id: string) => ipcRenderer.invoke('servers:verifyCurrent', { serverId: id }),
    onListChanged: (cb: (reason: string) => void) => {
      const sub = (_e: unknown, p: { reason: string }) => cb(p.reason);
      ipcRenderer.on('servers:listChanged', sub);
      return () => {
        ipcRenderer.removeListener('servers:listChanged', sub);
      };
    },
    onInstallLog: (cb: (msg: { line: string; type: 'stdout' | 'stderr' | 'info' }) => void) => {
      const sub = (_e: unknown, msg: { line: string; type: 'stdout' | 'stderr' | 'info' }) =>
        cb(msg);
      ipcRenderer.on('servers:install:log', sub);
      return () => {
        ipcRenderer.removeListener('servers:install:log', sub);
      };
    },
  },
  // ---------- v2 installer (used by ConnectServerWizard + version-gate) ----------
  installer: {
    check: (params: {
      sshHost: string;
      sshPort: number;
      sshUser: string;
      sshPassword: string;
    }) => ipcRenderer.invoke('installer:check', params),
    apply: (params: {
      sshHost: string;
      sshPort: number;
      sshUser: string;
      sshPassword: string;
      serverPort: number;
      adminUser?: string;
      publicUrl?: string;
      imageRef?: string;
      autoConnect?: boolean;
      kind?: 'projects' | 'prod';
    }) => ipcRenderer.invoke('installer:apply', params),
    installSshKey: (params: {
      sshHost: string;
      sshPort: number;
      sshUser: string;
      sshPassword: string;
      publicKey: string;
    }) => ipcRenderer.invoke('installer:installSshKey', params),
    onProgress: (
      cb: (p: {
        type: 'phase' | 'stdout' | 'stderr' | 'info';
        phase?: string;
        line?: string;
      }) => void,
    ) => {
      const sub = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
      ipcRenderer.on('installer:progress', sub);
      return () => {
        ipcRenderer.removeListener('installer:progress', sub);
      };
    },
  },
  // ---------- Projects ----------
  projects: {
    list: (serverId: string) => ipcRenderer.invoke('projects:list', serverId),
    create: (serverId: string, name: string, description?: string) =>
      ipcRenderer.invoke('projects:create', { serverId, name, description }),
    createExternal: (serverId: string, name: string, hostPath: string, description?: string) =>
      ipcRenderer.invoke('projects:createExternal', { serverId, name, hostPath, description }),
    browseHost: (serverId: string, hostPath: string) =>
      ipcRenderer.invoke('projects:browseHost', { serverId, hostPath }),
    delete: (serverId: string, projectId: string, opts?: { deleteLocalFolder?: boolean }) =>
      ipcRenderer.invoke('projects:delete', {
        serverId,
        projectId,
        deleteLocalFolder: opts?.deleteLocalFolder ?? false,
      }),
    history: (serverId: string, projectId: string, limit?: number) =>
      ipcRenderer.invoke('projects:history', { serverId, projectId, limit }),
    commit: (serverId: string, projectId: string, sha: string) =>
      ipcRenderer.invoke('projects:commit', { serverId, projectId, sha }),
    restore: (serverId: string, projectId: string, sha: string, strategy: 'revert' | 'reset') =>
      ipcRenderer.invoke('projects:restore', { serverId, projectId, sha, strategy }),
    members: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('projects:members', { serverId, projectId }),
    addMember: (serverId: string, projectId: string, username: string, role: string) =>
      ipcRenderer.invoke('projects:addMember', { serverId, projectId, username, role }),
    removeMember: (serverId: string, projectId: string, userId: string) =>
      ipcRenderer.invoke('projects:removeMember', { serverId, projectId, userId }),
    setMemberRole: (
      serverId: string,
      projectId: string,
      userId: string,
      role: 'admin' | 'member' | 'viewer',
    ) => ipcRenderer.invoke('projects:setMemberRole', { serverId, projectId, userId, role }),
    tree: (serverId: string, projectId: string, pathInRepo = '', ref = 'HEAD') =>
      ipcRenderer.invoke('projects:tree', { serverId, projectId, path: pathInRepo, ref }),
    fileHistory: (serverId: string, projectId: string, pathInRepo: string, limit = 100) =>
      ipcRenderer.invoke('projects:fileHistory', { serverId, projectId, path: pathInRepo, limit }),
    downloadFile: (
      serverId: string,
      projectId: string,
      pathInRepo: string,
      ref = 'HEAD',
      suggestedName?: string,
    ) =>
      ipcRenderer.invoke('projects:downloadFile', {
        serverId,
        projectId,
        path: pathInRepo,
        ref,
        suggestedName,
      }),
    openFileLocally: (
      serverId: string,
      projectId: string,
      pathInRepo: string,
      ref = 'HEAD',
    ) =>
      ipcRenderer.invoke('projects:openFileLocally', {
        serverId,
        projectId,
        path: pathInRepo,
        ref,
      }),
  },
  // ---------- External one-way sync (read-only mirror → local) ----------
  externalSync: {
    get: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('externalSync:get', { serverId, projectId }),
    chooseFolder: () => ipcRenderer.invoke('externalSync:chooseFolder'),
    openFolder: (localPath: string) => ipcRenderer.invoke('externalSync:openFolder', { localPath }),
    listHeavy: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('externalSync:listHeavy', { serverId, projectId }),
    detectDataStore: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('externalSync:detectDataStore', { serverId, projectId }),
    fileStatuses: (
      serverId: string,
      projectId: string,
      files: Array<{ relPath: string; size: number; mtime: number }>,
    ) => ipcRenderer.invoke('externalSync:fileStatuses', { serverId, projectId, files }),
    listAllFiles: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('externalSync:listAllFiles', { serverId, projectId }),
    downloadToLocal: (serverId: string, projectId: string, pathInRepo: string, ref = 'HEAD') =>
      ipcRenderer.invoke('externalSync:downloadToLocal', {
        serverId,
        projectId,
        path: pathInRepo,
        ref,
      }),
    diffStats: (serverId: string, projectId: string, pathInRepo: string) =>
      ipcRenderer.invoke('externalSync:diffStats', {
        serverId,
        projectId,
        path: pathInRepo,
      }),
    run: (params: {
      serverId: string;
      projectId: string;
      localPath: string;
      includeHeavy: boolean;
      manualPaths?: string[];
      excludedPaths?: string[];
      manualHeavyPaths?: string[];
      prune?: boolean;
    }) => ipcRenderer.invoke('externalSync:run', params),
    setRules: (params: {
      serverId: string;
      projectId: string;
      manualPaths?: string[];
      excludedPaths?: string[];
      manualHeavyPaths?: string[];
    }) => ipcRenderer.invoke('externalSync:setRules', params),
    setUiOverride: (params: {
      serverId: string;
      projectId: string;
      key: 'foldersBottom' | 'dataFilesBottom' | 'changeFeedAfterSyncOnly' | 'changeFeedShowDiff';
      value: boolean | null;
    }) => ipcRenderer.invoke('externalSync:setUiOverride', params),
    onProgress: (
      cb: (p: {
        serverId: string;
        projectId: string;
        phase: 'listing' | 'comparing' | 'downloading' | 'cleaning' | 'done' | 'error';
        totalFiles?: number;
        processedFiles?: number;
        totalBytes?: number;
        downloadedBytes?: number;
        currentFile?: string;
        error?: string;
      }) => void,
    ) => {
      const sub = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
      ipcRenderer.on('externalSync:progress', sub);
      return () => {
        ipcRenderer.removeListener('externalSync:progress', sub);
      };
    },
  },
  // ---------- Sync ----------
  sync: {
    chooseFolder: (opts?: { mode?: 'download' | 'upload' | 'auto'; suggestedName?: string }) =>
      ipcRenderer.invoke('sync:chooseFolder', opts),
    start: (params: {
      serverId: string;
      projectId: string;
      localPath: string;
      mode?: 'download' | 'upload' | 'auto';
    }) => ipcRenderer.invoke('sync:start', params),
    stop: (params: { serverId: string; projectId: string }) =>
      ipcRenderer.invoke('sync:stop', params),
    flushNow: (params: { serverId: string; projectId: string }) =>
      ipcRenderer.invoke('sync:flushNow', params),
    applyRemote: (params: { serverId: string; projectId: string }) =>
      ipcRenderer.invoke('sync:applyRemote', params) as Promise<{ ok: boolean }>,
    listSynced: (serverId: string) => ipcRenderer.invoke('sync:listSynced', serverId),
    dirtyFiles: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('sync:dirtyFiles', { serverId, projectId }) as Promise<{
        files: string[];
      }>,
    onStatus: (
      cb: (s: {
        serverId: string;
        projectId: string;
        state: string;
        detail?: string;
        dirtyFiles?: number;
        upload?: {
          phase: string;
          files?: number;
          totalBytes?: number;
          startedAt: number;
          etaSec?: number;
        };
        pendingRemote?: {
          sha: string;
          authorId: string;
          authorName: string;
          timestamp: number;
          filesChanged: number;
          kind: 'push' | 'restore';
        } | null;
      }) => void,
    ) => {
      const sub = (_e: unknown, s: Parameters<typeof cb>[0]) => cb(s);
      ipcRenderer.on('sync:status', sub);
      return () => {
        ipcRenderer.removeListener('sync:status', sub);
      };
    },
  },
  // ---------- Invites (project-level link invites) ----------
  invites: {
    /**
     * Создаёт project-invite на сервере и возвращает готовую строку-токен
     * `bapi.…` для отдачи другу. UI просто copy-to-clipboard.
     */
    createProject: (params: {
      serverId: string;
      projectId: string;
      role: 'admin' | 'member' | 'viewer';
      ttlSec: number;
    }) =>
      ipcRenderer.invoke('invites:createProject', params) as Promise<{
        code: string;
        token: string;
        expiresAt: number;
        role: 'admin' | 'member' | 'viewer';
        projectId: string;
        projectName: string;
      }>,
    listProject: (serverId: string, projectId: string) =>
      ipcRenderer.invoke('invites:listProject', { serverId, projectId }) as Promise<{
        invites: Array<{
          code: string;
          role: string;
          expiresAt: number;
          usedBy: string | null;
          usedByUsername: string | null;
          usedAt: number | null;
          revoked: number;
          createdBy: string;
          createdByUsername: string | null;
        }>;
      }>,
    revoke: (serverId: string, code: string) =>
      ipcRenderer.invoke('invites:revoke', { serverId, code }) as Promise<{
        ok: boolean;
      }>,
    accept: (serverId: string, code: string) =>
      ipcRenderer.invoke('invites:accept', { serverId, code }) as Promise<{
        ok: boolean;
        projectId: string;
        role: string;
      }>,
    /**
     * Прочитать публичную инфу об инвайте до подключения. Используется при
     * вставке `bapi.…` токена в ConnectServerWizard, чтобы показать «Вас
     * приглашают в проект X с ролью Y».
     */
    info: (params: { url: string; fingerprint: string; code: string }) =>
      ipcRenderer.invoke('invites:info', params) as Promise<{
        code: string;
        role: string;
        expiresAt: number;
        projectId: string | null;
        projectName: string | null;
      }>,
    joinByInvite: (params: {
      url: string;
      fingerprint: string;
      code: string;
      username: string;
      password: string;
    }) =>
      ipcRenderer.invoke('servers:joinByInvite', params) as Promise<{
        server: { id: string; name: string; url: string };
        joinedProjectId: string | null;
      }>,
  },
  // ---------- Live updates from server (relayed from WS) ----------
  events: {
    on: (
      event:
        | 'repo:updated'
        | 'project:restored'
        | 'project:deleted'
        | 'presence:join'
        | 'presence:leave'
        | 'presence:list',
      cb: (payload: unknown) => void,
    ) => {
      const channel = `event:${event}`;
      const sub = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(channel, sub);
      return () => {
        ipcRenderer.removeListener(channel, sub);
      };
    },
  },
  // ---------- Audit ----------
  audit: {
    list: (serverId: string, opts: { projectId?: string; userId?: string; limit?: number }) =>
      ipcRenderer.invoke('audit:list', { serverId, ...opts }),
  },
  // ---------- Settings / system ----------
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:update', patch),
    setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('settings:autoLaunch', enabled),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (p: string) => ipcRenderer.invoke('shell:showItemInFolder', p),
    openPath: (p: string) =>
      ipcRenderer.invoke('shell:openPath', p) as Promise<{ ok: boolean; error: string | null }>,
  },
  // ---------- App info ----------
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    platform: () => process.platform,
  },
};

contextBridge.exposeInMainWorld('backupsApp', api);

declare global {
  interface Window {
    backupsApp: typeof api;
  }
}

export type BackupsApi = typeof api;
