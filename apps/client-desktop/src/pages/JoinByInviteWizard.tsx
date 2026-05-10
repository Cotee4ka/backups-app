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
import { Link2, Loader2 } from 'lucide-react';
import { parseInviteToken } from '@/lib/invite-token';

/**
 * Отдельный визард для друга, который получил `bapi.…` ссылку-приглашение
 * в проект Mode 1. Здесь НЕТ выбора между режимами / SSH / pair-токеном —
 * просто вставь ссылку и попади в проект.
 *
 * Не путать с:
 *   - CreateServerWizard («Создать сервер») — создаёт новый Mode 1 VPS
 *   - ConnectServerWizard («Подключиться к проде») — Mode 2 read-only
 *     mirror к существующему prod-серверу
 */
export const JoinByInviteWizard = () => {
  const nav = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const refresh = useAppStore((s) => s.refreshServers);

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
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  /**
   * Юзер вставил `bapi.…` токен → парсим, валидируем код у сервера через
   * fingerprint-pinned запрос (без авторизации) → показываем «Тебя
   * приглашают в проект X с ролью Y» и форму регистрации/логина.
   */
  async function loadInfo() {
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
   * таким origin'ом (мы вернулись по той же ссылке), идём логином и
   * принимаем invite. Иначе регистрируемся с inviteCode'ом и сервер сразу
   * заносит нас в project_members.
   */
  async function submit() {
    if (!inviteInfo) return;
    if (username.trim().length < 3 || password.length < 8) {
      addToast({ type: 'error', text: 'Имя — от 3 символов, пароль — от 8.' });
      return;
    }
    setBusy(true);
    try {
      const res = await window.backupsApp.invites.joinByInvite({
        url: inviteInfo.url,
        fingerprint: inviteInfo.fingerprint,
        code: inviteInfo.code,
        username: username.trim(),
        password,
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

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-8 py-10">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link2 className="h-4 w-4" />
          <span>Принять приглашение в проект</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">У меня есть приглашение</h1>
        <p className="text-sm text-muted-foreground">
          Тебе прислали ссылку <code className="font-mono">bapi.…</code> в Telegram
          / email? Вставь её сюда — попадёшь сразу в проект, ничего настраивать
          не нужно.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {inviteInfo ? 'Регистрация в проекте' : 'Ссылка-приглашение'}
          </CardTitle>
          <CardDescription>
            {inviteInfo
              ? 'Создай аккаунт или войди в существующий — попадёшь прямо в проект.'
              : 'Скопируй строку из сообщения целиком и вставь сюда.'}
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
                  onClick={() => void loadInfo()}
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
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Если ты уже зарегистрирован на этом сервере — введи свои
                  логин и пароль, ты добавишься в проект существующим юзером.
                  Иначе — создастся новый аккаунт.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invp">Пароль</Label>
                <Input
                  id="invp"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setInviteInfo(null);
                    setUsername('');
                    setPassword('');
                  }}
                >
                  Назад
                </Button>
                <Button
                  variant="gradient"
                  onClick={() => void submit()}
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
    </div>
  );
};
