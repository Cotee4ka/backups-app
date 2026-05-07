import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Положение модала по горизонтали. По умолчанию 'center'. */
  align?: 'center' | 'left' | 'right';
}

export const Dialog = ({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  align = 'center',
}: DialogProps) => {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center bg-black/60 p-4 backdrop-blur-sm',
        align === 'center' && 'justify-center',
        align === 'left' && 'justify-start pl-8 transition-all duration-300',
        align === 'right' && 'justify-end pr-8 transition-all duration-300',
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          'relative z-10 w-full overflow-hidden rounded-xl border border-border bg-card shadow-2xl',
          size === 'sm' && 'max-w-md',
          size === 'md' && 'max-w-xl',
          size === 'lg' && 'max-w-3xl',
        )}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        {(title || description) && (
          <div className="border-b border-border px-6 py-4">
            {title && <h2 className="text-lg font-semibold tracking-tight">{title}</h2>}
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        )}
        <div className="max-h-[70vh] overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
};
