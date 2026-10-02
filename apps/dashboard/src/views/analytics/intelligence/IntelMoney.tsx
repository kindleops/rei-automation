/**
 * FINANCIAL — money as first-class, with its basis always said.
 *
 * Every figure is one basis — stated (seller asking), estimated (county /
 * AVM record), modeled (engine valuation, engine offer, modeled fee),
 * authorized (engine offers the canonical readiness rule says can be spent),
 * presented, contracted, expected, actual — and they are NEVER added
 * together. Engine offers that need validation are counted, never summed:
 * one of them values a $336K duplex at $332.5M.
 *
 * This is the active pipeline NOW (Pipeline Command's scope), not the period:
 * the range does not apply; geography, property and cohort filters do.
 * Actual settled revenue is zero because no closing has settled — shown as
 * zero, with the reason, never as an estimate.
 */
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { LCDataGrid, LCEmpty, LCSegmented, cx } from '../../../shared/lc'
import type { LCColumn, LCSort } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useLab } from './intel-context'
import { usePipelineData } from './intel-hooks'
import type { MoneyDeal, MoneyResult, MoneyStage } from './intel-model'
import { LANES, STAGE_SHORT } from './intel-model'
import { fmtInt, fmtMoney } from './intel-format'
import { handleObjectClick, objectMenuEntries, useClickGesture } from '../../../modules/desktop/objects'
import { moneyDealObject } from './intel-objects'

type BasisKey = 'record' | 'asking' | 'authorized' | 'fee' | 'presented' | 'contract' | 'expected' | 'actual'
const BASES: ReadonlyArray<{ key: BasisKey; label: string; kind: string; tone: string; of: (s: MoneyStage) => { sum: number; n: number } }> = [
  { key: 'record', label: 'County / AVM estimate', kind: 'estimated', tone: 'neutral', of: (s) => s.record },
  { key: 'asking', label: 'Seller asking', kind: 'stated', tone: 'cobalt', of: (s) => s.asking },
  { key: 'authorized', label: 'Authorized engine offers', kind: 'authorized · modeled', tone: 'exec', of: (s) => ({ sum: s.authorized.offer, n: s.authorized.n }) },
  { key: 'fee', label: 'Modeled assignment fee', kind: 'modeled', tone: 'flow', of: (s) => ({ sum: s.authorized.fee, n: s.authorized.n }) },
  { key: 'presented', label: 'Presented offers', kind: 'presented', tone: 'exec', of: (s) => s.presented },
  { key: 'contract', label: 'Contract value', kind: 'contracted', tone: 'ok', of: (s) => s.contract },
  { key: 'expected', label: 'Expected revenue', kind: 'expected', tone: 'attn', of: (s) => s.expected },
  { key: 'actual', label: 'Actual settled revenue', kind: 'actual', tone: 'ok', of: (s) => s.actual },
]

