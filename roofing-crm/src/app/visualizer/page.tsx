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
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Home,
  Info,
  Move3d,
  Plane,
  Repeat2,
  RotateCcw,
  Star,
  X,
} from 'lucide-react';

// WebGL only exists in the browser, so the scene never renders on the server.
const RoofScene = dynamic(() => import('@/components/RoofScene'), {
  ssr: false,
  loading: () => <SceneSkeleton />,
});

const MAX_SHORTLIST = 3;

const VIEWS: { key: CameraView; label: string; icon: typeof Home }[] = [
  { key: 'street', label: 'Street', icon: Home },
  { key: 'side', label: 'Side', icon: RotateCcw },
  { key: 'aerial', label: 'Aerial', icon: Plane },
];

type FilterValue = 'all' | ShingleFamily;

function SceneSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-sky-200 to-slate-200">
      <div className="flex items-center gap-2 rounded-full bg-white/80 px-4 py-2 text-sm text-slate-600 shadow-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-orange-500" />
        Building the 3D model…
      </div>
    </div>
  );
}

/** Chip background previewing the four-tone granule blend. */
function blendGradient(color: RoofColor): string {
  const { light, base, accent, dark } = color.palette;
  return `linear-gradient(160deg, ${light} 0%, ${base} 45%, ${accent} 70%, ${dark} 100%)`;
}

