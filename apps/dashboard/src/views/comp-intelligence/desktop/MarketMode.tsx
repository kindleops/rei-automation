import { LCStatus, cx } from '../../../shared/lc'
import { fmtAge, fmtDate, fmtMoney, fmtPct, fmtUnitValue, latestSales, median, subjectImplied, unitValue } from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Workstation } from './derive-workstation'
import { linear, useElementWidth } from './charts/chart-math'

/**
 * MARKET — what is happening around the subject beyond the shown set (§45–47).
 * Recorded sales only: LeadCommand has no listing feed, so active and
 * pending supply, days on market and list-to-sale ratios are stated as not
 * captured rather than estimated. Signals are counts and medians, never a
 * market score.
 */
export function MarketMode({ m }: { m: Workstation }) {
  const mk = m.w.market
  const s = m.w.subject
  const counts = m.w.counts
  const multi = m.kind === 'multifamily'
  const implied = m.comparableValuation ? subjectImplied(m.w.conclusion?.valueMid ?? null, s, m.metric) : null
  const lensUnit = median(m.lensComps.map((c) => unitValue(c, m.metric)).filter((v): v is number => v !== null))
  const universe = m.w.comps.filter((c) => c.state !== 'excluded')
  const uniUnits = universe.map((c) => unitValue(c, m.metric)).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const q = (p: number) => (uniUnits.length ? uniUnits[Math.round(p * (uniUnits.length - 1))] : null)
  const latest = latestSales(m.w.comps)
  // every recorded transaction loaded: deed-only rows plus pool sales a deed was folded into
  const deeds = m.w.comps.filter((c) => c.corpus === 'transaction_corpus' || (c.txnId ?? null) !== null)
  const buyers = { company: deeds.filter((c) => c.buyerKind === 'company').length, person: deeds.filter((c) => c.buyerKind === 'person').length, unknown: deeds.filter((c) => !c.buyerKind).length }
  const complete = counts.transactionsInRadius !== null && counts.transactionsReturned !== null && counts.transactionsReturned >= counts.transactionsInRadius
  const monthly = complete ? monthlyVolume(deeds.map((c) => c.saleDate), m.now, Math.min(24, m.w.query.months)) : null

  return (
    <div className="ciw-market">
      {mk ? (
        <section className="ciw-block">
          <header className="ciw-block__head">
            <span className="ciw-block__title">ZIP {mk.zip} · {familyWords(mk.family)} · last {Math.round((mk.windowDays ?? 365) / 30.4)} months</span>
            <span className="ciw-block__aside">{mk.admissible ? <LCStatus tone="ok" label="Market cell" quiet /> : <LCStatus tone="attn" label="Low sample" />} as of {fmtDate(mk.asOf, 'long')}</span>
          </header>
          {mk.p25 && mk.p75 && mk.medianPrice ? (
            <PriceBand p25={mk.p25} median={mk.medianPrice} p75={mk.p75} marks={[
              ...(m.comparableValuation && m.w.conclusion?.valueMid ? [{ id: 'engine', label: 'Engine central', value: m.w.conclusion.valueMid }] : []),
              ...(m.systemReplay.result && m.lens === 'operator' && m.operatorReplay?.result ? [{ id: 'op', label: 'Your set', value: m.operatorReplay.result.mid }] : []),
            ]} />
          ) : null}
          <div className="ciw-facts-grid lc-num">
            <Fact label="Recorded sales" value={mk.sales?.toLocaleString('en-US') ?? '—'} note={mk.sales ? `${(mk.sales / ((mk.windowDays ?? 365) / 30.4)).toFixed(1)} a month` : undefined} />
            <Fact label="Median price" value={fmtMoney(mk.medianPrice) ?? '—'} note={mk.p25 && mk.p75 ? `middle half ${fmtMoney(mk.p25)}–${fmtMoney(mk.p75)}` : undefined} />
            <Fact label={multi ? 'Median $/unit' : 'Median $/sq ft'} value={multi ? fmtMoney(mk.medianPpu) ?? '—' : mk.medianPpsf ? `$${mk.medianPpsf}` : '—'} note={implied !== null ? `subject implied ${fmtUnitValue(implied, m.metric)}` : undefined} />
            <Fact label="Cash purchases" value={fmtPct(mk.cashShare, 0) ?? '—'} />
            <Fact label="Arm’s-length" value={fmtPct(mk.armsLengthShare, 0) ?? '—'} />
            <Fact label="Company buyers" value={fmtPct(mk.corporateBuyerShare, 0) ?? '—'} note="name-based proxy" />
            <Fact label="Repeat buyers" value={fmtPct(mk.repeatBuyerShare, 0) ?? '—'} note="proxy" />
            <Fact label="Median sale age" value={fmtAge(mk.recencyDaysMedian) ?? '—'} />
          </div>
        </section>
      ) : (
        <section className="ciw-block"><p className="ciw-muted">No ZIP market cell exists for {s.zip ? `ZIP ${s.zip}` : 'this subject'} and this asset class.</p></section>
      )}

      <section className="ciw-block">
        <header className="ciw-block__head">
          <span className="ciw-block__title">Inside the search · {m.w.query.radiusMiles} mi · {m.w.query.months} mo</span>
        </header>
        <div className="ciw-facts-grid lc-num">
          <Fact label="Recorded transactions" value={counts.transactionsInRadius?.toLocaleString('en-US') ?? '—'} note={counts.transactionsSameFamily !== null ? `${counts.transactionsSameFamily.toLocaleString('en-US')} same asset class` : undefined} />
          <Fact label="Loaded for review" value={counts.transactionsReturned?.toLocaleString('en-US') ?? '—'} note={complete ? 'all of them' : 'nearest first'} />
          <Fact label="Engine pool sales" value={counts.enginePool.toLocaleString('en-US')} note="the engine’s candidate query" />
          <Fact label={`Universe ${m.metric.label}`} value={uniUnits.length ? fmtUnitValue(median(uniUnits), m.metric) ?? '—' : '—'} note={uniUnits.length >= 4 ? `middle half ${fmtUnitValue(q(0.25), m.metric)}–${fmtUnitValue(q(0.75), m.metric)}` : undefined} />
          <Fact label={`Shown set ${m.metric.label}`} value={lensUnit !== null ? fmtUnitValue(lensUnit, m.metric) ?? '—' : '—'} note="median" />
          <Fact label="Latest sale loaded" value={fmtDate([latest.enginePool, latest.recordedDeeds].filter(Boolean).sort().pop() ?? null, 'long') ?? '—'} note="evidence is as recent as this" />
        </div>
        {monthly ? (
          <div className="ciw-monthly">
            <span className="lc-eyebrow">Recorded sales in the search by month · all asset classes</span>
            <MonthlyBars data={monthly} />
          </div>
        ) : (
          <p className="ciw-muted">Monthly volume is shown only when every recorded sale in the search is loaded — here the nearest {counts.transactionsReturned ?? 0} of {counts.transactionsInRadius ?? 0} are.</p>
        )}
        {deeds.length ? (
          <p className="ciw-muted lc-num">Buyers on the {deeds.length} loaded recorded deeds: {buyers.company} companies · {buyers.person} individuals{buyers.unknown ? ` · ${buyers.unknown} not recorded` : ''}. Buyer activity is context for disposition, not valuation evidence.</p>
        ) : null}
      </section>

      <section className="ciw-block ciw-block--unavailable" aria-label="Active and pending listings">
        <header className="ciw-block__head"><span className="ciw-block__title">Active & pending listings</span><span className="ciw-block__aside"><LCStatus tone="neutral" label="Not captured" quiet /></span></header>
        <p className="ciw-muted">LeadCommand has no listing feed, so asking-market supply, days on market, price reductions and list-to-sale ratios are not shown — there is no active-market ceiling to draw. Every figure in Comp Intelligence is recorded sold evidence.{s.recordStatus ? ` The property record labels the subject “${s.recordStatus}” (an undated provider label, not a live listing status).` : ''}</p>
      </section>
    </div>
  )
}

