import React from 'react';
import { Cloud, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppStore } from '@/store/app-store';
import { useNavigate } from 'react-router-dom';

export const LoginPage = () => {
  const setAuthed = useAppStore((s) => s.setAuthed);
  const addToast = useAppStore((s) => s.addToast);
  const nav = useNavigate();

  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = (await window.backupsApp.account.verify(username, password)) as { ok: boolean };
      if (!r.ok) {
        addToast({ type: 'error', text: 'Неверный логин или пароль' });
        return;
      }
      setAuthed(true, username);
      nav('/dashboard');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!confirm('Сбросить локальный аккаунт? Все сохранённые серверы будут удалены.'))
      return;
    await window.backupsApp.account.reset();
    location.reload();
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="relative w-full max-w-md">
        <div className="accent-bg pointer-events-none absolute -inset-32 -z-10 rounded-full blur-3xl" />

        <div className="rounded-2xl border border-border bg-card/70 p-8 shadow-2xl backdrop-blur-xl">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="accent-icon grid h-12 w-12 place-items-center rounded-xl text-white" style={{ boxShadow: 'var(--accent-shadow)' }}>
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">С возвращением</h1>
              <p className="text-sm text-muted-foreground">
                Введите пароль локального аккаунта, чтобы разблокировать хранилище.
              </p>
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="u">Имя</Label>
              <Input
                id="u"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p">Пароль</Label>
              <Input
                id="p"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" variant="gradient" className="w-full" disabled={busy}>
              {busy ? 'Проверка…' : 'Войти'}
            </Button>
          </form>

          <div className="mt-6 text-center text-xs text-muted-foreground">
            <button onClick={reset} className="underline-offset-4 hover:underline">
              Забыли пароль / сбросить аккаунт
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
