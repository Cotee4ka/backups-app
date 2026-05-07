import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAppStore } from '@/store/app-store';
import { Cloud, KeyRound, Server, ShieldCheck, Copy, ChevronRight, Terminal } from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';

type Step = 'connection' | 'install' | 'done';

interface InstallLog {
  type: 'stdout' | 'stderr' | 'info';
  line: string;
}

export const CreateServerWizard = () => {
  const nav = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const refresh = useAppStore((s) => s.refreshServers);
  const [step, setStep] = React.useState<Step>('connection');

  const [host, setHost] = React.useState('');
  const [port, setPort] = React.useState('22');
  const [user, setUser] = React.useState('root');
  const [password, setPassword] = React.useState('');
  const [serverPort, setServerPort] = React.useState('8443');
  const [adminUser, setAdminUser] = React.useState('owner');

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

  React.useEffect(() => {
    const off = window.backupsApp.servers.onInstallLog((m) => setLogs((l) => [...l, m]));
    return off;
  }, []);

  async function start() {
    if (!host || !user || !password) {
      addToast({ type: 'error', text: 'Заполните все обязательные поля' });
      return;
    }
    setStep('install');
    setBusy(true);
    setLogs([]);
    try {
      const res = (await window.backupsApp.servers.install({
        sshHost: host.trim(),
        sshPort: Number(port) || 22,
        sshUser: user.trim(),
        sshPassword: password,
        serverPort: Number(serverPort) || 8443,
        adminUser: adminUser.trim() || 'owner',
      })) as {
        server: { id: string; url: string; fingerprint: string };
        adminUsername: string;
        adminPassword: string;
      };
      setResult(res);
      setStep('done');
      addToast({ type: 'success', text: 'Сервер запущен и подключён' });
      await refresh();
    } catch (e) {
      addToast({ type: 'error', text: `Ошибка установки: ${(e as Error).message}` });
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
          Через SSH: установит Docker (если нет) и поднимет наш контейнер с Git-сервером.
        </p>
      </header>

      <Stepper step={step} />

      {step === 'connection' && (
        <Card>
          <CardHeader>
            <CardTitle>Параметры VPS</CardTitle>
            <CardDescription>SSH-данные нужны только во время установки. Не сохраняются.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="host">Публичный IP / hostname</Label>
                <Input id="host" placeholder="203.0.113.42" value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="port">SSH порт</Label>
                <Input id="port" value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="user">SSH пользователь</Label>
                <Input id="user" value={user} onChange={(e) => setUser(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pwd">Пароль (или sudo пароль)</Label>
                <Input id="pwd" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sport">Порт сервера приложения</Label>
                <Input id="sport" value={serverPort} onChange={(e) => setServerPort(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ouser">Имя владельца сервера</Label>
                <Input id="ouser" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <div>
                <strong className="text-foreground">Безопасность.</strong> Пароль используется один раз для
                запуска install.sh и не сохраняется. После установки клиент закрепит SHA-256 fingerprint
                сертификата (TLS pinning).
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => nav(-1)}>Отмена</Button>
              <Button variant="gradient" onClick={start}>
                Развернуть <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'install' && (
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
              {logs.length === 0 && <div className="text-muted-foreground">Подключение к серверу…</div>}
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
      )}

      {step === 'done' && result && (
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
              <Button variant="gradient" onClick={() => nav(`/server/${result.server.id}`)}>
                Открыть сервер <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
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