function familyWords(f: string) {
  return f === 'sfr' ? 'single-family' : f === 'small_multifamily_2_4' ? '2–4 unit' : f === 'apartments_5plus' ? '5+ unit' : f.replace(/_/g, ' ')
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="ciw-fact">
      <span className="ciw-fact__label">{label}</span>
      <b className="ciw-fact__value">{value}</b>
      {note ? <span className="ciw-fact__note">{note}</span> : null}
    </div>
  )
}

function PriceBand({ p25, median: mid, p75, marks }: { p25: number; median: number; p75: number; marks: Array<{ id: string; label: string; value: number }> }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const lo = Math.min(p25, ...marks.map((x) => x.value)) * 0.94
  const hi = Math.max(p75, ...marks.map((x) => x.value)) * 1.06
  const x = linear(lo, hi, 8, Math.max(60, width - 8))
  return (
    <div ref={ref} className="ciw-priceband" style={{ height: 58 }}>
      {width > 0 ? (
        <svg width={width} height={58} role="img" aria-label={`ZIP middle half ${fmtMoney(p25)} to ${fmtMoney(p75)}, median ${fmtMoney(mid)}`}>
          <line x1={8} x2={width - 8} y1={30} y2={30} className="ciw-axis-line" />
          <rect x={x(p25)} y={24} width={Math.max(2, x(p75) - x(p25))} height={12} rx={4} className="ciw-priceband__iqr" />
          <line x1={x(mid)} x2={x(mid)} y1={20} y2={40} className="ciw-priceband__median" />
          <text x={x(p25)} y={52} className="ciw-axis" textAnchor="middle">{fmtMoney(p25)}</text>
          <text x={x(mid)} y={14} className="ciw-axis is-value" textAnchor="middle">median {fmtMoney(mid)}</text>
          <text x={x(p75)} y={52} className="ciw-axis" textAnchor="middle">{fmtMoney(p75)}</text>
          {marks.map((mk) => (
            <g key={mk.id} className={cx('ciw-priceband__mark', `is-${mk.id}`)}>
              <path d={`M${x(mk.value)} 24 l4 -6 h-8 z`} />
              <text x={x(mk.value)} y={52} textAnchor="middle" className="ciw-axis is-value">{mk.label}</text>
            </g>
          ))}
        </svg>
      ) : null}
    </div>
  )
}

