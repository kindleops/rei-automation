import { LCTooltip } from '../../../shared/lc'
import { fmtCount, fmtPct } from '../mi-format'
import type { MiInferredInvestors, MiValues } from '../mi-types'
import { TIER_DEFINITION } from '../sale-owner/sale-owner-client'
import { INFERRED_EXPLAINER, INFERRED_TITLE, STACK_FOOTNOTE } from './inferred-copy'

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

// ── Inferred investors (owner-based) — rendered from the API only (INFERRED_INVESTOR_UI.txt) ──

/** Compact plate (rail, inspector): the API's label line verbatim, owner-link coverage, confidence. */
export function InferredInvestorSlot({ data, compact }: { data: MiInferredInvestors | null | undefined; compact?: boolean }) {
  const ok = Boolean(data?.available)
  const precision = data?.validation?.local?.precision ?? data?.validation?.national?.precision ?? null
  const local = Boolean(data?.validation?.local)
  return (
    <div className={`mi-ev is-inferred${compact ? ' is-compact' : ''}`} data-kind="inferred">
      <div className="mi-ev__head">
        <span className="mi-ev__title">Inferred investor (owner-based)</span>
        <span className="mi-ev__tag">modeled</span>
        <LCTooltip content={INFERRED_EXPLAINER} side="top" align="start"><button type="button" className="mi-ev__why" aria-label="How inferred investors are measured">?</button></LCTooltip>
      </div>
      {ok ? (
        <>
          <p className="mi-ev__label">{data!.label}</p>
          <div className="mi-ev__cov">
            <span className="mi-ev__meter is-inferred" aria-hidden="true"><i style={{ width: `${Math.max(data!.coverage ?? 0, 0.004) * 100}%` }} /></span>
            <span className="mi-ev__covtext">Owner-linked on <b>{data!.coverage === null || data!.coverage === undefined ? '—' : fmtPct(data!.coverage)}</b> of sales</span>
          </div>
          {precision !== null ? <span className="mi-ev__count">Confidence: {fmtPct(precision)} precision vs recorded buyers {local ? `here (n ${fmtCount(data!.validation!.local_n)})` : 'nationally'}</span> : null}
        </>
      ) : (
        <div className="mi-ev__value"><b className="is-withheld">Unavailable</b><span className="mi-ev__base">{data?.message ?? 'Owner-based investor inference is not available for this geography.'}</span></div>
      )}
    </div>
  )
}

const TIER_TONE: Record<string, string> = { strong: 'is-strong', likely: 'is-likely' }

