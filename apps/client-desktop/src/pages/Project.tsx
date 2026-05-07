import React from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { useAppStore, statusKey } from '@/store/app-store';
import { copyToClipboard, formatRelativeTime, shortSha } from '@/lib/utils';
import {
  FolderGit2,
  Folder,
  History,
  Users,
  Settings as Cog,
  Save,
  RefreshCcw,
  Pause,
  Plus,
  RotateCcw,
  Activity,
  AlertCircle,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Download,
  Upload,
  Loader2,
  CheckCircle2,
  ChevronLeft,
  FileText,
  ExternalLink,
  Home,
  Database,
  FolderDown,
  FolderOpen,
  CloudDownload,
} from 'lucide-react';
import { Spinner, DotsLoader } from '@/components/ui/spinner';
import { isHeavyPath } from '@/lib/heavy-files';

interface CommitInfo {
  sha: string;
  message: string;
  authorId: string;
  authorName: string;
  timestamp: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface MemberRow {
  userId: string;
  username: string;
  role: string;
  joinedAt: number;
}

type Tab = 'files' | 'history' | 'members' | 'settings';

export const ProjectPage = () => {
  const { serverId = '', projectId = '' } = useParams();
  const nav = useNavigate();
  const servers = useAppStore((s) => s.servers);
  const refresh = useAppStore((s) => s.refreshServers);
  const addToast = useAppStore((s) => s.addToast);
  const syncStatus = useAppStore((s) => s.syncStatus.get(statusKey(serverId, projectId)));
  const presence = useAppStore((s) => s.presence.get(statusKey(serverId, projectId))) ?? [];

  const server = servers.find((s) => s.id === serverId);
  const synced = server?.syncedFolders.find((f) => f.projectId === projectId);

  const [project, setProject] = React.useState<{
    name: string;
    description?: string;
    externalPath?: string;
  } | null>(null);
  const isExternal = !!project?.externalPath;
  const [tab, setTab] = React.useState<Tab>('files');
  const [commits, setCommits] = React.useState<CommitInfo[]>([]);
  const [members, setMembers] = React.useState<MemberRow[]>([]);

  const [restoreSha, setRestoreSha] = React.useState<string | null>(null);
  const [addMemberOpen, setAddMemberOpen] = React.useState(false);
  const [inviteUsername, setInviteUsername] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState('member');

  React.useEffect(() => {
    if (!server) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, projectId]);

  React.useEffect(() => {
    if (isExternal && tab === 'history') setTab('files');
  }, [isExternal, tab]);

  async function load() {
    try {
      const projects = (await window.backupsApp.projects.list(serverId)) as {
        projects: { id: string; name: string; description?: string; externalPath?: string }[];
      };
      const p = projects.projects.find((x) => x.id === projectId);
      if (p) setProject(p);
      if (p?.externalPath) {
        setCommits([]);
      } else {
        const h = (await window.backupsApp.projects.history(serverId, projectId, 100)) as {
          commits: CommitInfo[];
        };
        setCommits(h.commits);
      }
      const m = (await window.backupsApp.projects.members(serverId, projectId)) as { members: MemberRow[] };
      setMembers(m.members);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  const [transferOpen, setTransferOpen] = React.useState<null | 'upload' | 'download'>(null);

  async function startSync(mode: 'download' | 'upload') {
    const folder = (await window.backupsApp.sync.chooseFolder({
      mode,
      suggestedName: project?.name,
    })) as string | null;
    if (!folder) return;
    if (
      mode === 'upload' &&
      !confirm(
        `Загрузить содержимое папки\n${folder}\nна сервер как первоначальную версию проекта «${project?.name ?? ''}»?\n\nДальше папка будет синхронизироваться автоматически.`,
      )
    ) {
      return;
    }
    setTransferOpen(mode);
    try {
      await window.backupsApp.sync.start({ serverId, projectId, localPath: folder, mode });
      addToast({
        type: 'success',
        text:
          mode === 'upload'
            ? `Папка загружена и синхронизируется: ${folder}`
            : `Проект скачан и синхронизируется: ${folder}`,
      });
      await refresh();
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setTransferOpen(null);
    }
  }

  async function stopSync() {
    if (!confirm('Остановить синхронизацию? Локальные файлы останутся на месте.')) return;
    await window.backupsApp.sync.stop({ serverId, projectId });
    await refresh();
    addToast({ type: 'info', text: 'Синхронизация остановлена' });
  }

  async function flushNow() {
    await window.backupsApp.sync.flushNow({ serverId, projectId });
    addToast({ type: 'info', text: 'Принудительный коммит и push' });
  }

  async function doRestore(sha: string, strategy: 'revert' | 'reset') {
    try {
      await window.backupsApp.projects.restore(serverId, projectId, sha, strategy);
      addToast({ type: 'success', text: `Восстановлено из ${shortSha(sha)}` });
      setRestoreSha(null);
      await load();
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  async function addMember() {
    try {
      await window.backupsApp.projects.addMember(serverId, projectId, inviteUsername.trim(), inviteRole);
      setAddMemberOpen(false);
      setInviteUsername('');
      const m = (await window.backupsApp.projects.members(serverId, projectId)) as { members: MemberRow[] };
      setMembers(m.members);
      addToast({ type: 'success', text: 'Участник добавлен' });
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  if (!server) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-8 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="accent-bg grid h-14 w-14 place-items-center rounded-2xl">
            <FolderGit2 className="accent-fg h-7 w-7" />
          </div>
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Link to={`/server/${serverId}`} className="hover:underline">
                {server.name}
              </Link>
              <ChevronRight className="h-3 w-3" />
              <span>{isExternal ? 'папка с сервера' : 'проект'}</span>
            </div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{project?.name ?? '—'}</h1>
              {isExternal && <Badge variant="info">read-only</Badge>}
            </div>
            {isExternal ? (
              <p className="text-sm text-muted-foreground font-mono">{project!.externalPath}</p>
            ) : (
              project?.description && (
                <p className="text-sm text-muted-foreground">{project.description}</p>
              )
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isExternal ? null : synced?.enabled ? (
            <>
              <SyncBadge status={syncStatus?.state ?? 'idle'} />
              <Button variant="outline" onClick={flushNow}>
                <Save className="h-4 w-4" /> Сохранить сейчас
              </Button>
              <Button variant="outline" onClick={() => window.backupsApp.settings.showItemInFolder(synced.localPath)}>
                <Folder className="h-4 w-4" /> Открыть папку
              </Button>
              <Button variant="destructive" onClick={stopSync}>
                <Pause className="h-4 w-4" /> Остановить
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => startSync('upload')}>
                <Upload className="h-4 w-4" /> Загрузить на сервер
              </Button>
              <Button variant="gradient" onClick={() => startSync('download')}>
                <Download className="h-4 w-4" /> Синхронизировать с ПК
              </Button>
            </>
          )}
        </div>
      </header>

      {synced?.enabled && (
        <Card className="border-emerald-500/20">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3 text-sm">
              <Activity className="h-4 w-4 text-emerald-400" />
              <span className="text-muted-foreground">Папка:</span>
              <code className="rounded bg-muted/40 px-2 py-1 font-mono text-xs">{synced.localPath}</code>
              {syncStatus?.dirtyFiles ? (
                <Badge variant="warning">{syncStatus.dirtyFiles} к коммиту</Badge>
              ) : null}
              {syncStatus?.detail && (
                <span className="text-xs text-muted-foreground">{syncStatus.detail}</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {presence.length > 1 && (
                <>
                  <Users className="h-3.5 w-3.5" />
                  Сейчас работают: {presence.map((p) => p.username).join(', ')}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-1 rounded-lg border border-border bg-card/40 p-1">
        <TabBtn active={tab === 'files'} onClick={() => setTab('files')} icon={<Folder className="h-4 w-4" />}>
          Файлы
        </TabBtn>
        {!isExternal && (
          <TabBtn active={tab === 'history'} onClick={() => setTab('history')} icon={<History className="h-4 w-4" />}>
            История
          </TabBtn>
        )}
        <TabBtn active={tab === 'members'} onClick={() => setTab('members')} icon={<Users className="h-4 w-4" />}>
          Участники
        </TabBtn>
        <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Cog className="h-4 w-4" />}>
          Настройки
        </TabBtn>
      </div>

      {tab === 'files' && (
        <FileBrowser
          serverId={serverId}
          projectId={projectId}
          projectName={project?.name ?? ''}
          syncedFolder={synced?.localPath ?? null}
          isExternal={isExternal}
        />
      )}

      {tab === 'history' && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>История изменений</CardTitle>
              <CardDescription>Каждый коммит = точка восстановления.</CardDescription>
            </div>
            <Button variant="outline" onClick={load}>
              <RefreshCcw className="h-4 w-4" /> Обновить
            </Button>
          </CardHeader>
          <CardContent>
            {commits.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
                Истории нет — это новый проект. Сделайте первый коммит, синхронизировав папку.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {commits.map((c) => (
                  <li key={c.sha} className="flex items-start gap-4 py-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted/40 text-xs font-mono">
                      {c.authorName.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {parseAuthorMessage(c.message)}
                        </span>
                        <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {shortSha(c.sha)}
                        </code>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>{c.authorName}</span>
                        <span>·</span>
                        <span>{formatRelativeTime(c.timestamp)}</span>
                        {c.filesChanged > 0 && (
                          <>
                            <span>·</span>
                            <span>{c.filesChanged} файлов</span>
                          </>
                        )}
                        {(c.insertions > 0 || c.deletions > 0) && (
                          <>
                            <span className="text-emerald-400">+{c.insertions}</span>
                            <span className="text-destructive">−{c.deletions}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRestoreSha(c.sha)}
                      title="Откатить на эту версию"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'members' && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>Участники</CardTitle>
              <CardDescription>Кто имеет доступ к проекту.</CardDescription>
            </div>
            <Button variant="gradient" onClick={() => setAddMemberOpen(true)}>
              <Plus className="h-4 w-4" /> Добавить
            </Button>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-4 py-3">
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-muted/40 text-xs font-semibold">
                    {m.username.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{m.username}</div>
                    <div className="text-xs text-muted-foreground">с {formatRelativeTime(m.joinedAt)}</div>
                  </div>
                  <Badge variant={m.role === 'owner' ? 'success' : 'secondary'}>{m.role}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {tab === 'settings' && (
        <Card>
          <CardHeader>
            <CardTitle>Настройки проекта</CardTitle>
            <CardDescription>
              Полная конфигурация хранится в файле <code className="font-mono">.backupsapp.json</code>{' '}
              в корне репозитория.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <DangerRow
              title="Удалить проект"
              description="Удаляет проект и все его бекапы на сервере. Безвозвратно."
              action={
                <Button
                  variant="destructive"
                  onClick={async () => {
                    if (!confirm(`Удалить проект «${project?.name}» вместе со всей историей?`))
                      return;
                    try {
                      await window.backupsApp.projects.delete(serverId, projectId);
                      addToast({ type: 'success', text: 'Проект удалён' });
                      nav(`/server/${serverId}`);
                    } catch (e) {
                      addToast({ type: 'error', text: (e as Error).message });
                    }
                  }}
                >
                  Удалить
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}

      <Dialog
        open={!!restoreSha}
        onClose={() => setRestoreSha(null)}
        title="Восстановить версию"
        description="Все клиенты автоматически подхватят изменение."
      >
        <div className="space-y-4 text-sm">
          <p>
            Версия:{' '}
            <code className="rounded bg-muted/40 px-2 py-1 font-mono text-xs">
              {restoreSha ? shortSha(restoreSha) : ''}
            </code>
          </p>
          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Revert</strong> — добавит «обратный» коммит.
            Безопасно. Сохраняет всю историю.
            <br />
            <strong className="text-foreground">Reset (snapshot)</strong> — создаёт коммит с
            точным содержимым старой версии. Текущее состояние остаётся в истории.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => restoreSha && doRestore(restoreSha, 'revert')}>
              Revert
            </Button>
            <Button variant="gradient" onClick={() => restoreSha && doRestore(restoreSha, 'reset')}>
              Snapshot reset
            </Button>
          </div>
        </div>
      </Dialog>

      <TransferProgressDialog
        mode={transferOpen}
        upload={syncStatus?.upload}
        detail={syncStatus?.detail}
        state={syncStatus?.state}
      />

      <Dialog
        open={addMemberOpen}
        onClose={() => setAddMemberOpen(false)}
        title="Добавить участника"
        description="Пользователь должен быть зарегистрирован на этом сервере."
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="iu">Имя пользователя</Label>
            <Input id="iu" value={inviteUsername} onChange={(e) => setInviteUsername(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ir">Роль</Label>
            <select
              id="ir"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background/40 px-3 text-sm focus-ring"
            >
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAddMemberOpen(false)}>Отмена</Button>
            <Button variant="gradient" onClick={addMember}>Добавить</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};

const TabBtn = ({
  active,
  onClick,
  children,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    className={
      'inline-flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition ' +
      (active ? 'bg-card text-foreground shadow' : 'text-muted-foreground hover:text-foreground')
    }
  >
    {icon}
    {children}
  </button>
);

const SyncBadge = ({ status }: { status: 'idle' | 'dirty' | 'pushing' | 'pulling' | 'error' }) => {
  if (status === 'idle') return <Badge variant="success">в синхроне</Badge>;
  if (status === 'dirty') return <Badge variant="warning">есть изменения</Badge>;
  if (status === 'pushing') return <Badge variant="default">отправка…</Badge>;
  if (status === 'pulling') return <Badge variant="default">приём…</Badge>;
  if (status === 'error') return <Badge variant="destructive">ошибка</Badge>;
  return null;
};

const DangerRow = ({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) => (
  <div className="flex items-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
    <AlertCircle className="h-5 w-5 text-destructive" />
    <div className="flex-1">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{description}</div>
    </div>
    {action}
  </div>
);

function TransferProgressDialog({
  mode,
  upload,
  detail,
  state,
}: {
  mode: null | 'upload' | 'download';
  upload?: {
    phase: string;
    files?: number;
    totalBytes?: number;
    startedAt: number;
    etaSec?: number;
  };
  detail?: string;
  state?: string;
}) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!mode) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [mode]);

  if (!mode) return null;

  const phaseLabels: Record<string, string> = {
    preparing: 'Подготовка',
    cloning: 'Скачиваем с сервера',
    init: 'Инициализация репозитория',
    scanning: 'Сканирование файлов',
    staging: 'Подготовка файлов',
    committing: 'Создание коммита',
    pushing: 'Загрузка на сервер',
    done: 'Готово',
  };
  const phase = upload?.phase ?? (mode === 'upload' ? 'preparing' : 'cloning');
  const elapsedSec = upload ? Math.max(0, Math.round((now - upload.startedAt) / 1000)) : 0;
  const etaSec = upload?.etaSec;

  const phaseOrder = ['preparing', 'scanning', 'staging', 'committing', 'pushing', 'done'];
  const downloadOrder = ['cloning', 'done'];
  const order = mode === 'upload' ? phaseOrder : downloadOrder;
  const idx = Math.max(0, order.indexOf(phase));
  const pct = order.length > 1 ? Math.min(99, Math.round((idx / (order.length - 1)) * 100)) : 50;
  const isError = state === 'error';
  const isDone = phase === 'done' || state === 'idle';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
      <div className="w-[420px] rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          {isError ? (
            <AlertCircle className="h-6 w-6 text-destructive" />
          ) : isDone ? (
            <CheckCircle2 className="h-6 w-6 text-emerald-400" />
          ) : (
            <Loader2 className="accent-fg h-6 w-6 animate-spin" />
          )}
          <div>
            <div className="text-base font-semibold">
              {mode === 'upload' ? 'Загрузка на сервер' : 'Скачивание с сервера'}
            </div>
            <div className="text-xs text-muted-foreground">
              {isError ? 'Произошла ошибка' : phaseLabels[phase] ?? phase}
            </div>
          </div>
        </div>

        <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-muted/40">
          <div
            className={
              'h-full transition-all duration-500 ' +
              (isError
                ? 'bg-destructive'
                : isDone
                  ? 'bg-emerald-400'
                  : 'accent-btn')
            }
            style={{ width: isDone ? '100%' : `${pct}%` }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md bg-muted/20 p-2">
            <div className="text-muted-foreground">Прошло</div>
            <div className="font-mono">{formatDuration(elapsedSec)}</div>
          </div>
          <div className="rounded-md bg-muted/20 p-2">
            <div className="text-muted-foreground">Осталось ~</div>
            <div className="font-mono">{etaSec != null ? formatDuration(etaSec) : '—'}</div>
          </div>
          {upload?.files != null && (
            <div className="rounded-md bg-muted/20 p-2">
              <div className="text-muted-foreground">Файлов</div>
              <div className="font-mono">{upload.files}</div>
            </div>
          )}
          {upload?.totalBytes != null && (
            <div className="rounded-md bg-muted/20 p-2">
              <div className="text-muted-foreground">Размер</div>
              <div className="font-mono">{formatBytes(upload.totalBytes)}</div>
            </div>
          )}
        </div>

        {detail && (
          <div className="mt-3 line-clamp-2 text-xs text-muted-foreground">{detail}</div>
        )}

        <div className="mt-4 text-[11px] text-muted-foreground">
          Не закрывайте окно до завершения. Большие папки могут занимать несколько минут.
        </div>
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseAuthorMessage(msg: string): string {
  // commit messages are like "<userId>|<userName>: ...". Strip prefix for display.
  const i = msg.indexOf(': ');
  if (i === -1) return msg;
  return msg.slice(i + 2);
}

interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime?: number;
  lastCommit?: {
    sha: string;
    shortSha: string;
    message: string;
    authorName: string;
    timestamp: number;
  };
}

interface FileHistoryEntry {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  timestamp: number;
  insertions: number;
  deletions: number;
  changeType: string;
}

function FileBrowser({
  serverId,
  projectId,
  projectName,
  syncedFolder,
  isExternal,
}: {
  serverId: string;
  projectId: string;
  projectName: string;
  syncedFolder: string | null;
  isExternal: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [pathInRepo, setPathInRepo] = React.useState('');
  const [entries, setEntries] = React.useState<TreeEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<TreeEntry | null>(null);
  const [fileHistory, setFileHistory] = React.useState<FileHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [serverNeedsUpdate, setServerNeedsUpdate] = React.useState(false);

  // External one-way sync state
  interface ExtSync {
    projectId: string;
    localPath: string;
    excludedPaths: string[];
    manualPaths: string[];
    lastSyncAt?: number;
    lastSyncIncludedHeavy?: boolean;
  }
  interface HeavyCandidate {
    relPath: string;
    size: number;
    mtime: number;
    /** Метки от серверного детектора («SQL-дамп», «backup в пути», «крупнее 25 МБ»). */
    labels?: string[];
    /** Машинные причины: 'extension' | 'name' | 'size'. */
    reasons?: string[];
  }
  interface JunkDir {
    relPath: string;
    size: number;
    fileCount: number;
    name: string;
    category: 'dependencies' | 'build' | 'cache' | 'vcs' | 'ide' | 'temp';
  }
  interface DataStoreReport {
    files: HeavyCandidate[];
    junkDirs: JunkDir[];
    totalScanned: number;
    truncated: boolean;
    totalDataBytes: number;
    totalJunkBytes: number;
    /** true, если сработал фоллбэк на клиентский regex (сервер < 0.2.0). */
    fallback?: boolean;
  }
  const [extSync, setExtSync] = React.useState<ExtSync | null>(null);
  const [syncProgress, setSyncProgress] = React.useState<null | {
    phase: string;
    totalFiles?: number;
    processedFiles?: number;
    currentFile?: string;
    downloadedBytes?: number;
    totalBytes?: number;
    includeHeavy: boolean;
  }>(null);
  // Heavy-confirm wizard
  const [heavyDialogOpen, setHeavyDialogOpen] = React.useState(false);
  const [heavyCandidates, setHeavyCandidates] = React.useState<HeavyCandidate[] | null>(null);
  const [heavyReport, setHeavyReport] = React.useState<DataStoreReport | null>(null);
  const [heavyLoading, setHeavyLoading] = React.useState(false);
  // 'heavy' = качается только по запросу, 'normal' = синхр. как все, 'excluded' = никогда
  type HeavyChoice = 'heavy' | 'normal' | 'excluded';
  const [heavyChoices, setHeavyChoices] = React.useState<Record<string, HeavyChoice>>({});
  type SortKey = 'name' | 'size' | 'mtime' | 'author';
  const [sortKey, setSortKey] = React.useState<SortKey>('name');
  const [sortAsc, setSortAsc] = React.useState(true);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(key === 'name'); }
  }

  const sorted = React.useMemo(() => {
    const dirs = entries.filter((e) => e.type === 'dir');
    const files = entries.filter((e) => e.type === 'file');
    const cmp = (a: TreeEntry, b: TreeEntry): number => {
      let v = 0;
      if (sortKey === 'name') v = a.name.localeCompare(b.name);
      else if (sortKey === 'size') v = (a.size ?? 0) - (b.size ?? 0);
      else if (sortKey === 'mtime') v = (a.mtime ?? 0) - (b.mtime ?? 0);
      else if (sortKey === 'author') {
        const ta = a.lastCommit?.authorName ?? '';
        const tb = b.lastCommit?.authorName ?? '';
        v = ta.localeCompare(tb);
      }
      return sortAsc ? v : -v;
    };
    return [...dirs.sort(cmp), ...files.sort(cmp)];
  }, [entries, sortKey, sortAsc]);

  const loadTree = React.useCallback(
    async (nextPath = pathInRepo) => {
      setLoading(true);
      try {
        const r = (await window.backupsApp.projects.tree(
          serverId,
          projectId,
          nextPath,
          'HEAD',
        )) as { entries: TreeEntry[] };
        setServerNeedsUpdate(false);
        setEntries(r.entries);
        setPathInRepo(nextPath);
      } catch (e) {
        const message = (e as Error).message;
        if (message.includes('HTTP 404') && message.includes('/tree')) {
          setServerNeedsUpdate(true);
          setEntries([]);
          return;
        }
        addToast({ type: 'error', text: message });
      } finally {
        setLoading(false);
      }
    },
    [addToast, pathInRepo, projectId, serverId],
  );

  React.useEffect(() => {
    void loadTree('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, projectId]);

  React.useEffect(() => {
    if (!isExternal) return;
    void window.backupsApp.externalSync
      .get(serverId, projectId)
      .then((s) => setExtSync(s as ExtSync | null));
  }, [isExternal, serverId, projectId]);

  React.useEffect(() => {
    if (!isExternal) return;
    const off = window.backupsApp.externalSync.onProgress((p) => {
      if (p.serverId !== serverId || p.projectId !== projectId) return;
      setSyncProgress((prev) => ({
        phase: p.phase,
        totalFiles: p.totalFiles ?? prev?.totalFiles,
        processedFiles: p.processedFiles ?? prev?.processedFiles,
        downloadedBytes: p.downloadedBytes ?? prev?.downloadedBytes,
        totalBytes: p.totalBytes ?? prev?.totalBytes,
        currentFile: p.currentFile ?? prev?.currentFile,
        includeHeavy: prev?.includeHeavy ?? false,
      }));
      if (p.phase === 'done' || p.phase === 'error') {
        setTimeout(() => setSyncProgress(null), 1500);
      }
    });
    return off;
  }, [isExternal, serverId, projectId]);

  async function chooseLocalFolder(): Promise<string | null> {
    const res = (await window.backupsApp.externalSync.chooseFolder()) as string | null;
    return res;
  }

  async function runSync(includeHeavy: boolean) {
    let localPath = extSync?.localPath ?? null;
    if (!localPath) {
      localPath = await chooseLocalFolder();
      if (!localPath) return;
    }
    setSyncProgress({ phase: 'listing', includeHeavy });
    try {
      const result = (await window.backupsApp.externalSync.run({
        serverId,
        projectId,
        localPath,
        includeHeavy,
        manualPaths: extSync?.manualPaths,
        excludedPaths: extSync?.excludedPaths,
        prune: false,
      })) as { downloaded: number; skipped: number; bytes: number };
      const fresh = (await window.backupsApp.externalSync.get(serverId, projectId)) as ExtSync | null;
      setExtSync(fresh);
      const sizeMb = (result.bytes / 1024 / 1024).toFixed(1);
      addToast({
        type: 'success',
        text: `Синхронизировано: ${result.downloaded} файлов (${sizeMb} МБ), пропущено ${result.skipped}`,
      });
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
      setSyncProgress(null);
    }
  }

  async function changeLocalFolder() {
    const next = await chooseLocalFolder();
    if (!next) return;
    if (extSync) {
      setExtSync({ ...extSync, localPath: next });
    } else {
      setExtSync({
        projectId,
        localPath: next,
        excludedPaths: [],
        manualPaths: [],
      });
    }
    addToast({ type: 'info', text: 'Папка обновлена. Нажмите «Синхронизировать», чтобы скачать.' });
  }

  function openLocalFolder() {
    if (extSync?.localPath) void window.backupsApp.externalSync.openFolder(extSync.localPath);
  }

  async function openHeavyDialog() {
    setHeavyDialogOpen(true);
    setHeavyLoading(true);
    try {
      // 1) Пробуем серверную автодетекцию (есть в server >= 0.2.0). Сервер
      //    знает размеры файлов, триггер-слова в путях, junk-папки и labels.
      const serverReport = (await window.backupsApp.externalSync.detectDataStore(
        serverId,
        projectId,
      )) as DataStoreReport | null;

      let list: HeavyCandidate[];
      let junkDirs: JunkDir[] = [];
      let report: DataStoreReport;
      if (serverReport && serverReport.files) {
        list = serverReport.files;
        junkDirs = serverReport.junkDirs ?? [];
        report = serverReport;
      } else {
        // 2) Фоллбэк: на старом сервере детекция делается клиентом
        //    (regex по relPath, без размеров/labels/junk).
        const legacy = (await window.backupsApp.externalSync.listHeavy(
          serverId,
          projectId,
        )) as Array<{ relPath: string; size: number; mtime: number }>;
        list = legacy.map((f) => ({ ...f, labels: ['по имени файла'], reasons: ['extension'] }));
        report = {
          files: list,
          junkDirs: [],
          totalScanned: list.length,
          truncated: false,
          totalDataBytes: list.reduce((a, c) => a + c.size, 0),
          totalJunkBytes: 0,
          fallback: true,
        };
      }
      const cur =
        extSync ??
        ((await window.backupsApp.externalSync.get(serverId, projectId)) as ExtSync | null);
      const manualSet = new Set(cur?.manualPaths ?? []);
      const excludedSet = new Set(cur?.excludedPaths ?? []);

      // Heavy-файлы: по умолчанию «heavy», если уже стояло manual/excluded — вернём.
      const initial: Record<string, HeavyChoice> = {};
      for (const f of list) {
        if (excludedSet.has(f.relPath)) initial[f.relPath] = 'excluded';
        else if (manualSet.has(f.relPath)) initial[f.relPath] = 'normal';
        else initial[f.relPath] = 'heavy';
      }

      // junkDirs показываются информационно — они уже исключены сервером
      // на уровне /tree-recursive, дополнительная конфигурация не нужна.
      void junkDirs;

      setHeavyCandidates(list);
      setHeavyReport(report);
      setHeavyChoices(initial);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
      setHeavyDialogOpen(false);
    } finally {
      setHeavyLoading(false);
    }
  }

  async function applyHeavyAndSync(runSyncAfter: boolean) {
    if (!heavyCandidates) return;
    // Собрать manualPaths / excludedPaths из выбранных значений.
    const cur = extSync ?? {
      projectId,
      localPath: '',
      excludedPaths: [] as string[],
      manualPaths: [] as string[],
    };
    // Берём существующие manual/excluded, которые НЕ относятся к heavy
    // (могут быть пути не из heavy — оставим их как есть).
    const heavySet = new Set(heavyCandidates.map((c) => c.relPath));
    const keptManual = (cur.manualPaths ?? []).filter((p) => !heavySet.has(p));
    const keptExcluded = (cur.excludedPaths ?? []).filter((p) => !heavySet.has(p));
    const nextManual = [...keptManual];
    const nextExcluded = [...keptExcluded];
    for (const f of heavyCandidates) {
      const c = heavyChoices[f.relPath] ?? 'heavy';
      if (c === 'normal') nextManual.push(f.relPath);
      else if (c === 'excluded') nextExcluded.push(f.relPath);
    }
    // Если папка ещё не выбрана — попросим выбрать её перед синком.
    let localPath = cur.localPath;
    if (runSyncAfter && !localPath) {
      const chosen = await chooseLocalFolder();
      if (!chosen) return;
      localPath = chosen;
    }
    // Сохраняем правила (если папка уже была — на бэкенд, иначе только локально).
    if (cur.localPath || localPath) {
      const updated = (await window.backupsApp.externalSync.setRules({
        serverId,
        projectId,
        manualPaths: nextManual,
        excludedPaths: nextExcluded,
      })) as ExtSync | null;
      setExtSync(
        updated ?? {
          projectId,
          localPath,
          excludedPaths: nextExcluded,
          manualPaths: nextManual,
        },
      );
    } else {
      setExtSync({
        projectId,
        localPath: '',
        excludedPaths: nextExcluded,
        manualPaths: nextManual,
      });
    }
    setHeavyDialogOpen(false);
    if (runSyncAfter) {
      // Запускаем sync с includeHeavy=true — скачаются и тяжёлые файлы,
      // которые остались в категории "тяжёлый". Те, что юзер пометил
      // как "обычный" (manual), и так попадают в основной набор.
      // Те, что "excluded" — не попадут вообще.
      await runSyncWith({
        includeHeavy: true,
        manualPaths: nextManual,
        excludedPaths: nextExcluded,
        localPath,
      });
    }
  }

  async function runSyncWith(p: {
    includeHeavy: boolean;
    manualPaths: string[];
    excludedPaths: string[];
    localPath: string;
  }) {
    setSyncProgress({ phase: 'listing', includeHeavy: p.includeHeavy });
    try {
      const result = (await window.backupsApp.externalSync.run({
        serverId,
        projectId,
        localPath: p.localPath,
        includeHeavy: p.includeHeavy,
        manualPaths: p.manualPaths,
        excludedPaths: p.excludedPaths,
        prune: false,
      })) as { downloaded: number; skipped: number; bytes: number };
      const fresh = (await window.backupsApp.externalSync.get(serverId, projectId)) as ExtSync | null;
      setExtSync(fresh);
      const sizeMb = (result.bytes / 1024 / 1024).toFixed(1);
      addToast({
        type: 'success',
        text: `Синхронизировано: ${result.downloaded} файлов (${sizeMb} МБ), пропущено ${result.skipped}`,
      });
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
      setSyncProgress(null);
    }
  }

  async function toggleManual(relPath: string, makeManual: boolean) {
    const cur = extSync ?? {
      projectId,
      localPath: '',
      excludedPaths: [],
      manualPaths: [],
    };
    const nextManual = makeManual
      ? Array.from(new Set([...(cur.manualPaths ?? []), relPath]))
      : (cur.manualPaths ?? []).filter((p) => p !== relPath);
    if (!cur.localPath) {
      // ничего не сохраняем на бэк, только локально пока папки нет
      setExtSync({ ...cur, manualPaths: nextManual });
      return;
    }
    const updated = (await window.backupsApp.externalSync.setRules({
      serverId,
      projectId,
      manualPaths: nextManual,
    })) as ExtSync | null;
    setExtSync(updated ?? { ...cur, manualPaths: nextManual });
  }

  async function selectFile(entry: TreeEntry) {
    setSelected(entry);
    setHistoryLoading(true);
    try {
      const r = (await window.backupsApp.projects.fileHistory(
        serverId,
        projectId,
        entry.path,
        100,
      )) as { history: FileHistoryEntry[] };
      setFileHistory(r.history);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
      setFileHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function downloadFile(entry: TreeEntry, ref = 'HEAD') {
    try {
      const result = (await window.backupsApp.projects.downloadFile(
        serverId,
        projectId,
        entry.path,
        ref,
        entry.name,
      )) as { canceled?: boolean; saved?: string };
      if (!result.canceled) {
        addToast({ type: 'success', text: `Файл сохранён: ${result.saved ?? entry.name}` });
      }
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  async function openFile(entry: TreeEntry, ref = 'HEAD') {
    try {
      await window.backupsApp.projects.openFileLocally(serverId, projectId, entry.path, ref);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  const crumbs = pathInRepo ? pathInRepo.split('/') : [];

  return (
    <>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Файлы проекта</CardTitle>
            <CardDescription>
              {isExternal
                ? 'Live-зеркало папки на проде. Синхронизируйте на ваш ПК — файлы скачаются в локальную папку.'
                : 'Содержимое последней версии на сервере. Видно, кто и когда менял каждый файл.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => loadTree()}>
              <RefreshCcw className="h-4 w-4" /> Обновить
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
            <button
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-card hover:text-foreground"
              onClick={() => loadTree('')}
            >
              <Home className="h-3.5 w-3.5" />
              {projectName || 'root'}
            </button>
            {crumbs.map((part, idx) => {
              const p = crumbs.slice(0, idx + 1).join('/');
              return (
                <React.Fragment key={p}>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <button
                    className="rounded px-2 py-1 text-muted-foreground hover:bg-card hover:text-foreground"
                    onClick={() => loadTree(p)}
                  >
                    {part}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          {syncedFolder && !isExternal && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground">
              Локальная папка синхронизации:{' '}
              <code className="font-mono text-foreground">{syncedFolder}</code>
            </div>
          )}

          {/* Sync-панели и прогресс перенесены в правую sidebar колонку. */}

          {serverNeedsUpdate ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-200">
                <AlertCircle className="h-4 w-4" />
                Нужно обновить серверное ПО на VPS
              </div>
              <p className="text-sm text-muted-foreground">
                Клиент уже умеет показывать файлы, историю файла и скачивание, но на сервере
                запущена старая версия без endpoint <code className="font-mono">/tree</code>.
                Переустановите сервер через мастер создания сервера на этот же VPS, чтобы
                контейнер пересобрался из новой версии.
              </p>
            </div>
          ) : loading ? (
            <div className="flex flex-col items-center gap-3 py-14">
              <Spinner size="lg" className="text-violet-400/70" />
              <DotsLoader />
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              Файлов пока нет. Нажмите «Загрузить на сервер» или сделайте первый push.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              {isExternal ? (
                <div className="grid grid-cols-[minmax(0,1fr)_100px_160px_100px] gap-3 border-b border-border bg-muted/20 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <SortBtn label="Имя" k="name" cur={sortKey} asc={sortAsc} toggle={toggleSort} />
                  <SortBtn label="Размер" k="size" cur={sortKey} asc={sortAsc} toggle={toggleSort} />
                  <SortBtn label="Изменён" k="mtime" cur={sortKey} asc={sortAsc} toggle={toggleSort} />
                  <span className="text-right">Действия</span>
                </div>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_150px_140px_120px] gap-3 border-b border-border bg-muted/20 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <SortBtn label="Имя" k="name" cur={sortKey} asc={sortAsc} toggle={toggleSort} />
                  <SortBtn label="Изменил" k="author" cur={sortKey} asc={sortAsc} toggle={toggleSort} />
                  <SortBtn label="Когда" k="mtime" cur={sortKey} asc={sortAsc} toggle={toggleSort} />
                  <span className="text-right">Действия</span>
                </div>
              )}
              <ul className="divide-y divide-border">
                {sorted.map((entry) => (
                  <li
                    key={entry.path}
                    className={
                      (isExternal
                        ? 'grid grid-cols-[minmax(0,1fr)_100px_160px_100px]'
                        : 'grid grid-cols-[minmax(0,1fr)_150px_140px_120px]') +
                      ' items-center gap-3 px-4 py-3 text-sm transition hover:bg-accent/20 ' +
                      (selected?.path === entry.path ? 'bg-accent/25' : '')
                    }
                  >
                    <button
                      className="flex min-w-0 items-center gap-3 text-left"
                      onClick={() =>
                        entry.type === 'dir' ? loadTree(entry.path) : void selectFile(entry)
                      }
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted/40">
                        {entry.type === 'dir' ? (
                          <Folder className="accent-fg h-5 w-5" />
                        ) : (
                          <FileText className="accent-fg h-5 w-5 opacity-60" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 font-medium">
                          <span className="truncate">{entry.name}</span>
                          {isExternal && entry.type === 'file' && isHeavyPath(entry.path) && (
                            extSync?.manualPaths?.includes(entry.path) ? (
                              <Badge variant="success" className="shrink-0">manual</Badge>
                            ) : (
                              <span title="Файл хранилища данных (БД, бэкап, архив, лог). Лежит там же, где и на проде, но качается только через «Хранилище данных…».">
                                <Database className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                              </span>
                            )
                          )}
                        </span>
                        {!isExternal && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {entry.type === 'dir' ? 'папка' : formatBytes(entry.size ?? 0)}
                          </span>
                        )}
                      </span>
                    </button>

                    {isExternal ? (
                      <>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.type === 'file' ? formatBytes(entry.size ?? 0) : '—'}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.mtime ? formatRelativeTime(entry.mtime) : '—'}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.lastCommit?.authorName ?? '—'}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.lastCommit ? formatRelativeTime(entry.lastCommit.timestamp) : '—'}
                        </span>
                      </>
                    )}

                    <div className="flex justify-end gap-1">
                      {entry.type === 'file' ? (
                        <>
                          {!isExternal && (
                            <Button variant="ghost" size="sm" title="История файла" onClick={() => selectFile(entry)}>
                              <History className="h-4 w-4" />
                            </Button>
                          )}
                          {isExternal && isHeavyPath(entry.path) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title={
                                extSync?.manualPaths?.includes(entry.path)
                                  ? 'Убрать из списка автоматической синхронизации'
                                  : 'Всегда синхронизировать этот тяжёлый файл'
                              }
                              onClick={() => void toggleManual(entry.path, !extSync?.manualPaths?.includes(entry.path))}
                            >
                              {extSync?.manualPaths?.includes(entry.path) ? (
                                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                              ) : (
                                <Plus className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" title="Открыть файл" onClick={() => openFile(entry)}>
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" title="Скачать файл" onClick={() => downloadFile(entry)}>
                            <Download className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => loadTree(entry.path)}>
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        {isExternal && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Локальная папка</CardTitle>
              <CardDescription className="text-xs">
                Сурсы скачиваются на ПК и сохраняют структуру папок проды.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <FolderDown className="accent-fg h-4 w-4 shrink-0" />
                {extSync?.localPath ? (
                  <>
                    <code className="min-w-0 flex-1 break-all rounded bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground/90">
                      {extSync.localPath}
                    </code>
                    <button
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Открыть в проводнике"
                      onClick={openLocalFolder}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => void changeLocalFolder()}
                    >
                      сменить
                    </button>
                  </>
                ) : (
                  <button
                    className="accent-fg text-xs underline-offset-2 hover:underline"
                    onClick={() => void changeLocalFolder()}
                  >
                    выбрать папку
                  </button>
                )}
              </div>
              {extSync?.lastSyncAt ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-foreground">{formatRelativeTime(extSync.lastSyncAt)}</span>
                  {extSync.lastSyncIncludedHeavy && (
                    <Badge variant="info">с хранилищем</Badge>
                  )}
                </div>
              ) : (
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  Файлы хранилища данных (БД, бэкапы, архивы) лежат в той же структуре, что и на
                  проде, но качаются отдельно — настраивается в «Хранилище данных…».
                </div>
              )}

              <Button
                variant="gradient"
                className="w-full"
                onClick={() => void runSync(false)}
                disabled={!!syncProgress}
                title="Скачать актуальные сурсы (без БД, архивов и логов)"
              >
                <CloudDownload className="h-4 w-4" />
                {syncProgress ? 'Идёт синхронизация…' : 'Синхронизировать сурсы'}
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void openHeavyDialog()}
                disabled={!!syncProgress || heavyLoading}
                title="Уточнить и скачать БД, дампы, архивы, статистику"
              >
                <Database className="h-4 w-4" />
                Хранилище данных…
              </Button>
            </CardContent>
          </Card>
        )}

        {syncProgress && (
          <Card>
            <CardContent className="space-y-2 py-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">
                  {syncProgress.phase === 'listing' && 'Получаем список файлов с сервера…'}
                  {syncProgress.phase === 'comparing' && 'Сравниваем с локальной копией…'}
                  {syncProgress.phase === 'downloading' && 'Скачиваем файлы…'}
                  {syncProgress.phase === 'cleaning' && 'Удаляем устаревшие…'}
                  {syncProgress.phase === 'done' && 'Готово'}
                  {syncProgress.phase === 'error' && 'Ошибка'}
                </span>
                <span className="font-mono text-muted-foreground">
                  {syncProgress.processedFiles ?? 0}/{syncProgress.totalFiles ?? 0}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                <div
                  className={
                    syncProgress.phase === 'done'
                      ? 'h-full bg-emerald-400 transition-all'
                      : 'h-full accent-btn transition-all'
                  }
                  style={{
                    width:
                      syncProgress.phase === 'done'
                        ? '100%'
                        : syncProgress.totalFiles
                          ? `${Math.round(((syncProgress.processedFiles ?? 0) / syncProgress.totalFiles) * 100)}%`
                          : '8%',
                  }}
                />
              </div>
              {syncProgress.currentFile && (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {syncProgress.currentFile}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>История файла</CardTitle>
            <CardDescription>
              {selected ? selected.path : 'Выберите файл слева, чтобы увидеть всю историю.'}
            </CardDescription>
          </CardHeader>
        <CardContent>
          {!selected ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Здесь появятся авторы, даты изменений и версии выбранного файла.
            </div>
          ) : historyLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Загрузка истории…</div>
          ) : fileHistory.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">История файла пуста.</div>
          ) : (
            <ul className="space-y-3">
              {fileHistory.map((h) => (
                <li key={h.sha} className="rounded-lg border border-border bg-muted/10 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {parseAuthorMessage(h.message)}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{h.authorName}</span>
                        <span>·</span>
                        <span>{formatRelativeTime(h.timestamp)}</span>
                        <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">
                          {h.shortSha || shortSha(h.sha)}
                        </code>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <Badge variant="secondary">{changeTypeLabel(h.changeType)}</Badge>
                        <span className="text-emerald-400">+{h.insertions}</span>
                        <span className="text-destructive">-{h.deletions}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" title="Открыть эту версию" onClick={() => openFile(selected, h.sha)}>
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" title="Скачать эту версию" onClick={() => downloadFile(selected, h.sha)}>
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
        </Card>
      </div>
    </div>

    <Dialog
      open={heavyDialogOpen}
      onClose={() => setHeavyDialogOpen(false)}
      title="Хранилище данных — подтверди и скачай"
      description="Сервер прошёлся по дереву файлов и нашёл то, что похоже на хранилище данных, плюс мусорные папки (node_modules, .git, dist…). Поправь, если что-то определилось не так."
    >
      <div className="space-y-4 text-sm">
        {heavyLoading ? (
          <div className="py-8 text-center text-muted-foreground">Сервер сканирует папку проекта…</div>
        ) : (
          <>
            <div className="rounded-md bg-muted/20 p-3 text-xs text-muted-foreground">
              {heavyReport?.fallback ? (
                <>
                  Серверная часть устарела — детекция сделана клиентом по расширениям и триггер-словам.
                  Обновите сервер на VPS, чтобы получить детекцию по размеру и junk-папкам.
                </>
              ) : (
                <>
                  Сервер просканировал{' '}
                  <span className="text-foreground">{heavyReport?.totalScanned ?? '—'}</span> файлов
                  и определил{' '}
                  <span className="text-foreground">{heavyCandidates?.length ?? 0}</span> как
                  хранилище данных (
                  <span className="text-foreground">
                    {formatBytes(heavyReport?.totalDataBytes ?? 0)}
                  </span>
                  ). Также автоматически исключил{' '}
                  <span className="text-foreground">
                    {heavyReport?.junkDirs?.length ?? 0}
                  </span>{' '}
                  мусорных папок (
                  <span className="text-foreground">
                    {formatBytes(heavyReport?.totalJunkBytes ?? 0)}
                  </span>
                  ).
                </>
              )}
            </div>

            {/* Junk-папки — информационная секция, всегда исключены */}
            {heavyReport?.junkDirs && heavyReport.junkDirs.length > 0 && (
              <div className="space-y-1 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                <div className="mb-1 flex items-center gap-2 text-xs font-medium text-rose-200">
                  <Database className="h-3.5 w-3.5" />
                  Автоматически исключены ({formatBytes(heavyReport.totalJunkBytes)})
                </div>
                <div className="max-h-[18vh] space-y-1 overflow-y-auto pr-1">
                  {heavyReport.junkDirs.map((d) => (
                    <div
                      key={d.relPath}
                      className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                    >
                      <span className="font-mono text-rose-200/80">{d.relPath}/</span>
                      <Badge variant="secondary" className="shrink-0">
                        {d.category === 'dependencies'
                          ? 'зависимости'
                          : d.category === 'vcs'
                            ? 'git/svn'
                            : d.category === 'build'
                              ? 'билд'
                              : d.category === 'cache'
                                ? 'кэш'
                                : d.category === 'ide'
                                  ? 'ide'
                                  : 'temp'}
                      </Badge>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                        {d.fileCount} файл. · {formatBytes(d.size)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Это зависимости / автогенерируемый код / git-история — обычно не нужны на ПК.
                  Если для вашего проекта какая-то из этих папок реально нужна — напишите, добавим
                  whitelist.
                </div>
              </div>
            )}

            {!heavyCandidates || heavyCandidates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                Файлов, похожих на хранилище данных, не нашлось. Можно смело синхронизировать
                сурсы основной кнопкой.
              </div>
            ) : null}
            {heavyCandidates && heavyCandidates.length > 0 && (
            <div className="max-h-[40vh] space-y-1 overflow-y-auto rounded-md border border-border bg-muted/10 p-2">
              {heavyCandidates.map((f) => {
                const choice = heavyChoices[f.relPath] ?? 'heavy';
                return (
                  <div
                    key={f.relPath}
                    className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 hover:bg-card/60"
                  >
                    <Database className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs" title={f.relPath}>
                        {f.relPath}
                      </div>
                      {f.labels && f.labels.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {f.labels.map((l) => (
                            <span
                              key={l}
                              className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200/90"
                            >
                              {l}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {formatBytes(f.size)}
                    </span>
                    <div className="flex shrink-0 gap-1">
                      <HeavyChoiceBtn
                        active={choice === 'heavy'}
                        onClick={() =>
                          setHeavyChoices((c) => ({ ...c, [f.relPath]: 'heavy' }))
                        }
                        title="Хранилище — качается только по этой кнопке"
                      >
                        хранилище
                      </HeavyChoiceBtn>
                      <HeavyChoiceBtn
                        active={choice === 'normal'}
                        onClick={() =>
                          setHeavyChoices((c) => ({ ...c, [f.relPath]: 'normal' }))
                        }
                        title="Считать обычным — качать в основном sync'е"
                      >
                        обычный
                      </HeavyChoiceBtn>
                      <HeavyChoiceBtn
                        active={choice === 'excluded'}
                        onClick={() =>
                          setHeavyChoices((c) => ({ ...c, [f.relPath]: 'excluded' }))
                        }
                        title="Никогда не качать"
                      >
                        исключить
                      </HeavyChoiceBtn>
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setHeavyDialogOpen(false)}>
            Отмена
          </Button>
          <Button
            variant="outline"
            onClick={() => void applyHeavyAndSync(false)}
            disabled={heavyLoading}
          >
            Сохранить правила
          </Button>
          {heavyCandidates && heavyCandidates.length > 0 && (
            <Button
              variant="gradient"
              onClick={() => void applyHeavyAndSync(true)}
              disabled={heavyLoading}
            >
              <CloudDownload className="h-4 w-4" /> Скачать хранилище сейчас
            </Button>
          )}
        </div>
      </div>
    </Dialog>
    </>
  );
}

function HeavyChoiceBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'rounded-md border px-2 py-0.5 text-[11px] transition ' +
        (active
          ? 'accent-btn border-transparent text-white'
          : 'border-border bg-background/40 text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

function changeTypeLabel(type: string): string {
  if (type === 'added') return 'добавлен';
  if (type === 'deleted') return 'удалён';
  if (type === 'renamed') return 'переименован';
  return 'изменён';
}

function SortBtn({
  label, k, cur, asc, toggle,
}: {
  label: string;
  k: 'name' | 'size' | 'mtime' | 'author';
  cur: string;
  asc: boolean;
  toggle: (k: 'name' | 'size' | 'mtime' | 'author') => void;
}) {
  const active = cur === k;
  return (
    <button
      onClick={() => toggle(k)}
      className="flex items-center gap-1 uppercase tracking-wider hover:text-foreground transition-colors"
      style={{ color: active ? 'hsl(var(--foreground))' : undefined }}
    >
      {label}
      {active ? (
        asc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronUp className="h-3 w-3 opacity-25" />
      )}
    </button>
  );
}
