import type { ReactNode } from 'react'
import { cx } from '../../../shared/lc'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { fmtAge, fmtDate, fmtInt, fmtMiles, fmtMoney, fmtUnitValue, saleAgeDays, unitValue } from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Workstation } from './derive-workstation'
import { useFocus, type FocusStore } from './focus-store'
import { DeviationRows } from './charts/DeviationRows'
import { saleTypeOfComp } from '../../../domain/comp-intelligence/comp-sale-type'
import { CompStreetView } from './CompStreetView'
import { SaleTypeBadge } from './SaleType'

type Cell = { text: ReactNode; tone?: 'attn' | 'ok' | null }
interface MatrixRow { id: string; label: string; subject: ReactNode; cell: (c: EvidenceComp) => Cell }

const signed = (n: number, unit = '') => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}${unit}`
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && b !== null && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase()

/**
 * COMPARE — an analyst's matrix (§40–41): the subject pinned on the left,
 * the shown set across, deltas printed beside values and meaningful
 * deviations marked (amber is attention, never failure). Above it, size
 * against the subject for every comp, inside the engine's allowed band.
 */
export function CompareMode({ m, store, onOpen }: { m: Workstation; store: FocusStore; onOpen: (c: EvidenceComp) => void }) {
  const focus = useFocus(store)
  const s = m.w.subject
  const comps = m.lensComps
  const multi = m.kind === 'multifamily'
  const land = m.kind === 'land'

  const sizeRows = comps.map((c) => {
    const pct = multi ? (s.units && c.units ? Math.round(((c.units - s.units) / s.units) * 100) : null) : land ? c.compare.lotPct : c.compare.sqftPct
    return { key: c.key, label: c.address ?? 'Comp', value: pct, text: pct === null ? 'not recorded' : signed(pct, '%'), emphasis: pct !== null && Math.abs(pct) > 20 }
  })
  const band = m.rules?.size ? { min: Math.round((m.rules.size.min - 1) * 100), max: Math.round((m.rules.size.max - 1) * 100), label: 'engine band' } : null
  const bound = Math.max(10, Math.ceil((Math.max(0, ...sizeRows.map((r) => Math.abs(r.value ?? 0))) * 1.25) / 5) * 5)
  const bandVisible = Boolean(band && (band.min > -bound || band.max < bound))

  const rows: MatrixRow[] = [
    { id: 'distance', label: 'Distance', subject: '—', cell: (c) => ({ text: fmtMiles(c.distanceMiles) ?? '—', tone: (c.distanceMiles ?? 0) > 2 ? 'attn' : null }) },
    { id: 'sold', label: 'Sold', subject: s.lastSale ? fmtDate(s.lastSale.date) : '—', cell: (c) => { const d = saleAgeDays(c, m.now); return { text: <>{fmtDate(c.saleDate) ?? '—'}<em>{d !== null ? fmtAge(d) : ''}</em></>, tone: d !== null && d > 365 ? 'attn' : null } } },
    { id: 'price', label: 'Sale price', subject: s.lastSale ? fmtMoney(s.lastSale.price) : '—', cell: (c) => ({ text: fmtMoney(c.salePrice) ?? '—' }) },
    { id: 'unit', label: m.metric.label, subject: '—', cell: (c) => { const u = unitValue(c, m.metric); return { text: u !== null ? `${fmtUnitValue(u, m.metric)}` : '—' } } },
    { id: 'adj', label: 'Adjusted to subject', subject: m.w.conclusion?.valueMid && m.comparableValuation ? <>{fmtMoney(m.w.conclusion.valueMid)}<em>central</em></> : '—', cell: (c) => ({ text: fmtMoney(c.engine?.adjustedPrice ?? null) ?? '—' }) },
    { id: 'weight', label: 'Engine weight', subject: '—', cell: (c) => ({ text: c.engine?.weight !== null && c.engine?.weight !== undefined ? c.engine.weight.toFixed(4) : '—' }) },
    { id: 'score', label: 'Comparability', subject: '—', cell: (c) => ({ text: c.engine?.score !== null && c.engine?.score !== undefined ? Math.round(c.engine.score) : '—', tone: (c.engine?.score ?? 100) < 60 ? 'attn' : null }) },
    { id: 'type', label: 'Type', subject: s.propertyType ?? '—', cell: (c) => ({ text: c.propertyType ?? '—', tone: c.assetMatch ? null : 'attn' }) },
    ...(multi ? [{ id: 'units', label: 'Units', subject: s.units ?? '—', cell: (c: EvidenceComp): Cell => ({ text: c.units !== null ? <>{c.units}{c.compare.units ? <em>{signed(c.compare.units)}</em> : null}</> : '—', tone: c.compare.units !== null && s.units ? (Math.abs(c.compare.units) / s.units > 0.25 ? 'attn' : null) : null }) }] : []),
    ...(!multi && !land ? [
      { id: 'beds', label: 'Beds', subject: s.beds ?? '—', cell: (c: EvidenceComp): Cell => ({ text: c.beds !== null ? <>{c.beds}{c.compare.beds ? <em>{signed(c.compare.beds)}</em> : null}</> : '—', tone: c.compare.beds !== null && Math.abs(c.compare.beds) >= 1 ? 'attn' : null }) },
      { id: 'baths', label: 'Baths', subject: s.baths ?? '—', cell: (c: EvidenceComp): Cell => ({ text: c.baths !== null ? <>{c.baths}{c.compare.baths ? <em>{signed(c.compare.baths)}</em> : null}</> : '—', tone: c.compare.baths !== null && Math.abs(c.compare.baths) >= 1 ? 'attn' : null }) },
    ] : []),
    ...(!land ? [{ id: 'sqft', label: 'Building sq ft', subject: fmtInt(s.sqft) ?? '—', cell: (c: EvidenceComp): Cell => ({ text: c.sqft ? <>{fmtInt(c.sqft)}{c.compare.sqftPct ? <em>{signed(c.compare.sqftPct, '%')}</em> : null}</> : '—', tone: c.compare.sqftPct !== null && Math.abs(c.compare.sqftPct) > 20 ? 'attn' : null }) }] : []),
    { id: 'year', label: 'Year built', subject: s.yearBuilt ?? '—', cell: (c) => ({ text: c.yearBuilt ? <>{c.yearBuilt}{c.compare.years ? <em>{signed(c.compare.years)}</em> : null}</> : '—', tone: c.compare.years !== null && Math.abs(c.compare.years) > 20 ? 'attn' : null }) },
    { id: 'lot', label: 'Lot sq ft', subject: fmtInt(s.lotSqft) ?? '—', cell: (c) => ({ text: c.lotSqft ? <>{fmtInt(c.lotSqft)}{c.compare.lotPct ? <em>{signed(c.compare.lotPct, '%')}</em> : null}</> : '—', tone: c.compare.lotPct !== null && Math.abs(c.compare.lotPct) > 35 ? 'attn' : null }) },
    { id: 'condition', label: 'Condition', subject: s.condition ?? '—', cell: (c) => ({ text: c.condition ?? '—', tone: c.condition && s.condition && !same(c.condition, s.condition) ? 'attn' : null }) },
    { id: 'garage', label: 'Garage', subject: s.garage ?? '—', cell: (c) => ({ text: c.features?.garage ?? '—' }) },
    { id: 'pool', label: 'Pool', subject: s.pool ?? '—', cell: (c) => ({ text: c.features?.pool ?? '—', tone: c.features?.pool && s.pool && !same(c.features.pool, s.pool) ? 'attn' : null }) },
    { id: 'stories', label: 'Stories', subject: s.stories ?? '—', cell: (c) => ({ text: c.features?.stories ?? '—' }) },
    { id: 'subdivision', label: 'Subdivision', subject: s.subdivision ?? '—', cell: (c) => ({ text: c.features?.subdivision ?? '—', tone: c.features?.subdivision && s.subdivision && same(c.features.subdivision, s.subdivision) ? 'ok' : null }) },
    { id: 'saletype', label: 'Sale type', subject: '—', cell: (c) => ({ text: <SaleTypeBadge v={saleTypeOfComp(c)} withBuyer /> }) },
    { id: 'source', label: 'Record', subject: '—', cell: (c) => ({ text: c.corpus === 'transaction_corpus' ? 'Recorded deed' : 'Engine pool' }) },
    { id: 'arms', label: 'Arm’s-length', subject: '—', cell: (c) => ({ text: c.armsLength === true ? 'Yes' : c.armsLength === false ? 'No' : 'Not recorded' }) },
  ]

  if (!comps.length) return <div className="ciw-empty-block">No comps in the shown set to compare. Include candidates from Evidence to build one.</div>

  return (
    <div className="ciw-compare">
      <section className="ciw-block">
        <header className="ciw-block__head">
          <span className="ciw-block__title">{multi ? 'Units' : land ? 'Lot size' : 'Size'} against the subject</span>
          <span className="ciw-block__aside">{band ? (bandVisible ? `shaded: what the engine allows (${band.min}% to +${band.max}%)` : `all inside what the engine allows (${band.min}% to +${band.max}%)`) : 'no size rule for this asset class'}</span>
        </header>
        <DeviationRows rows={sizeRows} store={store} band={bandVisible ? band : null} bound={bound} ariaLabel="Size deviation of each comp from the subject" />
      </section>

      <section className="ciw-block">
        <header className="ciw-block__head">
          <span className="ciw-block__title">Feature matrix</span>
          <span className="ciw-block__aside">{comps.length} comps · deltas vs subject · amber = meaningful deviation</span>
        </header>
        <div className="ciw-matrix lc-scroll" role="region" aria-label="Subject and comps compared feature by feature" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col" className="ciw-matrix__corner">Feature</th>
                <th scope="col" className="ciw-matrix__subject">Subject</th>
                {comps.map((c, i) => (
                  <th key={c.key} scope="col" className={cx('ciw-matrix__comp', (focus.hover === c.key || focus.selected === c.key) && 'is-hot')}
                    onPointerEnter={() => store.hover(c.key, 'matrix')} onPointerLeave={() => store.hover(null, null)}>
                    <button type="button" onClick={() => onOpen(c)} title={c.address ?? undefined}>
                      <CompStreetView size="header" load="visible" photo={c.photo} lat={c.lat} lng={c.lng} address={c.address} />
                      <b>{i + 1}</b><span>{(c.address ?? 'Comp').split(',')[0]}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.label}</th>
                  <td className="ciw-matrix__subject lc-num">{r.subject}</td>
                  {comps.map((c) => {
                    const cell = r.cell(c)
                    return (
                      <td key={c.key} className={cx('lc-num', cell.tone && `is-${cell.tone}`, (focus.hover === c.key || focus.selected === c.key) && 'is-hot')}
                        onPointerEnter={() => store.hover(c.key, 'matrix')} onPointerLeave={() => store.hover(null, null)}>
                        {cell.text}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
