import { LCTooltip } from '../../../shared/lc'
import { fmtCount, fmtPct } from '../mi-format'
import type { MiInferredInvestors, MiValues } from '../mi-types'

/**
 * EVIDENCE-BASED SHARES (owner, 2026-10-05: "13,183 investor purchases out of 665,000
 * sales doesn't make sense").
 *
 * A buyer is recorded on ~6% of deeds and cash/financed on ~7%, so a count of investor or
 * cash purchases must never sit beside total sales as if comparable. This plate leads
 * with the SHARE of the sales that carry the evidence, names that base, and puts the
 * evidence coverage right beside it as a meter. The raw count is secondary and is
 * phrased against its own base.
 */
type Kind = 'investor' | 'cash'
const SPEC: Record<Kind, { share: string; count: string; coverage: string; title: string; base: string; noun: string; deeds: string }> = {
  investor: { share: 'investor_purchase_share', count: 'investor_purchase_count', coverage: 'buyer_evidence_coverage', title: 'Investor share', base: 'sales with a recorded buyer', noun: 'investor purchases', deeds: 'Buyer identity is recorded' },
  cash: { share: 'cash_purchase_share', count: 'cash_purchase_count', coverage: 'cash_evidence_coverage', title: 'Cash share', base: 'sales with cash evidence', noun: 'cash purchases', deeds: 'Cash or financing is recorded' },
}

export function EvidenceShare({ kind, values, size = 'md' }: { kind: Kind; values: MiValues; size?: 'md' | 'lg' }) {
  const s = SPEC[kind]
  const share = values[s.share]
  const count = values[s.count]
  const cov = values[s.coverage]
  const covPct = cov?.status === 'ok' && cov.value !== null ? cov.value : null
  const base = share?.n ?? 0
  const explainer = covPct === null
    ? `${s.deeds} on none of the deeds in this geography for the period.`
    : `${s.deeds} on ${fmtPct(covPct)} of deeds in this geography (${fmtCount(base)} of ${fmtCount(cov?.n ?? 0)} sales). The share is taken over those ${fmtCount(base)} only; the other sales are unknown, not "not ${kind === 'investor' ? 'investor' : 'cash'}".`
  return (
    <div className={`mi-ev is-${size}`} data-kind={kind}>
      <div className="mi-ev__head">
        <span className="mi-ev__title">{s.title}</span>
        <LCTooltip content={explainer} side="top" align="start">
          <button type="button" className="mi-ev__why" aria-label={`How ${s.title.toLowerCase()} is measured`}>?</button>
        </LCTooltip>
      </div>
      <div className="mi-ev__value">
        {share?.status === 'ok' && share.value !== null ? <b>{fmtPct(share.value)}</b> : <b className="is-withheld">{share?.status === 'insufficient' ? 'Thin sample' : 'Unavailable'}</b>}
        <span className="mi-ev__base">of {fmtCount(base)} {s.base}</span>
      </div>
      <LCTooltip content={explainer} side="bottom" align="start">
        <div className="mi-ev__cov" tabIndex={0} aria-label={explainer}>
          <span className="mi-ev__meter" aria-hidden="true"><i style={{ width: `${Math.max(covPct ?? 0, 0.004) * 100}%` }} /></span>
          <span className="mi-ev__covtext"><b>{covPct === null ? '—' : fmtPct(covPct)}</b> of deeds record {kind === 'investor' ? 'the buyer' : 'cash or financing'}</span>
        </div>
      </LCTooltip>
      {count?.status === 'ok' ? <span className="mi-ev__count">{fmtCount(count.value ?? 0)} {s.noun} on record</span> : null}
    </div>
  )
}

/**
 * SLOT: "Inferred investor (owner-based)". Renders the API's inference (tiers + validation
 * note) when present; otherwise an honest "unavailable". It never computes or estimates
 * anything itself, and it is never merged with the deed-based investor share.
 */
export function InferredInvestorSlot({ data, compact }: { data: MiInferredInvestors | null | undefined; compact?: boolean }) {
  const ok = data && data.status === 'ok'
  return (
    <div className={`mi-ev is-inferred${compact ? ' is-compact' : ''}`} data-kind="inferred">
      <div className="mi-ev__head">
        <span className="mi-ev__title">{data?.label ?? 'Inferred investor (owner-based)'}</span>
        <span className="mi-ev__tag">inference, not a deed</span>
      </div>
      {ok ? (
        <>
          <div className="mi-ev__value">
            {typeof data.share === 'number' ? <b>{fmtPct(data.share)}</b> : typeof data.count === 'number' ? <b>{fmtCount(data.count)}</b> : <b className="is-withheld">—</b>}
            {data.base_n ? <span className="mi-ev__base">of {fmtCount(data.base_n)} {data.base_label ?? 'properties'}</span> : null}
          </div>
          {data.tiers?.length ? (
            <ul className="mi-ev__tiers">
              {data.tiers.map((t) => (
                <li key={t.id} title={t.definition}>
                  <span>{t.label}</span>
                  <b>{typeof t.share === 'number' ? fmtPct(t.share) : typeof t.n === 'number' ? fmtCount(t.n) : '—'}</b>
                </li>
              ))}
            </ul>
          ) : null}
          {data.validation ? <p className="mi-ev__note">{data.validation}</p> : null}
          {data.source ? <span className="mi-ev__count">{data.source}{data.as_of ? ` · as of ${data.as_of}` : ''}</span> : null}
        </>
      ) : (
        <div className="mi-ev__value"><b className="is-withheld">{data?.status === 'insufficient' ? 'Thin sample' : 'Unavailable'}</b>
          <span className="mi-ev__base">{data?.reason ?? 'Owner-based investor inference is not built for this geography yet.'}</span></div>
      )}
    </div>
  )
}
