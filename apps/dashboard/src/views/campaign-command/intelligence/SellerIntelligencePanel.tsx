import { useEffect, useState } from 'react'
import { LCError, LCSkeleton, LCTooltip, cx } from '../../../shared/lc'
import { readWhyTargeted } from './intelligence-api'
import { BAND_LABEL, COMPONENT_LABEL, EQUITY_CLASS_LABEL, LAYER_LABEL, PROVENANCE_LABEL, RANK_SOURCE_LABEL, TIER_LABEL, angleLabel, componentWords, fmtN, situationLabel, titleCase } from './intelligence-model'
import type { WhyTargetedProperty } from './intelligence-types'
import './intelligence.css'

/**
 * SELLER INTELLIGENCE (Acquisition OS §79) — one property's seller-situation
 * read: situation · tier · pressure in words with their numbers, why (each
 * evidence code with its source and provenance), the likely conversation
 * angle (only when evidence supports one), the ZIP's market quality and the
 * campaign rank (fallback clearly marked). INTERNAL — never seller-facing.
 *
 * Mountable anywhere (Property / Deal inspector): pass a property id, or a
 * row already read by the Screener.
 */

type Load = { id: string; data: WhyTargetedProperty | null; state: 'ok' | 'off' | 'missing' | 'error'; message?: string; fixture?: boolean }

export function SellerIntelligencePanel({ propertyId, preload = null, fixture = false, onRetry }: { propertyId: string; preload?: WhyTargetedProperty | null; fixture?: boolean; onRetry?: () => void }) {
  const [load, setLoad] = useState<Load | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (preload || !propertyId) return
    const ctl = new AbortController()
    readWhyTargeted([propertyId], ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      if (r.ok) {
        const p = r.data.properties.find((x) => x.property_id === propertyId) ?? null
        setLoad({ id: propertyId, data: p, state: p ? 'ok' : 'missing', fixture: r.data.fixture === true })
      } else if (r.off) setLoad({ id: propertyId, data: null, state: 'off' })
      else setLoad({ id: propertyId, data: null, state: 'error', message: r.message })
    })
    return () => ctl.abort()
  }, [propertyId, preload, nonce])

  const current: Load | null = preload ? { id: propertyId, data: preload, state: 'ok' } : load?.id === propertyId ? load : null
  if (!current) return <div className="aqi aqi-si"><LCSkeleton shape="lines" count={6} label="Reading seller intelligence" /></div>
  if (current.state === 'off') return <div className="aqi aqi-si"><p className="aqi-muted">Seller intelligence is off (SELLER_SCREENER).</p></div>
  if (current.state === 'missing') return <div className="aqi aqi-si"><p className="aqi-muted">This property isn’t in the campaign audience, so it has no seller-situation read.</p></div>
  if (current.state === 'error' || !current.data) {
    return <div className="aqi aqi-si"><LCError what="Seller intelligence didn’t load" detail={current.message} onRetry={() => { setNonce((x) => x + 1); onRetry?.() }} compact /></div>
  }
  return <SellerIntelligenceBody p={current.data} fixture={fixture || current.fixture === true} />
}

const COMPONENT_ORDER = ['forced_sale_pressure', 'equity_unlock', 'landlord_fatigue', 'tax_pain', 'property_burden', 'debt_pressure']

