'use client';

import { useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMoney, formatMoneyWhole, formatPct, toNumber, type Tone } from '@/lib/estimator';

// Building blocks for the estimator screens, in the CRM's look (white cards,
// gray borders, orange primary). They mirror the original estimator's
// primitives (card, card header, field, numeric input, pill, alert...).

// ==================== TONES ====================

export const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  bad: 'bg-red-50 text-red-700 ring-red-200',
  navy: 'bg-blue-50 text-blue-700 ring-blue-200',
  gold: 'bg-orange-50 text-orange-700 ring-orange-200',
  mut: 'bg-gray-100 text-gray-700 ring-gray-200',
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-600',
  warn: 'text-amber-600',
  bad: 'text-red-600',
  navy: 'text-blue-700',
  gold: 'text-orange-600',
  mut: 'text-gray-700',
};

export const TONE_BAR: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  navy: 'bg-blue-600',
  gold: 'bg-orange-500',
  mut: 'bg-gray-400',
};

export function Pill({ tone = 'mut', title, children, className }: { tone?: Tone; title?: string; children: ReactNode; className?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        TONE_PILL[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ==================== CARDS ====================

export function Card({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cn('min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, sub, right, className }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50/60 px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold leading-tight text-gray-900">{title}</h3>
        {sub ? <div className="mt-0.5 text-xs text-gray-500">{sub}</div> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4', className)}>{children}</div>;
}

// Bottom summary row of a card ("Section total", "Line items total"...).
export function CardFooterRow({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50/60 px-4 py-2.5 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className={cn('tabular-nums text-gray-900', strong && 'font-semibold')}>{value}</span>
    </div>
  );
}

// A sub-card inside a page (roof section / gutter run).
export function SubCard({ title, right, footer, children }: { title: ReactNode; right?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-100 bg-orange-50/70 px-4 py-2.5">
        <h4 className="min-w-0 truncate text-sm font-semibold text-orange-900">{title}</h4>
        <div className="flex items-center gap-2">{right}</div>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">{children}</div>
      {footer}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-[11px] font-semibold uppercase tracking-wider text-gray-500', className)}>{children}</div>;
}

// ==================== CALLOUTS ====================

const ALERT_STYLE = {
  ok: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: CheckCircle2, iconCls: 'text-emerald-600' },
  warn: { box: 'border-amber-200 bg-amber-50 text-amber-900', icon: AlertTriangle, iconCls: 'text-amber-600' },
  bad: { box: 'border-red-200 bg-red-50 text-red-900', icon: XCircle, iconCls: 'text-red-600' },
  info: { box: 'border-blue-200 bg-blue-50 text-blue-900', icon: Info, iconCls: 'text-blue-600' },
} as const;

export function Alert({ level, title, children }: { level: keyof typeof ALERT_STYLE; title?: ReactNode; children?: ReactNode }) {
  const s = ALERT_STYLE[level];
  const Icon = s.icon;
  return (
    <div className={cn('flex gap-2.5 rounded-lg border p-3 text-sm', s.box)}>
      <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', s.iconCls)} />
      <div className="min-w-0">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(!!title && 'mt-0.5')}>{children}</div> : null}
      </div>
    </div>
  );
}

// The original's gold-edged explanatory note.
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border-l-[3px] border-orange-400 bg-orange-50/50 px-3 py-2.5 text-[13px] text-gray-700', className)}>
      {children}
    </div>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-xs text-gray-500', className)}>{children}</div>;
}

// ==================== FORM CONTROLS ====================

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint ? <span className="text-[11.5px] text-gray-500">{hint}</span> : null}
    </label>
  );
}

export const controlClass =
  'block w-full min-w-0 min-h-[40px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ' +
  'placeholder:text-gray-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 ' +
  'disabled:bg-gray-50 disabled:text-gray-500 read-only:bg-gray-50 read-only:text-gray-700';

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(controlClass, className)} />;
}

export function ReadOnly({ value, className, numeric }: { value: string; className?: string; numeric?: boolean }) {
  return <input readOnly tabIndex={-1} value={value} className={cn(controlClass, numeric && 'text-right tabular-nums', className)} />;
}

