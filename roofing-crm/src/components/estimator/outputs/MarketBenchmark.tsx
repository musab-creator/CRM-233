'use client';

import { useRouter } from 'next/navigation';
import {
  benchmarkBarPosition, competitiveBidSample, formatDate, formatMoney, formatMoneyWhole, GUTTER_MARKET, MARKET_BAR_RANGES,
  MARKET_RESEARCHED_ON, ROOF_MARKET, type PriceBook,
} from '@/lib/estimator';
import { useEstimatorStore, useEstimatorUser } from '@/store/estimator';
import { Button, Card, CardBody, CardHeader, DataTable, Notice, Pill, Tip } from './ui';

// Where one of our prices sits on the market's below / average / above bar.
function BenchmarkBar({
  avgLo,
  avgHi,
  ours,
  unit,
  min,
  max,
}: {
  avgLo: number;
  avgHi: number;
  ours: number;
  unit: 'sq' | 'lf';
  min: number;
  max: number;
}) {
  const pos = (v: number) => benchmarkBarPosition(v, min, max);
  const at = pos(ours);
  // Keep the "ours" tag inside the bar near the ends.
  const shift = at < 12 ? '0%' : at > 88 ? '-100%' : '-50%';
  return (
    <div className="relative mb-2 mt-7">
      <span
        className="absolute -top-6 whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white"
        style={{ left: at + '%', transform: `translateX(${shift})` }}
      >
        ours {unit === 'sq' ? formatMoneyWhole(ours) : formatMoney(ours)}
      </span>
      <div className="flex h-7 overflow-hidden rounded-md border border-gray-200 text-[10.5px] font-semibold">
        <div className="grid place-items-center overflow-hidden whitespace-nowrap bg-gray-100 text-gray-500" style={{ width: pos(avgLo) + '%' }}>
          below avg
        </div>
        <div
          className="grid place-items-center overflow-hidden whitespace-nowrap bg-green-50 text-green-700"
          style={{ width: pos(avgHi) - pos(avgLo) + '%' }}
        >
          average
        </div>
        <div className="grid flex-1 place-items-center overflow-hidden whitespace-nowrap bg-amber-50 text-amber-700">above avg</div>
      </div>
      <span className="absolute top-0 block h-7 w-[2px] bg-slate-800" style={{ left: at + '%' }} />
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">{children}</div>;
}

const NOTE = 'text-xs text-gray-500';

export default function MarketBenchmark({ pricing: e }: { pricing: PriceBook }) {
  const router = useRouter();
  const user = useEstimatorUser();
  const tv = ROOF_MARKET;
  const tb = GUTTER_MARKET;
  const sqBar = MARKET_BAR_RANGES.roofPerSquare;

  const loadSample = () => {
    const { seq, saveEstimate } = useEstimatorStore.getState();
    const saved = saveEstimate(competitiveBidSample(e, seq), user);
    router.push(`/estimator/${saved.id}`);
  };

  type GutterRow = { item: string; lo?: number; avg?: number; hi?: number; range?: string; ours: string; note: string };
  const gutterRows: GutterRow[] = [
    { item: '5" seamless (reference)', lo: tb.g5.lo, avg: tb.g5.avg, hi: tb.g5.hi, ours: '—', note: tb.g5.note },
    {
      item: 'Gutter guards (independent)',
      lo: tb.guards.lo,
      avg: tb.guards.avg,
      hi: tb.guards.hi,
      ours: formatMoney(e.gutter.guardLF),
      note: tb.guards.note,
    },
    { item: 'Downspouts 3x4', range: tb.ds.market, ours: formatMoney(e.gutter.downspouts['3x4']) + '/LF', note: tb.ds.note },
    {
      item: 'Removal & disposal',
      lo: tb.removal.lo,
      avg: tb.removal.avg,
      hi: tb.removal.hi,
      ours: formatMoney(e.gutter.removalLF),
      note: tb.removal.note,
    },
    {
      item: 'Labor-only install',
      lo: tb.laborOnly.lo,
      avg: tb.laborOnly.avg,
      hi: tb.laborOnly.hi,
      ours: formatMoney(e.gutter.laborOnly.def),
      note: tb.laborOnly.note,
    },
    {
      item: 'Fascia repair',
      lo: tb.fascia.lo,
      avg: tb.fascia.avg,
      hi: tb.fascia.hi,
      ours: formatMoney(e.gutter.fasciaLF),
      note: tb.fascia.note,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Notice level="ok" title={`Researched ${formatDate(MARKET_RESEARCHED_ON)}`}>
        from eleven Jacksonville / Florida 2026 cost guides, HomeAdvisor member-reported jobs, national cost databases,
        contractor-facing pricing guides, and one published Jacksonville gutter rate card. Dollar figures are installed retail to
        the homeowner.
      </Notice>

      <Card>
        <CardHeader title="Where our roofing prices sit" sub="architectural shingle, $ per square" />
        <CardBody className="flex flex-col gap-6">
          {e.mfrs.IKO ? (
            <div>
              <Eyebrow>
                IKO — our range {formatMoneyWhole(e.mfrs.IKO.min)}–{formatMoneyWhole(e.mfrs.IKO.max)}/sq (standard{' '}
                {formatMoneyWhole(e.mfrs.IKO.standard)})
              </Eyebrow>
              <BenchmarkBar avgLo={tv.avgLo} avgHi={tv.avgHi} ours={e.mfrs.IKO.standard} unit="sq" min={sqBar.min} max={sqBar.max} />
              <div className="text-[13px] text-gray-500">
                {formatMoneyWhole(e.mfrs.IKO.standard)}/sq = {formatMoney(e.mfrs.IKO.standard / 100)}/sq ft. That is{' '}
                <b className="text-gray-800">
                  {formatMoneyWhole(tv.avg - e.mfrs.IKO.standard)} under the ${tv.avg} Jacksonville average
                </b>{' '}
                — priced to win the cash market while staying above the ${tv.low} red-flag floor.
              </div>
            </div>
          ) : null}
          {e.mfrs.OC ? (
            <div>
              <Eyebrow>
                Owens Corning — our range {formatMoneyWhole(e.mfrs.OC.min)}–{formatMoneyWhole(e.mfrs.OC.max)}/sq (standard{' '}
                {formatMoneyWhole(e.mfrs.OC.standard)})
              </Eyebrow>
              <BenchmarkBar avgLo={tv.avgLo} avgHi={tv.avgHi} ours={e.mfrs.OC.standard} unit="sq" min={sqBar.min} max={sqBar.max} />
              <div className="text-[13px] text-gray-500">
                {formatMoneyWhole(e.mfrs.OC.standard)}/sq = {formatMoney(e.mfrs.OC.standard / 100)}/sq ft — sits at the bottom edge
                of the average band while the OC brand itself books $525–825 in this market. Competitive for the brand.
              </div>
            </div>
          ) : null}
          <Tip>
            Market bands: <b>below $425/sq</b> red-flag zone · <b>$425–525</b> competitive · <b>$525–700</b> average (center $610) ·{' '}
            <b>$700–850</b> above average · <b>$850+</b> premium-only territory. 1 square = 100 sq ft, so divide by 100 for $/sq ft.
          </Tip>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Roofing market by shingle grade" sub="$ per square installed, Jacksonville 2026" />
        <DataTable
          rows={tv.grades}
          rowKey={(g) => g.grade}
          columns={[
            { key: 'g', header: 'Grade', primary: true, cell: (g) => <b>{g.grade}</b> },
            { key: 'lo', header: 'Low', right: true, mono: true, cell: (g) => formatMoneyWhole(g.lo) },
            { key: 'avg', header: 'Average', right: true, mono: true, cell: (g) => <span className="font-semibold">{formatMoneyWhole(g.avg)}</span> },
            { key: 'hi', header: 'High', right: true, mono: true, cell: (g) => formatMoneyWhole(g.hi) },
            { key: 'note', header: 'Note', className: `${NOTE} max-w-[44ch]`, cell: (g) => <span className={NOTE}>{g.note}</span> },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Brand ranges" sub="installed, $ per square" />
        <DataTable
          rows={tv.brands}
          rowKey={(b) => b.brand}
          columns={[
            { key: 'b', header: 'Brand', primary: true, cell: (b) => <b>{b.brand}</b> },
            { key: 'lo', header: 'Low', right: true, mono: true, cell: (b) => formatMoneyWhole(b.lo) },
            { key: 'hi', header: 'High', right: true, mono: true, cell: (b) => formatMoneyWhole(b.hi) },
            { key: 'note', header: 'Note', className: 'max-w-[50ch]', cell: (b) => <span className={NOTE}>{b.note}</span> },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Add-ons — market vs ours" />
        <DataTable
          rows={tv.adders}
          rowKey={(a) => a.adder}
          columns={[
            { key: 'a', header: 'Add-on', primary: true, cell: (a) => <b>{a.adder}</b> },
            { key: 'm', header: 'Market rate', mono: true, cell: (a) => a.market },
            { key: 'ours', header: 'Ours', mono: true, cell: (a) => a.ours },
            {
              key: 'v',
              header: '',
              cell: (a) =>
                a.verdict === 'avg' ? (
                  <Pill tone="ok">average</Pill>
                ) : a.verdict === 'below' ? (
                  <Pill tone="navy">below market</Pill>
                ) : (
                  <Pill tone="warn">above market</Pill>
                ),
            },
            { key: 'note', header: 'Note', className: 'max-w-[42ch]', cell: (a) => <span className={NOTE}>{a.note}</span> },
          ]}
        />
        <CardBody>
          <Tip>
            <b>The pattern:</b> our base $/square is competitive but our surcharges are far under market. Competitors price steep and
            two-story roofs 2–5× harder than we do. That means we are most underpriced exactly where jobs are hardest — raising the
            pitch and story adders funds the aggressive base price.
          </Tip>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Where our gutter prices sit" sub="$ per linear foot installed" />
        <CardBody className="flex flex-col gap-6">
          <div>
            <Eyebrow>6-inch — ours {formatMoney(e.gutter.g6.sell)}/LF</Eyebrow>
            <BenchmarkBar
              avgLo={tb.g6.lo}
              avgHi={tb.g6.hi}
              ours={e.gutter.g6.sell}
              unit="lf"
              min={MARKET_BAR_RANGES.g6PerLF.min}
              max={MARKET_BAR_RANGES.g6PerLF.max}
            />
            <div className="text-[13px] text-gray-500">
              Fair band $8–14, average $10.50. At {formatMoney(e.gutter.g6.sell)} we are{' '}
              <b className="text-gray-800">$1.50 above average</b>{' '}and inside the band — solid, mildly premium. Jacksonville{"'"}s
              published floor is $9/LF; below $7.50 is the red-flag zone.
            </div>
          </div>
          <div>
            <Eyebrow>7-inch — ours {formatMoney(e.gutter.g7.sell)}/LF</Eyebrow>
            <BenchmarkBar
              avgLo={tb.g7.lo}
              avgHi={tb.g7.hi}
              ours={e.gutter.g7.sell}
              unit="lf"
              min={MARKET_BAR_RANGES.g7PerLF.min}
              max={MARKET_BAR_RANGES.g7PerLF.max}
            />
            <div className="text-[13px] text-gray-500">
              Derived band $12–19, average $15 — nobody publishes 7-inch pricing. Ours sits{' '}
              <b className="text-gray-800">just above the derived high</b>; defensible, but check it against the AMF quote when it
              lands.
            </div>
          </div>
        </CardBody>
        <div className="border-t border-gray-100">
          <DataTable
            rows={gutterRows}
            rowKey={(r) => r.item}
            columns={[
              { key: 'item', header: 'Item', primary: true, cell: (r) => <span className="font-medium md:font-normal">{r.item}</span> },
              {
                key: 'lo',
                header: 'Low',
                right: true,
                mono: true,
                colSpan: (r) => (r.range ? 3 : undefined),
                cell: (r) => (r.range ? r.range : formatMoney(r.lo)),
              },
              { key: 'avg', header: 'Average', right: true, mono: true, skip: (r) => !!r.range, cell: (r) => formatMoney(r.avg) },
              { key: 'hi', header: 'High', right: true, mono: true, skip: (r) => !!r.range, cell: (r) => formatMoney(r.hi) },
              { key: 'ours', header: 'Ours', right: true, mono: true, cell: (r) => r.ours },
              { key: 'note', header: 'Note', className: 'max-w-[40ch]', cell: (r) => <span className={NOTE}>{r.note}</span> },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Whole-house gutter jobs — market totals" sub={'6" system incl. downspouts & removal'} />
        <DataTable
          rows={tb.jobs}
          rowKey={(j) => j.job}
          columns={[
            { key: 'job', header: 'Job size', primary: true, cell: (j) => <span className="font-medium md:font-normal">{j.job}</span> },
            { key: 'low', header: 'Lean bid', right: true, mono: true, cell: (j) => j.low },
            { key: 'avg', header: 'Average', right: true, mono: true, cell: (j) => <span className="font-semibold">{j.avg}</span> },
            { key: 'high', header: 'Premium', right: true, mono: true, cell: (j) => j.high },
          ]}
        />
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Roofing market notes" />
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-gray-800">
              {tv.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Gutter market notes" />
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-gray-800">
              {tb.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="The competitive sample estimate" right={<Pill tone="navy">worked example</Pill>} />
        <CardBody className="flex flex-col gap-3">
          <div className="max-w-[78ch] text-sm leading-7 text-gray-800">
            A 2,000 sq ft single-story 6/12 roof (20 measured squares, 15% waste = 23 billable) at{' '}
            <b>IKO Competitive {formatMoneyWhole(e.mfrs.IKO?.competitive)}/sq</b>, plus 150 LF of 6-inch gutter at the{' '}
            {formatMoney(e.gutter.g6.sell)} minimum with five 3x4 downspouts and removal. That prices the roof at{' '}
            <b>{formatMoney((e.mfrs.IKO?.competitive ?? 0) / 100)}/sq ft</b> — under the $6.10 market average, just above the $5.25
            competitive-band ceiling, and safely clear of the $4.25 red-flag floor. It undercuts the average Jacksonville quote by
            roughly <b>${tv.avg - (e.mfrs.IKO?.competitive ?? 0)}/square</b> — and the calculator will show you the honest price of
            that aggression: at current costs it lands near 28% gross margin, just under the 30% floor, so the margin warning fires.
            That is the real trade of a lowest-defensible bid.
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={loadSample}>
              Load it into the calculator
            </Button>
            <span className="text-xs text-gray-500">Saves it as a new draft estimate you can edit or delete.</span>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
