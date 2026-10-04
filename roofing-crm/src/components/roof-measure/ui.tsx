'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Small building blocks in the CRM's look (white cards, gray borders,
// orange-600 primary). Tap targets are at least 36px tall.

export const inputCls =
  'w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Btn({ variant = 'secondary', small, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        small ? 'px-2.5 text-xs' : 'px-3 text-sm',
        variant === 'primary' && 'bg-orange-600 text-white hover:bg-orange-700',
        variant === 'secondary' && 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
        variant === 'ghost' && 'text-gray-600 hover:bg-gray-100',
        variant === 'danger' && 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('mb-1 block text-xs font-medium text-gray-600', className)}>{children}</span>;
}

// Label above a control (the original's .grid2 label).
export function LField({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col', className)}>
      <Label>{label}</Label>
      {children}
    </label>
  );
}

export function Check({ checked, onChange, children, id }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; id?: string }) {
  return (
    <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input id={id} type="checkbox" className="h-4 w-4 rounded border-gray-300 accent-orange-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function H4({ children }: { children: ReactNode }) {
  return <h4 className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{children}</h4>;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-xs leading-relaxed text-gray-500', className)}>{children}</p>;
}

// Result box (the original's .out).
export function Out({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <div data-testid={testId} className={cn('mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800', className)}>{children}</div>;
}

export function Kpis({ items }: { items: { v: ReactNode; l: ReactNode; testId?: string }[] }) {
  return (
    <div className="mb-2 grid grid-cols-3 gap-2">
      {items.map((k, i) => (
        <div key={i} className="min-w-0 rounded-lg border border-gray-200 bg-white px-2.5 py-2">
          <div data-testid={k.testId} className="truncate text-lg font-bold tabular-nums text-gray-900">{k.v}</div>
          <div className="text-[11px] leading-tight text-gray-500">{k.l}</div>
        </div>
      ))}
    </div>
  );
}

// Tables inside result boxes.
export const tableCls = 'w-full border-collapse text-xs [&_td]:px-1 [&_td]:py-1 [&_td]:align-top [&_th]:border-b [&_th]:border-gray-200 [&_th]:px-1 [&_th]:py-1 [&_th]:text-left [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-gray-500';
export const numCls = 'text-right tabular-nums whitespace-nowrap';

export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span className={cn('inline-block h-2.5 w-2.5 flex-none rounded-sm border border-black/10', className)} style={{ background: color }} />;
}
