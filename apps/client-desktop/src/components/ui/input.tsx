import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background/40 px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-ring',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