const asText = (v: unknown) => (v === '' || v === null || v === undefined ? '' : String(v));

// Numeric input like the original's: keeps what is typed while focused,
// reports a number (or '' when `blankable` and cleared).
export function NumInput({
  value, onChange, placeholder, blankable, className, disabled, ariaLabel, invalid,
}: {
  value: unknown;
  onChange: (v: number | '') => void;
  placeholder?: string;
  blankable?: boolean;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const [text, setText] = useState<string | null>(null); // non-null while focused
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      disabled={disabled}
      placeholder={placeholder}
      className={cn(controlClass, 'text-right tabular-nums', invalid && 'border-red-500 ring-2 ring-red-500/20', className)}
      value={text ?? asText(value)}
      onFocus={() => setText(asText(value))}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9.\-]/g, '');
        setText(raw);
        onChange(raw === '' ? (blankable ? '' : 0) : toNumber(raw));
      }}
    />
  );
}

export function Select({
  value, onChange, children, className, disabled, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cn(controlClass, 'pr-8', className)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex min-h-[44px] cursor-pointer select-none items-center gap-2.5">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 flex-shrink-0 rounded border-gray-300 accent-orange-600"
      />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}

// Fields laid out in an auto-fitting grid (one column on narrow phones).
export function FieldGrid({ min = 150, children, className }: { min?: number; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-3', className)} style={{ gridTemplateColumns: `repeat(auto-fit,minmax(min(100%,${min}px),1fr))` }}>
      {children}
    </div>
  );
}

// ==================== BUTTONS ====================

type ButtonVariant = 'primary' | 'default' | 'danger' | 'ghost';

export const buttonClass = (variant: ButtonVariant = 'default', size: 'sm' | 'md' = 'md') =>
  cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'min-h-[36px] px-3 text-sm' : 'min-h-[40px] px-4 text-sm',
    variant === 'primary' && 'bg-orange-600 text-white shadow-sm hover:bg-orange-700',
    variant === 'default' && 'border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50',
    variant === 'danger' && 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
    variant === 'ghost' && 'text-gray-600 hover:bg-gray-100',
  );