export function SellerIntelligenceBody({ p, fixture = false }: { p: WhyTargetedProperty; fixture?: boolean }) {
  const s = p.situation
  const scored = s && s.opportunity_tier !== 'UNKNOWN'
  const comps = COMPONENT_ORDER.map((k) => ({ k, ...componentWords(k, s?.components?.[k] ?? null) }))
  const lead = comps.filter((c) => c.level === 'high' || c.level === 'moderate').slice(0, 3)
  const evidence = [...(s?.evidence ?? [])].filter((e) => e.points > 0).sort((a, b) => b.points - a.points)
  const r = p.rank
  const m = p.market
  return (
    <article className="aqi aqi-si" aria-label="Seller intelligence">
      {fixture ? <span className="aqi-fixture">FIXTURE · offline extract 2026-10-07</span> : null}
      <header className="aqi-si__head">
        <span className="aqi-eyebrow">Seller situation</span>
        <h3 className="aqi-si__title">
          {scored ? (
            <>
              <span className={cx('aqi-tier', `is-${s!.opportunity_tier}`)}>{s!.opportunity_tier}</span>
              {situationLabel(s!.seller_situation)}
              {lead.map((c) => <span key={c.k} className={cx('aqi-si__lead', `is-${c.level}`)}> · {c.text}</span>)}
            </>
          ) : <span className="aqi-muted">Not scored — too few source facts for a tier</span>}
        </h3>
        <p className="aqi-si__where aqi-num">{p.market_name ?? '—'} · {p.zip ?? '—'} · {p.property_id}</p>
      </header>

      {scored ? (
        <>
          <section className="aqi-si__sec">
            <h4 className="aqi-eyebrow">Why</h4>
            <ul className="aqi-ev">
              {evidence.slice(0, 12).map((e) => {
                const label = p.why.find((w) => w.code === e.code)?.label ?? titleCase(e.code)
                return (
                  <li key={`${e.code}-${e.source}`}>
                    <LCTooltip content={`${e.source} · ${PROVENANCE_LABEL[e.provenance] ?? e.provenance} · +${e.points} ${COMPONENT_LABEL[e.component] ?? e.component}`}>
                      <span className={cx('aqi-ev__chip', `is-${e.provenance}`)}>{label}<em className="aqi-num">+{e.points}</em></span>
                    </LCTooltip>
                  </li>
                )
              })}
            </ul>
            <p className="aqi-foot">Tier decided by: {s!.tier_reasons.map(titleCase).join(' · ') || '—'}</p>
          </section>

          <section className="aqi-si__sec aqi-si__grid">
            <div>
              <h4 className="aqi-eyebrow">Pressure</h4>
              <ul className="aqi-comp">
                {comps.map((c) => (
                  <li key={c.k} className={cx(`is-${c.level}`)}>
                    <span>{COMPONENT_LABEL[c.k]}</span>
                    <span className="aqi-comp__bar" aria-hidden="true"><i style={{ width: `${c.level === 'unknown' ? 0 : Math.max(2, s!.components[c.k] ?? 0)}%` }} /></span>
                    <b className="aqi-num">{c.level === 'unknown' ? 'not known' : Math.round(s!.components[c.k] ?? 0)}</b>
                  </li>
                ))}
              </ul>
              <p className="aqi-foot aqi-num">Sell chance (heuristic, uncalibrated) · 90d {s!.sell_probability.d90 ?? '—'} · 180d {s!.sell_probability.d180 ?? '—'} · 365d {s!.sell_probability.d365 ?? '—'}</p>
            </div>
            <div>
              <h4 className="aqi-eyebrow">Likely angle</h4>
              <p className={cx('aqi-si__angle', !s!.conversation_angle && 'is-none')}>{angleLabel(s!.conversation_angle)}</p>
              <h4 className="aqi-eyebrow">Market · ZIP {p.zip ?? ''}</h4>
              {m && m.score !== null ? (
                <ul className="aqi-kv">
                  <li><span>Market quality</span><b className="aqi-num">{m.score} · {m.label}</b></li>
                  <li><span>Liquidity</span><b className="aqi-num">{m.terms.liquidity ?? 'not measured'}{m.inputs.qualified_sales_1y !== null && m.inputs.qualified_sales_1y !== undefined ? ` · ${fmtN(m.inputs.qualified_sales_1y)} sales/yr` : ''}</b></li>
                  <li><span>Buyer depth</span><b className="aqi-num">{m.terms.buyer_depth ?? 'not measured'}{m.inputs.distinct_investor_buyers_36m !== null && m.inputs.distinct_investor_buyers_36m !== undefined ? ` · ${fmtN(m.inputs.distinct_investor_buyers_36m)} investor buyers/36m` : ''}</b></li>
                  <li><span>Investor activity</span><b className="aqi-num">{m.terms.investor_activity ?? 'not measured'}</b></li>
                </ul>
              ) : <p className="aqi-muted">No MI rollup for this ZIP.</p>}
            </div>
          </section>
        </>
      ) : null}

      {r ? (
        <section className="aqi-si__sec">
          <h4 className="aqi-eyebrow">Campaign rank</h4>
          <p className={cx('aqi-si__rank', r.rank_source !== 'v2' && 'is-fallback')}>
            <b>{BAND_LABEL[r.band]}</b>
            <span className="aqi-num">priority {r.score === null ? '—' : r.score.toFixed(1)}{r.priority_score === null ? ' · not eligible' : ''}</span>
            <span>{RANK_SOURCE_LABEL[r.rank_source]}{r.fallback_reason ? ` · ${titleCase(r.fallback_reason)}` : ''}</span>
          </p>
          {r.layers ? (
            <ul className="aqi-terms">
              {(['contact', 'pressure', 'deal', 'market'] as const).map((k) => {
                const L = r.layers![k]
                const shown = k === 'pressure' ? r.layers!.pressure.effective : L.score
                const tip = k === 'contact'
                  ? r.layers!.contact.evidence.map((e) => `${titleCase(e.code)} ${e.points >= 0 ? '+' : ''}${e.points}`).join(' · ')
                  : k === 'pressure'
                    ? `${r.layers!.pressure.source === 'legacy_fallback' ? 'Legacy fallback (no current seller evidence)' : 'Seller situation v2'} · ${r.layers!.pressure.score.toFixed(1)} × contact gate ${r.layers!.pressure.gate.toFixed(2)}`
                    : k === 'deal'
                      ? `${EQUITY_CLASS_LABEL[r.layers!.deal.equity.class]}${r.layers!.deal.equity.percent === null ? ' (% unknown — never assumed 100%)' : ` · ${r.layers!.deal.equity.percent}%`} · rule ${r.layers!.deal.equity.rule}`
                      : `${r.layers!.market.used_prior ? 'Market quality not measured — neutral 50' : `Market quality ${r.layers!.market.market_quality}`}${r.layers!.market.response_context_points === null ? ' · no response context' : ` · response context ${r.layers!.market.response_context_points} (capped ±4)`}`
                return (
                  <li key={k} className={cx(k === 'pressure' && r.layers!.pressure.source !== 'seller_situation_v2' && 'is-prior')}>
                    <LCTooltip content={tip}><span>{LAYER_LABEL[k]} <em className="aqi-muted">×{L.weight}</em></span></LCTooltip>
                    <b className="aqi-num">{shown.toFixed(1)}</b>
                  </li>
                )
              })}
            </ul>
          ) : null}
          <p className="aqi-foot aqi-num">{r.ranking_version} · contact signals known {r.coverage.contact_signals_known ?? '—'}/5 · equity {r.coverage.equity_known ? 'known' : 'unknown'} · market {r.coverage.market_known ? 'measured' : 'not measured'}</p>
        </section>
      ) : null}

      <footer className="aqi-si__prov aqi-num">
        {s ? <>{s.score_version} · {s.input_model_version} · scored {new Date(s.scored_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {s.computed === 'in_process' ? 'computed on read' : s.computed} · coverage {s.coverage.fields_known}/{s.coverage.fields_total} · {TIER_LABEL[s.opportunity_tier]}</> : 'No seller-situation read'}
      </footer>
    </article>
  )
}
