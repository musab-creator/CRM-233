'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';
import {
  ROOF_COLORS,
  FAMILY_LABELS,
  FAMILY_ORDER,
  DEFAULT_COLOR_ID,
  type RoofColor,
  type ShingleFamily,
} from '@/lib/roof-colors';
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Info,
  Star,
  X,
  ZoomIn,
} from 'lucide-react';

const MAX_SHORTLIST = 3;

/** Where the roof sits in the frame, used as the zoom origin. */
const ROOF_ORIGIN = '50% 34%';

type FilterValue = 'all' | ShingleFamily;

export default function VisualizerPage() {
  const [selectedId, setSelectedId] = useState(DEFAULT_COLOR_ID);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const [zoomed, setZoomed] = useState(false);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [shortlist, setShortlist] = useState<string[]>([]);

  const selected = useMemo(
    () => ROOF_COLORS.find((c) => c.id === selectedId) ?? ROOF_COLORS[0],
    [selectedId],
  );
  const compare = useMemo(
    () => (compareId ? ROOF_COLORS.find((c) => c.id === compareId) ?? null : null),
    [compareId],
  );

  const visibleColors = useMemo(
    () => (filter === 'all' ? ROOF_COLORS : ROOF_COLORS.filter((c) => c.family === filter)),
    [filter],
  );

  const step = useCallback(
    (delta: number) => {
      const list = visibleColors.length ? visibleColors : ROOF_COLORS;
      const current = list.findIndex((c) => c.id === selectedId);
      const next = list[(current + delta + list.length) % list.length];
      setSelectedId(next.id);
    },
    [visibleColors, selectedId],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  function toggleShortlist(id: string) {
    setShortlist((list) => {
      if (list.includes(id)) return list.filter((x) => x !== id);
      if (list.length >= MAX_SHORTLIST) return [...list.slice(1), id];
      return [...list, id];
    });
  }

  function startCompare() {
    if (compareId) {
      setCompareId(null);
      return;
    }
    // Default the comparison to the other color the rep is most likely to weigh:
    // the first shortlisted color that is not the current one, else the next color.
    const fromShortlist = shortlist.find((id) => id !== selected.id);
    if (fromShortlist) {
      setCompareId(fromShortlist);
      return;
    }
    const index = ROOF_COLORS.findIndex((c) => c.id === selected.id);
    setCompareId(ROOF_COLORS[(index + 1) % ROOF_COLORS.length].id);
  }

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shingle Color Visualizer</h1>
          <p className="text-sm text-slate-500">
            Show the homeowner the same house in every color before they pick.
          </p>
        </div>
        <span className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">
          Owens Corning TruDefinition&reg; Duration&reg;
        </span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <RoofView
            selected={selected}
            compare={compare}
            split={split}
            zoomed={zoomed}
            onSplitChange={setSplit}
            onStep={step}
          >
            <button
              type="button"
              onClick={startCompare}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors',
                compare ? 'bg-orange-600 text-white' : 'bg-white/90 text-slate-700 hover:bg-white',
              )}
            >
              <Columns2 className="h-3.5 w-3.5" />
              {compare ? 'Exit compare' : 'Compare'}
            </button>
            <button
              type="button"
              onClick={() => setZoomed((z) => !z)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors',
                zoomed ? 'bg-orange-600 text-white' : 'bg-white/90 text-slate-700 hover:bg-white',
              )}
            >
              <ZoomIn className="h-3.5 w-3.5" />
              {zoomed ? 'Full house' : 'Zoom roof'}
            </button>
          </RoofView>

          {compare && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
              <span className="text-xs font-semibold text-slate-500">Comparing against</span>
              <select
                value={compare.id}
                onChange={(e) => setCompareId(e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
              >
                {ROOF_COLORS.filter((c) => c.id !== selected.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-400">Drag the divider on the photo.</span>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex flex-wrap gap-1.5">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
                All {ROOF_COLORS.length}
              </FilterChip>
              {FAMILY_ORDER.map((family) => (
                <FilterChip
                  key={family}
                  active={filter === family}
                  onClick={() => setFilter(family)}
                >
                  {FAMILY_LABELS[family]}
                </FilterChip>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {visibleColors.map((color) => (
                <Swatch
                  key={color.id}
                  color={color}
                  selected={color.id === selected.id}
                  compared={color.id === compare?.id}
                  shortlisted={shortlist.includes(color.id)}
                  onSelect={() => setSelectedId(color.id)}
                  onShortlist={() => toggleShortlist(color.id)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 h-11 w-11 flex-shrink-0 rounded-lg border border-black/10 shadow-inner"
                style={{ backgroundColor: selected.swatch }}
              />
              <div className="min-w-0">
                <h2 className="text-lg font-bold leading-tight text-slate-900">{selected.name}</h2>
                <p className="text-xs text-slate-500">
                  {selected.collection === 'Duration Designer'
                    ? 'Duration Designer Colors Collection'
                    : 'TruDefinition Duration'}
                </p>
              </div>
            </div>

            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Granule blend
                </dt>
                <dd className="text-slate-700">{selected.blend}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Sells well with
                </dt>
                <dd className="text-slate-700">{selected.pairsWith}</dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={() => toggleShortlist(selected.id)}
              className={cn(
                'mt-4 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                shortlist.includes(selected.id)
                  ? 'bg-orange-600 text-white hover:bg-orange-700'
                  : 'border border-slate-300 text-slate-700 hover:bg-slate-50',
              )}
            >
              <Star
                className={cn('h-4 w-4', shortlist.includes(selected.id) && 'fill-current')}
              />
              {shortlist.includes(selected.id) ? 'On the shortlist' : 'Add to shortlist'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Homeowner shortlist
                <span className="ml-1 font-normal text-slate-400">
                  {shortlist.length}/{MAX_SHORTLIST}
                </span>
              </h3>
              {shortlist.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShortlist([])}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  Clear
                </button>
              )}
            </div>

            {shortlist.length === 0 ? (
              <p className="text-xs text-slate-500">
                Star up to {MAX_SHORTLIST} colors as you go, then flip between them to close on one.
              </p>
            ) : (
              <ul className="space-y-2">
                {shortlist.map((id) => {
                  const color = ROOF_COLORS.find((c) => c.id === id);
                  if (!color) return null;
                  return (
                    <li key={id} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedId(id)}
                        className={cn(
                          'flex flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition-colors',
                          id === selected.id
                            ? 'border-orange-500 bg-orange-50 text-slate-900'
                            : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                        )}
                      >
                        <span
                          className="h-5 w-5 flex-shrink-0 rounded border border-black/10"
                          style={{ backgroundColor: color.swatch }}
                        />
                        <span className="truncate">{color.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleShortlist(id)}
                        aria-label={`Remove ${color.name} from shortlist`}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              These are photoreal renders for choosing a direction, not certified color samples.
              Granule blends read differently by pitch, sun angle and region, and availability
              varies by market. Confirm the final pick against a physical sample board.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function RoofView({
  selected,
  compare,
  split,
  zoomed,
  onSplitChange,
  onStep,
  children,
}: {
  selected: RoofColor;
  compare: RoofColor | null;
  split: number;
  zoomed: boolean;
  onSplitChange: (value: number) => void;
  onStep: (delta: number) => void;
  children: React.ReactNode;
}) {
  // Keep the previously loaded render underneath so switching colors cross-fades
  // instead of flashing an empty frame.
  const [painted, setPainted] = useState(selected);
  // Id of the render that has finished decoding, so the fade only starts once
  // there is something to fade to.
  const [readyId, setReadyId] = useState<string | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const isIncoming = selected.id !== painted.id;
  const incomingReady = readyId === selected.id;
  const transform = zoomed ? 'scale(2.15)' : 'scale(1)';

  return (
    <div className="group relative aspect-3/2 w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
      <div
        className="absolute inset-0 transition-transform duration-500 ease-out"
        style={{ transform, transformOrigin: ROOF_ORIGIN }}
      >
        <Image
          key={painted.id}
          src={painted.image}
          alt={`House with ${painted.name} shingles`}
          fill
          priority
          sizes="(max-width: 1280px) 100vw, 60vw"
          className="object-cover"
        />

        {isIncoming && (
          <Image
            key={selected.id}
            src={selected.image}
            alt={`House with ${selected.name} shingles`}
            fill
            sizes="(max-width: 1280px) 100vw, 60vw"
            className={cn(
              'object-cover transition-opacity duration-300',
              incomingReady ? 'opacity-100' : 'opacity-0',
            )}
            onLoad={() => {
              setReadyId(selected.id);
              if (settleTimer.current) clearTimeout(settleTimer.current);
              settleTimer.current = setTimeout(() => setPainted(selected), 320);
            }}
          />
        )}

        {compare && (
          <div
            className="absolute inset-0"
            style={{ clipPath: `inset(0 0 0 ${split}%)` }}
          >
            <Image
              src={compare.image}
              alt={`House with ${compare.name} shingles`}
              fill
              sizes="(max-width: 1280px) 100vw, 60vw"
              className="object-cover"
            />
          </div>
        )}
      </div>

      {compare && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white shadow-[0_0_6px_rgba(0,0,0,0.4)]"
            style={{ left: `${split}%` }}
          />
          <div
            className="pointer-events-none absolute z-20 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-md"
            style={{ left: `${split}%`, top: '50%' }}
          >
            <Columns2 className="h-4 w-4 text-slate-600" />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            aria-label="Compare divider position"
            onChange={(e) => onSplitChange(Number(e.target.value))}
            className="absolute inset-0 z-10 h-full w-full cursor-ew-resize opacity-0"
          />
        </>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-3 bg-gradient-to-t from-black/60 to-transparent p-4">
        <ViewerLabel color={compare ?? selected} caption={compare ? 'Left of divider' : undefined} />
        {compare && <ViewerLabel color={selected} caption="Right of divider" align="right" />}
      </div>

      <div className="absolute right-3 top-3 z-30 flex gap-2">{children}</div>

      <button
        type="button"
        aria-label="Previous color"
        onClick={() => onStep(-1)}
        className="absolute left-3 top-1/2 z-30 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-slate-700 shadow-sm transition-opacity hover:bg-white group-hover:flex"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label="Next color"
        onClick={() => onStep(1)}
        className="absolute right-3 top-1/2 z-30 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-slate-700 shadow-sm transition-opacity hover:bg-white group-hover:flex"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
}

function ViewerLabel({
  color,
  caption,
  align = 'left',
}: {
  color: RoofColor;
  caption?: string;
  align?: 'left' | 'right';
}) {
  return (
    <div className={cn('flex items-center gap-2', align === 'right' && 'flex-row-reverse')}>
      <span
        className="h-7 w-7 flex-shrink-0 rounded border border-white/40"
        style={{ backgroundColor: color.swatch }}
      />
      <div className={cn(align === 'right' && 'text-right')}>
        <p className="text-sm font-semibold leading-tight text-white drop-shadow">{color.name}</p>
        {caption && <p className="text-[10px] uppercase tracking-wide text-white/70">{caption}</p>}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
        active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
      )}
    >
      {children}
    </button>
  );
}

function Swatch({
  color,
  selected,
  compared,
  shortlisted,
  onSelect,
  onShortlist,
}: {
  color: RoofColor;
  selected: boolean;
  compared: boolean;
  shortlisted: boolean;
  onSelect: () => void;
  onShortlist: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onSelect}
        title={color.blend}
        className={cn(
          'w-full overflow-hidden rounded-lg border text-left transition-all',
          selected
            ? 'border-orange-500 ring-2 ring-orange-500/30'
            : compared
              ? 'border-slate-900'
              : 'border-slate-200 hover:border-slate-400',
        )}
      >
        <span className="block h-14 w-full" style={{ backgroundColor: color.swatch }} />
        <span className="block px-2 py-1.5">
          <span className="block truncate text-xs font-medium text-slate-800">{color.name}</span>
          {color.collection === 'Duration Designer' && (
            <span className="block text-[10px] text-slate-400">Designer</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onShortlist}
        aria-label={shortlisted ? `Remove ${color.name} from shortlist` : `Shortlist ${color.name}`}
        className={cn(
          'absolute right-1 top-1 rounded-full p-1 transition-colors',
          shortlisted
            ? 'bg-orange-600 text-white'
            : 'bg-black/25 text-white/90 hover:bg-black/45',
        )}
      >
        <Star className={cn('h-3 w-3', shortlisted && 'fill-current')} />
      </button>
    </div>
  );
}