export function Button({
  variant = 'default', size = 'md', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return <button type="button" {...props} className={cn(buttonClass(variant, size), className)} />;
}

// ==================== FIGURES ====================

export interface Tile {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}

// The original's stat strip (dashboard, combined page).
export function StatTiles({ items }: { items: Tile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
      {items.map((t, i) => (
        <div key={i} className="min-w-0 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="truncate text-xs font-medium text-gray-500">{t.label}</div>
          <div className={cn('mt-1 truncate text-xl font-bold tabular-nums', t.tone ? TONE_TEXT[t.tone] : 'text-gray-900')}>
            {t.value}
          </div>
          {t.sub ? <div className="mt-0.5 truncate text-xs text-gray-500">{t.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

// Key/value line in the live summary.
export function KV({ k, v, strong, tone }: { k: ReactNode; v: ReactNode; strong?: boolean; tone?: Tone }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-[5px]', strong && 'mt-1 border-t border-gray-200 pt-2')}>
      <span className={cn('text-[13px]', strong ? 'font-semibold text-gray-900' : 'text-gray-600')}>{k}</span>
      <span className={cn('tabular-nums', strong ? 'text-lg font-bold' : 'text-sm', tone ? TONE_TEXT[tone] : 'text-gray-900')}>{v}</span>
    </div>
  );
}

export function MarginBar({ margin, tone }: { margin: number; tone: Tone }) {
  const w = Math.max(0, Math.min(100, margin));
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
      <i className={cn('block h-full rounded-full', TONE_BAR[tone])} style={{ width: w + '%' }} />
    </div>
  );
}

// Segment colours for the stacked bars, in the original's s1..s6 order.
export const SEGMENT_COLORS = ['#334155', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#ea580c'];

export interface BarSegment {
  label: string;
  value: number;
  color: string;
}

// Horizontal stacked bar with a legend. Slivers under 0.4% are hidden, as in the original.
export function StackedBar({ segments, total, ariaLabel = 'Price composition' }: { segments: BarSegment[]; total: number; ariaLabel?: string }) {
  const shown = segments.filter((s) => s.value > 0.004 * total && s.value > 0);
  if (!shown.length || total <= 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-9 w-full overflow-hidden rounded-md border border-gray-200" role="img" aria-label={ariaLabel}>
        {shown.map((s, i) => {
          const pct = (s.value / total) * 100;
          return (
            <div
              key={i}
              title={`${s.label}: ${formatMoney(s.value)} (${formatPct(pct)})`}
              style={{ flex: s.value, background: s.color }}
              className="flex items-center justify-center overflow-hidden"
            >
              {pct >= 12 ? <span className="px-1 text-[11px] font-semibold tabular-nums text-white/95">{formatMoneyWhole(s.value)}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-gray-500">
        <span>$0</span>
        <span>{formatMoneyWhole(total)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-gray-700">
        {shown.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label} <b className="tabular-nums">{formatMoneyWhole(s.value)}</b> · {formatPct((s.value / total) * 100)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ==================== TABLES ====================

export interface Column<T> {
  header?: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  right?: boolean;
  width?: string;
  className?: string;
  // Phone card layout: label shown beside the value (defaults to header);
  // false hides the column on phones; 'title' makes it the card's heading.
  mobile?: 'title' | false | ReactNode;
  mobileFull?: boolean; // spans the whole card width on phones (action buttons)
}

// A table from md up; below md each row becomes a card of label/value pairs
// (unless `phone="table"`, for narrow tables that fit a phone as they are).
export function DataTable<T>({
  rows, columns, rowKey, rowClassName, phone = 'cards', footer, className,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, index: number) => string | number;
  rowClassName?: (row: T, index: number) => string | undefined;
  phone?: 'cards' | 'table';
  footer?: ReactNode;
  className?: string;
}) {
  const table = (
    <div className={cn('overflow-x-auto', phone === 'cards' && 'hidden md:block', className)}>
      <table className="w-full border-collapse text-sm">
        {columns.some((c) => c.header) ? (
          <thead>
            <tr className="bg-gray-50">
              {columns.map((c, i) => (
                <th
                  key={i}
                  style={{ width: c.width }}
                  className={cn(
                    'border-b border-gray-200 px-3 py-2 align-bottom text-[11px] md:whitespace-nowrap font-semibold uppercase tracking-wider text-gray-500',
                    c.right ? 'text-right' : 'text-left',
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className={cn('align-top', rowClassName?.(r, i))}>
              {columns.map((c, j) => (
                <td key={j} className={cn('border-b border-gray-100 px-3 py-2', c.right && 'text-right tabular-nums', c.className)}>
                  {c.cell(r, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  );
  if (phone === 'table') return table;
  const titleCol = columns.find((c) => c.mobile === 'title') || columns[0];
  return (
    <>
      {table}
      <div className="divide-y divide-gray-100 md:hidden">
        {rows.map((r, i) => (
          <div key={rowKey(r, i)} className={cn('px-4 py-3', rowClassName?.(r, i))}>
            <div className="text-sm font-medium text-gray-900">{titleCol.cell(r, i)}</div>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
              {columns
                .filter((c) => c !== titleCol && c.mobile !== false)
                .map((c, j) => {
                  const label = c.mobile !== undefined && c.mobile !== 'title' ? c.mobile : c.header;
                  return (
                    <div key={j} className={cn('flex min-w-0 flex-col text-sm', !label && 'justify-end', c.mobileFull && 'col-span-2 mt-1')}>
                      {label ? <dt className="text-[11px] text-gray-500">{label}</dt> : null}
                      <dd className="min-w-0 break-words tabular-nums text-gray-900">{c.cell(r, i)}</dd>
                    </div>
                  );
                })}
            </dl>
          </div>
        ))}
        {footer}
      </div>
    </>
  );
}