export default function VisualizerPage() {
  const sceneRef = useRef<RoofSceneHandle>(null);
  const railRef = useRef<HTMLDivElement>(null);
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

  const pick = useCallback((id: string) => {
    setSelectedId((current) => {
      if (current === id) return current;
      setPreviousId(current);
      return id;
    });
  }, []);

  // Push color changes straight at the scene: no React re-render of the canvas.
  useEffect(() => {
    sceneRef.current?.setPalette(selected.palette);
  }, [selected]);

  useEffect(() => {
    sceneRef.current?.setView(view);
  }, [view]);

  // Keep the selected swatch visible in the horizontal rail.
  useEffect(() => {
    railRef.current
      ?.querySelector(`[data-color="${selected.id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [selected.id]);

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
  const isShortlisted = shortlist.includes(selected.id);

  return (
    <AppShell>
      {/* Bottom padding clears the sticky selection bar on screens without the right rail. */}
      <div className="pb-24 xl:pb-0" style={{ touchAction: 'manipulation' }}>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Shingle Color Visualizer
            </h1>
            <p className="text-sm text-slate-500">
              Walk around the house, then tap a color — the roof changes instantly.
            </p>
          </div>
          <span className="hidden rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white sm:inline-block">
            Owens Corning TruDefinition&reg; Duration&reg;
          </span>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          {/* ---- Configurator column ---- */}
          <div className="min-w-0">
            {/* Viewport: the hero. Controls live inside it, configurator-style. */}
            <div className="relative overflow-hidden rounded-2xl bg-slate-900 shadow-lg ring-1 ring-slate-900/10">
              <div className="h-[clamp(380px,60vh,660px)] w-full">
                <RoofScene ref={sceneRef} palette={selected.palette} />
              </div>

              {/* Camera segmented control — 44px touch targets, labeled icons */}
              <div
                role="group"
                aria-label="Camera angle"
                className="absolute left-3 top-3 flex gap-1 rounded-xl bg-slate-900/70 p-1 backdrop-blur-md"
              >
                {VIEWS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={view === key}
                    onClick={() => setView(key)}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 motion-reduce:transition-none',
                      view === key
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-200 hover:bg-white/10',
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>

              {/* One-tap A/B against the previous color */}
              {previous && previous.id !== selected.id && (
                <button
                  type="button"
                  onClick={() => pick(previous.id)}
                  className="absolute right-3 top-3 flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-slate-900/70 px-3 text-xs font-semibold text-white backdrop-blur-md transition-colors duration-200 hover:bg-slate-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 motion-reduce:transition-none"
                >
                  <span
                    className="h-5 w-5 rounded border border-white/40"
                    style={{ background: blendGradient(previous) }}
                    aria-hidden
                  />
                  <Repeat2 className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">Back to {previous.name}</span>
                </button>
              )}

              {/* Caption: current color, always visible over the scene */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-slate-950/75 via-slate-950/30 to-transparent p-4 pt-12">
                <div className="flex items-center gap-3">
                  <span
                    className="h-11 w-11 rounded-lg border border-white/40 shadow-lg"
                    style={{ background: blendGradient(selected) }}
                    aria-hidden
                  />
                  <div>
                    <p className="text-lg font-semibold leading-tight text-white">
                      {selected.name}
                    </p>
                    <p className="text-xs text-white/80">
                      {selected.collection === 'Duration Designer'
                        ? 'Designer Colors Collection'
                        : 'TruDefinition Duration'}
                    </p>
                  </div>
                </div>
                <p className="hidden items-center gap-1.5 text-xs text-white/80 md:flex">
                  <Move3d className="h-4 w-4" aria-hidden />
                  Drag to orbit · pinch or scroll to zoom
                </p>
              </div>
            </div>

            {/* ---- Family tabs ---- */}
            <div
              className="mt-4 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="tablist"
              aria-label="Color family"
            >
              <FamilyTab active={filter === 'all'} onClick={() => setFilter('all')}>
                All colors
                <span className="ml-1.5 rounded-full bg-black/10 px-1.5 text-[11px] tabular-nums">
                  {ROOF_COLORS.length}
                </span>
              </FamilyTab>
              {FAMILY_ORDER.map((family) => (
                <FamilyTab
                  key={family}
                  active={filter === family}
                  onClick={() => setFilter(family)}
                >
                  {FAMILY_LABELS[family]}
                </FamilyTab>
              ))}
            </div>

            {/* ---- Swatch rail: horizontal on touch, wraps to grid on xl ---- */}
            <div
              ref={railRef}
              className="mt-3 flex snap-x gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden xl:grid xl:grid-cols-7 xl:overflow-visible"
            >
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

          {/* ---- Right rail (xl+): detail + shortlist ---- */}
          <div className="hidden space-y-4 xl:block">
            <DetailCard
              color={selected}
              shortlisted={isShortlisted}
              onShortlist={() => toggleShortlist(selected.id)}
            />
            <ShortlistCard
              shortlist={shortlist}
              selectedId={selected.id}
              onPick={pick}
              onRemove={toggleShortlist}
              onClear={() => setShortlist([])}
            />
            <Disclaimer />
          </div>

          {/* ---- Below xl, detail and shortlist stack under the rail ---- */}
          <div className="space-y-4 xl:hidden">
            <DetailCard
              color={selected}
              shortlisted={isShortlisted}
              onShortlist={() => toggleShortlist(selected.id)}
            />
            {shortlist.length > 0 && (
              <ShortlistCard
                shortlist={shortlist}
                selectedId={selected.id}
                onPick={pick}
                onRemove={toggleShortlist}
                onClear={() => setShortlist([])}
              />
            )}
            <Disclaimer />
          </div>
        </div>
      </div>

      {/* ---- Sticky selection bar (configurator CTA pattern), sub-xl only ---- */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-md xl:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <span
            className="h-11 w-11 flex-shrink-0 rounded-lg border border-black/10 shadow-inner"
            style={{ background: blendGradient(selected) }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">{selected.name}</p>
            <p className="truncate text-xs text-slate-500">
              {selected.collection === 'Duration Designer' ? 'Designer Colors' : 'Duration'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Previous color"
            onClick={() => step(-1)}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label="Next color"
            onClick={() => step(1)}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => toggleShortlist(selected.id)}
            aria-pressed={isShortlisted}
            className={cn(
              'flex h-11 cursor-pointer items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none',
              isShortlisted
                ? 'bg-orange-600 text-white hover:bg-orange-700'
                : 'bg-slate-900 text-white hover:bg-slate-800',
            )}
          >
            <Star className={cn('h-4 w-4', isShortlisted && 'fill-current')} aria-hidden />
            <span className="hidden sm:inline">{isShortlisted ? 'Saved' : 'Shortlist'}</span>
          </button>
        </div>
      </div>
    </AppShell>
  );
}

function FamilyTab({
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
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex min-h-11 cursor-pointer items-center whitespace-nowrap rounded-xl px-4 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none',
        active
          ? 'bg-slate-900 text-white shadow-sm'
          : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50',
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
    <div className="relative w-[7.5rem] flex-shrink-0 snap-start xl:w-auto" data-color={color.id}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${color.name}${selected ? ', selected' : ''}`}
        title={color.blend}
        className={cn(
          'w-full cursor-pointer overflow-hidden rounded-xl bg-white text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none',
          selected
            ? 'ring-2 ring-orange-500 shadow-md'
            : 'ring-1 ring-slate-200 hover:ring-slate-400 hover:shadow-sm',
        )}
      >
        <span className="relative block h-14 w-full" style={{ background: blendGradient(color) }}>
          {selected && (
            <span className="absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-orange-600 text-white shadow">
              <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
            </span>
          )}
        </span>
        <span className="block px-2.5 py-2">
          <span className="block truncate text-xs font-semibold text-slate-800">{color.name}</span>
          <span className="block text-[10px] text-slate-400">
            {color.collection === 'Duration Designer' ? 'Designer' : 'Duration'}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onShortlist}
        aria-pressed={shortlisted}
        aria-label={shortlisted ? `Remove ${color.name} from shortlist` : `Shortlist ${color.name}`}
        className={cn(
          'absolute right-1 top-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 motion-reduce:transition-none',
          shortlisted
            ? 'bg-orange-600 text-white'
            : 'bg-slate-950/30 text-white hover:bg-slate-950/50',
        )}
      >
        <Star className={cn('h-3.5 w-3.5', shortlisted && 'fill-current')} aria-hidden />
      </button>
    </div>
  );
}