/** Investors surface panel: recorded and inferred side by side, never merged (spec §2 A–E). */
export function InferredInvestorsPanel({ data, values }: { data: MiInferredInvestors | null | undefined; values: MiValues }) {
  const ok = Boolean(data?.available)
  const tiers = data?.tiers ?? []
  const linked = tiers.reduce((t, x) => t + (x.n || 0), 0)
  const nat = data?.validation?.national ?? null
  const loc = data?.validation?.local ?? null
  return (
    <section className="mi-card mi-inferred" aria-label={INFERRED_TITLE}>
      <h2>{INFERRED_TITLE} <small>{INFERRED_EXPLAINER}</small></h2>
      <div className="mi-inferred__kpis">
        <div className="mi-inferred__kpi is-recorded">
          <span className="mi-inferred__kind">Recorded investor (deed buyer)</span>
          {ok && data!.recorded_label ? <p className="mi-ev__label">{data!.recorded_label}</p> : <EvidenceShare kind="investor" values={values} />}
        </div>
        <div className="mi-inferred__kpi is-inferred">
          <span className="mi-inferred__kind">Inferred investor (owner-based)</span>
          {ok ? (
            <>
              <p className="mi-ev__label">{data!.label}</p>
              <span className="mi-ev__covtext">Owner-linked on <b>{data!.coverage === null || data!.coverage === undefined ? '—' : fmtPct(data!.coverage)}</b> of sales{typeof data!.linked === 'number' && typeof data!.sales === 'number' ? ` (${fmtCount(data!.linked)} of ${fmtCount(data!.sales)})` : ''}</span>
            </>
          ) : <p className="mi-ev__label is-withheld">{data?.message ?? 'Unavailable'}</p>}
        </div>
      </div>
      {ok && linked > 0 ? (
        <>
          <div className="mi-tierbar" role="img" aria-label="Linked sales by owner tier">
            {tiers.map((t) => (
              <LCTooltip key={t.id} content={`${t.label}. ${TIER_DEFINITION[t.id] ?? ''} ${fmtCount(t.n)} sales (${fmtPct(t.n / linked)} of linked).${t.counted ? ' Counted as inferred investor.' : ' Not counted.'}`}>
                <span className={`mi-tierbar__seg ${TIER_TONE[t.id] ?? 'is-muted'}`} style={{ flexGrow: Math.max(t.n, 0) }} tabIndex={0} aria-label={`${t.label}: ${fmtCount(t.n)}`} />
              </LCTooltip>
            ))}
          </div>
          <ul className="mi-tierbar__legend">
            {tiers.map((t) => <li key={t.id} className={t.counted ? 'is-counted' : undefined}><i className={TIER_TONE[t.id] ?? 'is-muted'} />{t.label}<b>{fmtCount(t.n)}</b></li>)}
          </ul>
          <details className="mi-evidence">
            <summary>Evidence: how well the inference matches recorded buyers</summary>
            {nat ? (
              <>
                <p className="mi-quiet">Nationally: <b>{nat.precision === null || nat.precision === undefined ? '—' : fmtPct(nat.precision)}</b> precision, <b>{nat.recall === null || nat.recall === undefined ? '—' : fmtPct(nat.recall)}</b> recall on {fmtCount(nat.n ?? 0)} sales that record a buyer.{nat.truth ? ` ${nat.truth}` : ''}</p>
                {nat.matrix ? (
                  <table className="mi-table is-matrix">
                    <thead><tr><th>Owner tier</th><th className="r">Recorded investor</th><th className="r">Recorded other buyer</th><th className="r">Precision</th></tr></thead>
                    <tbody>{Object.entries(nat.matrix).map(([tier, m]) => (
                      <tr key={tier}><td>{tiers.find((t) => t.id === tier)?.label ?? tier}</td><td className="r">{fmtCount(m.recorded_investor)}</td><td className="r">{fmtCount(m.recorded_other)}</td>
                        <td className="r">{m.recorded_investor + m.recorded_other ? fmtPct(m.recorded_investor / (m.recorded_investor + m.recorded_other)) : '—'}</td></tr>
                    ))}</tbody>
                  </table>
                ) : null}
              </>
            ) : <p className="mi-quiet">National validation not available.</p>}
            <p className="mi-quiet">{loc ? `Here: ${loc.precision === null || loc.precision === undefined ? '—' : fmtPct(loc.precision)} precision on ${fmtCount(data!.validation!.local_n)} sales.` : `Too few recorded buyers here to validate locally (${fmtCount(data?.validation?.local_n ?? 0)}).`}</p>
            {data!.caveats?.length ? <ul className="mi-caveats">{data!.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
          </details>
          {data!.top_stacks?.length ? (
            <>
              <h3 className="mi-sub">Portfolio stacks</h3>
              <table className="mi-table">
                <thead><tr><th>Owner portfolio</th><th className="r">Linked purchases</th><th className="r">Properties at the mailing address</th><th className="r">Entity share</th></tr></thead>
                <tbody>{data!.top_stacks.map((st) => (
                  <tr key={st.stack}>
                    <td>{st.named && st.name_evidence ? <LCTooltip content={st.name_evidence}><span tabIndex={0}>{st.label}</span></LCTooltip> : st.label}</td>
                    <td className="r">{fmtCount(st.linked_purchases)}</td>
                    <td className="r">{fmtCount(st.properties_at_mailing_address)}</td>
                    <td className="r">{typeof st.entity_share === 'number' ? fmtPct(st.entity_share) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
              <p className="mi-quiet">{STACK_FOOTNOTE}</p>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