function monthlyVolume(dates: Array<string | null>, now: number, months: number): Array<{ label: string; n: number }> {
  const end = new Date(now)
  const out: Array<{ key: string; label: string; n: number }> = []
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1))
    out.push({ key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), n: 0 })
  }
  for (const s of dates) {
    if (!s) continue
    const b = out.find((o) => s.startsWith(o.key))
    if (b) b.n += 1
  }
  return out
}

function MonthlyBars({ data }: { data: Array<{ label: string; n: number }> }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const max = Math.max(1, ...data.map((d) => d.n))
  const slot = Math.max(1, (width - 4) / data.length)
  const bw = Math.min(14, slot * 0.62)
  return (
    <div ref={ref} style={{ height: 84 }}>
      {width > 0 ? (
        <svg width={width} height={84} role="img" aria-label={data.map((d) => `${d.label} ${d.n}`).join(', ')}>
          {data.map((d, i) => {
            const h = (d.n / max) * 52
            const cx0 = 2 + slot * i + slot / 2
            return (
              <g key={`${d.label}${i}`}>
                {d.n ? <rect x={cx0 - bw / 2} y={60 - h} width={bw} height={h} rx={2} className="ciw-bar is-candidate" /> : null}
                {i % Math.ceil(data.length / 8) === 0 ? <text x={cx0} y={76} textAnchor="middle" className="ciw-axis">{d.label}</text> : null}
              </g>
            )
          })}
          <line x1={0} x2={width} y1={60.5} y2={60.5} className="ciw-axis-line" />
        </svg>
      ) : null}
    </div>
  )
}
