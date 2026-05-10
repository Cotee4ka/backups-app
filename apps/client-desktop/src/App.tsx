import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './store/app-store';
import { OnboardingPage } from './pages/Onboarding';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { CreateServerWizard } from './pages/CreateServerWizard';
import { ConnectServerWizard } from './pages/ConnectServerWizard';
import { ProjectPage } from './pages/Project';
import { ServerPage } from './pages/Server';
import { SettingsPage } from './pages/Settings';
import { Sidebar } from './components/layout/Sidebar';
import { ToastHost } from './components/ui/toast';
import { FullPageLoader } from './components/ui/spinner';

export default function App(): JSX.Element {
  const isAuthed = useAppStore((s) => s.isAuthed);
  const hasAccount = useAppStore((s) => s.hasAccount);
  const setHasAccount = useAppStore((s) => s.setHasAccount);
  const setSyncStatus = useAppStore((s) => s.setSyncStatus);
  const setPresence = useAppStore((s) => s.setPresence);
  const addToast = useAppStore((s) => s.addToast);

  React.useEffect(() => {
    void window.backupsApp.account.has().then((v) => setHasAccount(!!v));
    void window.backupsApp.settings.get().then((s) => {
      const st = s as { accentTheme?: string; theme?: string };
      document.documentElement.dataset.accent = st.accentTheme ?? 'indigo';
    });
  }, [setHasAccount]);

  React.useEffect(() => {
    const offSync = window.backupsApp.sync.onStatus((s) => {
      const k = `${s.serverId ?? ''}::${s.projectId}`;
      setSyncStatus(k, {
        state: s.state as 'idle' | 'dirty' | 'pushing' | 'pulling' | 'error',
        detail: s.detail,
        dirtyFiles: s.dirtyFiles,
        upload: s.upload as
          | undefined
          | {
              phase:
                | 'preparing'
                | 'cloning'
                | 'init'
                | 'scanning'
                | 'staging'
                | 'committing'
                | 'pushing'
                | 'done';
              files?: number;
              totalBytes?: number;
              startedAt: number;
              etaSec?: number;
            },
        pendingRemote: s.pendingRemote ?? null,
      });
    });
    return offSync;
  }, [setSyncStatus]);

  // Сервер мог пере-классифицироваться на старте (kind: undefined → projects/prod).
  // Слушаем сигнал и обновляем сайдбар.
  const refreshServers = useAppStore((s) => s.refreshServers);
  React.useEffect(() => {
    const off = window.backupsApp.servers.onListChanged?.(() => {
      void refreshServers();
    });
    return off;
  }, [refreshServers]);

  React.useEffect(() => {
    const offRepo = window.backupsApp.events.on('repo:updated', (p) => {
      const ev = p as { authorName?: string; projectId: string };
      addToast({
        type: 'info',
        text: `Сервер: ${ev.authorName ?? 'кто-то'} обновил проект, изменения применяются`,
      });
    });
    const offRestored = window.backupsApp.events.on('project:restored', (p) => {
      const ev = p as { sha: string };
      addToast({ type: 'info', text: `Проект восстановлен из ${ev.sha.slice(0, 8)}` });
    });
    const offJoin = window.backupsApp.events.on('presence:list', (p) => {
      const ev = p as { serverId: string; projectId: string; users: { userId: string; username: string }[] };
      setPresence(`${ev.serverId}::${ev.projectId}`, ev.users);
    });
    return () => {
      offRepo();
      offRestored();
      offJoin();
    };
  }, [addToast, setPresence]);

  if (hasAccount === null) {
    return <FullPageLoader />;
  }

  if (!hasAccount) {
    return (
      <div className="min-h-screen gradient-mesh">
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
        <ToastHost />
      </div>
    );
  }

  if (!isAuthed) {
    return (
      <div className="min-h-screen gradient-mesh">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <ToastHost />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/wizard/create" element={<CreateServerWizard />} />
          <Route path="/wizard/connect" element={<ConnectServerWizard />} />
          <Route path="/server/:serverId" element={<ServerPage />} />
          <Route path="/server/:serverId/project/:projectId" element={<ProjectPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
      <ToastHost />
    </div>
  );
}
