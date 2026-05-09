import React from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
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
  Ban,
  RefreshCw,
  Search,
  X,
  Paperclip,
} from 'lucide-react';
import { Spinner, DotsLoader } from '@/components/ui/spinner';
import { isHeavyPath } from '@/lib/heavy-files';
import { matchesRule } from '@/lib/path-rules';
import {
  ServerOutdatedModal,
  useServerVersionGate,
} from '@/components/server-outdated-modal';
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive';

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

type FileSyncStatus = 'synced' | 'modified' | 'missing' | 'no-folder';

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
  const gate = useServerVersionGate(serverId);

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
  const [deleteOpen, setDeleteOpen] = React.useState(false);

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
        <div className="space-y-4">
          {isExternal && (
            <ProjectUiSettings serverId={serverId} projectId={projectId} />
          )}
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
                  <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                    Удалить
                  </Button>
                }
              />
            </CardContent>
          </Card>
        </div>
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

      {/* Version-gate: блокируем работу с проектом, если хост устарел. */}
      <ServerOutdatedModal
        open={gate.status === 'outdated'}
        onClose={() => nav('/dashboard')}
        server={server ? { id: server.id, url: server.url, name: server.name } : null}
        current={gate.current}
        expected={gate.expected}
        onUpdated={() => {
          gate.refetch();
          void load();
        }}
      />

      {/* Удаление проекта — необратимое действие, требует ручного ввода
          фразы «ПОДТВЕРДИТЬ». Сервер удалит bare-репо, клиент остановит
          watcher и почистит syncedFolders. */}
      <ConfirmDestructiveDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Удалить проект"
        description={`«${project?.name ?? 'Без имени'}» — все бекапы и git-история будут удалены безвозвратно с сервера и из клиента.`}
        subjectLabel={project?.name}
        confirmButtonLabel="Удалить навсегда"
        onConfirm={async () => {
          await window.backupsApp.projects.delete(serverId, projectId);
          addToast({ type: 'success', text: 'Проект удалён' });
          nav(`/server/${serverId}`);
        }}
      />
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

type UiKey =
  | 'foldersBottom'
  | 'dataFilesBottom'
  | 'changeFeedAfterSyncOnly'
  | 'changeFeedShowDiff';

const UI_TOGGLE_META: Array<{ key: UiKey; title: string; description: string }> = [
  {
    key: 'foldersBottom',
    title: 'Папки в самом низу',
    description: 'При сортировке файлы идут первыми, папки прижимаются вниз.',
  },
  {
    key: 'dataFilesBottom',
    title: 'Файлы данных внизу списка',
    description: 'Всё помеченное «хранилище данных» / исключённое опускается в конец.',
  },
  {
    key: 'changeFeedAfterSyncOnly',
    title: 'История только после синхронизации',
    description: 'В фиде показываются только файлы, изменённые после последнего синка.',
  },
  {
    key: 'changeFeedShowDiff',
    title: 'Считать +/− строк в истории',
    description: 'Сравнивает локальную копию и проду, показывает добавленные/удалённые строки.',
  },
];

