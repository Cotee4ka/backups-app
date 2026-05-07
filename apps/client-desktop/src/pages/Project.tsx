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
  Download,
  Upload,
  Loader2,
  CheckCircle2,
  ChevronLeft,
  FileText,
  ExternalLink,
  Home,
} from 'lucide-react';

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
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-blue-500/20 via-violet-500/20 to-fuchsia-500/20">
            <FolderGit2 className="h-7 w-7 text-violet-300" />
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
            <Loader2 className="h-6 w-6 animate-spin text-violet-300" />
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
                  : 'bg-gradient-to-r from-violet-500 via-fuchsia-500 to-blue-500')
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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Файлы проекта</CardTitle>
            <CardDescription>
              Содержимое последней версии на сервере. Видно, кто и когда менял каждый файл.
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => loadTree()}>
            <RefreshCcw className="h-4 w-4" /> Обновить
          </Button>
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

          {syncedFolder && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground">
              Локальная папка синхронизации:{' '}
              <code className="font-mono text-foreground">{syncedFolder}</code>
            </div>
          )}

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
            <div className="py-12 text-center text-sm text-muted-foreground">Загрузка файлов…</div>
          ) : entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              Файлов пока нет. Нажмите «Загрузить на сервер» или сделайте первый push.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              {isExternal ? (
                <div className="grid grid-cols-[minmax(0,1fr)_100px_160px_100px] gap-3 border-b border-border bg-muted/20 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <span>Имя</span>
                  <span>Размер</span>
                  <span>Изменён</span>
                  <span className="text-right">Действия</span>
                </div>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_150px_140px_120px] gap-3 border-b border-border bg-muted/20 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <span>Имя</span>
                  <span>Изменил</span>
                  <span>Когда</span>
                  <span className="text-right">Действия</span>
                </div>
              )}
              <ul className="divide-y divide-border">
                {entries.map((entry) => (
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
                          <Folder className="h-5 w-5 text-violet-300" />
                        ) : (
                          <FileText className="h-5 w-5 text-blue-300" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{entry.name}</span>
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

      <Card className="lg:sticky lg:top-6 lg:self-start">
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
  );
}

function changeTypeLabel(type: string): string {
  if (type === 'added') return 'добавлен';
  if (type === 'deleted') return 'удалён';
  if (type === 'renamed') return 'переименован';
  return 'изменён';
}
