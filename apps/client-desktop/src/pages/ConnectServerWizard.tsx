import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAppStore } from '@/store/app-store';
import { Globe, ShieldCheck, ChevronRight, Sparkles, Pencil, Terminal, Copy } from 'lucide-react';

interface PairPayload {
  v: number;
  url: string;
  fp: string;
  u: string;
  pw: string;
}

function parsePairToken(raw: string): PairPayload | null {
  let s = raw.trim();
  if (s.startsWith('bap1.')) s = s.slice(5);
  // url-safe base64 → standard
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  try {
    const json = atob(s);
    const obj = JSON.parse(json) as PairPayload;
    if (obj.v !== 1 || !obj.url || !obj.fp || !obj.u || !obj.pw) return null;
    return obj;
  } catch {
    return null;
  }
}

export const ConnectServerWizard = () => {
  const nav = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const refresh = useAppStore((s) => s.refreshServers);

  const [mode, setMode] = React.useState<'token' | 'manual'>('token');
  const [token, setToken] = React.useState('');
  const [url, setUrl] = React.useState('https://');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function connect(payload: { url: string; username: string; password: string }) {
    setBusy(true);
    try {
      const res = (await window.backupsApp.servers.connect(payload)) as {
        server: { id: string };
      };
      await refresh();
      addToast({ type: 'success', text: 'Сервер подключён' });
      nav(`/server/${res.server.id}`);
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submitManual() {
    if (!url.startsWith('https://')) {
      addToast({ type: 'error', text: 'Используйте https://' });
      return;
    }
    await connect({ url, username, password });
  }

  async function submitToken() {
    const parsed = parsePairToken(token);
    if (!parsed) {
      addToast({
        type: 'error',
        text: 'Неверный pair-токен. Скопируй строку из вывода install.sh.',
      });
      return;
    }
    await connect({ url: parsed.url, username: parsed.u, password: parsed.pw });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-8 py-10">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" />
          <span>Подключиться к существующему серверу</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Подключить сервер</h1>
        <p className="text-sm text-muted-foreground">
          Самый простой путь — вставить pair-токен из вывода <code>install.sh</code>.
          Или ввести параметры вручную.
        </p>
      </header>

      <div className="flex gap-2">
        <Button
          variant={mode === 'token' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('token')}
        >
          <Sparkles className="h-4 w-4" />
          Pair-токен
        </Button>
        <Button
          variant={mode === 'manual' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('manual')}
        >
          <Pencil className="h-4 w-4" />
          Вручную
        </Button>
      </div>

      {mode === 'token' ? (
        <Card>
          <CardHeader>
            <CardTitle>Pair-токен</CardTitle>
            <CardDescription>
              Запусти одну команду на сервере — она напечатает токен. Вставь его сюда.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Terminal className="h-3.5 w-3.5 shrink-0" />
                <span>Запусти на своей проде по SSH:</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-background/60 px-3 py-2 font-mono text-[11px] text-foreground/80 break-all">
                  curl -fsSL https://raw.githubusercontent.com/Cotee4ka/backups-app/main/apps/server/scripts/install.sh | sudo bash
                </code>
                <button
                  className="shrink-0 rounded p-2 hover:bg-accent transition-colors"
                  title="Скопировать"
                  onClick={() => navigator.clipboard.writeText('curl -fsSL https://raw.githubusercontent.com/Cotee4ka/backups-app/main/apps/server/scripts/install.sh | sudo bash')}
                >
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tok">Pair-токен</Label>
              <textarea
                id="tok"
                className="flex min-h-[112px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="bap1.eyJ2IjoxLCJ1cmwiOiJodHRwczovLy4uLiJ9"
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
                <strong className="text-foreground">TLS pinning.</strong> Fingerprint
                из токена сравнится с реальным сертификатом сервера. Если они не совпадут —
                подключение откажется.
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => nav(-1)}>
                Отмена
              </Button>
              <Button
                variant="gradient"
                onClick={submitToken}
                disabled={busy || !token.trim()}
              >
                {busy ? 'Подключаемся…' : 'Подключиться'} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Параметры подключения</CardTitle>
            <CardDescription>
              Данные будут зашифрованы локально, а TLS fingerprint сохранится после первого подключения.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="url">URL сервера</Label>
              <Input
                id="url"
                placeholder="https://example.com:8443"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="un">Логин</Label>
                <Input id="un" value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw">Пароль</Label>
                <Input
                  id="pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <div>
                <strong className="text-foreground">TLS pinning.</strong> Fingerprint
                будет снят с сертификата сервера и сохранён локально. Если сервер сменит сертификат —
                приложение откажется подключаться без вашего подтверждения.
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => nav(-1)}>
                Отмена
              </Button>
              <Button variant="gradient" onClick={submitManual} disabled={busy}>
                {busy ? 'Подключаемся…' : 'Подключиться'} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
