import React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Trash2 } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Заголовок модалки. */
  title: string;
  /** Описание/предупреждение под заголовком. */
  description: string;
  /** Что отображать в качестве «названия объекта», который удаляется. */
  subjectLabel?: string;
  /** Слово, которое юзер должен ввести вручную. По умолчанию «ПОДТВЕРДИТЬ». */
  confirmPhrase?: string;
  /** Текст кнопки удаления. По умолчанию «Удалить навсегда». */
  confirmButtonLabel?: string;
  /** Дополнительный JSX между warning'ом и полем ввода (например, чекбоксы опций). */
  extraContent?: React.ReactNode;
  /** Колбэк удаления. Если бросит — модалка останется открытой и покажет ошибку. */
  onConfirm: () => Promise<void> | void;
}

/**
 * Блокирующая destructive-confirm модалка с обязательным ручным вводом
 * подтверждающей фразы. Поле автоматически переводит ввод в верхний регистр,
 * чтобы юзер не задумывался про CAPS LOCK / раскладку.
 *
 * Используется для удаления проектов, серверов, других необратимых действий.
 */
export const ConfirmDestructiveDialog = ({
  open,
  onClose,
  title,
  description,
  subjectLabel,
  confirmPhrase = 'ПОДТВЕРДИТЬ',
  confirmButtonLabel = 'Удалить навсегда',
  extraContent,
  onConfirm,
}: Props) => {
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Сбрасываем поле при каждом открытии.
  React.useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const matches = typed === confirmPhrase;

  async function run() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      size="md"
      title={title}
      description={description}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
          <div className="space-y-1 text-foreground/90">
            <div>
              Это действие <strong>необратимо</strong>. Восстановить будет нельзя
              даже из git-истории — записи удалятся вместе с репозиторием.
            </div>
            {subjectLabel && (
              <div className="text-muted-foreground text-xs">
                Объект: <span className="font-mono">{subjectLabel}</span>
              </div>
            )}
          </div>
        </div>

        {extraContent}

        <div className="space-y-1.5">
          <Label htmlFor="confirm-phrase">
            Введите{' '}
            <span className="font-mono font-semibold text-foreground">
              {confirmPhrase}
            </span>{' '}
            для подтверждения
          </Label>
          <Input
            id="confirm-phrase"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={confirmPhrase}
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches && !busy) void run();
            }}
            className={
              'font-mono ' +
              (matches
                ? 'border-emerald-500/60 ring-1 ring-emerald-500/40'
                : typed.length > 0
                  ? 'border-amber-500/40'
                  : '')
            }
          />
          <p className="text-xs text-muted-foreground">
            Регистр поднимается автоматически.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="destructive" onClick={run} disabled={!matches || busy}>
            <Trash2 className="h-4 w-4" />
            {busy ? 'Удаляем…' : confirmButtonLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
