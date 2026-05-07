import React from 'react';
import { cn } from '@/lib/utils';

interface SpinnerProps {
  size?: 'sm' | 'default' | 'lg' | 'xl';
  className?: string;
}

export function Spinner({ size = 'default', className }: SpinnerProps) {
  const dim = { sm: 16, default: 24, lg: 36, xl: 56 }[size];
  const stroke = { sm: 2, default: 2.5, lg: 3, xl: 4 }[size];
  const r = (dim - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;

  return (
    <svg
      width={dim}
      height={dim}
      viewBox={`0 0 ${dim} ${dim}`}
      className={cn('spinner-arc', className)}
      aria-hidden
    >
      <circle
        cx={dim / 2}
        cy={dim / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.12}
        strokeWidth={stroke}
      />
      <circle
        cx={dim / 2}
        cy={dim / 2}
        r={r}
        fill="none"
        stroke="url(#spin-grad)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circ * 0.72} ${circ * 0.28}`}
        strokeDashoffset={0}
      />
      <defs>
        <linearGradient id="spin-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="hsl(221 78% 62%)" />
          <stop offset="100%" stopColor="hsl(270 70% 65%)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function DotsLoader({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="dot-1 h-1.5 w-1.5 rounded-full bg-violet-400" />
      <span className="dot-2 h-1.5 w-1.5 rounded-full bg-indigo-400" />
      <span className="dot-3 h-1.5 w-1.5 rounded-full bg-blue-400" />
    </div>
  );
}

export function FullPageLoader() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-background">
      <div className="relative">
        <Spinner size="xl" className="text-violet-400/60" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-3 w-3 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 shadow-lg shadow-violet-500/40" />
        </div>
      </div>
      <DotsLoader />
    </div>
  );
}
