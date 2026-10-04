'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Info, Lock, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toNumber, type Tone } from '@/lib/estimator';

// Small building blocks shared by the estimator's output and manager screens
// (proposal, job cost, history, market, admin pricing), in the CRM's look:
// white cards, orange primary, status pills, tables that turn into labelled
// cards on phones.

// ==================== TONES ====================

export const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-green-50 text-green-700 border-green-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
  navy: 'bg-blue-50 text-blue-800 border-blue-200',
  gold: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  mut: 'bg-gray-100 text-gray-700 border-gray-200',
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-green-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
  navy: 'text-blue-800',
  gold: 'text-yellow-700',
  mut: 'text-gray-500',
};

export function Pill({ tone = 'mut', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        TONE_PILL[tone],
      )}
    >
      {children}
    </span>
  );
}

// ==================== CARDS ====================

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, sub, right }: { title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {sub && <div className="text-xs text-gray-500">{sub}</div>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </header>
  );
}

export function CardBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4', className)}>{children}</div>;
}

// Collapsible card (the original's <details> groups on Admin pricing).
export function CollapsibleCard({ title, open, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/60 px-4 py-3 text-sm font-semibold text-gray-900 select-none [&::-webkit-details-marker]:hidden">
        {title}
        <span className="text-gray-400 transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
      </summary>
      <div className="flex flex-col gap-5 px-4 py-4">{children}</div>
    </details>
  );
}

// ==================== NOTICES ====================

type Level = 'ok' | 'warn' | 'bad' | 'info';

const NOTICE: Record<Level, { box: string; icon: typeof Check; iconCls: string }> = {
  ok: { box: 'border-green-200 bg-green-50', icon: Check, iconCls: 'text-green-600' },
  warn: { box: 'border-amber-200 bg-amber-50', icon: AlertTriangle, iconCls: 'text-amber-600' },
  bad: { box: 'border-red-200 bg-red-50', icon: XCircle, iconCls: 'text-red-600' },
  info: { box: 'border-blue-200 bg-blue-50', icon: Info, iconCls: 'text-blue-600' },
};

export function Notice({ level, title, children }: { level: Level; title?: React.ReactNode; children?: React.ReactNode }) {
  const n = NOTICE[level];
  return (
    <div className={cn('flex gap-3 rounded-lg border p-3 text-sm text-gray-800', n.box)}>
      <n.icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', n.iconCls)} />
      <div className="min-w-0">
        {title && <b className="font-semibold">{title}</b>}
        {title && children ? <br /> : null}
        {children}
      </div>
    </div>
  );
}

// The original's gold-edged explanatory note.
export function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border-l-[3px] border-orange-400 bg-orange-50/60 px-3 py-2.5 text-[13px] text-gray-700">
      {children}
    </div>
  );
}

// ==================== KPI STRIP ====================

export interface Kpi {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
}

