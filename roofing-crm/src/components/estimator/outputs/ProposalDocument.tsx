'use client';

import {
  formatDate, formatMoney, formatPct, PROPOSAL_NEXT_STEPS, PROPOSAL_PROCESS_STEPS, proposalFigures, round2, toNumber,
  whyChooseUs, type Estimate, type EstimateTotals, type PriceBook,
} from '@/lib/estimator';
import { cn } from '@/lib/utils';

// The printable customer proposal (the original's "Customer proposal"
// document): five Letter pages — cover, note, measurements, investment,
// scope of work, warranty/terms/acceptance. Nothing here shows cost,
// profit, markup, commission or internal warnings.
//
// Laid out for the page from `md` up (a Letter sheet is 816 CSS px wide, so
// print always gets the md layout); below md it stacks for phones.

const NAVY = '#244B67';
const GOLD = '#C9A76A';
const PALE = '#B5C4DB';
const WHITE = '#FFFFFF';
const INK = '#3D4E5A';
const MUTED = '#6C8090';
const LINE = '#D7E0E7';
const TINT = '#F4F7F9';

const PREPARED_BY = 'Musab Alraddad';
const PREPARED_BY_TITLE = 'General Manager';

function DocPage({ children, pad = true }: { children: React.ReactNode; pad?: boolean }) {
  return (
    <div
      className="doc-page avoid-break mx-auto mb-5 w-full max-w-[8.5in] overflow-hidden rounded-md"
      style={{ background: WHITE, color: '#101820', boxShadow: '0 2px 10px rgba(16,24,32,.18)', border: `1px solid ${LINE}` }}
    >
      <div className={pad ? 'p-5 sm:p-8 md:p-[0.6in]' : ''}>{children}</div>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: GOLD, fontSize: 10.5, fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

function SectionRule({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 mt-6 flex items-center gap-3">
      <h3 style={{ color: NAVY, fontSize: 15, fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase' }}>
        {children}
      </h3>
      <span className="h-px flex-1" style={{ background: LINE }} />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ color: MUTED, fontSize: 9.5, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 4 }}
    >
      {children}
    </div>
  );
}

function Logo({ size = 44 }: { size?: number }) {
  return (
    <div
      className="grid flex-shrink-0 place-items-center"
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: NAVY,
        color: GOLD,
        fontWeight: 700,
        fontSize: 0.36 * size,
        letterSpacing: '.04em',
      }}
    >
      DC
    </div>
  );
}

function H2({ children, size = 23, mt = 6 }: { children: React.ReactNode; size?: number; mt?: number }) {
  return <h2 style={{ fontSize: size, fontWeight: 700, marginTop: mt, color: NAVY, lineHeight: 1.2 }}>{children}</h2>;
}