function DetailCard({
  color,
  shortlisted,
  onShortlist,
}: {
  color: RoofColor;
  shortlisted: boolean;
  onShortlist: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 h-12 w-12 flex-shrink-0 rounded-xl border border-black/10 shadow-inner"
          style={{ background: blendGradient(color) }}
          aria-hidden
        />
        <div className="min-w-0">
          <h2 className="text-lg font-bold leading-tight text-slate-900">{color.name}</h2>
          <p className="text-xs text-slate-500">
            {color.collection === 'Duration Designer'
              ? 'Duration Designer Colors'
              : 'TruDefinition Duration'}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Granule tones in the blend
        </p>
        <div className="flex gap-1" aria-hidden>
          {(['dark', 'base', 'accent', 'light'] as const).map((tone) => (
            <span
              key={tone}
              title={`${tone} tone`}
              className="h-5 flex-1 rounded-md border border-black/10"
              style={{ backgroundColor: color.palette[tone] }}
            />
          ))}
        </div>
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            How it reads
          </dt>
          <dd className="mt-0.5 leading-relaxed text-slate-700">{color.blend}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Sells well with
          </dt>
          <dd className="mt-0.5 leading-relaxed text-slate-700">{color.pairsWith}</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onShortlist}
        aria-pressed={shortlisted}
        className={cn(
          'mt-5 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none',
          shortlisted
            ? 'bg-orange-600 text-white hover:bg-orange-700'
            : 'bg-slate-900 text-white hover:bg-slate-800',
        )}
      >
        <Star className={cn('h-4 w-4', shortlisted && 'fill-current')} aria-hidden />
        {shortlisted ? 'On the shortlist' : 'Add to shortlist'}
      </button>
    </div>
  );
}

function ShortlistCard({
  shortlist,
  selectedId,
  onPick,
  onRemove,
  onClear,
}: {
  shortlist: string[];
  selectedId: string;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Homeowner shortlist
          <span className="ml-1.5 font-normal text-slate-400">
            {shortlist.length}/{MAX_SHORTLIST}
          </span>
        </h3>
        {shortlist.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="min-h-11 cursor-pointer px-2 text-xs font-medium text-slate-400 transition-colors duration-150 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none"
          >
            Clear
          </button>
        )}
      </div>

      {shortlist.length === 0 ? (
        <p className="text-xs leading-relaxed text-slate-500">
          Star up to {MAX_SHORTLIST} colors, then flip between them with the camera parked where
          the homeowner wants it.
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
                  onClick={() => onPick(id)}
                  className={cn(
                    'flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none',
                    id === selectedId
                      ? 'border-orange-500 bg-orange-50 font-medium text-slate-900'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span
                    className="h-6 w-6 flex-shrink-0 rounded-md border border-black/10"
                    style={{ background: blendGradient(color) }}
                    aria-hidden
                  />
                  <span className="truncate">{color.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  aria-label={`Remove ${color.name} from shortlist`}
                  className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 motion-reduce:transition-none"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Disclaimer() {
  return (
    <div className="flex gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
      <p>
        A 3D approximation for choosing a direction, not certified color data. Granule blends read
        differently by pitch, sun angle and region, and availability varies by market. Confirm the
        final pick against a physical sample board.
      </p>
    </div>
  );
}
