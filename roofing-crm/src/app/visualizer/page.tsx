'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
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
import type { CameraView, RoofSceneHandle } from '@/components/RoofScene';
import { Info, Move3d, Repeat2, Star, X } from 'lucide-react';

// WebGL only exists in the browser, so the scene never renders on the server.
const RoofScene = dynamic(() => import('@/components/RoofScene'), {
  ssr: false,
  loading: () => <SceneSkeleton />,
});

const MAX_SHORTLIST = 3;

const VIEW_LABELS: Record<CameraView, string> = {
  street: 'Street view',
  side: 'Side',
  aerial: 'Aerial',
};

type FilterValue = 'all' | ShingleFamily;

function SceneSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-sky-200 to-slate-100">
      <p className="text-sm text-slate-500">Loading the 3D model…</p>
    </div>
  );
}

export default function VisualizerPage() {
  const sceneRef = useRef<RoofSceneHandle>(null);
  const [selectedId, setSelectedId] = useState(DEFAULT_COLOR_ID);
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [view, setView] = useState<CameraView>('street');
  const [filter, setFilter] = useState<FilterValue>('all');
  const [shortlist, setShortlist] = useState<string[]>([]);

  const selected = useMemo(
    () => ROOF_COLORS.find((c) => c.id === selectedId) ?? ROOF_COLORS[0],
    [selectedId],
  );

  const visibleColors = useMemo(
    () => (filter === 'all' ? ROOF_COLORS : ROOF_COLORS.filter((c) => c.family === filter)),
    [filter],
  );

  const pick = useCallback(
    (id: string) => {
      setSelectedId((current) => {
        if (current === id) return current;
        setPreviousId(current);
        return id;
      });
    },
    [],
  );

  // Push color changes straight at the scene: no React re-render of the canvas.
  useEffect(() => {
    sceneRef.current?.setPalette(selected.palette);
  }, [selected]);

  useEffect(() => {
    sceneRef.current?.setView(view);
  }, [view]);

  const step = useCallback(
    (delta: number) => {
      const list = visibleColors.length ? visibleColors : ROOF_COLORS;
      const index = list.findIndex((c) => c.id === selectedId);
      pick(list[(index + delta + list.length) % list.length].id);
    },
    [visibleColors, selectedId, pick],
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

  const previous = previousId ? ROOF_COLORS.find((c) => c.id === previousId) : null;

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shingle Color Visualizer</h1>
          <p className="text-sm text-slate-500">
            Drag to walk around the house. Tap a color and the roof changes instantly.
          </p>
        </div>
        <span className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">
          Owens Corning TruDefinition&reg; Duration&reg;
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-sm">
            <div className="h-[clamp(360px,58vh,620px)] w-full">
              <RoofScene ref={sceneRef} palette={selected.palette} />
            </div>

            {/* Camera presets */}
            <div className="absolute left-3 top-3 flex gap-1.5 rounded-lg bg-white/85 p-1 backdrop-blur-sm">
              {(Object.keys(VIEW_LABELS) as CameraView[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                    view === key
                      ? 'bg-orange-600 text-white'
                      : 'text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {VIEW_LABELS[key]}
                </button>
              ))}
            </div>

            {previous && previous.id !== selected.id && (
              <button
                type="button"
                onClick={() => pick(previous.id)}
                className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg bg-white/85 px-3 py-1.5 text-xs font-semibold text-slate-700 backdrop-blur-sm transition-colors hover:bg-white"
              >
                <Repeat2 className="h-3.5 w-3.5" />
                Back to {previous.name}
              </button>
            )}

            {/* Current color caption */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/55 to-transparent p-4">
              <div className="flex items-center gap-2.5">
                <span
                  className="h-9 w-9 rounded-md border border-white/50 shadow"
                  style={{ backgroundColor: selected.swatch }}
                />
                <div>
                  <p className="text-base font-semibold leading-tight text-white drop-shadow">
                    {selected.name}
                  </p>
                  <p className="text-[11px] text-white/75">
                    {selected.collection === 'Duration Designer'
                      ? 'Designer Colors Collection'
                      : 'TruDefinition Duration'}
                  </p>
                </div>
              </div>
              <p className="hidden items-center gap-1.5 text-[11px] text-white/70 sm:flex">
                <Move3d className="h-3.5 w-3.5" />
                Drag to orbit · scroll to zoom
              </p>
            </div>
          </div>

          {/* Color rail */}
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

            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {visibleColors.map((color) => (
                <Swatch
                  key={color.id}
                  color={color}
                  selected={color.id === selected.id}
                  shortlisted={shortlist.includes(color.id)}
                  onSelect={() => pick(color.id)}
                  onShortlist={() => toggleShortlist(color.id)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Detail rail */}
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
                    ? 'Duration Designer Colors'
                    : 'TruDefinition Duration'}
                </p>
              </div>
            </div>

            <div className="mt-3 flex gap-1">
              {(['dark', 'base', 'accent', 'light'] as const).map((tone) => (
                <span
                  key={tone}
                  title={`${tone} granule tone`}
                  className="h-4 flex-1 rounded-sm border border-black/10"
                  style={{ backgroundColor: selected.palette[tone] }}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[10px] uppercase tracking-wide text-slate-400">
              Granule tones in the blend
            </p>

            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  How it reads
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
              <Star className={cn('h-4 w-4', shortlist.includes(selected.id) && 'fill-current')} />
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
                Star up to {MAX_SHORTLIST} colors, then flip between them with the camera parked
                where the homeowner wants it.
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
                        onClick={() => pick(id)}
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
              A 3D approximation for choosing a direction, not certified color data. Granule blends
              read differently by pitch, sun angle and region, and availability varies by market.
              Confirm the final pick against a physical sample board.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
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
  shortlisted,
  onSelect,
  onShortlist,
}: {
  color: RoofColor;
  selected: boolean;
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
            : 'border-slate-200 hover:border-slate-400',
        )}
      >
        {/* Chip shows the blend, not one flat color. */}
        <span
          className="block h-12 w-full"
          style={{
            background: `linear-gradient(160deg, ${color.palette.light} 0%, ${color.palette.base} 45%, ${color.palette.accent} 70%, ${color.palette.dark} 100%)`,
          }}
        />
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
          shortlisted ? 'bg-orange-600 text-white' : 'bg-black/25 text-white/90 hover:bg-black/45',
        )}
      >
        <Star className={cn('h-3 w-3', shortlisted && 'fill-current')} />
      </button>
    </div>
  );
}
