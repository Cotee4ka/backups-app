import React from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '@/store/app-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, Server, Globe, FolderGit2, Activity, Cloud, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/utils';

export const DashboardPage = () => {
  const servers = useAppStore((s) => s.servers);
  const refresh = useAppStore((s) => s.refreshServers);
  const username = useAppStore((s) => s.username);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalSynced = servers.reduce((acc, s) => acc + s.syncedFolders.length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-8 py-10">
      <header className="flex items-center justify-between gap-6">
        <div>
          <p className="text-sm text-muted-foreground">Добро пожаловать,</p>
          <h1 className="text-3xl font-semibold tracking-tight">{username ?? 'пользователь'}</h1>
        </div>
        <div className="flex items-center gap-3">
          <Stat label="Серверов" value={servers.length} icon={<Server className="h-4 w-4" />} />
          <Stat label="Синхронизировано" value={totalSynced} icon={<FolderGit2 className="h-4 w-4" />} />
        </div>
      </header>

      {servers.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="accent-bg grid h-16 w-16 place-items-center rounded-2xl">
              <Cloud className="accent-fg h-8 w-8" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">С чего начнём?</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Можно создать свой сервер для синка проектов, принять
                приглашение в чужой проект, или подключиться к проде в
                read-only.
              </p>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
              <Link
                to="/wizard/create"
                className="accent-btn inline-flex h-10 items-center justify-center gap-2 rounded-md px-5 text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> Создать сервер
              </Link>
              <Link
                to="/wizard/invite"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/5 px-5 text-sm font-medium text-emerald-200 hover:bg-emerald-400/10"
              >
                <Link2 className="h-4 w-4" /> У меня есть приглашение
              </Link>
              <Link
                to="/wizard/connect"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-5 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
              >
                <Globe className="h-4 w-4" /> Подключиться к проде
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            to="/wizard/invite"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/5 px-3 text-xs font-medium text-emerald-200 hover:bg-emerald-400/10"
          >
            <Link2 className="h-3.5 w-3.5" /> По приглашению
          </Link>
          <Link
            to="/wizard/create"
            className="accent-btn inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" /> Создать сервер
          </Link>
          <Link
            to="/wizard/connect"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          >
            <Globe className="h-3.5 w-3.5" /> Подключиться к проде
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((s) => (
            <Link key={s.id} to={`/server/${s.id}`} className="group">
              <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-xl group-hover:shadow-violet-500/5">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="accent-bg grid h-10 w-10 place-items-center rounded-lg">
                        <Server className="accent-fg h-5 w-5" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{s.name}</CardTitle>
                        <CardDescription className="text-xs">{new URL(s.url).hostname}</CardDescription>
                      </div>
                    </div>
                    <Badge variant="success">online</Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <FolderGit2 className="h-3.5 w-3.5" />
                    {s.syncedFolders.length} синхр.
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5" />
                    {s.lastConnectedAt ? formatRelativeTime(s.lastConnectedAt) : 'давно'}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
        </>
      )}
    </div>
  );
};

const Stat = ({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
}) => (
  <div className="flex items-center gap-3 rounded-xl border border-border bg-card/50 px-4 py-2.5">
    <div className="grid h-8 w-8 place-items-center rounded-md bg-muted/50 text-muted-foreground">
      {icon}
    </div>
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
    </div>
  </div>
);
