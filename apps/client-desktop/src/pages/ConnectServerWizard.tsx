import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useAppStore } from '@/store/app-store';
import {
  Globe,
  ShieldCheck,
  ChevronRight,
  Pencil,
  Terminal,
  Copy,
  Cloud,
  KeyRound,
  Server,
  CheckCircle2,
  RefreshCw,
  Link2,
  Loader2,
} from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';
import { parseInviteToken } from '@/lib/invite-token';

type Mode = 'ssh' | 'pair' | 'invite';
type Step = 'connection' | 'install' | 'done';
type InstallAction =
  | 'full-install'
  | 'script-update'
  | 'image-update'
  | 'restart'
  | 'nothing';

interface InstallLog {
  type: 'stdout' | 'stderr' | 'info' | 'phase';
  line: string;
  phase?: string;
}

interface CheckResult {
  installed: boolean;
  scriptVersion: string;
  serverVersion: string;
  imageRef: string;
  imageDigest: string;
  containerRunning: boolean;
  installDir: string;
  plan: { action: InstallAction; reason: string };
  expected: { server: string; script: string };
}

interface ApplyResult {
  serverUrl: string;
  fingerprint: string;
  adminUsername: string;
  adminPassword: string;
  port: number;
  scriptVersion: string;
}

interface PairPayload {
  v: number;
  url: string;
  fp: string;
  u: string;
  pw: string;
  scriptVersion?: string;
}

