import * as React from 'react';
import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** ARIA-label на корневую кнопку. */
  label?: string;
  className?: string;
}

/**
 * Анимированный ползунок: thumb едет с easing'ом, фон трэка пульсирует
 * мягким свечением в активном состоянии. Используем button + role=switch
 * вместо input[type=checkbox], чтобы можно было полноценно стилизовать.
 */
export const Switch = ({
  checked,
  onChange,
  disabled,
  size = 'md',
  label,
  className,
}: SwitchProps) => {
  const dims =
    size === 'sm'
      ? { track: 'h-5 w-9', thumb: 'h-4 w-4', off: 'translate-x-0.5', on: 'translate-x-[18px]' }
      : { track: 'h-6 w-11', thumb: 'h-5 w-5', off: 'translate-x-0.5', on: 'translate-x-[22px]' };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'transition-[background-color,box-shadow] duration-300 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        disabled && 'cursor-not-allowed opacity-50',
        dims.track,
        checked
          ? 'accent-btn shadow-[0_0_0_1px_rgba(124,58,237,0.4),0_0_18px_-4px_rgba(124,58,237,0.7)]'
          : 'bg-muted/70 hover:bg-muted',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none block rounded-full bg-white shadow-md ring-0',
          'transition-[transform,box-shadow] duration-300',
          checked ? 'shadow-[0_0_8px_rgba(255,255,255,0.6)]' : '',
          dims.thumb,
          checked ? dims.on : dims.off,
        )}
        style={{ transitionTimingFunction: 'cubic-bezier(.34,1.56,.64,1)' }}
      />
    </button>
  );
};
