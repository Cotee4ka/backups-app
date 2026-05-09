import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Persistent encrypted store for credentials and settings.
 *
 * Использует Electron `safeStorage` (DPAPI на Windows / Keychain на macOS /
 * libsecret на Linux). Всё чувствительное — пароли локального аккаунта,
 * JWT токены серверов, fingerprints — кладётся в зашифрованном виде.
 *
 * Если safeStorage недоступен (headless среда) — fallback на простой файл
 * в userData (с предупреждением в логе).
 */

interface StoredServer {
  id: string;
  name: string;
  url: string;
  origin: string;
  fingerprint: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  lastConnectedAt?: number;
  /**
   * Тип сервера для UI-разделения в сайдбаре:
   *   'projects' — наш backups-app сервер (двухсторонняя git-синхронизация
   *                папок проектов). Создаётся через «Создать сервер».
   *   'prod'     — продакшен-сервер пользователя с лёгким агентом, который
   *                отдаёт файлы read-only (односторонний mirror). Подключается
   *                через «Подключиться к проде».
   * Дефолт 'projects' — все существующие записи это backups-сервера.
   */
  kind?: 'projects' | 'prod';
  // sync settings
  syncedFolders: SyncedFolder[];
  externalSyncs?: ExternalSync[];
}

export interface ExternalSync {
  projectId: string;
  localPath: string;
  /** Юзер пометил «никогда не качать» (точное совпадение или префикс). */
  excludedPaths: string[];
  /** Юзер пометил «считать обычным», даже если файл выглядит как хранилище. */
  manualPaths: string[];
  /** Юзер вручную пометил «это хранилище данных, качать только по кнопке». */
  manualHeavyPaths?: string[];
  lastSyncAt?: number;
  /** Was last sync done with includeHeavy=true */
  lastSyncIncludedHeavy?: boolean;
  /** Перекрытие глобальных UI-настроек на уровне этого проекта. Каждое
   *  поле может быть undefined — тогда наследуется значение из глобала. */
  uiOverrides?: ProjectUiOverrides;
}

/**
 * Точечные перекрытия глобальных UI-настроек на уровне проекта. Если ключа
 * нет — наследуется значение из AppSettings. Если ключ присутствует — это
 * явное переопределение.
 */
export interface ProjectUiOverrides {
  foldersBottom?: boolean;
  dataFilesBottom?: boolean;
  changeFeedAfterSyncOnly?: boolean;
  changeFeedShowDiff?: boolean;
}

export interface SyncedFolder {
  projectId: string;
  projectName: string;
  localPath: string;
  enabled: boolean;
  addedAt: number;
}

interface LocalAccount {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
}

interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  accentTheme: 'indigo' | 'ocean' | 'forest' | 'sunset' | 'gold' | 'mono';
  language: 'ru' | 'en';
  autoLaunch: boolean;
  startMinimized: boolean;
  syncDebounceMs: number;
  syncPeriodicMs: number;
  /** Сортировать папки в самый низ списка (по умолчанию папки сверху). */
  foldersBottom: boolean;
  /** Опускать в конец списка всё помеченное «хранилище данных» / исключённое. */
  dataFilesBottom: boolean;
  /** В «Истории изменений» показывать только изменения после последней синхронизации. */
  changeFeedAfterSyncOnly: boolean;
  /** Считать +/- строк в «Истории изменений» (требует загрузки файлов). */
  changeFeedShowDiff: boolean;
}

interface StoreData {
  account: LocalAccount | null;
  servers: StoredServer[];
  settings: AppSettings;
  pendingFingerprints: Record<string, string>;
  recentProjects: { serverId: string; projectId: string; projectName: string; openedAt: number }[];
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accentTheme: 'indigo',
  language: 'ru',
  autoLaunch: false,
  startMinimized: false,
  syncDebounceMs: 10_000,
  syncPeriodicMs: 2 * 60 * 1000,
  foldersBottom: true,
  dataFilesBottom: true,
  changeFeedAfterSyncOnly: true,
  changeFeedShowDiff: true,
};

const DEFAULT_DATA: StoreData = {
  account: null,
  servers: [],
  settings: DEFAULT_SETTINGS,
  pendingFingerprints: {},
  recentProjects: [],
};

class Store {
  private data: StoreData = structuredClone(DEFAULT_DATA);
  private file: string;
  private encrypted: boolean;

