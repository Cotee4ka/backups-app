import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppStore } from '@/store/app-store';
import { Sun, Moon, Monitor, Power, Clock, Globe, Trash2 } from 'lucide-react';

interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  language: 'ru' | 'en';
  autoLaunch: boolean;
  startMinimized: boolean;
  syncDebounceMs: number;
  syncPeriodicMs: number;
}

export const SettingsPage = () => {
  const addToast = useAppStore((s) => s.addToast);
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = React.useState('—');

  React.useEffect(() => {
    void window.backupsApp.settings.get().then((s) => setSettings(s as AppSettings));
    void window.backupsApp.app.version().then((v) => setAppVersion(String(v)));
  }, []);

  React.useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    if (settings.theme === 'dark') root.classList.add('dark');
    else if (settings.theme === 'light') root.classList.remove('dark');
    else {
      const m = matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', m);
    }
  }, [settings?.theme]);

  async function patch(p: Partial<AppSettings>) {
    const s = (await window.backupsApp.settings.update(p)) as AppSettings;
    setSettings(s);
  }

  async function toggleAutoLaunch(v: boolean) {
    try {
      await window.backupsApp.settings.setAutoLaunch(v);
      await patch({ autoLaunch: v });
      addToast({ type: 'success', text: v ? 'Автозагрузка включена' : 'Автозагрузка отключена' });
    } catch (e) {
      addToast({ type: 'error', text: (e as Error).message });
    }
  }

  if (!settings) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="text-sm text-muted-foreground">Версия {appVersion}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Внешний вид</CardTitle>
          <CardDescription>Тема оформления и язык интерфейса.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="mb-2 block">Тема</Label>
            <div className="grid grid-cols-3 gap-2">
              <ThemeBtn
                icon={<Sun className="h-4 w-4" />}
                label="Светлая"
                active={settings.theme === 'light'}
                onClick={() => patch({ theme: 'light' })}
              />
              <ThemeBtn
                icon={<Moon className="h-4 w-4" />}
                label="Тёмная"
                active={settings.theme === 'dark'}
                onClick={() => patch({ theme: 'dark' })}
              />
              <ThemeBtn
                icon={<Monitor className="h-4 w-4" />}
                label="Системная"
                active={settings.theme === 'system'}
                onClick={() => patch({ theme: 'system' })}
              />
            </div>
          </div>
          <div>
            <Label className="mb-2 block">Язык</Label>
            <div className="grid grid-cols-2 gap-2">
              <ThemeBtn
                icon={<Globe className="h-4 w-4" />}
                label="Русский"
                active={settings.language === 'ru'}
                onClick={() => patch({ language: 'ru' })}
              />
              <ThemeBtn
                icon={<Globe className="h-4 w-4" />}
                label="English"
                active={settings.language === 'en'}
                onClick={() => patch({ language: 'en' })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Запуск приложения</CardTitle>
          <CardDescription>
            Чтобы синхронизация шла даже когда вы не открывали окно вручную.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            icon={<Power className="h-4 w-4 text-violet-300" />}
            title="Запускать вместе с системой"
            description="Открывает приложение при старте Windows или macOS."
            checked={settings.autoLaunch}
            onChange={toggleAutoLaunch}
          />
          <ToggleRow
            icon={<Power className="h-4 w-4 text-blue-300" />}
            title="Стартовать свёрнутым"
            description="Не показывать окно при автозапуске."
            checked={settings.startMinimized}
            onChange={(v) => patch({ startMinimized: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Синхронизация</CardTitle>
          <CardDescription>
            Изменения коммитятся батчами, а не на каждое нажатие. Это бережёт диск и сеть.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" /> Debounce idle, мс
              </Label>
              <Input
                type="number"
                value={settings.syncDebounceMs}
                onChange={(e) => patch({ syncDebounceMs: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">
                Сколько секунд бездействия должно пройти, чтобы запушить изменения.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" /> Периодический flush, мс
              </Label>
              <Input
                type="number"
                value={settings.syncPeriodicMs}
                onChange={(e) => patch({ syncPeriodicMs: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">
                Гарантированный таймер для случаев непрерывной правки.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle>Опасная зона</CardTitle>
          <CardDescription>
            Сброс полностью удалит локальный аккаунт и все сохранённые подключения к серверам.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!confirm('Точно сбросить локальное состояние?')) return;
              await window.backupsApp.account.reset();
              location.reload();
            }}
          >
            <Trash2 className="h-4 w-4" /> Сбросить локальное состояние
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

const ThemeBtn = ({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className={
      'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition ' +
      (active
        ? 'border-violet-500 bg-violet-500/10 text-foreground'
        : 'border-border text-muted-foreground hover:bg-accent/40')
    }
  >
    {icon} {label}
  </button>
);

const ToggleRow = ({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label className="flex cursor-pointer items-center gap-4 rounded-lg border border-border bg-muted/20 p-4 transition hover:bg-muted/40">
    <div className="grid h-9 w-9 place-items-center rounded-md bg-muted/50">{icon}</div>
    <div className="flex-1">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{description}</div>
    </div>
    <input
      type="checkbox"
      className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-muted transition before:block before:h-4 before:w-4 before:translate-x-0.5 before:translate-y-0.5 before:rounded-full before:bg-foreground before:transition checked:bg-violet-500 checked:before:translate-x-[18px]"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  </label>
);
