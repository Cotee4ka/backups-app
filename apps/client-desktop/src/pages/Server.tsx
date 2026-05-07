import React from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useAppStore } from '@/store/app-store';
import { Cloud, Plus, Server, Trash2, FolderGit2, ShieldCheck, Copy, ChevronRight, HardDrive, ChevronUp, Folder, FileText, Loader2 } from 'lucide-react';
import { copyToClipboard, formatRelativeTime } from '@/lib/utils';

interface ProjectRow {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  createdBy: string;
  defaultBranch: string;
  externalPath?: string;
}

interface BrowseEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime: number;
}

export const ServerPage = () => {
  const { serverId = '' } = useParams();
  const nav = useNavigate();
  const servers = useAppStore((s) => s.servers);
  const refresh = useAppStore((s) => s.refreshServers);
  const removeServer = useAppStore((s) => s.removeServer);
  const addToast = useAppStore((s) => s.addToast);

  const server = servers.find((s) => s.id === serverId);
  const [projects, setProjects] = React.useState<ProjectRow[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newDesc, setNewDesc] = React.useState('');

  const [attachOpen, setAttachOpen] = React.useState(false);
  const [attachName, setAttachName] = React.useState('');
  const [attachPath, setAttachPath] = React.useState('/host');
  const [browseEntries, setBrowseEntries] = React.useState<BrowseEntry[]>([]);
  const [browseLoading, setBrowseLoading] = React.useState(false);
  const [browseError, setBrowseError] = React.useState<string | null>(null);
  const [attaching, setAttaching] = React.useState(false);

  React.useEffect(() => {
    if (!server) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function load() {
    setLoading(true);
    try {
      const r = (await window.backupsApp.projects.list(serverId)) as { projects: ProjectRow[] };
      setProjects(r.projects);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    if (!newName.trim()) return;
    try {
      const r = (await window.backupsApp.projects.create(serverId, newName.trim(), newDesc.trim() || undefined)) as {
        project: { id: string; name: string };
      };
      setCreateOpen(false);
      setNewName('');
      setNewDesc('');
      await load();
      nav(`/server/${serverId}/project/${r.project.id}`);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  async function loadBrowse(p: string) {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const r = (await window.backupsApp.projects.browseHost(serverId, p)) as {
        path: string;
        entries: BrowseEntry[];
      };
      setBrowseEntries(r.entries);
      setAttachPath(r.path);
    } catch (e) {
      setBrowseError((e as Error).message);
      setBrowseEntries([]);
    } finally {
      setBrowseLoading(false);
    }
  }

  function openAttach() {
    setAttachName('');
    setAttachPath('/host');
    setBrowseEntries([]);
    setBrowseError(null);
    setAttachOpen(true);
    void loadBrowse('/host');
  }

  async function attach() {
    if (!attachName.trim() || !attachPath.startsWith('/host')) return;
    setAttaching(true);
    try {
      const r = (await window.backupsApp.projects.createExternal(
        serverId,
        attachName.trim(),
        attachPath,
      )) as { project: { id: string; name: string; externalPath: string } };
      setAttachOpen(false);
      await load();
      nav(`/server/${serverId}/project/${r.project.id}`);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setAttaching(false);
    }
  }

  async function deleteServer() {
    if (!server) return;
    if (!confirm(`Удалить ${server.name} из приложения? Сами данные на VPS не удаляются.`))
      return;
    await window.backupsApp.servers.delete(server.id);
    removeServer(server.id);
    nav('/dashboard');
  }

  if (!server) {
    return (
      <div className="mx-auto max-w-3xl p-10">
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Сервер не найден.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-8 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-blue-500/20 via-violet-500/20 to-fuchsia-500/20">
            <Server className="h-7 w-7 text-violet-300" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
            <p className="text-sm text-muted-foreground">{server.url}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => copyToClipboard(server.fingerprint)}>
            <Copy className="h-4 w-4" /> Копировать fingerprint
          </Button>
          <Button variant="destructive" onClick={deleteServer}>
            <Trash2 className="h-4 w-4" /> Отвязать
          </Button>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <InfoTile
          icon={<Cloud className="h-4 w-4 text-blue-300" />}
          label="Адрес"
          value={new URL(server.url).hostname}
        />
        <InfoTile
          icon={<ShieldCheck className="h-4 w-4 text-emerald-400" />}
          label="TLS fingerprint"
          value={server.fingerprint.slice(0, 32) + '…'}
          mono
        />
        <InfoTile
          icon={<FolderGit2 className="h-4 w-4 text-violet-300" />}
          label="Синхронизировано папок"
          value={String(server.syncedFolders.length)}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Проекты</CardTitle>
            <CardDescription>
              Bare git-репозитории на сервере. Каждый — отдельный проект.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={openAttach}>
              <HardDrive className="h-4 w-4" /> Подключить папку с сервера
            </Button>
            <Button variant="gradient" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Новый проект
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && <p className="py-8 text-center text-sm text-muted-foreground">Загрузка…</p>}
          {!loading && projects.length === 0 && (
            <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              Здесь пока нет проектов. Создайте первый.
            </div>
          )}
          <ul className="divide-y divide-border">
            {projects.map((p) => {
              const synced = server.syncedFolders.find((f) => f.projectId === p.id);
              return (
                <li key={p.id}>
                  <Link
                    to={`/server/${serverId}/project/${p.id}`}
                    className="group flex items-center gap-4 py-4 transition hover:bg-accent/30 px-2 rounded-md"
                  >
                    <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted/40">
                      {p.externalPath ? (
                        <HardDrive className="h-5 w-5 text-blue-300" />
                      ) : (
                        <FolderGit2 className="h-5 w-5 text-violet-300" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        {p.externalPath && <Badge variant="info">с сервера</Badge>}
                        {synced?.enabled && <Badge variant="success">синхр.</Badge>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {p.externalPath ?? p.description ?? `создан ${formatRelativeTime(p.createdAt)}`}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Новый проект"
        description="Будет создан bare git-репозиторий на сервере."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) void create();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="np">Название</Label>
            <Input
              id="np"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="мой-проект"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nd">Описание (необязательно)</Label>
            <Textarea
              id="nd"
              rows={3}
              placeholder="о чём этот проект"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="gradient" disabled={!newName.trim()}>
              Создать
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        title="Подключить папку с сервера"
        description="Read-only зеркало папки на VPS. Без истории, без записи обратно."
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ap-name">Название проекта</Label>
            <Input
              id="ap-name"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="например, prod-myapp"
              value={attachName}
              onChange={(e) => setAttachName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Путь на сервере</Label>
            <div className="flex items-center gap-2">
              <Input
                value={attachPath}
                onChange={(e) => setAttachPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void loadBrowse(attachPath);
                  }
                }}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadBrowse(attachPath)}
                disabled={browseLoading}
              >
                {browseLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Открыть'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Доступ к ФС VPS открывается через Docker volume <code>/:/host:ro</code>.
              Если ничего не видно — раскомментируйте volume в <code>docker-compose.yml</code>.
            </p>
          </div>

          <div className="rounded-md border border-border bg-card/50 max-h-72 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
              <span className="font-mono text-muted-foreground truncate">{attachPath}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const parent = attachPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/host';
                  if (parent.startsWith('/host')) void loadBrowse(parent);
                }}
                disabled={attachPath === '/host' || browseLoading}
              >
                <ChevronUp className="h-3 w-3" /> вверх
              </Button>
            </div>
            {browseError && (
              <div className="p-3 text-xs text-destructive">{browseError}</div>
            )}
            {!browseError && browseEntries.length === 0 && !browseLoading && (
              <div className="p-3 text-xs text-muted-foreground">Папка пуста</div>
            )}
            <ul>
              {browseEntries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/30 disabled:opacity-50"
                    onClick={() => {
                      if (e.type === 'dir') void loadBrowse(e.path);
                    }}
                    disabled={e.type !== 'dir'}
                  >
                    {e.type === 'dir' ? (
                      <Folder className="h-4 w-4 text-blue-300 shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAttachOpen(false)}>
              Отмена
            </Button>
            <Button
              type="button"
              variant="gradient"
              disabled={!attachName.trim() || !attachPath.startsWith('/host') || attaching}
              onClick={() => void attach()}
            >
              {attaching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Подключить
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};

const InfoTile = ({
  label,
  value,
  icon,
  mono,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  mono?: boolean;
}) => (
  <div className="flex items-center gap-3 rounded-xl border border-border bg-card/50 p-4">
    <div className="grid h-10 w-10 place-items-center rounded-md bg-muted/40">{icon}</div>
    <div className="min-w-0 flex-1">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={'truncate text-sm font-medium ' + (mono ? 'font-mono text-xs' : '')}>
        {value}
      </div>
    </div>
  </div>
);