  constructor() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'backups-app.store');
    this.encrypted = safeStorage.isEncryptionAvailable();
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = fs.readFileSync(this.file);
      let json: string;
      if (this.encrypted) {
        try {
          json = safeStorage.decryptString(raw);
        } catch {
          json = raw.toString('utf8');
        }
      } else {
        json = raw.toString('utf8');
      }
      const parsed = JSON.parse(json) as Partial<StoreData>;
      this.data = {
        ...DEFAULT_DATA,
        ...parsed,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      };
    } catch (e) {
      console.error('[store] failed to load, starting fresh:', e);
    }
  }

  private save(): void {
    const json = JSON.stringify(this.data, null, 2);
    const out = this.encrypted ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, this.file);
    this.writeCredentialsBridge();
  }

  /**
   * Сбрасывает usable-без-Electron'а копию серверных кредов в
   * ~/.backups-app/credentials.json. Это нужно хук-скриптам Claude Code и
   * MCP-серверу — у них нет доступа к safeStorage и к нашему зашифрованному
   * Electron-store'у. Файл хранит только то, что нужно для API-вызовов:
   * URL, fingerprint, JWT-пара. Безопасностно: 0600 + ~/ под пользователем.
   *
   * Перезаписывается на каждом save() — токены синхронизируются автоматически
   * после рефреша.
   */
  private writeCredentialsBridge(): void {
    try {
      const dir = path.join(os.homedir(), '.backups-app');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'credentials.json');
      const tmp = file + '.tmp';
      const payload = {
        writtenAt: Date.now(),
        servers: this.data.servers.map((s) => ({
          id: s.id,
          url: s.url,
          origin: s.origin,
          fingerprint: s.fingerprint,
          username: s.username,
          accessToken: s.accessToken,
          refreshToken: s.refreshToken,
          accessExpiresAt: s.accessExpiresAt,
          refreshExpiresAt: s.refreshExpiresAt,
          kind: s.kind ?? 'projects',
        })),
      };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* Windows не всегда уважает chmod, окей */
      }
    } catch (e) {
      console.error('[store] credentials bridge write failed:', e);
    }
  }

  // --- Local account ---

  hasAccount(): boolean {
    return this.data.account !== null;
  }

  getAccount(): LocalAccount | null {
    return this.data.account;
  }

  createAccount(username: string, password: string): void {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto
      .pbkdf2Sync(password, salt, 200_000, 32, 'sha256')
      .toString('hex');
    this.data.account = {
      username,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: Date.now(),
    };
    this.save();
  }

  verifyAccount(username: string, password: string): boolean {
    const a = this.data.account;
    if (!a || a.username !== username) return false;
    const hash = crypto
      .pbkdf2Sync(password, a.passwordSalt, 200_000, 32, 'sha256')
      .toString('hex');
    if (hash.length !== a.passwordHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.passwordHash, 'hex'));
  }

  resetAccount(): void {
    this.data = structuredClone(DEFAULT_DATA);
    this.save();
  }

  // --- Servers ---

  listServers(): StoredServer[] {
    return this.data.servers;
  }

  getServer(id: string): StoredServer | undefined {
    return this.data.servers.find((s) => s.id === id);
  }

  getServerByOrigin(origin: string): StoredServer | undefined {
    return this.data.servers.find((s) => s.origin === origin);
  }

  upsertServer(s: StoredServer): void {
    const idx = this.data.servers.findIndex((x) => x.id === s.id);
    if (idx === -1) this.data.servers.push(s);
    else this.data.servers[idx] = s;
    this.save();
  }

  deleteServer(id: string): void {
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this.save();
  }

  // --- Pending fingerprints (during install/connect wizard) ---

  setPendingFingerprint(origin: string, fingerprint: string): void {
    this.data.pendingFingerprints[origin] = fingerprint;
    this.save();
  }

  getPendingFingerprint(origin: string): string | undefined {
    return this.data.pendingFingerprints[origin];
  }

  clearPendingFingerprint(origin: string): void {
    delete this.data.pendingFingerprints[origin];
    this.save();
  }

  // --- Synced folders ---

  setSyncedFolder(serverId: string, folder: SyncedFolder): void {
    const s = this.getServer(serverId);
    if (!s) return;
    const idx = s.syncedFolders.findIndex((f) => f.projectId === folder.projectId);
    if (idx === -1) s.syncedFolders.push(folder);
    else s.syncedFolders[idx] = folder;
    this.save();
  }

  removeSyncedFolder(serverId: string, projectId: string): void {
    const s = this.getServer(serverId);
    if (!s) return;
    s.syncedFolders = s.syncedFolders.filter((f) => f.projectId !== projectId);
    this.save();
  }

  // --- External syncs ---

  getExternalSync(serverId: string, projectId: string): ExternalSync | undefined {
    return this.getServer(serverId)?.externalSyncs?.find((s) => s.projectId === projectId);
  }

  setExternalSync(serverId: string, sync: ExternalSync): void {
    const s = this.getServer(serverId);
    if (!s) return;
    if (!s.externalSyncs) s.externalSyncs = [];
    const idx = s.externalSyncs.findIndex((x) => x.projectId === sync.projectId);
    if (idx === -1) s.externalSyncs.push(sync);
    else s.externalSyncs[idx] = sync;
    this.save();
  }

  removeExternalSync(serverId: string, projectId: string): void {
    const s = this.getServer(serverId);
    if (!s?.externalSyncs) return;
    s.externalSyncs = s.externalSyncs.filter((x) => x.projectId !== projectId);
    this.save();
  }

  // --- Settings ---

  getSettings(): AppSettings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  // --- Recent projects ---

  pushRecent(serverId: string, projectId: string, projectName: string): void {
    this.data.recentProjects = [
      { serverId, projectId, projectName, openedAt: Date.now() },
      ...this.data.recentProjects.filter(
        (r) => !(r.serverId === serverId && r.projectId === projectId),
      ),
    ].slice(0, 20);
    this.save();
  }

  getRecent(): StoreData['recentProjects'] {
    return this.data.recentProjects;
  }
}

let _store: Store | null = null;

export function getServerStore(): Store {
  if (!_store) _store = new Store();
  return _store;
}

export type { StoredServer, LocalAccount, AppSettings };
