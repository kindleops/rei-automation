/**
 * BUYERS / DISPOSITION — recorded buyer demand, with its date.
 *
 * The recorded-transaction corpus ends at its DATA-THROUGH date (Jul 28 in
 * production) — earlier than the seller data. A period after it is "not yet
 * recorded", never zero; to still show where buyers ARE buying, the corpus's
 * own latest 90 days are read and named as such.
 *
 * SUPPLY × DEMAND joins seller interest in THIS period with that buyer
 * window by canonical market (the same market ids on both sides). Two
 * different windows, both named: this is a map of where acquisition supply
 * and disposition demand overlap, not a forecast and not a demand score.
 */
import { useMemo } from 'react'
import type { LabQuery } from '../../../domain/analytics/analytics-lab-api'
import { cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { fmtThrough, useBuyerWindow } from './intel-hooks'
import { fmtInt, fmtPct } from './intel-format'
import { serverContext } from './intel-state'

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—')

export function IntelBuyers({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, act, refreshing } = useLab()
  const bw = useBuyerWindow(ctx)
  const supplyQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'sellers_reached', groupBy: 'market', limit: 120, metrics: ['sellers_reached', 'interested_sellers', 'reached_replied'] }), 'table'))
  const through = fmtThrough(bw.through)
  const shown = bw.shown
  const windowLabel = bw.window === 'latest' ? `${day(bw.start)} – ${through}` : bw.window === 'period' ? 'this period' : '…'
  const marketSegment = ctx.segment.find((s) => s.dim === 'market')?.value || null

  type SRow = { key: string; label: string; values: Record<string, { value: number | null }> }
  const supply = useMemo(() => ((supplyQ.data?.result?.rows || []) as unknown as SRow[]).filter((r) => r.key !== '__unresolved'), [supplyQ.data])
  const joined = useMemo(() => {
    const demand = new Map((shown?.markets || []).map((m) => [m.key, m]))
    const keys = new Set([...supply.map((s) => s.key), ...demand.keys()])
    return [...keys].map((k) => {
      const s = supply.find((x) => x.key === k)
      const d = demand.get(k)
      const reached = s?.values.sellers_reached?.value ?? 0
      const interested = s?.values.interested_sellers?.value ?? 0
      const purchases = d?.cur ?? 0
      const kind = (interested > 0 || reached > 0) && purchases > 0 ? 'both' : reached > 0 ? 'supply' : 'demand'
      return { key: k, label: s?.label || d?.label || k, reached, interested, purchases, buyers: d?.entities ?? 0, kind }
    }).sort((a, b) => ({ both: 0, supply: 1, demand: 2 }[a.kind as 'both'] - { both: 0, supply: 1, demand: 2 }[b.kind as 'both']) || (b.interested - a.interested) || (b.purchases - a.purchases))
  }, [supply, shown])
  const maxP = Math.max(1, ...joined.map((j) => j.purchases))
  const maxR = Math.max(1, ...joined.map((j) => j.reached))
  const both = joined.filter((j) => j.kind === 'both')

  return (
    <section className={cx('ix-buyers lc-plane is-smoke is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Buyer and disposition intelligence">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Buyers · disposition</span>
          <h2>Where buyers are buying</h2>
        </div>
        <span className={cx('ix-stamp', bw.period?.coverage !== 'full' && 'is-attn')} title="The recorded-transaction corpus's last recorded date">DATA THROUGH {through.toUpperCase()}</span>
      </header>
      {bw.error && !shown ? <p className="ix-note is-bad">Buyer corpus didn’t load · {bw.error}</p> : null}
      {bw.period && bw.period.coverage !== 'full' ? (
        <p className="ix-callout is-neutral"><Icon name="database" size={14} /><span>{bw.period.coverage === 'none' ? <>This period starts after the corpus ends: its buyer activity is <b>not yet recorded</b> (not zero). Below: the corpus’s latest 90 days, {windowLabel}.</> : <>The corpus ends inside this period; days after {through} are not yet recorded. Below: the latest 90 recorded days, {windowLabel}.</>}</span></p>
      ) : null}
      {shown ? (
        <>
          <dl className="ix-bases is-three">
            <div className="ix-basis" data-tone="flow"><dt><span>Recorded purchases</span><em>{windowLabel}</em></dt><dd><b>{fmtInt(shown.purchases)}</b><small>arm’s-length, identity-resolved buyers</small></dd></div>
            <div className="ix-basis" data-tone="flow"><dt><span>Distinct buyers</span><em>{windowLabel}</em></dt><dd><b>{fmtInt(shown.entities)}</b><small>{shown.repeat !== null && shown.purchases ? `${fmtPct(shown.repeat / shown.purchases)} of purchases by repeat buyers` : '—'}</small></dd></div>
            <div className="ix-basis" data-tone="neutral"><dt><span>Supply × demand</span><em>by canonical market</em></dt><dd><b>{fmtInt(both.length)}</b><small>markets with sellers reached this period and recorded buyers</small></dd></div>
          </dl>
          <div className="ix-sxd" role="table" aria-label="Seller supply this period against recorded buyer demand">
            <div className="ix-sxd__head" role="row">
              <span role="columnheader">Market</span>
              <span role="columnheader" className="is-supply">Sellers reached · interested <em>this period</em></span>
              <span role="columnheader" className="is-demand">Recorded purchases <em>{windowLabel}</em></span>
            </div>
            {joined.slice(0, variant === 'lens' ? 30 : 8).map((j) => (
              <div key={j.key} role="row" className={cx('ix-sxd__row', `is-${j.kind}`, marketSegment === j.key && 'is-on')}>
                <button type="button" role="rowheader" className="ix-sxd__market" onClick={() => act.pushSegment({ dim: 'market', value: j.key, label: j.label })} title="Narrow the Lab to this market">
                  <i aria-hidden="true" />{j.label}
                </button>
                <span role="cell" className="ix-sxd__supply"><i style={{ width: `${(j.reached / maxR) * 100}%` }} /><b>{fmtInt(j.reached)}</b><small>{j.interested ? `${fmtInt(j.interested)} interested` : ''}</small></span>
                <span role="cell" className="ix-sxd__demand"><i style={{ width: `${(j.purchases / maxP) * 100}%` }} /><b>{fmtInt(j.purchases)}</b><small>{j.buyers ? `${fmtInt(j.buyers)} buyers` : ''}</small></span>
              </div>
            ))}
          </div>
          <p className="ix-note">● both · ◐ supply only (sellers reached, no recorded buyers in the window) · ○ demand only. {shown.unresolved ? `${fmtInt(shown.unresolved)} purchases could not be placed in a canonical market (counted, never assigned). ` : ''}{shown.note} Not a demand score.</p>
        </>
      ) : bw.loading ? <div className="ix-skel-rows"><i /><i /><i /></div> : null}
      <div className="ix-plane__acts">
        <button type="button" className="ix-link" onClick={() => pushRoutePath('/buyer-match')}>Open Buyer Match <Icon name="arrow-up-right" size={12} /></button>
        <span className="ix-muted">Buyer Match opens on a property; pick a deal in Financial to carry its property there.</span>
      </div>
    </section>
  )
}

/** A compact line for the overview's last row when nothing external is connected (no dead widget). */
export function IntelGrowthLine() {
  const { registry, act } = useLab()
  const sources = registry.external || []
  const connected = sources.filter((s) => s.status === 'connected')
  return (
    <section className="ix-growthline lc-plane is-clear is-d1" aria-label="External intelligence">
      <span className="ix-eyebrow">Growth · external intelligence</span>
      <p>{connected.length ? `${connected.length} source${connected.length === 1 ? '' : 's'} connected.` : `No external source is connected. ${sources.map((s) => s.label).join(', ') || 'Search Console'} is declared and waits for a property and credential — nothing is estimated in the meantime.`}</p>
      <button type="button" className="ix-link" onClick={() => act.setLens('growth')}>How a source connects <Icon name="chevron-right" size={12} /></button>
    </section>
  )
}

export function IntelGrowth() {
  const { registry } = useLab()
  const sources = registry.external || []
  return (
    <div className="ix-growth">
      {sources.map((s) => (
        <section key={s.id} className="ix-source lc-plane is-crystal is-d2" aria-label={s.label}>
          <header className="ix-plane__head">
            <div>
              <span className="ix-eyebrow">{s.family} · external source</span>
              <h2>{s.label}</h2>
            </div>
            <span className={cx('ix-stamp', s.status !== 'connected' && 'is-neutral')}>{s.status === 'connected' ? 'CONNECTED' : 'NOT CONNECTED'}</span>
          </header>
          <p className="ix-source__reason">{s.reason}</p>
          <div className="ix-source__cols">
            <div>
              <span className="ix-eyebrow">What it would measure</span>
              <dl className="ix-source__metrics">
                {s.metrics.map((m) => <div key={m.id}><dt>{m.label}</dt><dd>{m.definition}</dd></div>)}
              </dl>
            </div>
            <div>
              <span className="ix-eyebrow">To connect</span>
              <ol className="ix-source__steps">{s.requires.map((r) => <li key={r}>{r}</li>)}</ol>
              <span className="ix-eyebrow">Dimensions</span>
              <p className="ix-muted">{s.dimensions.join(' · ')}</p>
              <span className="ix-eyebrow">Freshness</span>
              <p className="ix-muted">{s.freshness}</p>
            </div>
          </div>
          <p className="ix-note">When connected: top, growing and declining queries; landing pages; click and impression trends; position changes — with query ↔ page cross-filtering and the same current-vs-previous windows as the rest of the Lab. Growth stays a separate lens: it never mixes into acquisition metrics.</p>
        </section>
      ))}
      <section className="ix-source lc-plane is-clear is-d1" aria-label="The adapter contract">
        <header className="ix-plane__head"><div><span className="ix-eyebrow">Architecture</span><h2>How any outside source joins</h2></div></header>
        <ol className="ix-source__steps is-wide">
          <li>The API declares the source in the metric registry (<code>external</code>): metrics with definitions, dimensions, freshness.</li>
          <li>A read adapter answers with rows and its own data-through date; until it answers, the source is <b>not connected</b> and the Lab draws nothing.</li>
          <li>The Lab renders the source in its own lens with the shared period, comparison and cohort controls — never blended into seller metrics.</li>
          <li>Candidates after Search Console: website analytics, ads, social — each added only with a real connector, never a placeholder.</li>
        </ol>
      </section>
    </div>
  )
}
