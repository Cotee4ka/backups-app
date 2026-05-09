import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppStore } from '@/store/app-store';
import {
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';

const PHASE_LABELS: Record<string, string> = {
  connecting: 'Подключение по SSH',
  'uploading-script': 'Загрузка установщика',
  'uploading-source': 'Загрузка исходников',
  'checking-prereqs': 'Проверка зависимостей',
  'installing-docker': 'Установка Docker',
  'installing-compose': 'Установка docker compose',
  'preparing-dir': 'Подготовка /opt/backups-app',
  'writing-config': 'Запись конфигурации',
  'pulling-image': 'Скачивание образа',
  'starting-container': 'Запуск контейнера',
  'waiting-healthy': 'Ожидание готовности TLS',
  done: 'Готово',
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Сервер, который провалил version-gate. Используем для подсказки SSH-host. */
  server: {
    id: string;
    url: string;
    name?: string;
  } | null;
  current: string | undefined;
  expected: string;
  /** Вызывается после успешного апдейта — родитель должен пере-проверить версию. */
  onUpdated?: () => void;
}

interface LogEntry {
  type: 'stdout' | 'stderr' | 'info' | 'phase';
  line: string;
}

/**
 * Блокирующая модалка: показывается, когда клиент пытается «зайти» на хост,
 * чья версия серверной части ниже ожидаемой. Без апдейта внутрь не пускает.
 *
 * Внутри модалки — SSH-форма. После «Обновить» прогоняем installer:apply,
 * стримим фазы. По успеху вызываем onUpdated() и закрываемся.
 */
export const ServerOutdatedModal = ({
  open,
  onClose,
  server,
  current,
  expected,
  onUpdated,
}: Props) => {
  const addToast = useAppStore((s) => s.addToast);

  const [phase, setPhase] = React.useState<'intro' | 'form' | 'progress' | 'done'>(
    'intro',
  );
  const [host, setHost] = React.useState('');
  const [sshPort, setSshPort] = React.useState('22');
  const [sshUser, setSshUser] = React.useState('root');
  const [sshPassword, setSshPassword] = React.useState('');
  const [serverPort, setServerPort] = React.useState('8443');
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [activePhase, setActivePhase] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const logRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  // Заполняем дефолты по серверу: SSH-host берём из URL.
  React.useEffect(() => {
    if (!open || !server) return;
    try {
      const u = new URL(server.url);
      setHost(u.hostname);
      if (u.port) setServerPort(u.port);
    } catch {
      /* ignore */
    }
    setPhase('intro');
    setLogs([]);
    setActivePhase(null);
    setBusy(false);
  }, [open, server]);

  // Стрим прогресса от installer:*.
  React.useEffect(() => {
    if (!open) return;
    const off = window.backupsApp.installer.onProgress((p) => {
      if (p.type === 'phase' && p.phase) {
        setActivePhase(p.phase);
        setLogs((l) => [
          ...l,
          { type: 'phase', line: PHASE_LABELS[p.phase!] ?? p.phase! },
        ]);
      } else if (p.line) {
        setLogs((l) => [...l, { type: p.type as LogEntry['type'], line: p.line! }]);
      }
    });
    return off;
  }, [open]);

  async function runUpdate() {
    if (!host || !sshUser || !sshPassword) {
      addToast({ type: 'error', text: 'Заполните SSH-доступ' });
      return;
    }
    setPhase('progress');
    setBusy(true);
    setLogs([]);
    try {
      await window.backupsApp.installer.apply({
        sshHost: host.trim(),
        sshPort: Number(sshPort) || 22,
        sshUser: sshUser.trim(),
        sshPassword,
        serverPort: Number(serverPort) || 8443,
        // autoConnect: false — сервер уже сохранён в сторе, не плодим дубль.
        autoConnect: false,
      });
      setPhase('done');
      addToast({ type: 'success', text: 'Сервер обновлён' });
      onUpdated?.();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setLogs((l) => [...l, { type: 'stderr', line: msg }]);
      addToast({ type: 'error', text: `Ошибка: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  if (!server) return null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) return; // не даём закрыть модалку посреди апдейта
        onClose();
      }}
      size="lg"
      title="Сервер устарел"
      description={`Версия на хосте ${current ?? '?'} ниже ожидаемой ${expected}. Обновите серверную часть, чтобы продолжить.`}
    >
      {phase === 'intro' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
            <div className="space-y-1 text-foreground/90">
              <div>
                Клиент не может работать со старым сервером — изменился API и/или
                схема данных. Пока серверная часть не обновится, вход на этот хост
                заблокирован.
              </div>
              <div className="text-muted-foreground text-xs">
                Адрес: <span className="font-mono">{server.url}</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
            Обновление накатится через SSH автоматически. Креды владельца и
            данные не будут затронуты — установщик читает существующий{' '}
            <code className="font-mono">.env</code> и сохраняет всё, что там есть.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              Не сейчас
            </Button>
            <Button variant="gradient" onClick={() => setPhase('form')}>
              Обновить через SSH <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {phase === 'form' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="om-host">SSH host</Label>
              <Input id="om-host" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="om-port">SSH порт</Label>
              <Input id="om-port" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="om-user">SSH пользователь</Label>
              <Input id="om-user" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="om-pwd">Пароль (или sudo пароль)</Label>
              <Input
                id="om-pwd"
                type="password"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="om-sp">Порт сервера приложения</Label>
            <Input
              id="om-sp"
              value={serverPort}
              onChange={(e) => setServerPort(e.target.value)}
            />
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <div>
              <strong className="text-foreground">Идемпотентно.</strong> Скрипт
              читает существующие админ-логин, пароль и JWT-секрет из{' '}
              <code className="font-mono">/opt/backups-app/.env</code> и не трогает
              их — после апдейта вы продолжите работать с теми же кредами.
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setPhase('intro')}>
              Назад
            </Button>
            <Button variant="gradient" onClick={runUpdate}>
              Запустить обновление <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {phase === 'progress' && (
        <div className="space-y-4">
          {activePhase && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
              <RefreshCw
                className={
                  'h-4 w-4 ' +
                  (busy ? 'animate-spin text-violet-400' : 'text-emerald-400')
                }
              />
              <span className="text-foreground/90">
                {PHASE_LABELS[activePhase] ?? activePhase}
              </span>
            </div>
          )}
          <div
            ref={logRef}
            className="h-72 overflow-y-auto rounded-lg border border-border bg-black/60 p-4 font-mono text-xs"
          >
            {logs.length === 0 && (
              <div className="text-muted-foreground">Подключаемся…</div>
            )}
            {logs.map((l, i) => (
              <div
                key={i}
                className={
                  l.type === 'stderr'
                    ? 'text-amber-300/90'
                    : l.type === 'phase'
                      ? 'text-violet-300'
                      : l.type === 'info'
                        ? 'accent-fg'
                        : 'text-foreground/90'
                }
              >
                <span className="mr-2 text-muted-foreground">›</span>
                {l.line}
              </div>
            ))}
          </div>
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              Идёт обновление, может занять до пары минут. Не закрывайте окно.
            </div>
          )}
        </div>
      )}

      {phase === 'done' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-foreground/90">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
            <div>
              Сервер обновлён до версии <strong>{expected}</strong>. Можно
              продолжать работу.
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="gradient" onClick={onClose}>
              Войти на сервер <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
};

// ============================================================================
//  Hook: версия-гейт. Прогоняет verifyCurrent при mount/изменении serverId.
// ============================================================================

export interface ServerGateState {
  status: 'loading' | 'ok' | 'outdated' | 'unreachable';
  current?: string;
  expected: string;
  error?: string;
  /** Дёрни, чтобы пере-проверить (например, после успешного апдейта). */
  refetch: () => void;
}

export function useServerVersionGate(serverId: string | undefined): ServerGateState {
  const [state, setState] = React.useState<ServerGateState>({
    status: 'loading',
    expected: '',
    refetch: () => undefined,
  });

  const fetchOnce = React.useCallback(async () => {
    if (!serverId) return;
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const v = (await window.backupsApp.servers.verifyCurrent(serverId)) as
        | { ok: true; current: string; expected: string }
        | {
            ok: false;
            reason: 'outdated' | 'unreachable';
            current?: string;
            expected: string;
            error?: string;
          };
      if (v.ok) {
        setState({
          status: 'ok',
          current: v.current,
          expected: v.expected,
          refetch: fetchOnce,
        });
      } else if (v.reason === 'outdated') {
        setState({
          status: 'outdated',
          current: v.current,
          expected: v.expected,
          refetch: fetchOnce,
        });
      } else {
        setState({
          status: 'unreachable',
          expected: v.expected,
          error: v.error,
          refetch: fetchOnce,
        });
      }
    } catch (e) {
      setState({
        status: 'unreachable',
        expected: '',
        error: (e as Error).message,
        refetch: fetchOnce,
      });
    }
  }, [serverId]);

  React.useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  return state;
}