function ProjectUiSettings({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [global, setGlobal] = React.useState<Record<UiKey, boolean> | null>(null);
  const [overrides, setOverrides] = React.useState<Partial<Record<UiKey, boolean>>>({});
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(async () => {
    try {
      const [s, ext] = await Promise.all([
        window.backupsApp.settings.get(),
        window.backupsApp.externalSync.get(serverId, projectId),
      ]);
      const x = s as Record<string, unknown>;
      setGlobal({
        foldersBottom: (x.foldersBottom as boolean) ?? true,
        dataFilesBottom: (x.dataFilesBottom as boolean) ?? true,
        changeFeedAfterSyncOnly: (x.changeFeedAfterSyncOnly as boolean) ?? true,
        changeFeedShowDiff: (x.changeFeedShowDiff as boolean) ?? true,
      });
      const ov = (ext as { uiOverrides?: Partial<Record<UiKey, boolean>> } | null)?.uiOverrides ?? {};
      setOverrides(ov);
    } finally {
      setLoading(false);
    }
  }, [serverId, projectId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function setOverride(key: UiKey, value: boolean | null) {
    try {
      await window.backupsApp.externalSync.setUiOverride({
        serverId,
        projectId,
        key,
        value,
      });
      await reload();
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  if (loading || !global) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Вид списка и истории</CardTitle>
        <CardDescription>
          Эти настройки переопределяют глобальные значения для текущего проекта. Сбрось
          переключатель в «по глобальному», чтобы наследовать значение из настроек приложения.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {UI_TOGGLE_META.map((m) => {
          const ov = overrides[m.key];
          const globalVal = global[m.key];
          const effective = ov ?? globalVal;
          return (
            <div
              key={m.key}
              className="rounded-lg border border-border bg-muted/15 p-3"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{m.title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{m.description}</div>
                  <div className="mt-2 flex items-center gap-2 text-[11px]">
                    {ov === undefined ? (
                      <Badge variant="secondary" className="font-normal">
                        Наследуется из глобала: {globalVal ? 'вкл' : 'выкл'}
                      </Badge>
                    ) : (
                      <>
                        <Badge variant="info" className="font-normal">
                          Переопределено для проекта
                        </Badge>
                        <button
                          className="text-muted-foreground underline-offset-2 hover:underline"
                          onClick={() => void setOverride(m.key, null)}
                        >
                          сбросить
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <Switch
                  checked={effective}
                  onChange={(v) => void setOverride(m.key, v)}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
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
    manualHeavyPaths?: string[];
    lastSyncAt?: number;
    lastSyncIncludedHeavy?: boolean;
    uiOverrides?: {
      foldersBottom?: boolean;
      dataFilesBottom?: boolean;
      changeFeedAfterSyncOnly?: boolean;
      changeFeedShowDiff?: boolean;
    };
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
  /** Карта файлов: relPath → 'synced' | 'modified' | 'missing'. Заполняется
   *  параллельно loadTree через externalSync.fileStatuses. */
  const [fileStatuses, setFileStatuses] = React.useState<Map<string, FileSyncStatus>>(
    new Map(),
  );
  /** Множество всех «хранилище данных»-путей по серверной автодетекции —
   *  применяется и к файлам, и к папкам (через префикс) для значков. */
  const [serverHeavyPaths, setServerHeavyPaths] = React.useState<Set<string>>(new Set());
  /** Множество junk-директорий (node_modules, .git, dist, …) от сервера. */
  const [serverJunkDirs, setServerJunkDirs] = React.useState<Set<string>>(new Set());
  /** Все файлы проекта (для file-picker внутри визарда + расчёта зелёных папок). */
  const [allProjectFiles, setAllProjectFiles] = React.useState<
    Array<{ relPath: string; size: number; mtime: number }>
  >([]);
  /** Глобальные sync-статусы (по всем файлам, рекурсивно) — для пометок папок. */
  const [globalStatuses, setGlobalStatuses] = React.useState<Map<string, FileSyncStatus>>(
    new Map(),
  );
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
  // Поиск и сортировка в визарде
  const [heavySearch, setHeavySearch] = React.useState('');
  const [heavySortKey, setHeavySortKey] = React.useState<'name' | 'size' | 'mtime'>('size');
  const [heavySortAsc, setHeavySortAsc] = React.useState(false);
  const [heavyAddPath, setHeavyAddPath] = React.useState('');
  // Slide-панель «выбрать файл из дерева»
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSearch, setPickerSearch] = React.useState('');
  const [pickerSort, setPickerSort] = React.useState<'name' | 'size' | 'mtime'>('mtime');
  const [pickerAsc, setPickerAsc] = React.useState(false);
  type SortKey = 'name' | 'size' | 'mtime' | 'author';
  const [sortKey, setSortKey] = React.useState<SortKey>('name');
  const [sortAsc, setSortAsc] = React.useState(true);

  // Подгружаем настройки приложения (обновляются после смены — в Settings).
  type UiTogglesSnap = {
    foldersBottom: boolean;
    dataFilesBottom: boolean;
    changeFeedAfterSyncOnly: boolean;
    changeFeedShowDiff: boolean;
  };
  const [globalUi, setGlobalUi] = React.useState<UiTogglesSnap | null>(null);
  React.useEffect(() => {
    let alive = true;
    const load = () =>
      window.backupsApp.settings.get().then((s) => {
        if (!alive) return;
        const x = s as Record<string, unknown>;
        setGlobalUi({
          foldersBottom: (x.foldersBottom as boolean) ?? true,
          dataFilesBottom: (x.dataFilesBottom as boolean) ?? true,
          changeFeedAfterSyncOnly: (x.changeFeedAfterSyncOnly as boolean) ?? true,
          changeFeedShowDiff: (x.changeFeedShowDiff as boolean) ?? true,
        });
      });
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Эффективные настройки = глобал + uiOverrides проекта (перекрытия).
  const appSettings = React.useMemo<UiTogglesSnap | null>(() => {
    if (!globalUi) return null;
    const ov = extSync?.uiOverrides ?? {};
    return {
      foldersBottom: ov.foldersBottom ?? globalUi.foldersBottom,
      dataFilesBottom: ov.dataFilesBottom ?? globalUi.dataFilesBottom,
      changeFeedAfterSyncOnly:
        ov.changeFeedAfterSyncOnly ?? globalUi.changeFeedAfterSyncOnly,
      changeFeedShowDiff: ov.changeFeedShowDiff ?? globalUi.changeFeedShowDiff,
    };
  }, [globalUi, extSync?.uiOverrides]);

  // Контекстное меню по ПКМ на файле
  const [ctxMenu, setCtxMenu] = React.useState<null | {
    x: number;
    y: number;
    relPath: string;
    name: string;
    status?: FileSyncStatus;
    isHeavyMarked: boolean;
  }>(null);

  // Кэш расчёта +/- по relPath. Считается лениво для top-N в фиде, когда
  // включён тоггл «Считать +/− строк».
  type DiffEntry =
    | { ins: number; del: number; skipped?: 'binary' | 'too-large' | 'no-local' }
    | 'loading'
    | 'error';
  const [diffCache, setDiffCache] = React.useState<Map<string, DiffEntry>>(new Map());

  // Топ-фид для правой панели «История изменений». Вынесен в useMemo, чтобы
  // эффект подгрузки diff'ов не пересчитывал список на каждый рендер.
  const feedFiles = React.useMemo(() => {
    const excludedSet = new Set(extSync?.excludedPaths ?? []);
    const manualHeavySet = new Set(extSync?.manualHeavyPaths ?? []);
    const afterSyncOnly = !!appSettings?.changeFeedAfterSyncOnly;
    const sinceTs = afterSyncOnly ? extSync?.lastSyncAt ?? 0 : 0;
    const isFiltered = (p: string) => {
      if (serverHeavyPaths.has(p)) return true;
      if (manualHeavySet.has(p)) return true;
      for (const r of excludedSet) if (r && (r === p || p.startsWith(r + '/'))) return true;
      for (const r of manualHeavySet) if (r && (r === p || p.startsWith(r + '/'))) return true;
      return false;
    };
    return allProjectFiles
      .filter((f) => !isFiltered(f.relPath))
      .filter((f) => !afterSyncOnly || f.mtime >= sinceTs)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 60);
  }, [
    allProjectFiles,
    extSync?.excludedPaths,
    extSync?.manualHeavyPaths,
    extSync?.lastSyncAt,
    serverHeavyPaths,
    appSettings?.changeFeedAfterSyncOnly,
  ]);

  // Если тоггл diff'ов выключили — забываем кэш, чтобы при включении заново
  // показались актуальные числа (а в это время ничего не висело).
  React.useEffect(() => {
    if (appSettings?.changeFeedShowDiff === false) {
      setDiffCache(new Map());
    }
  }, [appSettings?.changeFeedShowDiff]);

  // После синхронизации обнуляем diff-кэш — локальные копии обновились,
  // прежние числа уже не верны.
  React.useEffect(() => {
    setDiffCache(new Map());
  }, [extSync?.lastSyncAt]);

  // Множество путей с запросом «в полёте» — через ref, чтобы не было петли
  // с deps useEffect (включение diffCache в deps убивало воркеры на каждый
  // setDiffCache, и записи 'loading' оставались навсегда).
  const inflightRef = React.useRef<Set<string>>(new Set());
  const diffCacheRef = React.useRef<Map<string, DiffEntry>>(new Map());
  React.useEffect(() => {
    diffCacheRef.current = diffCache;
  }, [diffCache]);

  // Подгружаем diff'ы для top-15 видимых строк фида (чтобы не валить сервер).
  React.useEffect(() => {
    if (!appSettings?.changeFeedShowDiff) return;
    if (!isExternal || feedFiles.length === 0) return;
    const targets = feedFiles
      .slice(0, 15)
      .filter(
        (f) => !diffCacheRef.current.has(f.relPath) && !inflightRef.current.has(f.relPath),
      );
    if (targets.length === 0) return;
    setDiffCache((prev) => {
      const next = new Map(prev);
      for (const t of targets) {
        next.set(t.relPath, 'loading');
        inflightRef.current.add(t.relPath);
      }
      return next;
    });
    // Параллелим до 4х одновременных запросов — компромисс между скоростью
    // (на 15 файлов один за одним заняло бы десятки секунд) и нагрузкой.
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (true) {
        const t = queue.shift();
        if (!t) return;
        try {
          // eslint-disable-next-line no-console
          console.log('[diffStats] fetching', t.relPath);
          const r = (await window.backupsApp.externalSync.diffStats(
            serverId,
            projectId,
            t.relPath,
          )) as { ins: number; del: number; skipped?: 'binary' | 'too-large' | 'no-local' };
          // eslint-disable-next-line no-console
          console.log('[diffStats] got', t.relPath, r);
          setDiffCache((prev) => {
            const next = new Map(prev);
            next.set(t.relPath, r);
            return next;
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[diffStats] failed for', t.relPath, e);
          setDiffCache((prev) => {
            const next = new Map(prev);
            next.set(t.relPath, 'error');
            return next;
          });
        } finally {
          inflightRef.current.delete(t.relPath);
        }
      }
    });
    void Promise.all(workers);
  }, [
    appSettings?.changeFeedShowDiff,
    isExternal,
    feedFiles,
    serverId,
    projectId,
  ]);

  React.useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    // Глушим прокрутку под меню — клик/колесико не должны прокручивать
    // страницу, пока меню открыто. Сохраняем прежнее значение overflow,
    // чтобы не сломать стили лэйаута на закрытии.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const stopWheel = (e: WheelEvent) => e.preventDefault();
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', stopWheel, { passive: false });
    window.addEventListener('touchmove', stopWheel as EventListener, { passive: false });
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', stopWheel);
      window.removeEventListener('touchmove', stopWheel as EventListener);
    };
  }, [ctxMenu]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(key === 'name'); }
  }

  const sorted = React.useMemo(() => {
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

    // Файл/папка считается «data» если: путь в excluded, в manualHeavy
    // (или внутри такой папки), либо сервер пометил как heavy.
    const excluded = extSync?.excludedPaths ?? [];
    const manualHeavy = extSync?.manualHeavyPaths ?? [];
    const isDataEntry = (e: TreeEntry): boolean => {
      if (matchesRule(e.path, excluded)) return true;
      if (matchesRule(e.path, manualHeavy)) return true;
      if (e.type === 'file' && serverHeavyPaths.has(e.path)) return true;
      if (e.type === 'dir') {
        const prefix = e.path + '/';
        for (const p of serverHeavyPaths) if (p.startsWith(prefix)) return true;
      }
      return false;
    };

    const dataPushDown = !!appSettings?.dataFilesBottom;
    const foldersDown = !!appSettings?.foldersBottom;

    const dirs: TreeEntry[] = [];
    const files: TreeEntry[] = [];
    const dataDirs: TreeEntry[] = [];
    const dataFiles: TreeEntry[] = [];
    for (const e of entries) {
      const data = dataPushDown && isDataEntry(e);
      if (e.type === 'dir') (data ? dataDirs : dirs).push(e);
      else (data ? dataFiles : files).push(e);
    }
    dirs.sort(cmp);
    files.sort(cmp);
    dataDirs.sort(cmp);
    dataFiles.sort(cmp);
    const top = foldersDown ? [...files, ...dirs] : [...dirs, ...files];
    const bottom = foldersDown ? [...dataFiles, ...dataDirs] : [...dataDirs, ...dataFiles];
    return [...top, ...bottom];
  }, [
    entries,
    sortKey,
    sortAsc,
    appSettings?.foldersBottom,
    appSettings?.dataFilesBottom,
    extSync?.excludedPaths,
    extSync?.manualHeavyPaths,
    serverHeavyPaths,
  ]);

  const loadTree = React.useCallback(
    async (nextPath = pathInRepo, opts: { silent?: boolean } = {}) => {
      // Silent-режим — для фонового авторефреша. Не дёргаем спиннер,
      // не сбрасываем entries: данные подменим только когда придёт ответ.
      if (!opts.silent) setLoading(true);
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

        // Параллельно — статусы синхронизации, чтобы значки на иконках
        // показывали что у юзера есть на диске. Только для external project.
        if (isExternal) {
          const files = r.entries
            .filter((e) => e.type === 'file' && e.size != null && e.mtime != null)
            .map((e) => ({
              relPath: e.path,
              size: e.size as number,
              mtime: e.mtime as number,
            }));
          if (files.length > 0) {
            try {
              const statuses = (await window.backupsApp.externalSync.fileStatuses(
                serverId,
                projectId,
                files,
              )) as Array<{ relPath: string; status: FileSyncStatus }>;
              const map = new Map<string, FileSyncStatus>();
              for (const s of statuses) map.set(s.relPath, s.status);
              setFileStatuses(map);
            } catch {
              setFileStatuses(new Map());
            }
          } else {
            setFileStatuses(new Map());
          }
        }
      } catch (e) {
        const message = (e as Error).message;
        if (message.includes('HTTP 404') && message.includes('/tree')) {
          setServerNeedsUpdate(true);
          setEntries([]);
          return;
        }
        if (!opts.silent) addToast({ type: 'error', text: message });
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [addToast, isExternal, pathInRepo, projectId, serverId],
  );

  // Тик для принудительного перерасчёта списка всех файлов и статусов:
  // обновляется после синка, на focus окна и при клике «Обновить».
  const [refreshTick, setRefreshTick] = React.useState(0);
  const firstLoadDoneRef = React.useRef(false);

  React.useEffect(() => {
    // Первый mount → loud (со спиннером); все последующие тики → silent.
    const silent = firstLoadDoneRef.current;
    void loadTree('', { silent });
    firstLoadDoneRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, projectId, isExternal, refreshTick]);

  // При смене проекта/сервера сбрасываем «первый mount уже был».
  React.useEffect(() => {
    firstLoadDoneRef.current = false;
  }, [serverId, projectId]);

  // Когда окно снова получает фокус — например, юзер вернулся в приложение
  // после правки файла на проде — освежаем mtime'ы.
  React.useEffect(() => {
    if (!isExternal) return;
    const onFocus = () => setRefreshTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isExternal]);

  // Авто-опрос каждые 15с, пока вкладка/окно видимы. На скрытом окне таймер
  // не тикает — вернётся через onFocus и сразу же дёрнется ручной рефреш.
  React.useEffect(() => {
    if (!isExternal) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setRefreshTick((t) => t + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, [isExternal]);

  React.useEffect(() => {
    if (!isExternal) return;
    void window.backupsApp.externalSync
      .get(serverId, projectId)
      .then((s) => setExtSync(s as ExtSync | null));
    // Подгружаем серверный отчёт «хранилище данных» один раз — нужен для
    // значков на файлах и папках в общем дереве (не только в визарде).
    void window.backupsApp.externalSync
      .detectDataStore(serverId, projectId)
      .then((report) => {
        const r = report as DataStoreReport | null;
        if (!r) return;
        setServerHeavyPaths(new Set((r.files ?? []).map((f) => f.relPath)));
        setServerJunkDirs(new Set((r.junkDirs ?? []).map((d) => d.relPath)));
      })
      .catch(() => {
        /* старый сервер — fallback на клиентский regex остаётся */
      });

    // Грузим список ВСЕХ файлов проекта рекурсивно — нужен для двух вещей:
    // 1) file-picker внутри визарда (выбрать любой файл и пометить как
    //    хранилище);
    // 2) расчёт «вся папка синхронизирована» для зелёного маркера на папках.
    void (async () => {
      try {
        const files = (await window.backupsApp.externalSync.listAllFiles(
          serverId,
          projectId,
        )) as Array<{ relPath: string; size: number; mtime: number }>;
        setAllProjectFiles(files);
        if (files.length > 0) {
          const statuses = (await window.backupsApp.externalSync.fileStatuses(
            serverId,
            projectId,
            files,
          )) as Array<{ relPath: string; status: FileSyncStatus }>;
          const map = new Map<string, FileSyncStatus>();
          for (const s of statuses) map.set(s.relPath, s.status);
          setGlobalStatuses(map);
        } else {
          setGlobalStatuses(new Map());
        }
      } catch {
        /* старый сервер без /tree-recursive — оставляем пустые */
      }
    })();
  }, [isExternal, serverId, projectId, refreshTick]);

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
      if (p.phase === 'done') {
        // Запросить свежий список файлов и статусы — теперь часть может
        // оказаться в категории «изменено после синка».
        setRefreshTick((t) => t + 1);
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
      // Сливаем «хранилище данных» из 3 источников:
      // 1) что юзер пометил руками (extSync.manualHeavyPaths),
      // 2) что детектор сервера нашёл автоматом (serverHeavyPaths) — на случай,
      //    если визард ещё не запускали;
      // вычитаем то, что юзер явно добавил в manualPaths (хочет качать).
      const manualSet = new Set(extSync?.manualPaths ?? []);
      const heavyMerged = new Set<string>([...(extSync?.manualHeavyPaths ?? [])]);
      for (const p of serverHeavyPaths) {
        if (!manualSet.has(p)) heavyMerged.add(p);
      }
      const result = (await window.backupsApp.externalSync.run({
        serverId,
        projectId,
        localPath,
        includeHeavy,
        manualPaths: extSync?.manualPaths,
        excludedPaths: extSync?.excludedPaths,
        manualHeavyPaths: Array.from(heavyMerged),
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
    const cur = extSync ?? {
      projectId,
      localPath: '',
      excludedPaths: [] as string[],
      manualPaths: [] as string[],
      manualHeavyPaths: [] as string[],
    };
    // Все пути, которые показывали в визарде, перестраиваем с нуля.
    // Существующие правила, не относящиеся к этим путям, оставляем как есть.
    const wizardSet = new Set(heavyCandidates.map((c) => c.relPath));
    const keptManual = (cur.manualPaths ?? []).filter((p) => !wizardSet.has(p));
    const keptExcluded = (cur.excludedPaths ?? []).filter((p) => !wizardSet.has(p));
    const keptHeavy = (cur.manualHeavyPaths ?? []).filter((p) => !wizardSet.has(p));
    const nextManual = [...keptManual];
    const nextExcluded = [...keptExcluded];
    const nextHeavy = [...keptHeavy];
    for (const f of heavyCandidates) {
      const c = heavyChoices[f.relPath] ?? 'heavy';
      if (c === 'normal') nextManual.push(f.relPath);
      else if (c === 'excluded') nextExcluded.push(f.relPath);
      else nextHeavy.push(f.relPath); // 'heavy' → запоминаем как «хранилище данных»
    }
    let localPath = cur.localPath;
    if (runSyncAfter && !localPath) {
      const chosen = await chooseLocalFolder();
      if (!chosen) return;
      localPath = chosen;
    }
    if (cur.localPath || localPath) {
      const updated = (await window.backupsApp.externalSync.setRules({
        serverId,
        projectId,
        manualPaths: nextManual,
        excludedPaths: nextExcluded,
        manualHeavyPaths: nextHeavy,
      })) as ExtSync | null;
      setExtSync(
        updated ?? {
          projectId,
          localPath,
          excludedPaths: nextExcluded,
          manualPaths: nextManual,
          manualHeavyPaths: nextHeavy,
        },
      );
    } else {
      setExtSync({
        projectId,
        localPath: '',
        excludedPaths: nextExcluded,
        manualPaths: nextManual,
        manualHeavyPaths: nextHeavy,
      });
    }
    setHeavyDialogOpen(false);
    if (runSyncAfter) {
      // includeHeavy=true → скачаются и файлы хранилища (manualHeavyPaths),
      // потому что юзер явно нажал «и скачать». Те, что пометили excluded,
      // пропустятся; manual («обычный») гарантированно скачаются.
      await runSyncWith({
        includeHeavy: true,
        manualPaths: nextManual,
        excludedPaths: nextExcluded,
        manualHeavyPaths: nextHeavy,
        localPath,
      });
    }
  }

  async function runSyncWith(p: {
    includeHeavy: boolean;
    manualPaths: string[];
    excludedPaths: string[];
    manualHeavyPaths?: string[];
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
        manualHeavyPaths: p.manualHeavyPaths,
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

  /** Toggle: пометить файл/папку как «хранилище данных» (manualHeavy). */
  async function toggleHeavyMark(relPath: string) {
    const cur = extSync ?? {
      projectId,
      localPath: '',
      excludedPaths: [],
      manualPaths: [],
      manualHeavyPaths: [],
    };
    const heavy = new Set(cur.manualHeavyPaths ?? []);
    const excluded = new Set(cur.excludedPaths ?? []);
    if (heavy.has(relPath)) {
      heavy.delete(relPath);
    } else {
      heavy.add(relPath);
      excluded.delete(relPath); // взаимоисключающе с excluded
    }
    await applyRules(cur, {
      manualHeavyPaths: Array.from(heavy),
      excludedPaths: Array.from(excluded),
    });
  }

  /** Toggle: пометить «не качать никогда» (excluded). */
  async function toggleExcluded(relPath: string) {
    const cur = extSync ?? {
      projectId,
      localPath: '',
      excludedPaths: [],
      manualPaths: [],
      manualHeavyPaths: [],
    };
    const excluded = new Set(cur.excludedPaths ?? []);
    const heavy = new Set(cur.manualHeavyPaths ?? []);
    const manual = new Set(cur.manualPaths ?? []);
    if (excluded.has(relPath)) {
      excluded.delete(relPath);
    } else {
      excluded.add(relPath);
      heavy.delete(relPath);
      manual.delete(relPath);
    }
    await applyRules(cur, {
      excludedPaths: Array.from(excluded),
      manualHeavyPaths: Array.from(heavy),
      manualPaths: Array.from(manual),
    });
  }

  /** Применяет частичный апдейт правил extSync (на бэк, либо локально если папки нет). */
  async function applyRules(cur: ExtSync, patch: Partial<ExtSync>) {
    const next: ExtSync = { ...cur, ...patch };
    if (!cur.localPath) {
      setExtSync(next);
      return;
    }
    const updated = (await window.backupsApp.externalSync.setRules({
      serverId,
      projectId,
      manualPaths: next.manualPaths,
      excludedPaths: next.excludedPaths,
      manualHeavyPaths: next.manualHeavyPaths,
    })) as ExtSync | null;
    setExtSync(updated ?? next);
  }

  /** Добавить произвольный путь в категорию «хранилище» вручную. */
  function addHeavyByPath(rawPath: string) {
    const p = rawPath.trim().replace(/^\/+/, '').replace(/\\+/g, '/');
    if (!p) return;
    if (heavyCandidates?.some((c) => c.relPath === p)) {
      addToast({ type: 'info', text: 'Этот путь уже в списке' });
      return;
    }
    const candidate: HeavyCandidate = {
      relPath: p,
      size: 0,
      mtime: 0,
      labels: ['добавлено вручную'],
      reasons: ['name'],
    };
    setHeavyCandidates((prev) => (prev ? [candidate, ...prev] : [candidate]));
    setHeavyChoices((prev) => ({ ...prev, [p]: 'heavy' }));
    setHeavyAddPath('');
    addToast({ type: 'success', text: `Добавлено в хранилище: ${p}` });
  }

  /** Скачать/обновить один файл прямо в локальную папку синка (если она есть). */
  async function refreshFileLocally(entry: TreeEntry) {
    try {
      let localPath = extSync?.localPath;
      if (!localPath) {
        // Папка не выбрана — предложим выбрать сейчас.
        const chosen = (await window.backupsApp.externalSync.chooseFolder()) as string | null;
        if (!chosen) return;
        localPath = chosen;
        setExtSync(
          extSync
            ? { ...extSync, localPath: chosen }
            : {
                projectId,
                localPath: chosen,
                excludedPaths: [],
                manualPaths: [],
                manualHeavyPaths: [],
              },
        );
      }
      await window.backupsApp.externalSync.downloadToLocal(serverId, projectId, entry.path);
      addToast({ type: 'success', text: `Файл обновлён: ${entry.name}` });
      // Перечитаем статусы, чтобы значок стал зелёным.
      await loadTree(pathInRepo);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-stretch">
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void loadTree();
                setRefreshTick((t) => t + 1);
              }}
            >
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
                {sorted.map((entry) => {
                  const status =
                    entry.type === 'file' ? fileStatuses.get(entry.path) : undefined;
                  // Зелёный маркер на папке: все её файлы (рекурсивно)
                  // синхронизированы. Игнорируем heavy и excluded — их быть не
                  // обязано локально, чтобы папка считалась «в порядке».
                  let folderAllSynced = false;
                  if (entry.type === 'dir' && globalStatuses.size > 0) {
                    const prefix = entry.path + '/';
                    let any = false;
                    let allOk = true;
                    for (const [p, st] of globalStatuses) {
                      if (!p.startsWith(prefix)) continue;
                      if (serverHeavyPaths.has(p)) continue;
                      if (matchesRule(p, extSync?.excludedPaths)) continue;
                      if (matchesRule(p, extSync?.manualHeavyPaths)) continue;
                      any = true;
                      if (st !== 'synced') {
                        allOk = false;
                        break;
                      }
                    }
                    folderAllSynced = any && allOk;
                  }
                  const inExcluded = matchesRule(entry.path, extSync?.excludedPaths);
                  const inManualHeavy = matchesRule(entry.path, extSync?.manualHeavyPaths);
                  const inManualOverride = matchesRule(entry.path, extSync?.manualPaths);
                  // Heavy по серверной автодетекции: для файла — точный путь,
                  // для папки — есть ли внутри хоть один heavy-файл.
                  let serverHeavy = false;
                  if (entry.type === 'file') {
                    serverHeavy = serverHeavyPaths.has(entry.path);
                  } else {
                    const prefix = entry.path + '/';
                    for (const p of serverHeavyPaths) {
                      if (p.startsWith(prefix)) {
                        serverHeavy = true;
                        break;
                      }
                    }
                  }
                  // Junk-папка — отдельный значок (не Database).
                  const isJunkDir = entry.type === 'dir' && serverJunkDirs.has(entry.path);
                  const autoHeavy =
                    serverHeavy ||
                    (entry.type === 'file' && isHeavyPath(entry.path)) ||
                    (entry.type === 'dir' && isHeavyPath(entry.name));
                  const isHeavyMarked = (autoHeavy && !inManualOverride) || inManualHeavy;
                  return (
                  <li
                    key={entry.path}
                    className={
                      (isExternal
                        ? 'grid grid-cols-[minmax(0,1fr)_100px_160px_100px]'
                        : 'grid grid-cols-[minmax(0,1fr)_150px_140px_120px]') +
                      ' items-center gap-3 px-4 py-3 text-sm transition hover:bg-accent/20 ' +
                      (selected?.path === entry.path ? 'bg-accent/25' : '') +
                      (inExcluded ? ' opacity-60' : '')
                    }
                    onContextMenu={(e) => {
                      if (entry.type !== 'file' || !isExternal) return;
                      e.preventDefault();
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        relPath: entry.path,
                        name: entry.name,
                        status,
                        isHeavyMarked,
                      });
                    }}
                  >
                    <button
                      className="flex min-w-0 items-center gap-3 text-left"
                      onClick={() =>
                        entry.type === 'dir' ? loadTree(entry.path) : void selectFile(entry)
                      }
                    >
                      <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted/40">
                        {entry.type === 'dir' ? (
                          <Folder className="accent-fg h-5 w-5" />
                        ) : (
                          <FileText className="accent-fg h-5 w-5 opacity-60" />
                        )}
                        {/* Неоновая скрепка — overlay в углу иконки. Paperclip
                            сам по себе под углом, неон делаем drop-shadow'ом. */}
                        {status === 'synced' && (
                          <span title="Совпадает с продой" className="absolute -bottom-0.5 -right-0.5 leading-none">
                            <Paperclip className="h-3 w-3 text-emerald-400/80 drop-shadow-[0_0_3px_rgba(74,222,128,0.95)]" />
                          </span>
                        )}
                        {status === 'modified' && (
                          <span title="Изменён локально" className="absolute -bottom-0.5 -right-0.5 leading-none">
                            <Paperclip className="h-3 w-3 text-amber-400/80 drop-shadow-[0_0_3px_rgba(251,191,36,0.85)]" />
                          </span>
                        )}
                        {status === 'missing' && (
                          <span title="Не скачано на ПК" className="absolute -bottom-0.5 -right-0.5 leading-none">
                            <Paperclip className="h-3 w-3 text-slate-400/30" />
                          </span>
                        )}
                        {/* Папка: все её файлы (рекурсивно) синхронизированы. */}
                        {entry.type === 'dir' && folderAllSynced && (
                          <span title="Все файлы папки скачаны и совпадают с продой" className="absolute -bottom-0.5 -right-0.5 leading-none">
                            <Paperclip className="h-3 w-3 text-emerald-400/80 drop-shadow-[0_0_3px_rgba(74,222,128,0.95)]" />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 font-medium">
                          <span className="truncate">{entry.name}</span>
                          {/* Junk-папка (node_modules, .git, dist…) — серая метка */}
                          {isExternal && isJunkDir && (
                            <span title="Зависимости / автогенерируемое — автоматически исключается">
                              <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            </span>
                          )}
                          {/* Метка «Хранилище данных» — для файлов и папок (если внутри есть БД/бэкапы). */}
                          {isExternal && isHeavyMarked && !inExcluded && !isJunkDir && (
                            <span
                              title={
                                entry.type === 'dir'
                                  ? 'В этой папке есть файлы хранилища данных — качаются по кнопке «Хранилище данных…»'
                                  : 'Файл хранилища данных — качается через «Хранилище данных…»'
                              }
                            >
                              <Database className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                            </span>
                          )}
                          {/* Метка «исключено» */}
                          {isExternal && inExcluded && (
                            <span title="Исключено из синхронизации">
                              <Ban className="h-3.5 w-3.5 shrink-0 text-rose-400/80" />
                            </span>
                          )}
                          {/* Override на heavy → файл тащим как обычный */}
                          {isExternal && autoHeavy && inManualOverride && !inExcluded && (
                            <Badge variant="success" className="shrink-0">manual</Badge>
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
                          <Button variant="ghost" size="sm" title="Открыть файл" onClick={() => openFile(entry)}>
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title={
                              isExternal && extSync?.localPath
                                ? status === 'synced'
                                  ? 'Обновить файл (перекачать с проды)'
                                  : status === 'modified'
                                    ? 'Обновить (локальная копия изменена — будет перезаписана)'
                                    : 'Скачать в локальную папку синка'
                                : 'Скачать файл'
                            }
                            onClick={() => {
                              if (isExternal && extSync?.localPath) {
                                void refreshFileLocally(entry);
                              } else {
                                void downloadFile(entry);
                              }
                            }}
                          >
                            {isExternal && extSync?.localPath && (status === 'synced' || status === 'modified') ? (
                              <RefreshCw className="h-4 w-4" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => loadTree(entry.path)}>
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex min-h-0 flex-col gap-4 lg:h-full">
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

        {isExternal ? (
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>История изменений</CardTitle>
              <CardDescription>
                Последние изменения файлов на проде (без хранилища данных и исключённых).
              </CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              {(() => {
                const afterSyncOnly = !!appSettings?.changeFeedAfterSyncOnly;
                if (allProjectFiles.length === 0) {
                  return (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      Сервер ещё не отдал список файлов…
                    </div>
                  );
                }
                if (feedFiles.length === 0) {
                  if (afterSyncOnly && !extSync?.lastSyncAt) {
                    return (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                        Синка ещё не было — нечего сравнивать. Запустите синхронизацию, чтобы зафиксировать точку отсчёта.
                      </div>
                    );
                  }
                  if (afterSyncOnly) {
                    return (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                        После последней синхронизации ничего не менялось.
                      </div>
                    );
                  }
                  return (
                    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                      Все недавно изменённые файлы попадают под «хранилище данных».
                    </div>
                  );
                }
                return (
                  <ul className="space-y-2">
                    {feedFiles.map((f) => {
                      const status = globalStatuses.get(f.relPath);
                      const lastSlash = f.relPath.lastIndexOf('/');
                      const dir = lastSlash >= 0 ? f.relPath.slice(0, lastSlash) : '';
                      const name = lastSlash >= 0 ? f.relPath.slice(lastSlash + 1) : f.relPath;
                      const sizeKb = f.size < 1024
                        ? `${f.size} Б`
                        : f.size < 1024 * 1024
                          ? `${(f.size / 1024).toFixed(1)} КБ`
                          : `${(f.size / 1024 / 1024).toFixed(1)} МБ`;
                      const feedHeavy =
                        serverHeavyPaths.has(f.relPath) ||
                        matchesRule(f.relPath, extSync?.manualHeavyPaths);
                      const diff = diffCache.get(f.relPath);
                      return (
                        <li
                          key={f.relPath}
                          className="cursor-default rounded-md border border-border bg-muted/10 p-2.5"
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCtxMenu({
                              x: e.clientX,
                              y: e.clientY,
                              relPath: f.relPath,
                              name,
                              status,
                              isHeavyMarked: feedHeavy,
                            });
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm font-medium">{name}</span>
                            {status === 'synced' && (
                              <Paperclip className="ml-auto h-3 w-3 shrink-0 text-emerald-400/80 drop-shadow-[0_0_3px_rgba(74,222,128,0.95)]" />
                            )}
                            {status === 'modified' && (
                              <Paperclip className="ml-auto h-3 w-3 shrink-0 text-amber-400/80 drop-shadow-[0_0_3px_rgba(251,191,36,0.95)]" />
                            )}
                          </div>
                          {dir && (
                            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                              {dir}/
                            </div>
                          )}
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>{formatRelativeTime(f.mtime)}</span>
                            <span>·</span>
                            <span>{sizeKb}</span>
                            {appSettings?.changeFeedShowDiff && (
                              <span className="ml-auto flex items-center gap-1.5 font-mono">
                                {diff === 'loading' && (
                                  <span className="text-muted-foreground/70">…</span>
                                )}
                                {diff === 'error' && (
                                  <span className="text-rose-400/70" title="Не удалось посчитать">
                                    ⚠
                                  </span>
                                )}
                                {typeof diff === 'object' && diff?.skipped === 'binary' && (
                                  <span className="text-muted-foreground/70" title="Бинарный файл — diff не считается">
                                    bin
                                  </span>
                                )}
                                {typeof diff === 'object' && diff?.skipped === 'too-large' && (
                                  <span className="text-muted-foreground/70" title="Файл слишком большой">
                                    ≫
                                  </span>
                                )}
                                {typeof diff === 'object' && diff?.skipped === 'no-local' && diff.ins > 0 && (
                                  <span className="text-emerald-400" title={`Файла нет локально: ${diff.ins} строк на проде`}>
                                    +{diff.ins}
                                  </span>
                                )}
                                {typeof diff === 'object' && !diff?.skipped && (
                                  <>
                                    {diff.ins > 0 && (
                                      <span className="text-emerald-400" title={`+${diff.ins} строк`}>
                                        +{diff.ins}
                                      </span>
                                    )}
                                    {diff.del > 0 && (
                                      <span className="text-rose-400" title={`−${diff.del} строк`}>
                                        −{diff.del}
                                      </span>
                                    )}
                                    {diff.ins === 0 && diff.del === 0 && (
                                      <span className="text-muted-foreground/60" title="Идентично локальной копии">=</span>
                                    )}
                                  </>
                                )}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </CardContent>
          </Card>
        ) : (
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
        )}
      </div>
    </div>

    <Dialog
      size="lg"
      align={pickerOpen ? 'left' : 'center'}
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
            <div className="rounded-lg border border-border bg-muted/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="например: var/log или secret-data/users.csv"
                  value={heavyAddPath}
                  onChange={(e) => setHeavyAddPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addHeavyByPath(heavyAddPath);
                  }}
                  className="min-w-[200px] flex-1 rounded-md border border-input bg-background/40 px-3 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addHeavyByPath(heavyAddPath)}
                  disabled={!heavyAddPath.trim()}
                >
                  <Plus className="h-3.5 w-3.5" /> По пути
                </Button>
                <Button
                  size="sm"
                  variant="gradient"
                  onClick={() => setPickerOpen(true)}
                  disabled={allProjectFiles.length === 0}
                  title="Выдвинуть панель со списком всех файлов проекта"
                >
                  <FileText className="h-3.5 w-3.5" /> Выбрать из дерева →
                </Button>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Можно ввести путь руками или открыть выдвижной список всех файлов проекта.
              </div>
            </div>

            {heavyCandidates && heavyCandidates.length > 0 && (
            <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-1 min-w-[180px] items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Поиск по пути или ярлыку…"
                  value={heavySearch}
                  onChange={(e) => setHeavySearch(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                {heavySearch && (
                  <button
                    onClick={() => setHeavySearch('')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>Сорт:</span>
                {(['size', 'mtime', 'name'] as const).map((k) => {
                  const active = heavySortKey === k;
                  const labels: Record<typeof k, string> = {
                    size: 'размер',
                    mtime: 'дата',
                    name: 'имя',
                  };
                  return (
                    <button
                      key={k}
                      onClick={() => {
                        if (active) setHeavySortAsc((v) => !v);
                        else {
                          setHeavySortKey(k);
                          setHeavySortAsc(k === 'name');
                        }
                      }}
                      className={
                        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition ' +
                        (active
                          ? 'bg-card text-foreground'
                          : 'hover:bg-card hover:text-foreground')
                      }
                    >
                      {labels[k]}
                      {active && (heavySortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="max-h-[36vh] space-y-1 overflow-y-auto rounded-md border border-border bg-muted/10 p-2">
              {(() => {
                const q = heavySearch.trim().toLowerCase();
                const filtered = q
                  ? heavyCandidates.filter(
                      (f) =>
                        f.relPath.toLowerCase().includes(q) ||
                        f.labels?.some((l) => l.toLowerCase().includes(q)),
                    )
                  : heavyCandidates;
                const sorted = [...filtered].sort((a, b) => {
                  let v = 0;
                  if (heavySortKey === 'name') v = a.relPath.localeCompare(b.relPath);
                  else if (heavySortKey === 'size') v = a.size - b.size;
                  else if (heavySortKey === 'mtime') v = a.mtime - b.mtime;
                  return heavySortAsc ? v : -v;
                });
                if (sorted.length === 0) {
                  return (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      Ничего не найдено по «{heavySearch}»
                    </div>
                  );
                }
                return sorted.map((f) => {
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
                });
              })()}
            </div>
            </>
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

    {/* Отдельное выдвижное окно справа — picker с папками/файлами как
        на главной странице проекта. Открывается одновременно с визардом,
        не накрывает его. */}
    <DataStorePicker
      open={heavyDialogOpen && pickerOpen}
      onClose={() => setPickerOpen(false)}
      serverId={serverId}
      projectId={projectId}
      pickedPaths={new Set((heavyCandidates ?? []).map((c) => c.relPath))}
      onPick={(p) => addHeavyByPath(p)}
      globalStatuses={globalStatuses}
      serverHeavyPaths={serverHeavyPaths}
      serverJunkDirs={serverJunkDirs}
    />

    {ctxMenu && (() => {
      const synced = ctxMenu.status === 'synced';
      const modified = ctxMenu.status === 'modified';
      const hasLocal = synced || modified;
      // Поджимаем меню к краю окна, чтобы не уезжало за вьюпорт.
      const w = 240;
      const h = 124;
      const x = Math.min(ctxMenu.x, window.innerWidth - w - 4);
      const y = Math.min(ctxMenu.y, window.innerHeight - h - 4);
      const fakeEntry: TreeEntry = {
        path: ctxMenu.relPath,
        name: ctxMenu.name,
        type: 'file',
        size: null,
      };
      return (
        <div
          className="fixed z-50 min-w-[240px] overflow-hidden rounded-md border border-border bg-popover shadow-2xl"
          style={{ left: x, top: y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/40"
            onClick={() => {
              void toggleHeavyMark(ctxMenu.relPath);
              setCtxMenu(null);
            }}
          >
            <Database className="h-4 w-4 text-amber-400/90" />
            <span>{ctxMenu.isHeavyMarked ? 'Убрать из хранилища данных' : 'Пометить как данные'}</span>
          </button>
          <button
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/40"
            onClick={() => {
              void openFile(fakeEntry);
              setCtxMenu(null);
            }}
          >
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            <span>Открыть</span>
          </button>
          <button
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/40"
            onClick={() => {
              void refreshFileLocally(fakeEntry);
              setCtxMenu(null);
            }}
          >
            {hasLocal ? (
              <RefreshCw className="h-4 w-4 text-emerald-400/90" />
            ) : (
              <Download className="h-4 w-4 text-emerald-400/90" />
            )}
            <span>{hasLocal ? 'Обновить файл' : 'Скачать'}</span>
          </button>
        </div>
      );
    })()}
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

interface PickerEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime?: number;
}

/**
 * Выдвижное окно справа со своим деревом проекта (с папками, breadcrumbs,
 * сортировкой). Открывается параллельно с визардом «Хранилище данных»,
 * имеет свой собственный backdrop справа, не перекрывает визард.
 */
function DataStorePicker({
  open,
  onClose,
  serverId,
  projectId,
  pickedPaths,
  onPick,
  globalStatuses,
  serverHeavyPaths,
  serverJunkDirs,
}: {
  open: boolean;
  onClose: () => void;
  serverId: string;
  projectId: string;
  pickedPaths: Set<string>;
  onPick: (relPath: string) => void;
  globalStatuses: Map<string, FileSyncStatus>;
  serverHeavyPaths: Set<string>;
  serverJunkDirs: Set<string>;
}) {
  const [pathInRepo, setPathInRepo] = React.useState('');
  const [entries, setEntries] = React.useState<PickerEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [sortKey, setSortKey] = React.useState<'name' | 'size' | 'mtime'>('mtime');
  const [sortAsc, setSortAsc] = React.useState(false);

  const load = React.useCallback(
    async (next: string) => {
      setLoading(true);
      try {
        const r = (await window.backupsApp.projects.tree(
          serverId,
          projectId,
          next,
          'HEAD',
        )) as { entries: PickerEntry[] };
        setEntries(r.entries);
        setPathInRepo(next);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [serverId, projectId],
  );

  React.useEffect(() => {
    if (open) void load('');
  }, [open, load]);

  if (!open) return null;

  const filtered = (() => {
    const q = search.trim().toLowerCase();
    let list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    list = [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      let v = 0;
      if (sortKey === 'name') v = a.name.localeCompare(b.name);
      else if (sortKey === 'size') v = (a.size ?? 0) - (b.size ?? 0);
      else if (sortKey === 'mtime') v = (a.mtime ?? 0) - (b.mtime ?? 0);
      return sortAsc ? v : -v;
    });
    return list;
  })();

  const crumbs = pathInRepo ? pathInRepo.split('/') : [];

  return (
    <div
      role="dialog"
      aria-modal="false"
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed top-0 right-0 z-[60] m-4 flex h-[calc(100vh-2rem)] w-[480px] max-w-[40vw] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-right duration-300"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Файлы проекта</div>
          <div className="text-[11px] text-muted-foreground">
            Выбери файл или папку — пометится как «хранилище данных»
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Закрыть"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/20 px-3 py-2 text-xs">
        <button
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
          onClick={() => void load('')}
        >
          <Home className="h-3 w-3" />
          root
        </button>
        {crumbs.map((part, idx) => {
          const p = crumbs.slice(0, idx + 1).join('/');
          return (
            <React.Fragment key={p}>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
                onClick={() => void load(p)}
              >
                {part}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Search + sort */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-1 min-w-[140px] items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Поиск в этой папке…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {(['mtime', 'size', 'name'] as const).map((k) => {
            const active = sortKey === k;
            const labels: Record<typeof k, string> = {
              size: 'размер',
              mtime: 'дата',
              name: 'имя',
            };
            return (
              <button
                key={k}
                onClick={() => {
                  if (active) setSortAsc((v) => !v);
                  else {
                    setSortKey(k);
                    setSortAsc(k === 'name');
                  }
                }}
                className={
                  'inline-flex items-center gap-0.5 rounded px-1 py-0.5 transition ' +
                  (active ? 'bg-card text-foreground' : 'hover:bg-card hover:text-foreground')
                }
              >
                {labels[k]}
                {active && (sortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="py-8 text-center text-xs text-muted-foreground">Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {search ? `Ничего не найдено по «${search}»` : 'Пусто в этой папке'}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((entry) => {
              const status =
                entry.type === 'file' ? globalStatuses.get(entry.path) : undefined;
              const isJunk = entry.type === 'dir' && serverJunkDirs.has(entry.path);
              const isHeavy =
                (entry.type === 'file' && serverHeavyPaths.has(entry.path)) ||
                (entry.type === 'file' && isHeavyPath(entry.path)) ||
                (entry.type === 'dir' && isHeavyPath(entry.name));
              const alreadyPicked = pickedPaths.has(entry.path);
              // Зелёная скрепка для папки: все её файлы (рекурсивно) synced.
              // Heavy и junk-файлы из проверки исключаем.
              let folderAllSynced = false;
              if (entry.type === 'dir' && globalStatuses.size > 0) {
                const prefix = entry.path + '/';
                let any = false;
                let allOk = true;
                for (const [p, st] of globalStatuses) {
                  if (!p.startsWith(prefix)) continue;
                  if (serverHeavyPaths.has(p)) continue;
                  any = true;
                  if (st !== 'synced') {
                    allOk = false;
                    break;
                  }
                }
                folderAllSynced = any && allOk;
              }
              return (
                <li
                  key={entry.path}
                  className="flex items-center gap-2 px-2 py-1.5 transition hover:bg-accent/20"
                >
                  <button
                    className="flex min-w-0 items-center gap-2 text-left"
                    onClick={() => entry.type === 'dir' && void load(entry.path)}
                  >
                    <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted/40">
                      {entry.type === 'dir' ? (
                        <Folder className="accent-fg h-4 w-4" />
                      ) : (
                        <FileText className="accent-fg h-4 w-4 opacity-60" />
                      )}
                      {status === 'synced' && (
                        <span title="Совпадает с продой" className="absolute -bottom-0.5 -right-0.5 leading-none">
                          <Paperclip className="h-2.5 w-2.5 text-emerald-400/80 drop-shadow-[0_0_2px_rgba(74,222,128,0.95)]" />
                        </span>
                      )}
                      {status === 'modified' && (
                        <span title="Изменён локально" className="absolute -bottom-0.5 -right-0.5 leading-none">
                          <Paperclip className="h-2.5 w-2.5 text-amber-400/80 drop-shadow-[0_0_2px_rgba(251,191,36,0.85)]" />
                        </span>
                      )}
                      {status === 'missing' && (
                        <span title="Не скачано на ПК" className="absolute -bottom-0.5 -right-0.5 leading-none">
                          <Paperclip className="h-2.5 w-2.5 text-slate-400/30" />
                        </span>
                      )}
                      {entry.type === 'dir' && folderAllSynced && (
                        <span title="Все файлы папки скачаны и совпадают с продой" className="absolute -bottom-0.5 -right-0.5 leading-none">
                          <Paperclip className="h-2.5 w-2.5 text-emerald-400/80 drop-shadow-[0_0_2px_rgba(74,222,128,0.95)]" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <span className="truncate">{entry.name}</span>
                        {isJunk && <Ban className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
                        {isHeavy && !isJunk && (
                          <Database className="h-3 w-3 shrink-0 text-amber-400/80" />
                        )}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {entry.type === 'dir'
                          ? 'папка'
                          : `${formatBytes(entry.size ?? 0)} · ${entry.mtime ? formatRelativeTime(entry.mtime) : '—'}`}
                      </span>
                    </span>
                  </button>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {entry.type === 'dir' && (
                      <button
                        onClick={() => void load(entry.path)}
                        className="rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground"
                        title="Открыть папку"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}
                    <Button
                      size="sm"
                      variant={alreadyPicked ? 'ghost' : 'outline'}
                      disabled={alreadyPicked}
                      onClick={() => onPick(entry.path)}
                      title={
                        alreadyPicked
                          ? 'Уже добавлен'
                          : entry.type === 'dir'
                            ? 'Пометить всю папку как хранилище'
                            : 'Пометить как хранилище данных'
                      }
                    >
                      {alreadyPicked ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground">
        Кликни по папке, чтобы зайти внутрь. Тыкни «+», чтобы добавить файл или целую папку.
      </div>
    </div>
  );
}
