import React from 'react';
import { Cloud, Lock, Sparkles, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppStore } from '@/store/app-store';
import { useNavigate } from 'react-router-dom';

export const OnboardingPage = () => {
  const setHasAccount = useAppStore((s) => s.setHasAccount);
  const setAuthed = useAppStore((s) => s.setAuthed);
  const addToast = useAppStore((s) => s.addToast);
  const nav = useNavigate();

  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (username.length < 2) {
      addToast({ type: 'error', text: 'Имя слишком короткое' });
      return;
    }
    if (password.length < 8) {
      addToast({ type: 'error', text: 'Пароль не короче 8 символов' });
      return;
    }
    if (password !== confirm) {
      addToast({ type: 'error', text: 'Пароли не совпадают' });
      return;
    }
    setBusy(true);
    try {
      await window.backupsApp.account.create(username, password);
      setHasAccount(true);
      setAuthed(true, username);
      addToast({ type: 'success', text: 'Локальный аккаунт создан' });
      nav('/dashboard');
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left hero */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-violet-900 via-blue-950 to-slate-950 p-12 text-white lg:flex">
        <div className="relative z-10 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/10 backdrop-blur-md">
            <Cloud className="h-5 w-5" />
          </div>
          <div className="text-lg font-semibold">Backups App</div>
        </div>

        <div className="relative z-10 max-w-md space-y-6">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            Совместная работа
            <br />
            над проектами в реальном времени
          </h1>
          <p className="text-lg text-white/70">
            Подключите свой VPS — и приложение само поднимет сервер, будет
            хранить историю всех изменений, синхронизировать команду и
            восстанавливать любую версию в один клик.
          </p>
          <ul className="space-y-3 text-sm text-white/80">
            <Feature icon={<Server className="h-4 w-4" />} text="Установка сервера на VPS одним кликом по SSH" />
            <Feature icon={<Sparkles className="h-4 w-4" />} text="Все правки автоматически бекапятся через Git" />
            <Feature icon={<Lock className="h-4 w-4" />} text="TLS pinning, шифрование локального хранилища" />
          </ul>
        </div>

        <div className="relative z-10 text-xs text-white/50">© Backups App</div>

        {/* glow */}
        <div className="pointer-events-none absolute -left-32 top-32 h-96 w-96 rounded-full bg-violet-500/30 blur-[120px]" />
        <div className="pointer-events-none absolute right-0 bottom-0 h-96 w-96 rounded-full bg-blue-500/30 blur-[120px]" />
      </div>

      {/* Right form */}
      <div className="flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center gap-2 text-center lg:items-start lg:text-left">
            <h2 className="text-2xl font-semibold tracking-tight">
              Создать локальный аккаунт
            </h2>
            <p className="text-sm text-muted-foreground">
              Аккаунт защищает ваши пароли от серверов. Никуда не отправляется.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="u">Имя пользователя</Label>
              <Input
                id="u"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="example"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p">Пароль</Label>
              <Input
                id="p"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="минимум 8 символов"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c">Повторите пароль</Label>
              <Input
                id="c"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <Button type="submit" variant="gradient" className="w-full" disabled={busy}>
              {busy ? 'Создаётся…' : 'Создать аккаунт'}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Пароль не передаётся ни на какой сервер. Используется только для
            расшифровки локального хранилища.
          </p>
        </div>
      </div>
    </div>
  );
};

const Feature = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <li className="flex items-start gap-3">
    <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-md bg-white/10">{icon}</span>
    <span>{text}</span>
  </li>
);
