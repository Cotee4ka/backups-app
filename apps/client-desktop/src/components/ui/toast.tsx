import * as React from 'react';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

export const ToastHost = () => {
  const toasts = useAppStore((s) => s.toasts);
  const remove = useAppStore((s) => s.removeToast);

  React.useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => remove(t.id), 5000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, remove]);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon =
          t.type === 'success' ? CheckCircle2 : t.type === 'error' ? AlertCircle : Info;
        return (
          <div
            key={t.id}
            role="alert"
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-xl border bg-card p-4 shadow-2xl backdrop-blur',
              t.type === 'success' && 'border-emerald-600/40',
              t.type === 'error' && 'border-destructive/40',
              t.type === 'info' && 'border-border',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 h-5 w-5 shrink-0',
                t.type === 'success' && 'text-emerald-400',
                t.type === 'error' && 'text-destructive',
                t.type === 'info' && 'text-blue-400',
              )}
            />
            <span className="flex-1 text-sm leading-snug text-foreground">{t.text}</span>
            <button
              onClick={() => remove(t.id)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