export function IntelMoney({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { inspect, refreshing } = useLab()
  const { money, moneyQ } = usePipelineData()
  const [basis, setBasis] = useState<BasisKey>('record')
  if (!money) {
    return (
      <section className="ix-money lc-plane is-frosted is-d2" data-under="ok" aria-busy={moneyQ.loading}>
        {moneyQ.error ? <p className="ix-note is-bad ix-pad">The pipeline’s money didn’t load · {moneyQ.error}</p> : <div className="ix-skel-rows"><i /><i /><i /><i /></div>}
      </section>
    )
  }
  const t = money.totals
  const b = BASES.find((x) => x.key === basis) || BASES[0]
  const stages = money.stages.filter((s) => s.code !== 'closed' || s.deals)
  const max = Math.max(1, ...stages.map((s) => b.of(s).sum))
  return (
    <section className={cx('ix-money lc-plane is-frosted is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} data-under="ok" aria-label="Financial intelligence">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Financial · as of now</span>
          <h2>Value in motion, by basis</h2>
        </div>
        <p className="ix-muted">{fmtInt(t.deals)} active deals · the period does not apply · bases are never added together</p>
      </header>

      <dl className="ix-bases">
        <Basis label="County / AVM estimate" kind="estimated" value={t.record.sum} sub={`${fmtInt(t.record.n)} of ${fmtInt(t.deals)} deals carry one`} tone="neutral" />
        <Basis label="Seller asking" kind="stated" value={t.asking.sum} sub={`${fmtInt(t.asking.n)} deals${t.askingImplausible ? ` · ${t.askingImplausible} implausible excluded` : ''}`} tone="cobalt" />
        <Basis label="Authorized engine offers" kind="authorized · modeled" value={t.authorized.offer} sub={`${fmtInt(t.authorized.n)} deals · ${fmtMoney(t.authorized.fee, { zero: '$0' })} modeled fee`} tone="exec" emphasis />
        <Basis label="Needs validation" kind="modeled · not spendable" value={null} display={`${fmtInt(t.needsValidation)} deals`} sub="priced by the engine, counted — never summed" tone="attn" />
        <Basis label="Presented · contract" kind="presented · contracted" value={t.presented.sum + t.contract.sum} display={`${fmtMoney(t.presented.sum, { zero: '$0' })} · ${fmtMoney(t.contract.sum, { zero: '$0' })}`} sub={`${fmtInt(t.presented.n)} offers out · ${fmtInt(t.contract.n)} contracts`} tone="exec" />
        <Basis label="Actual settled" kind="actual" value={t.actual.sum} sub={t.actual.n ? `${fmtInt(t.actual.n)} closings` : 'no closing has settled'} tone="ok" />
      </dl>

      <div className="ix-money__stages">
        <div className="ix-money__stagehead">
          <span className="ix-eyebrow">Through the stages · {b.label.toLowerCase()}</span>
          <LCSegmented label="Basis" size="sm" value={basis} onChange={setBasis} options={BASES.filter((x) => variant === 'lens' || ['record', 'asking', 'authorized', 'actual'].includes(x.key)).map((x) => ({ value: x.key, label: x.key === 'record' ? 'Estimate' : x.key === 'asking' ? 'Asking' : x.key === 'authorized' ? 'Authorized' : x.key === 'fee' ? 'Fee' : x.key === 'presented' ? 'Presented' : x.key === 'contract' ? 'Contract' : x.key === 'expected' ? 'Expected' : 'Actual' }))} />
        </div>
        <ol className="ix-money__bars">
          {stages.map((s) => {
            const v = b.of(s)
            return (
              <li key={s.code}>
                <button type="button" onClick={() => inspect({ kind: 'stage', code: s.code })} className={cx(!v.sum && 'is-zero')} title={`${STAGE_SHORT[s.code]} ${s.label}: ${fmtMoney(v.sum, { zero: '$0' })} across ${v.n} of ${s.deals} deals`}>
                  <span className="ix-money__stage"><span className="ix-stage">{STAGE_SHORT[s.code]}</span>{s.label}</span>
                  <span className="ix-money__track"><i data-tone={b.tone} style={{ width: `${v.sum ? Math.max(1.5, (v.sum / max) * 100) : 0}%` } as CSSProperties} /></span>
                  <b>{fmtMoney(v.sum, { zero: '—' })}</b>
                  <small>{fmtInt(v.n)} / {fmtInt(s.deals)}</small>
                </button>
              </li>
            )
          })}
        </ol>
      </div>

      {t.actual.n === 0 ? (
        <LCEmpty compact icon="dollar-sign" title="No closed transactions" body={`Actual settlement analytics appear here once a closing records revenue. The closing desk holds ${fmtInt(money.ever.closings)} non-voided case${money.ever.closings === 1 ? '' : 's'}; contracts with a price: ${fmtInt(money.ever.contracts)}.`} action={{ label: 'Open Closing Desk', onClick: () => pushRoutePath('/closing-desk') }} />
      ) : null}

      {variant === 'lens' ? <MoneyDetail money={money} /> : null}
    </section>
  )
}

function Basis({ label, kind, value, display, sub, tone, emphasis }: { label: string; kind: string; value: number | null; display?: string; sub: string; tone: string; emphasis?: boolean }) {
  return (
    <div className={cx('ix-basis', emphasis && 'is-em')} data-tone={tone}>
      <dt><span>{label}</span><em>{kind}</em></dt>
      <dd><b>{display ?? fmtMoney(value, { zero: '$0' })}</b><small>{sub}</small></dd>
    </div>
  )
}

function MoneyDetail({ money }: { money: MoneyResult }) {
  const { act, inspect } = useLab()
  const [sort, setSort] = useState<LCSort>({ id: 'stage', dir: 'desc' })
  const gesture = useClickGesture()
  const rows = useMemo(() => {
    const out = [...money.deals]
    if (!sort) return out
    const key = sort.id
    const val = (d: MoneyDeal): number | string => (key === 'stage' ? d.stageIndex ?? 0 : key === 'asking' ? (d.askImplausible ? -1 : d.asking ?? -1) : key === 'record' ? d.record ?? -1 : key === 'engine' ? d.engine.recommended ?? -1 : key === 'days' ? d.daysInStage ?? -1 : key === 'market' ? d.market || '' : d.address || '')
    out.sort((a, b) => { const x = val(a); const y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (sort.dir === 'asc' ? 1 : -1) })
    return out
  }, [money.deals, sort])
  const columns: LCColumn<MoneyDeal>[] = [
    { id: 'address', header: 'Deal', minWidth: 200, sortable: true, render: (d) => <span className="ix-cell-strong">{d.address || 'Address not recorded'}</span> },
    { id: 'market', header: 'Market', width: 150, sortable: true, render: (d) => d.market || <span className="ix-muted">unresolved</span> },
    { id: 'stage', header: 'Stage', width: 150, sortable: true, render: (d) => <span><span className="ix-stage">{STAGE_SHORT[d.stage]}</span>{d.stall ? <em className="ix-cell-flag">{d.stall}</em> : null}</span> },
    { id: 'lane', header: 'Ball with', width: 140, render: (d) => { const l = LANES.find((x) => x.key === d.lane?.key); return <span className="ix-lane" data-tone={l?.tone || 'neutral'}>{l?.label || d.lane?.label || '—'}</span> } },
    { id: 'days', header: 'Days in stage', width: 104, align: 'right', sortable: true, render: (d) => fmtInt(d.daysInStage) },
    { id: 'asking', header: 'Asking · stated', width: 128, align: 'right', sortable: true, hint: 'What the seller said; implausible captures are flagged', render: (d) => (d.asking ? (d.askImplausible ? <span className="ix-muted" title="Implausible capture — excluded from totals">{fmtMoney(d.asking)} ✕</span> : fmtMoney(d.asking)) : '—') },
    { id: 'record', header: 'County est.', width: 112, align: 'right', sortable: true, hint: 'properties.estimated_value — not an appraisal', render: (d) => fmtMoney(d.record) },
    { id: 'engine', header: 'Engine offer', width: 168, align: 'right', sortable: true, hint: 'Decision Engine recommended cash offer and its readiness', render: (d) => (d.engine.state === 'not_priced' ? <span className="ix-muted">not priced</span> : <span>{fmtMoney(d.engine.recommended)} <em className={cx('ix-readiness', `is-${d.engine.state}`)}>{d.engine.state === 'authorized' ? 'authorized' : 'needs validation'}</em></span>) },
    { id: 'presented', header: 'Presented', width: 104, align: 'right', render: (d) => fmtMoney(d.presented) },
    { id: 'contract', header: 'Contract', width: 104, align: 'right', render: (d) => fmtMoney(d.contract) },
  ]
  return (
    <>
      <div className="ix-subhead"><span className="ix-eyebrow">By market (canonical geography)</span></div>
      <div className="ix-tablewrap lc-scroll">
        <table className="ix-table">
          <thead><tr><th>Market</th><th>Deals</th><th>County estimate</th><th>Seller asking</th><th>Authorized offers</th><th>Needs validation</th></tr></thead>
          <tbody>
            {money.markets.slice(0, 24).map((m) => (
              <tr key={m.key}>
                <th>{m.key === '__unresolved' ? <span className="ix-muted">Unresolved</span> : <button type="button" className="ix-link" onClick={() => act.pushSegment({ dim: 'market', value: m.key, label: m.label })} title="Narrow the Lab to this market">{m.label}</button>}</th>
                <td>{fmtInt(m.deals)}</td>
                <td>{m.record.n ? <>{fmtMoney(m.record.sum)}<small> {m.record.n}</small></> : '—'}</td>
                <td>{m.asking.n ? <>{fmtMoney(m.asking.sum)}<small> {m.asking.n}</small></> : '—'}</td>
                <td>{m.authorized.n ? <>{fmtMoney(m.authorized.offer)}<small> {m.authorized.n}</small></> : '—'}</td>
                <td>{m.needsValidation ? fmtInt(m.needsValidation) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ix-subhead"><span className="ix-eyebrow">Every deal · {fmtInt(money.deals.length)}{money.dealsTruncated ? ' (first 400)' : ''}</span><small className="ix-muted">row opens the deal in Pipeline</small></div>
      <div className="ix-grid" {...gesture.captureProps}>
        <LCDataGrid
          id="intel-money-deals"
          label="Deals in the active pipeline"
          rows={rows}
          rowKey={(d) => d.id}
          columns={columns}
          sort={sort}
          onSortChange={setSort}
          // click explains the deal here · ⇧-click inspects it (Universal Inspector) · ⌘/Ctrl-click opens it beside
          onActivate={(d) => handleObjectClick(gesture.take(), moneyDealObject(d), () => inspect({ kind: 'deal', deal: d }))}
          rowTone={(d) => (d.engine.state === 'authorized' ? 'exec' : null)}
          rowMenu={(d) => [
            { id: 'open', label: 'Open in Pipeline', icon: 'arrow-up-right', onSelect: () => pushRoutePath(`/pipeline?opp=${encodeURIComponent(d.id)}`) },
            ...(d.threadKey ? [{ id: 'inbox', label: 'Open the conversation', icon: 'message' as const, onSelect: () => pushRoutePath(`/inbox?thread=${encodeURIComponent(d.threadKey as string)}`) }] : []),
            ...(d.propertyId ? [{ id: 'buyers', label: 'Open Buyer Match for the property', icon: 'users' as const, onSelect: () => pushRoutePath(`/buyer-match?property_id=${encodeURIComponent(d.propertyId as string)}`) }] : []),
            ...objectMenuEntries(moneyDealObject(d), { omit: ['open'], showOnMap: { source: 'analytics' } }).map((e) => (e.kind === 'separator' ? e : { ...e, id: `obj-${e.id}` })),
          ]}
          total={money.deals.length}
          height={420}
          density="standard"
        />
      </div>
      <p className="ix-note"><Icon name="hash" size={12} /> {money.note}{money.offersTruncated ? ' The engine-offer read capped at 200 deals; totals cover the first 200.' : ''}</p>
    </>
  )
}