const th = 'px-3 py-2 text-left border-b';
const thStyle: React.CSSProperties = { borderColor: NAVY, color: NAVY, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' };
const td = 'px-3 py-2 border-b';
const tdStyle: React.CSSProperties = { borderColor: LINE };

function StatGrid({ items, cols, valueSize }: { items: [string, React.ReactNode][]; cols: string; valueSize: number }) {
  return (
    <div className={cn('grid gap-px', cols)} style={{ background: LINE }}>
      {items.map(([label, value]) => (
        <div key={label} className="px-3.5 py-3" style={{ background: TINT }}>
          <Label>{label}</Label>
          <div className="tabular-nums" style={{ fontSize: valueSize, fontWeight: 700, color: NAVY }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function Check({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span style={{ color: GOLD, fontWeight: 700 }}>✓</span>
      <span>{children}</span>
    </>
  );
}

export default function ProposalDocument({
  est,
  pricing,
  totals,
}: {
  est: Estimate;
  pricing: PriceBook;
  totals: EstimateTotals;
}) {
  const fig = proposalFigures(est, pricing, totals);
  const a = est.customer;
  const company = pricing.company;
  const { proposal: s, insurance: c, payments: pay } = fig;
  const ins = s.ins;
  const E = est.takeoff;
  const R = totals.roof;
  const G = totals.gutter;
  const expires = formatDate(fig.expiresOn);
  const blank = (v: unknown) => (toNumber(v) ? formatMoney(v) : '$ ______');

  return (
    <div style={{ color: '#101820' }}>
      {/* ============ COVER ============ */}
      <DocPage pad={false}>
        <div
          className="relative"
          style={{
            height: '4.6in',
            background: fig.coverPhoto
              ? `#0b1a24 center/cover no-repeat url(${JSON.stringify(fig.coverPhoto)})`
              : `linear-gradient(155deg, #183446 0%, ${NAVY} 60%, #2f6183 100%)`,
          }}
        >
          {fig.coverPhoto ? (
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(11,26,36,.72) 0%, rgba(11,26,36,.42) 45%, rgba(11,26,36,.86) 100%)',
              }}
            />
          ) : null}
          <div className="relative flex h-full flex-col justify-between p-6 md:p-[0.6in]">
            <div className="flex items-center gap-3">
              <Logo size={48} />
              <div style={{ color: WHITE }}>
                <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '.01em' }}>{company.name}</div>
                <div style={{ fontSize: 11.5, color: PALE, letterSpacing: '.06em', textTransform: 'uppercase' }}>
                  Roofing {'&'} Gutter
                </div>
              </div>
            </div>
            <div>
              <Eyebrow>{c ? 'Insurance restoration agreement' : 'Proposal for roof replacement'}</Eyebrow>
              <h1
                className="break-words"
                style={{ color: WHITE, fontSize: 38, lineHeight: 1.06, fontWeight: 700, marginTop: 10, maxWidth: '11ch' }}
              >
                {a.address || 'Your property'}
              </h1>
              <div style={{ color: PALE, fontSize: 14, marginTop: 6 }}>{[a.city, a.state, a.zip].filter(Boolean).join(', ')}</div>
              <div className="mt-4 h-[3px] w-[86px]" style={{ background: GOLD }} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px border-b md:grid-cols-4" style={{ borderColor: LINE, background: LINE }}>
          {(
            [
              ['Prepared for', a.name || '—'],
              ['Prepared by', `${PREPARED_BY} · ${PREPARED_BY_TITLE}`],
              ['Date', formatDate(est.date)],
              [c ? 'Claim no.' : 'Proposal no.', c ? ins.claim || '—' : est.number],
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="px-4 py-4" style={{ background: WHITE }}>
              <Label>{label}</Label>
              <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>{value}</div>
            </div>
          ))}
        </div>
        <div
          className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 md:px-[0.6in]"
          style={{ background: NAVY, color: WHITE }}
        >
          <span style={{ fontSize: 11.5, letterSpacing: '.04em' }}>
            {company.legal} · {company.license}
          </span>
          <span className="break-all sm:break-normal" style={{ fontSize: 11.5, color: PALE }}>
            {company.phone} · {company.email} · {company.web}
          </span>
        </div>
      </DocPage>

      {/* ============ A NOTE BEFORE THE NUMBERS ============ */}
      <DocPage>
        <Eyebrow>A note before the numbers</Eyebrow>
        <H2 size={25} mt={8}>
          Thank you for the opportunity.
        </H2>
        <div className="mt-4 flex flex-col gap-3" style={{ fontSize: 13.5, lineHeight: 1.75, color: INK, maxWidth: '66ch' }}>
          <p>
            {a.name ? a.name.split(' ')[0] + ',' : 'Hello,'} thank you for letting us look at{' '}
            {a.address ? 'the roof at ' + a.address : 'your roof'}. What follows is everything we intend to do, what it costs, and
            what is deliberately not included — written plainly so nothing has to be guessed at later.
          </p>
          <p>
            We measure before we price.{' '}
            {E
              ? `The quantities on the next page come straight off a ${E.vendor} measurement report, so the squares, ridge and valley footage in this proposal are measured, not estimated.`
              : 'The quantities on the next page were taken by hand at the property and will be confirmed against a measurement report before material is ordered.'}{' '}
            Every line you see is priced from that takeoff.
          </p>
          <p>
            The crew that starts your roof is the crew that finishes it. We pull the permit, we file the notice of commencement, we
            protect the landscaping, and we sweep the property with a magnet before we leave. If we find rotten decking under the old
            shingles, we show you the photograph and bill it at the per-sheet rate printed in this proposal — never a surprise number
            after the fact.
          </p>
        </div>
        <div className="mt-7">
          <StatGrid
            cols="grid-cols-2 md:grid-cols-4"
            valueSize={17}
            items={[
              ['Roof area', R.billable ? R.billable.toFixed(2) + ' sq' : '—'],
              ['Gutter', G.lf ? G.lf.toFixed(0) + ' LF' : '—'],
              ['Workmanship warranty', fig.warrantyYears + ' years'],
              ['Proposal valid', expires],
            ]}
          />
        </div>
        <SectionRule>Why homeowners pick us</SectionRule>
        <ul className="grid grid-cols-1 gap-x-7 gap-y-2.5 md:grid-cols-2" style={{ fontSize: 12.5, lineHeight: 1.6, color: INK }}>
          {whyChooseUs(fig.warrantyYears).map((line) => (
            <li key={line} className="flex gap-2">
              <Check>{line}</Check>
            </li>
          ))}
        </ul>
        <div className="mt-8 flex items-end justify-between gap-6">
          <div style={{ fontSize: 12.5, color: INK }}>
            <div style={{ fontSize: 22, color: NAVY, fontWeight: 600, letterSpacing: '-.01em' }}>{PREPARED_BY}</div>
            <div className="mt-1" style={{ fontSize: 11.5, color: MUTED }}>
              {PREPARED_BY_TITLE} · {company.legal}
            </div>
            <div className="break-all sm:break-normal" style={{ fontSize: 11.5, color: MUTED }}>
              {company.phone} · {company.email}
            </div>
          </div>
          <Logo size={54} />
        </div>
      </DocPage>

      {/* ============ MEASUREMENTS ============ */}
      <DocPage>
        <Eyebrow>Measurements</Eyebrow>
        <H2>What we measured</H2>
        <p className="mt-2" style={{ fontSize: 12.5, color: INK, maxWidth: '68ch' }}>
          {E
            ? `Taken from the ${E.vendor} aerial measurement report for ${E.address || a.address || 'this property'}. Roof area is reported in squares; one square is 100 square feet of roof surface.`
            : 'Taken on site. Roof area is reported in squares; one square is 100 square feet of roof surface. These quantities are confirmed against a measurement report before material is ordered.'}
        </p>
        {E ? (
          <>
            <SectionRule>Roof report summary</SectionRule>
            <StatGrid
              cols="grid-cols-2 md:grid-cols-3"
              valueSize={15}
              items={[
                ['Total roof area', `${E.total.toLocaleString()} sq ft`],
                ['Pitched area', `${Number(E.pitched).toLocaleString()} sq ft`],
                ['Flat / low-slope', `${Number(E.flat).toLocaleString()} sq ft`],
                ['Predominant pitch', `${E.pitch}/12`],
                ['Facets', E.facets || '—'],
                ['Waste applied', `${E.waste}%`],
              ]}
            />
            <SectionRule>Lengths</SectionRule>
            <table className="w-full border-collapse" style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  {['Component', 'Linear feet', 'What it drives'].map((h) => (
                    <th key={h} className={th} style={thStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Eaves', E.eaves, 'Gutter line and drip edge'],
                    ['Eaves + rakes', E.eavesRakes, 'Drip edge and starter course'],
                    ['Hips + ridges', E.hipsRidges, 'Ridge cap shingles and ridge vent'],
                    ['Valleys', E.valleys, 'Valley metal and closed-cut waste'],
                  ] as [string, number, string][]
                ).map(([name, lf, drives]) => (
                  <tr key={name}>
                    <td className={td} style={tdStyle}>
                      {name}
                    </td>
                    <td className={cn(td, 'text-right tabular-nums')} style={{ ...tdStyle, fontWeight: 600 }}>
                      {round2(lf).toFixed(2)}
                    </td>
                    <td className={td} style={{ ...tdStyle, color: MUTED }}>
                      {drives}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
        <SectionRule>Roof sections priced</SectionRule>
        {/* Table from md (and in print); stacked rows on phones. */}
        <table className="hidden w-full border-collapse md:table" style={{ fontSize: 12.5 }}>
          <thead>
            <tr>
              {['Section', 'Pitch', 'Stories', 'Measured', 'Waste', 'Installed squares'].map((h, i) => (
                <th key={h} className={cn('border-b px-3 py-2', i > 2 ? 'text-right' : 'text-left')} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fig.sections.map((row) => (
              <tr key={row.id}>
                <td className={td} style={{ ...tdStyle, fontWeight: 600 }}>
                  {row.name}
                </td>
                <td className={cn(td, 'tabular-nums')} style={tdStyle}>
                  {toNumber(row.section.pitch)}/12
                </td>
                <td className={cn(td, 'tabular-nums')} style={tdStyle}>
                  {toNumber(row.section.stories)}
                </td>
                <td className={cn(td, 'text-right tabular-nums')} style={tdStyle}>
                  {toNumber(row.section.measured).toFixed(2)}
                </td>
                <td className={cn(td, 'text-right tabular-nums')} style={tdStyle}>
                  {toNumber(row.section.waste)}%
                </td>
                <td className={cn(td, 'text-right tabular-nums')} style={{ ...tdStyle, fontWeight: 700 }}>
                  {row.billable.toFixed(2)}
                </td>
              </tr>
            ))}
            {fig.runs.map((row) => (
              <tr key={row.id}>
                <td className={td} style={{ ...tdStyle, fontWeight: 600 }}>
                  {row.name} — {pricing.gutter[row.run.size]?.label ?? row.run.size}
                </td>
                <td className={td} style={tdStyle} colSpan={4}>
                  Seamless gutter
                </td>
                <td className={cn(td, 'text-right tabular-nums')} style={{ ...tdStyle, fontWeight: 700 }}>
                  {row.lf.toFixed(0)} LF
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col md:hidden" style={{ fontSize: 12.5 }}>
          {fig.sections.map((row) => (
            <div key={row.id} className="border-b py-2.5" style={{ borderColor: LINE }}>
              <div className="flex items-baseline justify-between gap-3">
                <b>{row.name}</b>
                <b className="tabular-nums">{row.billable.toFixed(2)} sq</b>
              </div>
              <div style={{ color: MUTED, fontSize: 11.5 }}>
                Pitch {toNumber(row.section.pitch)}/12 · {toNumber(row.section.stories)} stor
                {toNumber(row.section.stories) === 1 ? 'y' : 'ies'} · measured {toNumber(row.section.measured).toFixed(2)} ·
                waste {toNumber(row.section.waste)}%
              </div>
            </div>
          ))}
          {fig.runs.map((row) => (
            <div key={row.id} className="flex items-baseline justify-between gap-3 border-b py-2.5" style={{ borderColor: LINE }}>
              <span>
                <b>{row.name}</b>
                <span style={{ color: MUTED }}> — {pricing.gutter[row.run.size]?.label ?? row.run.size}, seamless gutter</span>
              </span>
              <b className="whitespace-nowrap tabular-nums">{row.lf.toFixed(0)} LF</b>
            </div>
          ))}
        </div>
        {fig.preliminary ? (
          <div
            className="mt-5 rounded-lg px-3.5 py-2.5"
            style={{ border: `1px solid ${GOLD}`, background: '#FBF6E4', fontSize: 11.5, color: '#5B4A12' }}
          >
            <b>Preliminary measurements.</b> Quantities are estimated from preliminary measurements and are subject to final field
            verification before contract pricing is fixed.
          </div>
        ) : null}
      </DocPage>

      {/* ============ THE INVESTMENT ============ */}
      <DocPage>
        <Eyebrow>The investment</Eyebrow>
        <H2>{c ? 'Your insurance-restoration scope' : 'One complete option'}</H2>
        <div className="avoid-break mt-5 overflow-hidden rounded-[10px]" style={{ border: `2px solid ${NAVY}` }}>
          <div className="flex items-baseline justify-between gap-3 px-5 py-3.5" style={{ background: NAVY, color: WHITE }}>
            <div className="min-w-0">
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '.02em' }}>{fig.title}</div>
              <div style={{ fontSize: 11.5, color: PALE }}>{fig.productHeadline}</div>
            </div>
            <div className="whitespace-nowrap tabular-nums" style={{ fontSize: 15, color: GOLD }}>
              {est.number}
            </div>
          </div>
          <div className="px-5 py-4">
            <div
              style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: MUTED, marginBottom: 8 }}
            >
              Everything included
            </div>
            <ul className="columns-1 gap-[26px] md:columns-2" style={{ fontSize: 12, lineHeight: 1.6, color: INK }}>
              {fig.scopeOfWork.map((line, i) => (
                <li key={i} className="mb-1.5 flex gap-2" style={{ breakInside: 'avoid' }}>
                  <Check>{line}</Check>
                </li>
              ))}
            </ul>
            {fig.upgrades.length || fig.discounts.length || totals.adjustments || totals.tax ? (
              <table className="mt-4 w-full border-collapse" style={{ fontSize: 12.5 }}>
                <tbody>
                  {fig.upgrades.map((u, i) => (
                    <tr key={'u' + i}>
                      <td className="border-b px-2 py-1.5" style={tdStyle}>
                        {u.label || 'Optional upgrade'}
                      </td>
                      <td className="border-b px-2 py-1.5 text-right tabular-nums" style={tdStyle}>
                        {formatMoney(u.amount)}
                      </td>
                    </tr>
                  ))}
                  {fig.discounts.map((d, i) => (
                    <tr key={'d' + i}>
                      <td className="border-b px-2 py-1.5" style={tdStyle}>
                        {d.label || 'Discount'}
                      </td>
                      <td className="border-b px-2 py-1.5 text-right tabular-nums" style={tdStyle}>
                        -{formatMoney(d.amount)}
                      </td>
                    </tr>
                  ))}
                  {totals.adjustments ? (
                    <tr>
                      <td className="border-b px-2 py-1.5" style={tdStyle}>
                        Adjustment
                      </td>
                      <td className="border-b px-2 py-1.5 text-right tabular-nums" style={tdStyle}>
                        {formatMoney(totals.adjustments)}
                      </td>
                    </tr>
                  ) : null}
                  {totals.tax ? (
                    <tr>
                      <td className="border-b px-2 py-1.5" style={tdStyle}>
                        Sales tax ({formatPct(totals.taxRate)})
                      </td>
                      <td className="border-b px-2 py-1.5 text-right tabular-nums" style={tdStyle}>
                        {formatMoney(totals.tax)}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : null}
          </div>
          <div
            className="flex flex-wrap items-end justify-between gap-4 px-5 py-4"
            style={{ background: TINT, borderTop: `1px solid ${LINE}` }}
          >
            <div>
              <Label>{c ? 'Total contract price' : 'Your investment'}</Label>
              <div style={{ fontSize: 11.5, color: MUTED }}>
                {R.billable ? `${R.billable.toFixed(2)} squares installed` : ''}
                {R.billable && G.lf ? ' · ' : ''}
                {G.lf ? `${G.lf.toFixed(0)} LF of gutter` : ''}
              </div>
            </div>
            <div className="tabular-nums" style={{ fontSize: 33, fontWeight: 700, color: NAVY, lineHeight: 1 }}>
              {formatMoney(fig.headlinePrice)}
            </div>
          </div>
          <div className="px-5 py-4" style={{ borderTop: `1px solid ${LINE}` }}>
            <Label>{c ? 'Insurance payment schedule' : 'Payment schedule'}</Label>
            <table className="w-full border-collapse" style={{ fontSize: 12.5 }}>
              <tbody>
                {c ? (
                  <>
                    {(
                      [
                        ['First payment from insurance (ACV)', 'due upon roof completion', ins.acv],
                        ['Second payment (depreciation)', 'due upon insurance release of funds', ins.depreciation],
                        ['Deductible', 'due upon roof completion', ins.deductible],
                        ['Upgrades', 'due upon roof completion', ins.upgradesAmt],
                      ] as [string, string, unknown][]
                    ).map(([label, when, amount]) => (
                      <tr key={label}>
                        <td className="border-b px-2 py-1.5" style={tdStyle}>
                          {label}
                          <div style={{ fontSize: 10.5, color: MUTED }}>{when}</div>
                        </td>
                        <td className="border-b px-2 py-1.5 text-right tabular-nums" style={tdStyle}>
                          {blank(amount)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="px-2 py-2" style={{ fontWeight: 700, borderTop: `1.5px solid ${NAVY}` }}>
                        Total contract price
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums" style={{ fontWeight: 700, borderTop: `1.5px solid ${NAVY}` }}>
                        {fig.insuranceTotal ? formatMoney(fig.insuranceTotal) : formatMoney(totals.sell)}
                      </td>
                    </tr>
                  </>
                ) : (
                  <>
                    {(
                      [
                        [`Due at signing (${pay.signPct}%)`, pay.atSigning],
                        [`Due on material delivery (${pay.deliveryPct}%)`, pay.onDelivery],
                        ['Balance due at completion', pay.balance],
                      ] as [string, number][]
                    ).map(([label, amount]) => (
                      <tr key={label}>
                        <td className="border-b px-2 py-1.5" style={tdStyle}>
                          {label}
                        </td>
                        <td className="border-b px-2 py-1.5 text-right tabular-nums" style={tdStyle}>
                          {formatMoney(amount)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="px-2 py-2" style={{ fontWeight: 700, borderTop: `1.5px solid ${NAVY}` }}>
                        Total price
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums" style={{ fontWeight: 700, borderTop: `1.5px solid ${NAVY}` }}>
                        {formatMoney(totals.sell)}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
            <div className="mt-2" style={{ fontSize: 10.5, color: MUTED }}>
              {c
                ? `Plus additional supplements paid for by the insurance carrier — all supplements are due to ${company.legal}.`
                : 'A project timeline is provided once material is scheduled. Work outside this scope requires written approval.'}
            </div>
          </div>
          <div
            className="mx-5 my-5 flex items-center justify-between gap-4 rounded-lg px-4 py-3.5"
            style={{ border: `2px dashed ${GOLD}`, background: '#FDFAF3' }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: NAVY }}>I accept this option</div>
              <div style={{ fontSize: 11, color: MUTED }}>Initial here and sign on the last page.</div>
            </div>
            <div className="h-11 w-24 flex-shrink-0 rounded-md" style={{ border: `1px solid ${GOLD}`, background: WHITE }} />
          </div>
        </div>
        <SectionRule>Not included in this price</SectionRule>
        <ul className="columns-1 gap-[26px] md:columns-2" style={{ listStyle: 'disc', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.6, color: INK }}>
          {s.exclusions.map((line, i) => (
            <li key={i} style={{ breakInside: 'avoid', marginBottom: 4 }}>
              {line}
            </li>
          ))}
        </ul>
      </DocPage>

      {/* ============ SCOPE OF WORK ============ */}
      <DocPage>
        <Eyebrow>Scope of work</Eyebrow>
        <H2>How the job runs, step by step</H2>
        <ol className="mt-5 columns-1 gap-7 md:columns-2" style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12, lineHeight: 1.6, color: INK }}>
          {PROPOSAL_PROCESS_STEPS.map(([title, detail], i) => (
            <li key={title} className="mb-3.5" style={{ breakInside: 'avoid' }}>
              <div className="flex gap-2.5">
                <span className="flex-shrink-0 tabular-nums" style={{ color: GOLD, fontWeight: 700, fontSize: 12 }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <div style={{ fontWeight: 700, color: NAVY, fontSize: 12.5 }}>{title}</div>
                  <div>{detail}</div>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <SectionRule>Materials</SectionRule>
        <table className="w-full border-collapse" style={{ fontSize: 12.5 }}>
          <thead>
            <tr>
              {['Component', 'Specification'].map((h) => (
                <th key={h} className={th} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fig.sections.map((row) => (
              <tr key={row.id}>
                <td className={td} style={tdStyle}>
                  Field shingle — {row.name}
                </td>
                <td className={td} style={tdStyle}>
                  {pricing.mfrs[row.section.mfr]?.label ?? row.section.mfr}
                  {row.section.product ? ' ' + row.section.product : ''} architectural
                  {row.section.color ? `, ${row.section.color}` : ''}
                </td>
              </tr>
            ))}
            <tr>
              <td className={td} style={tdStyle}>
                Underlayment
              </td>
              <td className={td} style={tdStyle}>
                {R.psSquares > 0
                  ? `Self-adhered peel-and-stick over ${R.psSquares.toFixed(2)} squares; synthetic elsewhere`
                  : 'Synthetic underlayment over the full deck'}
              </td>
            </tr>
            <tr>
              <td className={td} style={tdStyle}>
                Drip edge
              </td>
              <td className={td} style={tdStyle}>
                New metal drip edge, eaves and rakes
              </td>
            </tr>
            <tr>
              <td className={td} style={tdStyle}>
                Decking allowance
              </td>
              <td className={td} style={tdStyle}>
                {formatMoney(fig.deckingAllowance)} per 4×8 sheet, billed only for sheets actually replaced
              </td>
            </tr>
            {fig.runs.map((row) => (
              <tr key={row.id}>
                <td className={td} style={tdStyle}>
                  Gutter — {row.name}
                </td>
                <td className={td} style={tdStyle}>
                  {pricing.gutter[row.run.size]?.label ?? row.run.size}
                  {row.run.color ? `, ${row.run.color}` : ''}, seamless aluminium
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <SectionRule>Allowances</SectionRule>
        <ul style={{ listStyle: 'disc', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.7, color: INK }}>
          {s.allowances.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {s.notes ? (
          <>
            <SectionRule>Notes</SectionRule>
            <div style={{ fontSize: 12.5, color: INK, whiteSpace: 'pre-wrap' }}>{s.notes}</div>
          </>
        ) : null}
      </DocPage>

      {/* ============ WARRANTY, TERMS AND ACCEPTANCE ============ */}
      <DocPage>
        <Eyebrow>Warranty, terms and acceptance</Eyebrow>
        <H2>What you are covered for</H2>
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-[9px] p-4" style={{ border: `1px solid ${LINE}`, background: TINT }}>
            <div style={{ fontWeight: 700, fontSize: 12.5, color: NAVY }}>Workmanship</div>
            <div className="mt-1.5" style={{ fontSize: 12.5, color: INK }}>
              <b>{fig.warrantyYears}-year labor warranty</b> on installation, transferable once to the next owner of the property.
            </div>
          </div>
          <div className="rounded-[9px] p-4" style={{ border: `1px solid ${LINE}`, background: TINT }}>
            <div style={{ fontWeight: 700, fontSize: 12.5, color: NAVY }}>Materials</div>
            <div className="mt-1.5" style={{ fontSize: 12.5, color: INK }}>
              Manufacturer{"'"}s limited lifetime shingle warranty on the selected system, registered in your name after final
              inspection.
            </div>
          </div>
        </div>
        <SectionRule>Code</SectionRule>
        <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.7, maxWidth: '70ch' }}>
          Work is performed to the current Florida Building Code edition in force in {a.city || 'your county'}, including deck
          re-nailing schedule, secondary water barrier where required, and the wind-uplift nailing pattern for your exposure
          category. The municipal final inspection is scheduled by us and must pass before the final payment is due.
        </div>
        <SectionRule>Next steps</SectionRule>
        <ol style={{ listStyle: 'decimal', paddingLeft: 18, fontSize: 12.5, color: INK, lineHeight: 1.8 }}>
          {PROPOSAL_NEXT_STEPS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <SectionRule>Contract conditions</SectionRule>
        <div className="grid grid-cols-1 gap-x-6 text-[11px] md:grid-cols-2 md:text-[8.6px]" style={{ lineHeight: 1.45, color: INK }}>
          {fig.terms.map((term, i) => (
            <div key={term.title} className="mb-1.5" style={{ breakInside: 'avoid' }}>
              <b>
                {i + 1}. {term.title}.
              </b>{' '}
              {term.body}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-3" style={{ fontSize: 10.5, color: MUTED }}>
          Owner initials
          <span className="inline-block h-8 w-20 rounded-[5px]" style={{ border: `1px solid ${LINE}` }} />
        </div>
        <div className="avoid-break">
          <SectionRule>Acceptance</SectionRule>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {['Property owner — signature & date', `${company.legal} — authorized representative & date`].map((line) => (
              <div key={line} className="rounded-lg p-4" style={{ border: `1px solid ${LINE}` }}>
                <div className="h-12" />
                <div className="border-t pt-2" style={{ borderColor: NAVY, fontSize: 11, color: MUTED }}>
                  {line}
                </div>
              </div>
            ))}
          </div>
          <div
            className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg px-4 py-3"
            style={{ background: NAVY, color: WHITE, fontSize: 10.5 }}
          >
            <span>
              By signing, the owner accepts the scope, price, payment terms and the {fig.terms.length} contract conditions above.
            </span>
            <span style={{ color: PALE }}>
              {c ? '' : 'Expires ' + expires + ' · '}Owner may cancel within three (3) business days of execution.
            </span>
          </div>
        </div>
      </DocPage>
    </div>
  );
}
