import { create } from 'zustand';

export type AppRoute =
  | { name: 'onboarding' }
  | { name: 'login' }
  | { name: 'dashboard' }
  | { name: 'wizard-create' }
  | { name: 'wizard-connect' }
  | { name: 'server'; serverId: string }
  | { name: 'project'; serverId: string; projectId: string; projectName?: string }
  | { name: 'settings' };

export interface ServerSummary {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
  username: string;
  lastConnectedAt?: number;
  /**
   * Тип сервера: 'projects' — наш бэкап-сервер с двухсторонней синхронизацией,
   * 'prod' — продакшен с лёгким агентом для одностороннего mirror'а.
   * Сайдбар разделяет их по этому полю.
   */
  kind?: 'projects' | 'prod';
  syncedFolders: Array<{
    projectId: string;
    projectName: string;
    localPath: string;
    enabled: boolean;
    addedAt: number;
  }>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  createdBy: string;
  defaultBranch: string;
}

export interface UploadProgressInfo {
  phase: 'preparing' | 'cloning' | 'init' | 'scanning' | 'staging' | 'committing' | 'pushing' | 'done';
  files?: number;
  totalBytes?: number;
  startedAt: number;
  etaSec?: number;
}

interface SyncStatus {
  state: 'idle' | 'dirty' | 'pushing' | 'pulling' | 'error';
  detail?: string;
  dirtyFiles?: number;
  upload?: UploadProgressInfo;
  pendingRemote?: {
    sha: string;
    authorId: string;
    authorName: string;
    timestamp: number;
    filesChanged: number;
    kind: 'push' | 'restore';
  } | null;
}

interface PresenceUser {
  userId: string;
  username: string;
}

interface AppState {
  isAuthed: boolean;
  hasAccount: boolean;
  username: string | null;

  servers: ServerSummary[];
  syncStatus: Map<string, SyncStatus>; // key: serverId::projectId
  presence: Map<string, PresenceUser[]>; // key: serverId::projectId
  toasts: Array<{ id: string; type: 'success' | 'error' | 'info'; text: string }>;

  setHasAccount: (v: boolean) => void;
  setAuthed: (v: boolean, username?: string | null) => void;
  setServers: (s: ServerSummary[]) => void;
  upsertServer: (s: ServerSummary) => void;
  removeServer: (id: string) => void;
  setSyncStatus: (key: string, s: SyncStatus) => void;
  setPresence: (key: string, users: PresenceUser[]) => void;
  addToast: (t: { type: 'success' | 'error' | 'info'; text: string }) => void;
  removeToast: (id: string) => void;

  refreshServers: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  isAuthed: false,
  hasAccount: false,
  username: null,
  servers: [],
  syncStatus: new Map(),
  presence: new Map(),
  toasts: [],

  setHasAccount: (v) => set({ hasAccount: v }),
  setAuthed: (v, username = null) => set({ isAuthed: v, username }),
  setServers: (s) => set({ servers: s }),
  upsertServer: (s) =>
    set((st) => {
      const idx = st.servers.findIndex((x) => x.id === s.id);
      const next = [...st.servers];
      if (idx === -1) next.push(s);
      else next[idx] = s;
      return { servers: next };
    }),
  removeServer: (id) =>
    set((st) => ({ servers: st.servers.filter((s) => s.id !== id) })),
  setSyncStatus: (key, s) =>
    set((st) => {
      const m = new Map(st.syncStatus);
      m.set(key, s);
      return { syncStatus: m };
    }),
  setPresence: (key, users) =>
    set((st) => {
      const m = new Map(st.presence);
      m.set(key, users);
      return { presence: m };
    }),
  addToast: (t) =>
    set((st) => ({
      toasts: [...st.toasts, { ...t, id: Math.random().toString(36).slice(2) }],
    })),
  removeToast: (id) =>
    set((st) => ({ toasts: st.toasts.filter((x) => x.id !== id) })),

  refreshServers: async () => {
    const list = (await window.backupsApp.servers.list()) as ServerSummary[];
    set({ servers: list });
  },
}));

export function statusKey(serverId: string, projectId: string): string {
  return `${serverId}::${projectId}`;
}