export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
      {items.map((k) => (
        <div key={k.label} className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{k.label}</div>
          <div className={cn('mt-0.5 text-xl font-bold tabular-nums', k.tone ? TONE_TEXT[k.tone] : 'text-gray-900')}>
            {k.value}
          </div>
          {k.sub && <div className="mt-0.5 text-xs text-gray-500">{k.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ==================== RESPONSIVE TABLE ====================

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T, index: number) => React.ReactNode;
  right?: boolean;
  mono?: boolean;
  className?: string;
  // Hide this column's label in the phone card (e.g. the row title).
  primary?: boolean;
  colSpan?: (row: T) => number | undefined;
  skip?: (row: T) => boolean;
  mobileSkip?: (row: T) => boolean; // leave out of the phone card only
}

// A table from md up; below md each row becomes a labelled card.
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
  groups,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  rowClassName?: (row: T) => string | undefined;
  // Extra header rows inserted before a row index (job cost's "Estimated cost" heading).
  groups?: { before: number; header: React.ReactNode[] }[];
}) {
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap border-b border-gray-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500',
                    c.right ? 'text-right' : 'text-left',
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <TableRowWithGroup key={rowKey(row, i)} group={groups?.find((g) => g.before === i)} columns={columns}>
                <tr className={rowClassName?.(row)}>
                  {columns.map((c) =>
                    c.skip?.(row) ? null : (
                      <td
                        key={c.key}
                        colSpan={c.colSpan?.(row)}
                        className={cn(
                          'border-b border-gray-100 px-3 py-2 align-top',
                          c.right && 'text-right',
                          c.mono && 'tabular-nums',
                          c.className,
                        )}
                      >
                        {c.cell(row, i)}
                      </td>
                    ),
                  )}
                </tr>
              </TableRowWithGroup>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-gray-100 md:hidden">
        {rows.map((row, i) => {
          const group = groups?.find((g) => g.before === i);
          return (
            <div key={rowKey(row, i)}>
              {group && (
                <div className="bg-gray-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  {group.header[0]}
                </div>
              )}
              <div className={cn('flex flex-col gap-1.5 px-4 py-3 text-[13px]', rowClassName?.(row))}>
                {columns.map((c) => {
                  if (c.skip?.(row) || c.mobileSkip?.(row)) return null;
                  const content = c.cell(row, i);
                  if (content === null || content === undefined || content === '') return null;
                  if (c.primary) return <div key={c.key} className="min-w-0">{content}</div>;
                  return (
                    <div key={c.key} className="flex items-start justify-between gap-3">
                      <span className="flex-shrink-0 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                        {c.header}
                      </span>
                      <span className={cn('min-w-0 text-right', c.mono && 'tabular-nums')}>{content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function TableRowWithGroup<T>({
  group,
  columns,
  children,
}: {
  group?: { header: React.ReactNode[] };
  columns: Column<T>[];
  children: React.ReactNode;
}) {
  return (
    <>
      {group && (
        <tr>
          {columns.map((c, i) => (
            <th
              key={c.key}
              className={cn(
                'whitespace-nowrap border-b border-gray-200 px-3 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-gray-500',
                c.right ? 'text-right' : 'text-left',
              )}
            >
              {group.header[i] ?? null}
            </th>
          ))}
        </tr>
      )}
      {children}
    </>
  );
}

// ==================== FORM CONTROLS ====================

export const inputCls =
  'w-full min-h-[40px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50 disabled:text-gray-500';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

// Numeric input like the original's: keeps what is typed while focused,
// strips anything but digits, "." and "-", and reports a number (or '' when
// blankable and empty). `commitOnBlur` reports only when the field is left
// (used on Admin pricing so one edit logs one change).
export function NumberInput({
  value,
  onChange,
  blankable,
  disabled,
  placeholder,
  commitOnBlur,
  className,
  ariaLabel,
}: {
  value: unknown;
  onChange: (v: number | '') => void;
  blankable?: boolean;
  disabled?: boolean;
  placeholder?: string;
  commitOnBlur?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const show = (v: unknown) => (v === '' || v === null || v === undefined ? '' : String(v));
  const [text, setText] = useState(show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(show(value)); // eslint-disable-line react-hooks/set-state-in-effect
  }, [value]);
  const emit = (raw: string) => onChange(raw === '' ? (blankable ? '' : 0) : toNumber(raw));
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      disabled={disabled}
      placeholder={placeholder}
      className={cn(inputCls, 'text-right tabular-nums', className)}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (commitOnBlur) emit(text);
      }}
      onKeyDown={(e) => {
        if (commitOnBlur && e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9.\-]/g, '');
        setText(raw);
        if (!commitOnBlur) emit(raw);
      }}
    />
  );
}

// Text input that reports on blur / Enter (Admin pricing company fields).
export function CommitTextInput({
  value,
  onCommit,
  disabled,
  type = 'text',
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  type?: string;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value); // eslint-disable-line react-hooks/set-state-in-effect
  }, [value]);
  return (
    <input
      type={type}
      disabled={disabled}
      className={inputCls}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (text !== value) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      onChange={(e) => {
        setText(e.target.value);
        // Date pickers commit on pick.
        if (type === 'date') onCommit(e.target.value);
      }}
    />
  );
}

// ==================== BUTTONS ====================

const BUTTON = {
  primary: 'bg-orange-600 text-white border-orange-600 hover:bg-orange-700',
  default: 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50',
  danger: 'bg-white text-red-700 border-red-300 hover:bg-red-50',
};

export function buttonCls(variant: keyof typeof BUTTON = 'default', size: 'sm' | 'md' = 'md') {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-lg border font-medium shadow-sm transition-colors disabled:opacity-50',
    size === 'sm' ? 'min-h-[36px] px-3 text-[13px]' : 'min-h-[40px] px-4 text-sm',
    BUTTON[variant],
  );
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON; size?: 'sm' | 'md' }) {
  return <button type="button" {...props} className={cn(buttonCls(variant, size), className)} />;
}

// ==================== PAGE STATES ====================

export function Loading() {
  return <div className="py-16 text-center text-sm text-gray-500">Loading estimator…</div>;
}

export function ManagerOnly({ what }: { what: string }) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
          <Lock className="h-6 w-6 text-gray-500" />
        </div>
        <div>
          <p className="font-semibold text-gray-900">{what} is for managers only</p>
          <p className="mt-1 max-w-md text-sm text-gray-500">
            Internal costs, margins and pricing rules are hidden from sales reps. Ask a manager if you need these figures.
          </p>
        </div>
        <Link href="/estimator" className={buttonCls('default')}>
          Back to the estimator
        </Link>
      </CardBody>
    </Card>
  );
}

export function EstimateNotFound() {
  return (
    <Card>
      <CardBody className="py-12 text-center">
        <p className="font-semibold text-gray-900">Estimate not found</p>
        <p className="mt-1 text-sm text-gray-500">It may have been deleted, or it belongs to another rep.</p>
        <Link href="/estimator/saved" className="mt-3 inline-block text-sm font-medium text-orange-600 hover:underline">
          Saved estimates
        </Link>
      </CardBody>
    </Card>
  );
}

// Print rules for an output page: hide the CRM chrome (sidebar, top bar,
// the estimator's tabs and anything marked .no-print) and print on Letter.
// Rendered only on the page that needs it, so it never leaks elsewhere.
export function PrintStyles({ document }: { document?: boolean }) {
  return (
    <style>{`
@media print {
  @page { size: letter; margin: ${document ? '0' : '0.5in'}; }
  html, body { background: #fff !important; }
  aside, header.sticky, .no-print { display: none !important; }
  main { padding: 0 !important; }
  main > div > :not(.print-root) { display: none !important; }
  main > div > .print-root { margin: 0 !important; }
  div:has(> header.sticky) { margin-left: 0 !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${
    document
      ? `.doc-page { break-after: page; page-break-after: always; width: 8.5in; max-width: none !important; min-height: 11in; margin: 0 !important; box-shadow: none !important; border: 0 !important; border-radius: 0 !important; }
  .doc-page:last-child { break-after: auto; page-break-after: auto; }
  .doc-page > div { -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .avoid-break { break-inside: avoid; page-break-inside: avoid; }`
      : `.print-root section, .print-root .rounded-xl { break-inside: avoid; box-shadow: none !important; }`
  }
}`}</style>
  );
}
