import type { ReactNode } from 'react'
import { LCTooltip } from '../../../shared/lc'
import { useMi } from '../mi-context'
import { fmtCount, fmtPct, fmtUnit, fmtUsd } from '../mi-format'
import type { MiDossier, MiStatusPayload, MiValue } from '../mi-types'
import { INFERRED_EXPLAINER } from './inferred-copy'
import { UniverseLoad } from './surfaces-core'
import { headlineNotes } from './headline-model'

/**
 * HEADLINE STRIP: what the area is, readable in two seconds.
 *   646,180 sales · 10,099 recorded investor purchases · inferred investor (pending) · …
 * Recorded vs inferred is spelled out on the strip itself and in one explainer line, so a
 * recorded count is never read as a share of all sales ("investors are 2%").
 * Everything that is NOT available collapses into ONE quiet status line below.
 */
const ok = (v: MiValue | undefined): v is MiValue & { value: number } => v?.status === 'ok' && v.value !== null && v.value !== undefined

function Kpi({ label, value, sub, tip, tone }: { label: string; value: ReactNode; sub?: ReactNode; tip?: string; tone?: 'pending' | 'evidence' }) {
  const body = (
    <div className={`mi-kpi${tone ? ` is-${tone}` : ''}`} tabIndex={tip ? 0 : undefined}>
      <span className="mi-kpi__label">{label}</span>
      <b className="mi-kpi__value">{value}</b>
      {sub ? <span className="mi-kpi__sub">{sub}</span> : null}
    </div>
  )
  return tip ? <LCTooltip content={tip} side="bottom" align="start">{body}</LCTooltip> : body
}

export function Headline({ d }: { d: MiDossier }) {
  const { status } = useMi()
  const v = d.values
  const inf = status?.inferred_investor
  const cov = ok(v.buyer_evidence_coverage) ? v.buyer_evidence_coverage.value : null
  const period = (status?.periods ?? []).find((p) => p.id === d.window.period)?.label ?? d.window.period.toUpperCase()
  const notes = headlineNotes(d, status as MiStatusPayload | null)
  return (
    <section className="mi-headline" aria-label="Headline figures">
      <div className="mi-kpis">
        <Kpi label={`Sales · ${period}`} value={ok(v.sales_count) ? fmtCount(v.sales_count.value) : '—'} sub={ok(v.monthly_sales_rate) ? `${fmtUnit('number', v.monthly_sales_rate.value)} / month` : undefined}
          tip="Every recorded sale in the period (public record and MLS), priced or not." />
        <Kpi label="Investors · recorded" tone="evidence" value={ok(v.investor_purchase_count) ? fmtCount(v.investor_purchase_count.value) : '—'}
          sub={ok(v.investor_purchase_share) ? <>{fmtPct(v.investor_purchase_share.value)} of {fmtCount(v.investor_purchase_share.n)} with a recorded buyer</> : 'too few recorded buyers for a share'}
          tip="Recorded = the deed names an investor buyer. Most deeds name no buyer at all, so this count is a floor and its share is taken over the sales that record a buyer, never over all sales." />
        {inf?.available ? (
          <Kpi label="Investors · inferred" tone="evidence" value={ok(v.inferred_investor_count) ? fmtCount(v.inferred_investor_count.value) : '—'}
            sub={ok(v.inferred_investor_share) ? `${fmtPct(v.inferred_investor_share.value)} of ${fmtCount(v.inferred_investor_share.n)} owner-linked sales` : 'no owner-linked sales here'} tip={INFERRED_EXPLAINER} />
        ) : (
          <Kpi label="Investors · inferred" tone="pending" value={<span className="mi-pending">pending</span>} sub="owner-based · next summary build" tip={`${INFERRED_EXPLAINER} ${inf?.message ?? ''}`.trim()} />
        )}
        <Kpi label="Cash share" value={ok(v.cash_purchase_share) ? fmtPct(v.cash_purchase_share.value) : '—'} sub={ok(v.cash_purchase_share) ? `of ${fmtCount(v.cash_purchase_share.n)} with cash evidence` : 'too few sales with cash evidence'}
          tip="Cash purchases ÷ the sales whose record says cash or financed. The other sales are unknown, not financed." />
        <Kpi label="Median price" value={ok(v.median_sale_price) ? fmtUsd(v.median_sale_price.value) : '—'} sub={ok(v.median_ppsf) ? `$${Math.round(v.median_ppsf.value)} / sq ft` : undefined}
          tip="Median of qualified priced sales (arm's length, single property, no quitclaim / gift / correction deeds)." />
        {ok(v.median_price_per_unit) ? <Kpi label="MF price / door" value={fmtUsd(v.median_price_per_unit.value)} sub={`n ${fmtCount(v.median_price_per_unit.n)} multifamily sales`} tip="Median multifamily price ÷ recorded unit count, only sales with a valid unit count." /> : null}
        {ok(v.company_buyer_count) ? <Kpi label="Company buyers" value={fmtCount(v.company_buyer_count.value)} sub={ok(v.repeat_buyer_count) ? `${fmtCount(v.repeat_buyer_count.value)} bought more than once` : undefined} tip="Distinct named company buyers in the period (lenders and agencies excluded)." /> : null}
        {ok(v.sms_eligible_count) ? <Kpi label="SMS-eligible" value={fmtCount(v.sms_eligible_count.value)} sub={ok(v.seller_record_count) ? `of ${fmtCount(v.seller_record_count.value)} seller records` : undefined} tip="From the campaign target graph (summary only). Composer computes the actual audience." /> : null}
      </div>
      <p className="mi-explain">
        <b>Recorded</b> = the deed names an investor buyer{cov !== null ? <> (only <b>{fmtPct(cov)}</b> of deeds here name any buyer)</> : null}, so it is a floor, not a share of all sales.
        {' '}<b>Inferred</b> = from the property's current owner of record{inf?.available ? '.' : ', pending.'}
      </p>
      {notes.length ? (
        <p className="mi-status" role="note">
          <span className="mi-status__dot" aria-hidden="true" />
          {notes.map((n) => <span key={n.id} className="mi-status__item">{n.text}{n.id === 'universe' && d.geography.state && d.geography.level !== 'nation' ? <> <UniverseLoad states={d.geography.state} /></> : null}</span>)}
        </p>
      ) : null}
    </section>
  )
}
