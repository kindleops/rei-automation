/**
 * EVIDENCE LAYER — what the decision stands on: comps, what the seller said
 * vs what the record says, recorded debt, the property's history, demand.
 * Estimates are labelled estimates; nothing is netted into a fake payoff.
 */
import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { IconName } from '../../../../shared/icons'
import type { DealDecision } from '../../../../domain/deal-intelligence/deal-decision-api'
import { money, shortDate } from '../../../../domain/deal-intelligence/deal-decision-api'
import { cls, DdCard, DdLink, Meter, ProvenanceChip } from './dd-primitives'

const SOURCE_LABEL: Record<string, string> = { mls_sold: 'MLS', public_record_sold: 'Public record' }

export function CompEvidence({ d, onOpenComps }: { d: DealDecision; onOpenComps: () => void }) {
  const [all, setAll] = useState(false)
  const c = d.comps
  if (!c) return null
  const maxRej = Math.max(1, ...c.rejectionBreakdown.map((r) => r.count))
  const top = all ? c.top : c.top.slice(0, 3)
  return (
    <DdCard id="comps" title="Comparable sales" icon="stats" tone={c.selected === 0 ? 'bad' : c.selected <= 2 ? 'warn' : undefined}
      meta={`${c.selected} qualified${c.raw !== null ? ` of ${c.raw}` : ''}`}
      action={<DdLink icon="stats" label="Open in Comps" onClick={onOpenComps} />}>
      <div className="ddx-quality">
        <div><span>Qualified</span><b>{c.selected}</b><em>{c.eligible !== null ? `${c.eligible} eligible` : ''}</em></div>
        <div><span>Dispersion</span><b>{c.dispersion !== null ? `${Math.round(c.dispersion * 100)}%` : '—'}</b><em>{c.dispersion === null ? '' : c.dispersion > 0.35 ? 'wide' : c.dispersion > 0.2 ? 'moderate' : 'tight'}</em></div>
        <div><span>Avg distance</span><b>{c.avgDistanceMiles !== null ? `${c.avgDistanceMiles} mi` : '—'}</b><em /></div>
        <div><span>Median age</span><b>{c.medianAgeMonths !== null ? `${c.medianAgeMonths} mo` : '—'}</b><em /></div>
      </div>
      {Object.keys(c.sources).length ? (
        <p className="ddx-note">Sources: {Object.entries(c.sources).map(([k, n]) => `${SOURCE_LABEL[k] ?? k} ${n}`).join(' · ')}{c.completeness !== null ? ` · field completeness ${c.completeness}%` : ''}</p>
      ) : null}
      {c.message && c.selected === 0 ? <p className="ddx-note is-warn">{c.message}</p> : null}
      {top.length ? (
        <ul className="ddx-comps">
          {top.map((x, i) => (
            <li key={x.id ?? i} className="ddx-comp" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="ddx-comp__row">
                <b>{money(x.salePrice)}</b>
                {x.adjustedValue && x.salePrice && Math.abs(x.adjustedValue - x.salePrice) > 500 ? <span className="ddx-comp__adj">adj. {money(x.adjustedValue)}</span> : null}
                <span className="ddx-comp__when">{shortDate(x.saleDate)}</span>
              </div>
              <p className="ddx-comp__addr">{x.address}</p>
              <div className="ddx-comp__meta">
                {x.distanceMiles !== null ? <span>{x.distanceMiles.toFixed(2)} mi</span> : null}
                {x.score !== null ? <span>match {Math.round(x.score)}</span> : null}
                {x.weight !== null ? <span>weight {Math.round(x.weight * 100)}%</span> : null}
                {x.source ? <span>{SOURCE_LABEL[x.source] ?? x.source}</span> : null}
              </div>
              {x.mismatches.length ? <p className="ddx-comp__miss">Differs: {x.mismatches.map((m) => `${m.feature} ${String(m.comp)} vs ${String(m.subject)}`).join(' · ')}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {c.top.length > 3 ? <button type="button" className="ddx-more" onClick={() => setAll((v) => !v)}>{all ? 'Show top 3' : `Show top ${c.top.length}`}</button> : null}
      {c.rejectionBreakdown.length ? (
        <div className="ddx-rejects">
          <span className="ddx-sub">Why {c.rejected ?? ''} were rejected</span>
          {c.rejectionBreakdown.map((r) => (
            <div key={r.reason} className="ddx-rejects__row"><span>{r.label}</span><i style={{ width: `${(r.count / maxRej) * 100}%` }} /><b>{r.count}</b></div>
          ))}
        </div>
      ) : null}
      {c.anchor ? (
        <figure className="ddx-anchor">
          <figcaption>Comp the automation may cite{c.anchor.disclosed ? ' · already disclosed' : ''}</figcaption>
          <blockquote>{c.anchor.statement ?? `${c.anchor.address} sold for ${money(c.anchor.salePrice)}`}</blockquote>
        </figure>
      ) : null}
    </DdCard>
  )
}

export function SellerFacts({ d }: { d: DealDecision }) {
  if (!d.sellerFacts.length) return null
  const groups = new Map<string, typeof d.sellerFacts>()
  for (const f of d.sellerFacts) groups.set(f.label, [...(groups.get(f.label) ?? []), f])
  const conflicts = [...groups.values()].filter((g) => g.length > 1 && new Set(g.map((f) => (f.display ?? '').toLowerCase())).size > 1).length
  return (
    <DdCard id="facts" title="Seller facts" icon="user" meta={conflicts ? <b>{conflicts} differ by source</b> : `${d.sellerFacts.length} facts`}>
      <ul className="ddx-facts">
        {[...groups.entries()].map(([label, facts]) => (
          <li key={label} className={cls('ddx-fact', facts.length > 1 && 'is-multi')}>
            <span className="ddx-fact__label">{label}</span>
            <div className="ddx-fact__vals">
              {facts.map((f) => (
                <div key={f.key} className="ddx-fact__val">
                  <ProvenanceChip p={f.provenance} />
                  <b>{f.display}</b>
                  {f.quote ? <em>“{f.quote}”</em> : null}
                  {f.at ? <small>{shortDate(f.at)}</small> : null}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </DdCard>
  )
}

export function DebtAndLiens({ d }: { d: DealDecision }) {
  const e = d.economics
  const debt = e.debt
  const has = debt.mortgages.length || e.liens.length || e.foreclosure || debt.estOpenBalance
  return (
    <DdCard id="debt" title="Debt, liens & tax" icon="dollar-sign" tone={e.foreclosure ? 'bad' : e.liens.length ? 'warn' : undefined}
      meta={[debt.estOpenBalance ? `${money(debt.estOpenBalance)} est. open` : null, e.liens.length ? `${e.liens.length} lien${e.liens.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'none recorded'}
      defaultOpen={Boolean(e.foreclosure || e.liens.length)}>
      {!has ? <p className="ddx-empty">No recorded mortgages, liens or foreclosure filings.</p> : null}
      {e.atOffer && debt.estOpenBalance ? (
        <div className={cls('ddx-cover', e.atOffer.debtCovered ? 'is-yes' : 'is-no')}>
          <Icon name={e.atOffer.debtCovered ? 'check' : 'alert'} />
          <span>Engine offer {money(e.atOffer.offer)} {e.atOffer.debtCovered ? 'covers' : 'does not cover'} the {money(debt.estOpenBalance)} estimated open balance.</span>
        </div>
      ) : null}
      {debt.mortgages.length ? (
        <ul className="ddx-loans">
          {debt.mortgages.map((m, i) => (
            <li key={`${m.position}-${i}`}>
              <span className="ddx-loans__pos">{m.position ? `#${m.position}` : '—'}</span>
              <div>
                <b>{m.lender ?? 'Lender not recorded'}</b>
                <span>{[m.type, m.amount ? `${money(m.amount)} original` : null, m.rate ? `${m.rate}%` : null, m.recordedAt ? `rec. ${shortDate(m.recordedAt)}` : null].filter(Boolean).join(' · ')}</span>
              </div>
              <em>{m.estBalance ? `${money(m.estBalance)} est.` : 'balance unknown'}</em>
            </li>
          ))}
        </ul>
      ) : null}
      {debt.unknownBalances ? <p className="ddx-note">{debt.unknownBalances} recorded loan{debt.unknownBalances === 1 ? ' has' : 's have'} no balance estimate (often a modification) — the open balance may be understated. Balances are provider estimates, not payoff letters.</p> : null}
      {e.liens.length ? (
        <>
          <span className="ddx-sub">Liens</span>
          <ul className="ddx-loans is-liens">
            {e.liens.map((l, i) => (
              <li key={i}>
                <span className="ddx-loans__pos"><Icon name="flag" /></span>
                <div><b>{l.type ?? 'Lien'}</b><span>{[l.holder, l.at ? shortDate(l.at) : null].filter(Boolean).join(' · ')}</span></div>
                <em>{money(l.amount) ?? 'amount not stated'}</em>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {e.foreclosure ? (
        <div className="ddx-fcl">
          <b>{e.foreclosure.status ?? 'Foreclosure filing'}</b>
          <span>{[e.foreclosure.docType, e.foreclosure.defaultAt ? `default ${shortDate(e.foreclosure.defaultAt)}` : null, e.foreclosure.auctionAt ? `auction ${shortDate(e.foreclosure.auctionAt)}` : null].filter(Boolean).join(' · ')}</span>
        </div>
      ) : null}
      <dl className="ddx-kv">
        {e.tax.annual ? <div><dt>Annual tax{e.tax.year ? ` (${e.tax.year})` : ''}</dt><dd>{money(e.tax.annual, { exact: true })}</dd></div> : null}
        <div><dt>Tax status</dt><dd className={e.tax.delinquent ? 'is-bad' : ''}>{e.tax.delinquent ? `Delinquent${e.tax.delinquentYear ? ` since ${e.tax.delinquentYear}` : ''}` : 'Current on record'}</dd></div>
        {debt.monthlyPayment ? <div><dt>Loan payments</dt><dd>{money(debt.monthlyPayment)}/mo est.</dd></div> : null}
        {e.avmRange ? <div><dt>AVM range</dt><dd>{money(e.avmRange.low)}–{money(e.avmRange.high)}{e.avmRange.confidence ? ` · conf ${e.avmRange.confidence}` : ''}</dd></div> : null}
      </dl>
    </DdCard>
  )
}

const KIND_ICON: Record<string, IconName> = { sale: 'home', mortgage: 'dollar-sign', lien: 'flag', foreclosure: 'alert', ask: 'message', analysis: 'cpu', offer: 'send' }

export function HistoryTimeline({ d }: { d: DealDecision }) {
  const [all, setAll] = useState(false)
  if (!d.history.length) return null
  const rows = all ? d.history : d.history.slice(0, 6)
  return (
    <DdCard id="history" title="History" icon="clock" meta={`${d.history.length} events`} defaultOpen={false}>
      <ol className="ddx-tl">
        {rows.map((h, i) => (
          <li key={`${h.kind}-${h.at}-${i}`} className={cls('ddx-tl__item', `k-${h.kind}`)}>
            <span className="ddx-tl__dot"><Icon name={KIND_ICON[h.kind] ?? 'clock'} /></span>
            <div>
              <div className="ddx-tl__row"><b>{h.title}</b>{h.amount ? <strong>{money(h.amount)}</strong> : null}</div>
              <span>{[shortDate(h.at), h.detail].filter(Boolean).join(' · ')}</span>
            </div>
          </li>
        ))}
      </ol>
      {d.history.length > 6 ? <button type="button" className="ddx-more" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${d.history.length}`}</button> : null}
    </DdCard>
  )
}

export function ValuationTrend({ d }: { d: DealDecision }) {
  const pts = d.valuationHistory.filter((p) => p.mid)
  if (pts.length < 2) return null
  const vals = pts.flatMap((p) => [p.mid ?? 0, p.offer ?? p.mid ?? 0])
  const lo = Math.min(...vals) * 0.95
  const hi = Math.max(...vals) * 1.05
  const x = (i: number) => (i / (pts.length - 1)) * 300
  const y = (v: number) => 70 - ((v - lo) / (hi - lo || 1)) * 60
  const line = (k: 'mid' | 'offer') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y((p[k] ?? p.mid) as number).toFixed(1)}`).join(' ')
  return (
    <DdCard id="trend" title="Analysis history" icon="trending-up" meta={`${pts.length} snapshots`} defaultOpen={false}>
      <svg className="ddx-trend" viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="Engine value and offer across snapshots">
        <path d={line('mid')} className="ddx-trend__mid" />
        <path d={line('offer')} className="ddx-trend__offer" />
      </svg>
      <div className="ddx-trend__legend"><span><i className="k-mid" />Value</span><span><i className="k-offer" />Offer</span></div>
      <ul className="ddx-snaps">
        {[...pts].reverse().slice(0, 5).map((p) => (
          <li key={p.at}><span>{shortDate(p.at)}</span><b>{money(p.mid)}</b><em>{money(p.offer) ?? '—'} · {p.tier}</em></li>
        ))}
      </ul>
    </DdCard>
  )
}

export function BuyerDemand({ d, onOpenBuyers }: { d: DealDecision; onOpenBuyers: () => void }) {
  const b = d.buyers
  return (
    <DdCard id="buyers" title="Buyer demand" icon="users" meta={b ? `${b.candidates} matched` : 'no match run'} defaultOpen={false}
      action={<DdLink icon="users" label="Open Buyer Match" onClick={onOpenBuyers} />}>
      {b ? (
        <>
          <div className="ddx-quality">
            <div><span>Matched</span><b>{b.candidates}</b><em>{b.topScore !== null ? `top ${Math.round(b.topScore)}` : ''}</em></div>
            <div><span>A-grade</span><b>{b.grades.A ?? 0}</b><em /></div>
            <div><span>Packages</span><b>{b.packagesSent}</b><em>{b.interested ? `${b.interested} interested` : ''}</em></div>
            <div><span>Median dispo</span><b>{money(b.medianDispo) ?? '—'}</b><em>suggested</em></div>
          </div>
          <div className="ddx-types">{b.types.map((t) => <span key={t.type}>{t.type} <b>{t.count}</b></span>)}</div>
        </>
      ) : <p className="ddx-empty">Buyer Match hasn’t been run for this property, so there is no measured demand.</p>}
    </DdCard>
  )
}

export function ConfidenceBars({ d }: { d: DealDecision }) {
  if (d.decision.status !== 'available' || !d.decision.confidenceBreakdown) return null
  const cb = d.decision.confidenceBreakdown
  const rows: Array<[string, number | null, string]> = [
    ['Valuation', cb.valuation, '45%'],
    ['Subject data', cb.subject, '20%'],
    ['Buyer behavior', cb.buyer, '20%'],
    ['Finance & distress', cb.finance, '15%'],
  ]
  return (
    <div className="ddx-conf">
      {rows.map(([k, v, w]) => (
        <div key={k} className="ddx-conf__row"><span>{k} <em>{w}</em></span><Meter value={v} /><b>{v ?? '—'}</b></div>
      ))}
      {cb.missing.length ? <p className="ddx-note">Missing inputs: {cb.missing.join(', ')}</p> : null}
    </div>
  )
}