const PHASE_LABELS: Record<string, string> = {
  connecting: 'Подключение по SSH',
  'uploading-script': 'Загрузка установщика',
  'uploading-source': 'Загрузка исходников (fallback)',
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

function parsePairToken(raw: string): PairPayload | null {
  let s = raw.trim();
  if (s.startsWith('bap1.') || s.startsWith('bap2.')) s = s.slice(5);
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  try {
    const json = atob(s);
    const obj = JSON.parse(json) as PairPayload;
    if (!obj.url || !obj.fp || !obj.u || !obj.pw) return null;
    return obj;
  } catch {
    return null;
  }
}

export const ConnectServerWizard = () => {
  const nav = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const refresh = useAppStore((s) => s.refreshServers);

  const [mode, setMode] = React.useState<Mode>('ssh');
  const [step, setStep] = React.useState<Step>('connection');

  // SSH form state
  const [host, setHost] = React.useState('');
  const [sshPort, setSshPort] = React.useState('22');
  const [sshUser, setSshUser] = React.useState('root');
  const [sshPassword, setSshPassword] = React.useState('');
  const [serverPort, setServerPort] = React.useState('8443');
  const [adminUser, setAdminUser] = React.useState('owner');

  // Pair-token form state
  const [token, setToken] = React.useState('');

  // Invite-link form state
  const [inviteRaw, setInviteRaw] = React.useState('');
  const [inviteInfo, setInviteInfo] = React.useState<{
    code: string;
    role: string;
    expiresAt: number;
    projectId: string | null;
    projectName: string | null;
    url: string;
    fingerprint: string;
  } | null>(null);
  const [inviteUsername, setInviteUsername] = React.useState('');
  const [invitePassword, setInvitePassword] = React.useState('');

  // Process state
  const [busy, setBusy] = React.useState(false);
  const [logs, setLogs] = React.useState<InstallLog[]>([]);
  const [check, setCheck] = React.useState<CheckResult | null>(null);
  const [activePhase, setActivePhase] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    server: { id: string; url: string; fingerprint: string };
    adminUsername: string;
    adminPassword: string;
  } | null>(null);

  const logRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  // Подписываемся на стрим прогресса от installer:* IPC.
  React.useEffect(() => {
    const off = window.backupsApp.installer.onProgress((p) => {
      if (p.type === 'phase' && p.phase) {
        setActivePhase(p.phase);
        setLogs((l) => [
          ...l,
          { type: 'phase', line: PHASE_LABELS[p.phase!] ?? p.phase!, phase: p.phase! },
        ]);
      } else if (p.line) {
        setLogs((l) => [...l, { type: p.type, line: p.line! }]);
      }
    });
    return off;
  }, []);

  function appendLog(line: string, type: InstallLog['type'] = 'info') {
    setLogs((l) => [...l, { type, line }]);
  }

  // ----------------------- SSH FLOW -----------------------

  async function startSsh() {
    if (!host || !sshUser || !sshPassword) {
      addToast({ type: 'error', text: 'Заполните адрес, логин и пароль SSH' });
      return;
    }
    setStep('install');
    setBusy(true);
    setLogs([]);
    setCheck(null);
    setActivePhase(null);
    setResult(null);

    try {
      // 1) Проверяем состояние хоста.
      appendLog('Подключаемся и проверяем состояние сервера…', 'info');
      const checkRes = (await window.backupsApp.installer.check({
        sshHost: host.trim(),
        sshPort: Number(sshPort) || 22,
        sshUser: sshUser.trim(),
        sshPassword,
      })) as CheckResult;
      setCheck(checkRes);

      const action = checkRes.plan.action;
      const reasonHuman: Record<InstallAction, string> = {
        'full-install': 'Сервер ещё не настраивался — устанавливаю с нуля',
        'script-update': 'Скрипт устарел — обновляю окружение',
        'image-update': 'Образ устарел — накатываю новую версию сервера',
        restart: 'Контейнер не запущен — перезапускаю',
        nothing: 'Хост уже актуален — просто подключаюсь',
      };
      appendLog(
        `${reasonHuman[action]} (${checkRes.plan.reason})`,
        action === 'nothing' ? 'info' : 'info',
      );

      // 2) Если нечего ставить, всё равно надо залогиниться. Используем
      //    apply без autoConnect=false? Нет — если ничего не делать на хосте,
      //    идём в обход: запускаем apply'ом (он быстро дойдёт до 'done' если
      //    всё актуально, но всё равно перезапишет config). Простой путь —
      //    всё равно гнать apply, он идемпотентен. Так у нас единый путь.
      // …либо: если action === 'nothing', можно прямо забрать креды через
      // отдельную ручку. Но пока — единый путь через apply.
      const applyRes = (await window.backupsApp.installer.apply({
        sshHost: host.trim(),
        sshPort: Number(sshPort) || 22,
        sshUser: sshUser.trim(),
        sshPassword,
        serverPort: Number(serverPort) || 8443,
        adminUser: adminUser.trim() || 'owner',
        autoConnect: true,
        kind: 'prod',
      })) as {
        applied: ApplyResult;
        server: { id: string; url: string; fingerprint: string };
        adminUsername: string;
        adminPassword: string;
      };

      setResult({
        server: applyRes.server,
        adminUsername: applyRes.adminUsername,
        adminPassword: applyRes.adminPassword,
      });
      setStep('done');
      addToast({
        type: 'success',
        text:
          action === 'nothing'
            ? 'Сервер актуален и подключён'
            : `Сервер обновлён до ${applyRes.applied.scriptVersion} и подключён`,
      });
      await refresh();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      appendLog(msg, 'stderr');
      addToast({ type: 'error', text: `Ошибка: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  // ----------------------- PAIR-TOKEN FLOW -----------------------

  async function submitPairToken() {
    const parsed = parsePairToken(token);
    if (!parsed) {
      addToast({
        type: 'error',
        text: 'Неверный pair-токен. Скопируй строку из вывода install-v2.sh.',
      });
      return;
    }
    setBusy(true);
    try {
      const res = (await window.backupsApp.servers.connect({
        url: parsed.url,
        username: parsed.u,
        password: parsed.pw,
        kind: 'prod',
      })) as { server: { id: string } };
      // version gate — не пускаем на устаревший хост.
      const verify = (await window.backupsApp.servers.verifyCurrent(
        res.server.id,
      )) as
        | { ok: true; current: string; expected: string }
        | {
            ok: false;
            reason: 'outdated' | 'unreachable';
            current?: string;
            expected: string;
            error?: string;
          };
      if (!verify.ok) {
        if (verify.reason === 'outdated') {
          addToast({
            type: 'error',
            text: `Сервер ${verify.current} устарел. Ожидается ${verify.expected}. Обнови через SSH.`,
          });
          await window.backupsApp.servers.delete(res.server.id);
          await refresh();
          setMode('ssh');
        } else {
          addToast({
            type: 'error',
            text: `Сервер недоступен: ${verify.error ?? 'неизвестная ошибка'}`,
          });
          await window.backupsApp.servers.delete(res.server.id);
          await refresh();
        }
        return;
      }
      await refresh();
      addToast({ type: 'success', text: 'Сервер подключён' });
      nav(`/server/${res.server.id}`);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // ----------------------- INVITE-LINK FLOW -----------------------

  /**
   * Юзер вставил `bapi.…` токен → парсим, валидируем код у сервера через
   * fingerprint-pinned запрос (без авторизации), сохраняем info — UI
   * показывает «Вас приглашают в проект X с ролью Y» и форму регистрации.
   */
  async function loadInviteInfo() {
    const parsed = parseInviteToken(inviteRaw);
    if (!parsed) {
      addToast({
        type: 'error',
        text: 'Неверная ссылка-приглашение. Проверь что скопировал её целиком.',
      });
      return;
    }
    setBusy(true);
    try {
      const info = await window.backupsApp.invites.info({
        url: parsed.url,
        fingerprint: parsed.fp,
        code: parsed.code,
      });
      setInviteInfo({ ...info, url: parsed.url, fingerprint: parsed.fp });
      // Fingerprint мы пинуем сами через TLS-pin — если info прошла, значит
      // сервер живой и серт совпадает.
    } catch (e) {
      addToast({
        type: 'error',
        text: 'Не удалось проверить приглашение: ' + (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  /** Регистрирует юзера и принимает invite — ipc сам решит register vs login. */
  async function submitInvite() {
    if (!inviteInfo) return;
    if (inviteUsername.trim().length < 3 || invitePassword.length < 8) {
      addToast({
        type: 'error',
        text: 'Имя — от 3 символов, пароль — от 8.',
      });
      return;
    }
    setBusy(true);
    try {
      const res = await window.backupsApp.invites.joinByInvite({
        url: inviteInfo.url,
        fingerprint: inviteInfo.fingerprint,
        code: inviteInfo.code,
        username: inviteUsername.trim(),
        password: invitePassword,
      });
      await refresh();
      addToast({ type: 'success', text: 'Готово. Ты в проекте.' });
      if (res.joinedProjectId) {
        nav(`/server/${res.server.id}/project/${res.joinedProjectId}`);
      } else {
        nav(`/server/${res.server.id}`);
      }
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // ----------------------- RENDER -----------------------

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-10">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" />
          <span>Подключиться к существующему серверу</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Подключить сервер</h1>
        <p className="text-sm text-muted-foreground">
          Дай SSH-доступ — клиент сам проверит и при необходимости обновит сервер
          до актуальной версии. Если SSH недоступен — вкладка «Pair-токен»: запусти
          команду на VPS вручную и вставь полученный токен сюда.
        </p>
      </header>

      {step === 'connection' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={mode === 'invite' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('invite')}
            >
              <Link2 className="h-4 w-4" />
              По ссылке-приглашению
            </Button>
            <Button
              variant={mode === 'ssh' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('ssh')}
            >
              <Cloud className="h-4 w-4" />
              Через SSH
            </Button>
            <Button
              variant={mode === 'pair' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('pair')}
            >
              <Pencil className="h-4 w-4" />
              Pair-токен
            </Button>
          </div>

          {mode === 'ssh' && (
            <SshForm
              host={host}
              setHost={setHost}
              sshPort={sshPort}
              setSshPort={setSshPort}
              sshUser={sshUser}
              setSshUser={setSshUser}
              sshPassword={sshPassword}
              setSshPassword={setSshPassword}
              serverPort={serverPort}
              setServerPort={setServerPort}
              adminUser={adminUser}
              setAdminUser={setAdminUser}
              onCancel={() => nav(-1)}
              onSubmit={startSsh}
            />
          )}

          {mode === 'pair' && (
            <PairForm
              token={token}
              setToken={setToken}
              busy={busy}
              onCancel={() => nav(-1)}
              onSubmit={submitPairToken}
            />
          )}

          {mode === 'invite' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Приглашение в проект</CardTitle>
                <CardDescription>
                  Вставь ссылку которую тебе прислал владелец проекта (начинается
                  с <code className="font-mono">bapi.</code>). Сразу попадёшь в
                  проект, без отдельной настройки сервера.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!inviteInfo ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="inv">Ссылка-приглашение</Label>
                      <textarea
                        id="inv"
                        className="flex min-h-[88px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="bapi.eyJ2IjoxLCJ1cmwiOi4uLn0"
                        value={inviteRaw}
                        onChange={(e) => setInviteRaw(e.target.value)}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => nav(-1)}>Отмена</Button>
                      <Button
                        variant="gradient"
                        onClick={() => void loadInviteInfo()}
                        disabled={busy || !inviteRaw.trim()}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Проверить ссылку
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-3 text-sm">
                      <div className="font-medium">
                        Тебя приглашают в проект{' '}
                        <span className="text-emerald-300">
                          {inviteInfo.projectName ?? '(без имени)'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Роль: <strong className="text-foreground">{inviteInfo.role}</strong>
                        {' · '}действительно ещё{' '}
                        {Math.max(
                          0,
                          Math.round((inviteInfo.expiresAt - Date.now()) / 3600_000),
                        )}{' '}
                        ч.
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="invu">Имя пользователя</Label>
                      <Input
                        id="invu"
                        placeholder="myname"
                        value={inviteUsername}
                        onChange={(e) => setInviteUsername(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Если у тебя уже есть аккаунт на этом сервере — введи свой
                        логин и пароль, ты будешь добавлен в проект как существующий
                        юзер. Иначе — создаётся новый аккаунт.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="invp">Пароль</Label>
                      <Input
                        id="invp"
                        type="password"
                        value={invitePassword}
                        onChange={(e) => setInvitePassword(e.target.value)}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setInviteInfo(null);
                          setInviteUsername('');
                          setInvitePassword('');
                        }}
                      >
                        Назад
                      </Button>
                      <Button
                        variant="gradient"
                        onClick={() => void submitInvite()}
                        disabled={busy}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Войти в проект
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {step === 'install' && (
        <>
          <Stepper step={step} />
          <InstallProgress
            check={check}
            activePhase={activePhase}
            logs={logs}
            busy={busy}
            logRef={logRef}
          />
        </>
      )}

      {step === 'done' && result && (
        <>
          <Stepper step={step} />
          <DoneCard
            url={result.server.url}
            fingerprint={result.server.fingerprint}
            adminUsername={result.adminUsername}
            adminPassword={result.adminPassword}
            onHome={() => nav('/dashboard')}
            onOpen={() => nav(`/server/${result.server.id}`)}
          />
        </>
      )}
    </div>
  );
};

// ============================================================================
//  Sub-components
// ============================================================================

const SshForm = ({
  host,
  setHost,
  sshPort,
  setSshPort,
  sshUser,
  setSshUser,
  sshPassword,
  setSshPassword,
  serverPort,
  setServerPort,
  adminUser,
  setAdminUser,
  onCancel,
  onSubmit,
}: {
  host: string;
  setHost: (v: string) => void;
  sshPort: string;
  setSshPort: (v: string) => void;
  sshUser: string;
  setSshUser: (v: string) => void;
  sshPassword: string;
  setSshPassword: (v: string) => void;
  serverPort: string;
  setServerPort: (v: string) => void;
  adminUser: string;
  setAdminUser: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>Параметры VPS</CardTitle>
      <CardDescription>
        Клиент подключится по SSH, проверит версию серверной части и накатит
        обновление, если оно нужно. Пароль используется один раз и не сохраняется.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="host">Публичный IP / hostname</Label>
          <Input
            id="host"
            placeholder="203.0.113.42"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="port">SSH порт</Label>
          <Input id="port" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="user">SSH пользователь</Label>
          <Input id="user" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pwd">Пароль (или sudo пароль)</Label>
          <Input
            id="pwd"
            type="password"
            value={sshPassword}
            onChange={(e) => setSshPassword(e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="sport">Порт сервера приложения</Label>
          <Input
            id="sport"
            value={serverPort}
            onChange={(e) => setServerPort(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ouser">Имя владельца сервера</Label>
          <Input id="ouser" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <div>
          <strong className="text-foreground">Версия проверяется автоматически.</strong>{' '}
          Если на хосте установлена устаревшая версия — клиент сам обновит её до
          актуальной перед тем, как пустить вас внутрь.
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
        <Button variant="gradient" onClick={onSubmit}>
          Подключиться <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </CardContent>
  </Card>
);

const PAIR_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/Cotee4ka/backups-app/main/apps/server/scripts/install-v2.sh | sudo bash -s -- --apply';

const PairForm = ({
  token,
  setToken,
  busy,
  onCancel,
  onSubmit,
}: {
  token: string;
  setToken: (v: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>Pair-токен</CardTitle>
      <CardDescription>
        Запусти одну команду на сервере — она напечатает токен. Вставь его сюда.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="rounded-lg border-2 border-dashed border-border bg-muted/20 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span>Выполнить на VPS по SSH:</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded bg-background/60 px-3 py-2 font-mono text-[11px] text-foreground/80 break-all">
            {PAIR_INSTALL_COMMAND}
          </code>
          <button
            className="shrink-0 rounded p-2 hover:bg-accent transition-colors"
            title="Скопировать"
            onClick={() => copyToClipboard(PAIR_INSTALL_COMMAND)}
          >
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Скрипт идемпотентный: если сервер уже стоит, он лишь обновится до
          актуальной версии, креды владельца сохранятся.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tok">Pair-токен из вывода скрипта</Label>
        <textarea
          id="tok"
          className="flex min-h-[112px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="bap2.eyJ2IjoyLCJ1cmwiOiJodHRwczovLy4uLiJ9"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          В токене зашиты адрес сервера, TLS fingerprint, логин и пароль.
          Креды сохранятся локально и зашифруются.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <div>
          <strong className="text-foreground">TLS pinning + version-gate.</strong>{' '}
          Fingerprint из токена сравнится с реальным сертификатом. После входа
          версия серверной части тоже проверится — если хост устарел, в него
          не пустит, потребуется обновить через SSH.
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
        <Button
          variant="gradient"
          onClick={onSubmit}
          disabled={busy || !token.trim()}
        >
          {busy ? 'Подключаемся…' : 'Подключиться'}{' '}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </CardContent>
  </Card>
);

const InstallProgress = ({
  check,
  activePhase,
  logs,
  busy,
  logRef,
}: {
  check: CheckResult | null;
  activePhase: string | null;
  logs: InstallLog[];
  busy: boolean;
  logRef: React.RefObject<HTMLDivElement>;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Terminal className="h-5 w-5" /> Установка / обновление
      </CardTitle>
      <CardDescription>
        {check?.plan
          ? `Действие: ${planLabel(check.plan.action)} — ${check.plan.reason}`
          : 'Подключение к серверу…'}
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {check && (
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="Сервер сейчас"
            value={check.serverVersion || (check.installed ? 'неизвестно' : 'не установлен')}
          />
          <Stat label="Скрипт сейчас" value={check.scriptVersion || '—'} />
          <Stat label="Сервер ожидаем" value={check.expected.server} />
          <Stat label="Скрипт ожидаем" value={check.expected.script} />
        </div>
      )}

      {activePhase && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
          <RefreshCw
            className={
              'h-4 w-4 ' + (busy ? 'animate-spin text-violet-400' : 'text-emerald-400')
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
          <div className="text-muted-foreground">Подключение к серверу…</div>
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
          <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          идёт работа, может занять до пары минут…
        </div>
      )}
    </CardContent>
  </Card>
);

const DoneCard = ({
  url,
  fingerprint,
  adminUsername,
  adminPassword,
  onHome,
  onOpen,
}: {
  url: string;
  fingerprint: string;
  adminUsername: string;
  adminPassword: string;
  onHome: () => void;
  onOpen: () => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-400" /> Сервер подключён
      </CardTitle>
      <CardDescription>
        Сохраните пароль владельца — без него вы не сможете войти повторно.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <Field
        label="Адрес сервера"
        icon={<Server className="accent-fg h-4 w-4" />}
        value={url}
      />
      <Field
        label="TLS fingerprint"
        icon={<ShieldCheck className="h-4 w-4 text-emerald-400" />}
        value={fingerprint}
        mono
      />
      <Field
        label="Логин владельца"
        icon={<Cloud className="accent-fg h-4 w-4" />}
        value={adminUsername}
      />
      <Field
        label="Пароль владельца"
        icon={<KeyRound className="h-4 w-4 text-amber-300" />}
        value={adminPassword}
        mono
        important
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onHome}>
          На главную
        </Button>
        <Button variant="gradient" onClick={onOpen}>
          Открыть сервер <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </CardContent>
  </Card>
);

const Stepper = ({ step }: { step: Step }) => {
  const items: { key: Step; label: string }[] = [
    { key: 'connection', label: 'Параметры' },
    { key: 'install', label: 'Проверка/установка' },
    { key: 'done', label: 'Готово' },
  ];
  const activeIdx = items.findIndex((i) => i.key === step);
  return (
    <div className="flex items-center gap-2 text-xs">
      {items.map((it, i) => (
        <React.Fragment key={it.key}>
          <div
            className={
              'flex items-center gap-2 rounded-md px-3 py-1.5 ' +
              (i <= activeIdx
                ? 'accent-bg text-foreground'
                : 'border border-border text-muted-foreground')
            }
          >
            <span
              className={
                'grid h-5 w-5 place-items-center rounded-full text-[10px] ' +
                (i <= activeIdx ? 'accent-icon text-white' : 'bg-muted text-muted-foreground')
              }
            >
              {i + 1}
            </span>
            {it.label}
          </div>
          {i < items.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        </React.Fragment>
      ))}
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border border-border bg-muted/20 p-3">
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className="mt-1 font-mono text-sm text-foreground/90">{value}</div>
  </div>
);

const Field = ({
  label,
  value,
  icon,
  mono,
  important,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  mono?: boolean;
  important?: boolean;
}) => (
  <div
    className={
      'flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 ' +
      (important ? 'ring-2 ring-amber-500/30' : '')
    }
  >
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={'truncate text-sm ' + (mono ? 'font-mono' : '')}>{value}</div>
      </div>
    </div>
    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(value)}>
      <Copy className="h-3.5 w-3.5" /> Копировать
    </Button>
  </div>
);

function planLabel(action: InstallAction): string {
  switch (action) {
    case 'full-install':
      return 'Установка с нуля';
    case 'script-update':
      return 'Обновление скрипта';
    case 'image-update':
      return 'Обновление сервера';
    case 'restart':
      return 'Перезапуск';
    case 'nothing':
      return 'Уже актуален';
  }
}
