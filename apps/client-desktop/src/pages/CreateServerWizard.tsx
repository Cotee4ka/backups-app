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
  Cloud,
  KeyRound,
  Server,
  ShieldCheck,
  Copy,
  ChevronRight,
  Terminal,
  Sparkles,
  Pencil,
  Link2,
  Loader2,
} from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';
import { parseInviteToken } from '@/lib/invite-token';

type Step = 'connection' | 'install' | 'done';
type Mode = 'pair' | 'ssh' | 'invite';

interface InstallLog {
  type: 'stdout' | 'stderr' | 'info';
  line: string;
}

interface PairPayload {
  v: number;
  url: string;
  fp: string;
  u: string;
  pw: string;
  scriptVersion?: string;
}

// CreateServerWizard = Mode 1 (Projects, двухсторонняя git-синхронизация).
// Соответствующий скрипт — install-projects.sh, БЕЗ /host:ro mount.
const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/Cotee4ka/backups-app/main/apps/server/scripts/install-projects.sh | sudo bash -s -- --apply';

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

export const CreateServerWizard = () => {
  const nav = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const refresh = useAppStore((s) => s.refreshServers);

  const [mode, setMode] = React.useState<Mode>('pair');
  const [step, setStep] = React.useState<Step>('connection');

  // Pair-token form state
  const [token, setToken] = React.useState('');

  // SSH form state
  const [host, setHost] = React.useState('');
  const [port, setPort] = React.useState('22');
  const [user, setUser] = React.useState('root');
  const [password, setPassword] = React.useState('');
  const [serverPort, setServerPort] = React.useState('8443');
  const [adminUser, setAdminUser] = React.useState('owner');

  // Invite form state — для случая «друг прислал ссылку, я хочу попасть
  // в его проект, не поднимая свой сервер».
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

  const [logs, setLogs] = React.useState<InstallLog[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{
    server: { id: string; url: string; fingerprint: string };
    adminUsername: string;
    adminPassword: string;
  } | null>(null);

  const logRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  // Стримим прогресс из installer:* (v2 протокол) — фазы и логи.
  React.useEffect(() => {
    const off = window.backupsApp.installer.onProgress((p) => {
      if (p.type === 'phase' && p.phase) {
        setLogs((l) => [...l, { type: 'info', line: `[${p.phase}]` }]);
      } else if (p.line) {
        setLogs((l) => [
          ...l,
          { type: p.type as 'stdout' | 'stderr' | 'info', line: p.line! },
        ]);
      }
    });
    return off;
  }, []);

  /**
   * Юзер вставил `bapi.…` invite-токен → парсим, валидируем код у сервера
   * через fingerprint-pinned запрос (без авторизации) → показываем «Тебя
   * приглашают в проект X» и форму регистрации.
   */
  async function loadInviteInfo() {
    const parsed = parseInviteToken(inviteRaw);
    if (!parsed) {
      addToast({
        type: 'error',
        text: 'Неверная ссылка. Скопируй её целиком — должна начинаться с bapi.',
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
    } catch (e) {
      addToast({
        type: 'error',
        text: 'Не удалось проверить приглашение: ' + (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * IPC сам решает register vs login — если на сервере уже есть юзер с
   * таким origin'ом (мы вернулись по ссылке), идём логином и принимаем
   * invite. Иначе регистрируемся с inviteCode'ом и сервер сразу заносит
   * нас в project_members с указанной ролью.
   */
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

  async function startPair() {
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
        kind: 'projects',
      })) as { server: { id: string; url: string; fingerprint: string } };

      // Версия после ручной установки тоже должна совпасть с ожидаемой.
      const verify = (await window.backupsApp.servers.verifyCurrent(res.server.id)) as
        | { ok: true }
        | {
            ok: false;
            reason: 'outdated' | 'unreachable';
            current?: string;
            expected: string;
            error?: string;
          };
      if (!verify.ok) {
        await window.backupsApp.servers.delete(res.server.id);
        await refresh();
        const msg =
          verify.reason === 'outdated'
            ? `Сервер на хосте (${verify.current ?? '?'}) старше ожидаемой версии (${verify.expected}). Перезапусти install-v2.sh последней версией.`
            : `Сервер недоступен: ${verify.error ?? 'неизвестно'}`;
        addToast({ type: 'error', text: msg });
        return;
      }

      setResult({
        server: res.server,
        adminUsername: parsed.u,
        adminPassword: parsed.pw,
      });
      setStep('done');
      addToast({ type: 'success', text: 'Сервер подключён' });
      await refresh();
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function startSsh() {
    if (!host || !user || !password) {
      addToast({ type: 'error', text: 'Заполните все обязательные поля' });
      return;
    }
    setStep('install');
    setBusy(true);
    setLogs([]);
    try {
      // v2-протокол: idempotent install-projects.sh (Mode 1) с фазами,
      // авто-сохранение сервера и логин по cred'ам из вывода скрипта.
      const applyRes = (await window.backupsApp.installer.apply({
        sshHost: host.trim(),
        sshPort: Number(port) || 22,
        sshUser: user.trim(),
        sshPassword: password,
        serverPort: Number(serverPort) || 8443,
        adminUser: adminUser.trim() || 'owner',
        autoConnect: true,
        kind: 'projects',
      })) as {
        applied: { serverUrl: string; fingerprint: string; adminUsername: string; adminPassword: string };
        server: { id: string; url: string; fingerprint: string };
        adminUsername: string;
        adminPassword: string;
      };
      const res = {
        server: applyRes.server,
        adminUsername: applyRes.adminUsername,
        adminPassword: applyRes.adminPassword,
      };
      const verify = (await window.backupsApp.servers.verifyCurrent(res.server.id)) as
        | { ok: true }
        | {
            ok: false;
            reason: 'outdated' | 'unreachable';
            current?: string;
            expected: string;
            error?: string;
          };
      if (!verify.ok) {
        await window.backupsApp.servers.delete(res.server.id);
        await refresh();
        const msg =
          verify.reason === 'outdated'
            ? `После установки версия на хосте (${verify.current ?? '?'}) ниже ожидаемой (${verify.expected}). Проверь, что в registry лежит актуальный образ.`
            : `Сервер недоступен после установки: ${verify.error ?? 'неизвестно'}`;
        setLogs((l) => [...l, { type: 'stderr', line: msg }]);
        addToast({ type: 'error', text: msg });
        return;
      }
      setResult(res);
      setStep('done');
      addToast({ type: 'success', text: 'Сервер запущен и подключён' });
      await refresh();
    } catch (e) {
      addToast({
        type: 'error',
        text: `Ошибка установки: ${(e as Error).message}`,
      });
      setLogs((l) => [...l, { type: 'stderr', line: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-10">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Cloud className="h-4 w-4" />
          <span>Мастер создания сервера</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Развернуть сервер на VPS Ubuntu
        </h1>
        <p className="text-sm text-muted-foreground">
          Поднять свой сервер на Ubuntu-VPS — Pair-токен или SSH. Если друг
          уже поднял свой и прислал ссылку — вкладка «По приглашению».
        </p>
      </header>

      {step === 'connection' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={mode === 'pair' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('pair')}
            >
              <Sparkles className="h-4 w-4" />
              Pair-токен (рекомендуется)
            </Button>
            <Button
              variant={mode === 'ssh' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('ssh')}
            >
              <Pencil className="h-4 w-4" />
              Через SSH
            </Button>
            <Button
              variant={mode === 'invite' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('invite')}
            >
              <Link2 className="h-4 w-4" />
              По приглашению
            </Button>
          </div>

          {mode === 'invite' ? (
            <Card>
              <CardHeader>
                <CardTitle>Приглашение в проект</CardTitle>
                <CardDescription>
                  Тебе прислали ссылку <code className="font-mono">bapi.…</code> в
                  Telegram / email? Вставь её сюда — попадёшь сразу в проект,
                  свой сервер поднимать не нужно.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!inviteInfo ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="inv">Приглашение</Label>
                      <textarea
                        id="inv"
                        className="flex min-h-[120px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="bapi.eyJ2IjoxLCJ1cmwiOi4uLn0..."
                        value={inviteRaw}
                        onChange={(e) => setInviteRaw(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => nav(-1)}>
                        Отмена
                      </Button>
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
                    <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4 text-sm">
                      <div className="font-medium">
                        Тебя приглашают в проект{' '}
                        <span className="text-emerald-300">
                          {inviteInfo.projectName ?? '(без имени)'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Роль:{' '}
                        <strong className="text-foreground">
                          {inviteInfo.role}
                        </strong>
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
                        autoFocus
                      />
                      <p className="text-xs text-muted-foreground">
                        Если ты уже зарегистрирован на этом сервере — введи свои
                        логин и пароль, добавишься в проект существующим юзером.
                        Иначе — создастся новый аккаунт.
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
          ) : mode === 'pair' ? (
            <Card>
              <CardHeader>
                <CardTitle>Pair-токен</CardTitle>
                <CardDescription>
                  Запусти команду на чистой Ubuntu — она поставит Docker, поднимет
                  контейнер и напечатает токен. Вставь его сюда.
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
                      {INSTALL_COMMAND}
                    </code>
                    <button
                      className="shrink-0 rounded p-2 hover:bg-accent transition-colors"
                      title="Скопировать"
                      onClick={() => copyToClipboard(INSTALL_COMMAND)}
                    >
                      <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Команда идемпотентная — её можно прогонять много раз, ничего не
                    сломается. Существующие креды (`.env`) сохранятся.
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
                    В токене зашиты адрес сервера, TLS fingerprint, логин и пароль
                    владельца. Креды сохранятся локально и зашифруются.
                  </p>
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  <div>
                    <strong className="text-foreground">
                      TLS pinning + version-gate.
                    </strong>{' '}
                    После входа клиент проверит версию серверной части. Если хост
                    окажется старше ожидаемого — внутрь не пустит, сервер удалится
                    из списка.
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="ghost" onClick={() => nav(-1)}>
                    Отмена
                  </Button>
                  <Button
                    variant="gradient"
                    onClick={startPair}
                    disabled={busy || !token.trim()}
                  >
                    {busy ? 'Подключаемся…' : 'Подключиться'}{' '}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Параметры VPS</CardTitle>
                <CardDescription>
                  SSH-данные нужны только во время установки. Не сохраняются.
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
                    <Input
                      id="port"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="user">SSH пользователь</Label>
                    <Input
                      id="user"
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pwd">Пароль (или sudo пароль)</Label>
                    <Input
                      id="pwd"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
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
                    <Input
                      id="ouser"
                      value={adminUser}
                      onChange={(e) => setAdminUser(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  <div>
                    <strong className="text-foreground">Безопасность.</strong>{' '}
                    Пароль используется один раз для запуска install-v2.sh и не
                    сохраняется. После установки клиент закрепит SHA-256
                    fingerprint сертификата (TLS pinning).
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="ghost" onClick={() => nav(-1)}>
                    Отмена
                  </Button>
                  <Button variant="gradient" onClick={startSsh}>
                    Развернуть <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {step === 'install' && (
        <>
          <Stepper step={step} />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="h-5 w-5" /> Установка
              </CardTitle>
              <CardDescription>
                Лог установки. Не закрывайте окно до завершения.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                ref={logRef}
                className="h-96 overflow-y-auto rounded-lg border border-border bg-black/60 p-4 font-mono text-xs"
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
                <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
                  идёт установка, может занять до пары минут…
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {step === 'done' && result && (
        <>
          <Stepper step={step} />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-emerald-400" /> Сервер готов
              </CardTitle>
              <CardDescription>
                Сохраните пароль владельца — без него вы не сможете войти повторно.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Адрес сервера"
                icon={<Server className="accent-fg h-4 w-4" />}
                value={result.server.url}
              />
              <Field
                label="TLS fingerprint"
                icon={<ShieldCheck className="h-4 w-4 text-emerald-400" />}
                value={result.server.fingerprint}
                mono
              />
              <Field
                label="Логин владельца"
                icon={<Cloud className="accent-fg h-4 w-4" />}
                value={result.adminUsername}
              />
              <Field
                label="Пароль владельца"
                icon={<KeyRound className="h-4 w-4 text-amber-300" />}
                value={result.adminPassword}
                mono
                important
              />
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => nav('/dashboard')}>
                  На главную
                </Button>
                <Button
                  variant="gradient"
                  onClick={() => nav(`/server/${result.server.id}`)}
                >
                  Открыть сервер <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};

const Stepper = ({ step }: { step: Step }) => {
  const items: { key: Step; label: string }[] = [
    { key: 'connection', label: 'Параметры' },
    { key: 'install', label: 'Установка' },
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
                (i <= activeIdx
                  ? 'accent-icon text-white'
                  : 'bg-muted text-muted-foreground')
              }
            >
              {i + 1}
            </span>
            {it.label}
          </div>
          {i < items.length - 1 && (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

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
        <div className={'truncate text-sm ' + (mono ? 'font-mono' : '')}>
          {value}
        </div>
      </div>
    </div>
    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(value)}>
      <Copy className="h-3.5 w-3.5" /> Копировать
    </Button>
  </div>
);
