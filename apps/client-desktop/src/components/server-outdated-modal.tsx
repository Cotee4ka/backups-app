import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useAppStore } from '@/store/app-store';
import {
  AlertTriangle,
  ChevronRight,
  Copy,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';

const UPDATE_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/Cotee4ka/backups-app/main/apps/server/scripts/install-v2.sh | sudo bash -s -- --apply';

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

/**
 * Блокирующая модалка: показывается, когда клиент пытается «зайти» на хост,
 * чья версия серверной части ниже ожидаемой. Без апдейта внутрь не пускает.
 *
 * Содержит команду для копирования (юзер сам гонит её на VPS по SSH) и
 * кнопку «Проверить снова», которая дёргает gate.refetch(). Если версия
 * сошлась — модалка закрывается.
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
  const [checking, setChecking] = React.useState(false);

  async function recheck() {
    if (!server) return;
    setChecking(true);
    try {
      const v = (await window.backupsApp.servers.verifyCurrent(server.id)) as
        | { ok: true; current: string; expected: string }
        | {
            ok: false;
            reason: 'outdated' | 'unreachable';
            current?: string;
            expected: string;
            error?: string;
          };
      if (v.ok) {
        addToast({
          type: 'success',
          text: `Сервер обновлён до ${v.current}. Заходим.`,
        });
        onUpdated?.();
        onClose();
      } else if (v.reason === 'outdated') {
        addToast({
          type: 'error',
          text: `На хосте всё ещё ${v.current ?? '?'} (нужно ${v.expected}). Проверь, что команда действительно отработала.`,
        });
      } else {
        addToast({
          type: 'error',
          text: `Сервер недоступен: ${v.error ?? 'неизвестно'}`,
        });
      }
    } finally {
      setChecking(false);
    }
  }

  if (!server) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Сервер устарел"
      description={`Версия на хосте ${current ?? '?'} ниже ожидаемой ${expected}. Обновите серверную часть, чтобы продолжить.`}
    >
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

        <div className="rounded-lg border-2 border-dashed border-border bg-muted/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="h-3.5 w-3.5 shrink-0" />
            <span>Зайди по SSH на хост и выполни:</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-background/60 px-3 py-2 font-mono text-[11px] text-foreground/80 break-all">
              {UPDATE_COMMAND}
            </code>
            <button
              className="shrink-0 rounded p-2 hover:bg-accent transition-colors"
              title="Скопировать"
              onClick={() => copyToClipboard(UPDATE_COMMAND)}
            >
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Идемпотентно: креды владельца, JWT-секрет и данные из{' '}
            <code className="font-mono">/opt/backups-app/.env</code> сохранятся.
            Когда команда закончится и напечатает «Сервер готов» — нажми
            «Проверить снова».
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          <div>
            После апдейта клиент сам пере-проверит версию. Если совпала —
            войдёт; если нет — снова покажет это окно.
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={checking}>
            Не сейчас
          </Button>
          <Button variant="gradient" onClick={recheck} disabled={checking}>
            <RefreshCw
              className={'h-4 w-4 ' + (checking ? 'animate-spin' : '')}
            />
            {checking ? 'Проверяем…' : 'Проверить снова'}
            {!checking && <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </div>
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
