import React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAppStore } from '@/store/app-store';
import {
  Cloud,
  Plus,
  Server,
  Settings,
  FolderGit2,
  Activity,
  LogOut,
  Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const Sidebar = () => {
  const username = useAppStore((s) => s.username);
  const servers = useAppStore((s) => s.servers);
  const refreshServers = useAppStore((s) => s.refreshServers);
  const setAuthed = useAppStore((s) => s.setAuthed);
  const location = useLocation();

  React.useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/40 backdrop-blur-md">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="accent-icon grid h-9 w-9 place-items-center rounded-lg text-white" style={{ boxShadow: 'var(--accent-shadow)' }}>
          <Cloud className="h-5 w-5" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight">Backups App</span>
          <span className="text-xs text-muted-foreground">v0.1.0</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <NavItem to="/dashboard" icon={<Activity className="h-4 w-4" />} active={isActive('/dashboard')}>
          Главная
        </NavItem>
        <NavItem to="/settings" icon={<Settings className="h-4 w-4" />} active={isActive('/settings')}>
          Настройки
        </NavItem>

        {(() => {
          const projectsServers = servers.filter(
            (s) => (s.kind ?? 'projects') === 'projects',
          );
          const prodServers = servers.filter((s) => s.kind === 'prod');
          return (
            <>
              {/* === ПРОЕКТЫ: «Создать сервер» — двухсторонняя git-синхронизация === */}
              <div className="mt-6 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FolderGit2 className="h-3 w-3" />
                <span>Проекты</span>
                <span className="text-[10px] font-normal normal-case text-muted-foreground/70">
                  · двухсторонняя
                </span>
              </div>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {projectsServers.length === 0 && (
                  <p className="rounded-md px-3 py-2 text-xs text-muted-foreground">
                    Серверов пока нет
                  </p>
                )}
                {projectsServers.map((s) => (
                  <NavItem
                    key={s.id}
                    to={`/server/${s.id}`}
                    icon={<Server className="h-4 w-4" />}
                    active={isActive(`/server/${s.id}`)}
                  >
                    <div className="flex flex-col items-start truncate">
                      <span className="truncate text-sm">{s.name}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {new URL(s.url).hostname}
                      </span>
                    </div>
                  </NavItem>
                ))}
              </div>
              <div className="mt-2 px-2">
                <Link
                  to="/wizard/create"
                  className="accent-btn inline-flex h-8 w-full items-center justify-center gap-2 rounded-md px-3 text-xs font-medium"
                >
                  <Plus className="h-4 w-4" /> Создать сервер
                </Link>
              </div>

              {/* === ПРОДАКШН: «Подключиться» — read-only mirror с проды === */}
              <div className="mt-6 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Globe className="h-3 w-3" />
                <span>Продакшн</span>
                <span className="text-[10px] font-normal normal-case text-muted-foreground/70">
                  · read-only
                </span>
              </div>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {prodServers.length === 0 && (
                  <p className="rounded-md px-3 py-2 text-xs text-muted-foreground">
                    Прод-серверов пока нет
                  </p>
                )}
                {prodServers.map((s) => (
                  <NavItem
                    key={s.id}
                    to={`/server/${s.id}`}
                    icon={<Globe className="h-4 w-4" />}
                    active={isActive(`/server/${s.id}`)}
                  >
                    <div className="flex flex-col items-start truncate">
                      <span className="truncate text-sm">{s.name}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {new URL(s.url).hostname}
                      </span>
                    </div>
                  </NavItem>
                ))}
              </div>
              <div className="mt-2 px-2">
                <Link
                  to="/wizard/connect"
                  className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border bg-transparent px-3 text-xs font-medium shadow-sm transition hover:bg-accent hover:text-accent-foreground"
                >
                  <Plus className="h-4 w-4" /> Подключиться к проде
                </Link>
              </div>
            </>
          );
        })()}
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2">
          <div className="grid h-8 w-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {(username ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 truncate">
            <div className="text-sm font-medium leading-tight">{username ?? 'локальный'}</div>
            <div className="text-[11px] text-muted-foreground">локальный аккаунт</div>
          </div>
          <button
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => setAuthed(false)}
            title="Заблокировать"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
};

interface NavItemProps {
  to: string;
  icon?: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
}

const NavItem = ({ to, icon, active, children }: NavItemProps) => (
  <NavLink
    to={to}
    className={cn(
      'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
      active
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
    )}
  >
    {icon}
    <div className="flex-1 truncate">{children}</div>
  </NavLink>
);
