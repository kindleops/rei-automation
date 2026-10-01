import { useState } from 'react'
import { LCButton, LCFacts, LCIconButton, LCInspector, LCInspectorSection, LCStatus, cx } from '../../../shared/lc'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import {
  fmtAge, fmtDate, fmtInt, fmtMiles, fmtMoney, fmtUnitValue, saleAgeDays, transactionsOfProperty, unitValue, weaknesses, whyExcluded, whyIncluded,
  type ExplainContext,
} from '../../../domain/comp-intelligence/comps-workstation-model'
import { staticStreetViewUrl } from '../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'
import type { Tier, Workstation } from './derive-workstation'

const CATEGORY: Record<string, string> = { core: 'Property', location_context: 'Location', quality_condition: 'Quality & condition', amenities_structure: 'Amenities & structure', utility_mechanical: 'Utilities' }
const DIM: Record<string, string> = { asset_type: 'Asset type', units: 'Units', sqft: 'Size', beds: 'Beds', baths: 'Baths', year_built: 'Year built', lot_sqft: 'Lot', condition: 'Condition', zip: 'ZIP', subdivision: 'Subdivision', zoning: 'Zoning', garage: 'Garage', pool: 'Pool', stories: 'Stories' }
const ADJ: Record<string, string> = { sale_price: 'Sale price as recorded', price_per_unit: 'Per unit × subject units', price_per_building_sqft: 'Per sq ft × subject sq ft', price_per_lot_sqft: 'Per lot sq ft × subject lot', bedroom_count: 'Bedroom ratio', repair_difference: 'Repair difference' }
const STATUS_WORD = { exact_or_near: 'matches', similar: 'similar', mismatch: 'differs' } as const

interface Props {
  m: Workstation
  c: EvidenceComp | null
  tier: Tier | null
  ctx: ExplainContext
  onClose: () => void
  onInclude: (c: EvidenceComp) => void
  onExclude: (c: EvidenceComp) => void
  onGraph: (c: EvidenceComp) => void
  onFocusLinked: (c: EvidenceComp) => void
}

/** The refined evidence inspector (§65–70): one sale, every question about it answerable here. */
export function CompInspector({ m, c, tier, ctx, onClose, onInclude, onExclude, onGraph, onFocusLinked }: Props) {
  const [photoFailed, setPhotoFailed] = useState<string | null>(null)
  if (!c || !tier) return <LCInspector open={false} onClose={onClose} id="comps-evidence" title="">{null}</LCInspector>

  const inSet = tier === 'set' || tier === 'added'
  const days = saleAgeDays(c, m.now)
  const rank = inSet ? m.lensComps.findIndex((x) => x.key === c.key) + 1 : 0
  const totalWeight = m.lensComps.reduce((s, x) => s + (x.engine?.weight ?? 0), 0)
  const share = inSet && totalWeight > 0 && c.engine?.weight ? c.engine.weight / totalWeight : null
  const why = tier === 'excluded' ? whyExcluded(c, ctx) : whyIncluded(c, ctx)
  const weak = tier === 'excluded' ? [] : weaknesses(c, ctx)
  const unit = unitValue(c, m.metric)
  const photo = c.photo ?? staticStreetViewUrl(c.address, c.lat, c.lng)
  const history = transactionsOfProperty(m.w.comps, c)
  const e = c.engine
  const s = m.w.subject
  const stateLabel = tier === 'set' ? `Priced by the engine · #${rank} by weight` : tier === 'added' ? `Added by you · #${rank} by weight` : tier === 'removed' ? 'Removed by you from the system set' : tier === 'excluded' ? 'Excluded' : 'Candidate'
  const blendTotal = (e?.adjustments ?? []).reduce((t, a) => t + (a.amount === null && a.weight ? a.weight : 0), 0)

  const action = tier === 'excluded' || !e?.eligible ? null : inSet
    ? <LCButton variant="secondary" icon="slash" onClick={() => onExclude(c)}>Exclude from your set</LCButton>
    : <LCButton variant="primary" icon="check" onClick={() => onInclude(c)}>{tier === 'removed' ? 'Restore to your set' : 'Include in your set'}</LCButton>

  return (
    <LCInspector
      open
      onClose={onClose}
      id="comps-evidence"
      mode="float"
      width={400}
      minWidth={340}
      maxWidth={560}
      contentKey={c.key}
      eyebrow={stateLabel}
      title={c.address ?? 'Comparable sale'}
      subtitle={[c.city, fmtMiles(c.distanceMiles) ? `${fmtMiles(c.distanceMiles)} from the subject` : null].filter(Boolean).join(' · ')}
      status={<LCStatus tone={inSet ? 'exec' : tier === 'excluded' ? 'neutral' : 'neutral'} hollow={tier === 'excluded' || tier === 'removed'} label={tier === 'excluded' ? 'Not evidence' : inSet ? 'In the shown set' : tier === 'removed' ? 'Out of your set' : 'Admissible'} quiet={!inSet} />}
      actions={
        <>
          {c.propertyId ? <LCIconButton icon="radar" label="Open in Entity Graph" size="sm" onClick={() => onGraph(c)} /> : null}
          {c.propertyId ? <LCIconButton icon="link" label="Focus linked apps on this property" size="sm" onClick={() => onFocusLinked(c)} /> : null}
        </>
      }
      footer={action ? <div className="ciw-insp__foot">{action}</div> : undefined}
      className="ciw-insp"
    >
      {photo && photoFailed !== photo ? (
        <div className="ciw-insp__photo"><img src={photo} alt="" loading="lazy" onError={() => setPhotoFailed(photo)} /></div>
      ) : null}

      <div className="ciw-insp__hero lc-num">
        <div><span className="lc-eyebrow">Sold</span><b>{fmtMoney(c.salePrice, { exact: true }) ?? '—'}</b><em>{fmtDate(c.saleDate, 'long') ?? 'undated'}{days !== null ? ` · ${fmtAge(days)} ago` : ''}</em></div>
        <div><span className="lc-eyebrow">{m.metric.label}</span><b>{unit !== null ? fmtUnitValue(unit, m.metric) : '—'}</b><em>{c.sqft ? `${fmtInt(c.sqft)} sf` : m.kind === 'multifamily' && c.units ? `${c.units} units` : ' '}</em></div>
        {e?.eligible && e.adjustedPrice ? <div><span className="lc-eyebrow">Adjusted to subject</span><b>{fmtMoney(e.adjustedPrice, { exact: true })}</b><em>{share !== null ? `${(share * 100).toFixed(1)}% of the set’s weight` : 'engine adjustment'}</em></div> : null}
      </div>

      <LCInspectorSection title={tier === 'excluded' ? 'Why excluded' : 'Why it is evidence'}>
        <ul className="ciw-reasons">{why.map((r) => <li key={r.code} data-tone={r.tone}>{r.text}</li>)}</ul>
      </LCInspectorSection>

      {weak.length ? (
        <LCInspectorSection title="Weaknesses">
          <ul className="ciw-reasons">{weak.map((r) => <li key={r.code} data-tone={r.tone}>{r.text}</li>)}</ul>
        </LCInspectorSection>
      ) : null}

      {e?.eligible ? (
        <LCInspectorSection title={e.origin === 'stored' ? 'How the engine weighed it · as priced' : 'How the engine weighs it · today'}>
          <div className="ciw-weightline lc-num">
            <span><em>comparability</em><b>{e.score?.toFixed(1) ?? '—'}</b></span><i>×</i>
            <span><em>confidence</em><b>{e.confidence?.toFixed(1) ?? '—'}</b></span><i>×</i>
            <span><em>recency</em><b>{e.recency !== null && e.recency !== undefined ? `${e.recency}%` : '—'}</b></span><i>×</i>
            <span><em>source</em><b>{e.saleSource === 'mls_sold' ? `MLS ×${m.rules?.weight.mlsFactor ?? 1}` : `×${m.rules?.weight.otherFactor ?? 0.92}`}</b></span><i>=</i>
            <span className="is-result"><em>weight</em><b>{e.weight?.toFixed(4) ?? '—'}</b></span>
          </div>
          {c.today && c.state === 'system' ? (
            <p className="ciw-muted lc-num">{c.today.eligible ? `Scored today the weight is ${c.today.weight?.toFixed(4)} (recency ${c.today.recency ?? '—'}%).` : `Scored today the engine would reject it: ${c.today.reasons.map((r) => r.replace(/_/g, ' ')).join(', ')}.`}</p>
          ) : null}
          {e.adjustments?.length ? (
            <ul className="ciw-adj lc-num">
              {e.adjustments.map((a, i) => (
                <li key={`${a.basis}-${i}`}>
                  <span>{ADJ[a.basis] ?? a.basis.replace(/_/g, ' ')}</span>
                  <b>{a.amount !== null ? `${a.amount > 0 ? '+' : ''}${fmtMoney(a.amount)}` : fmtMoney(a.value)}</b>
                  {a.amount === null && a.weight !== null && blendTotal > 0 ? <em>{Math.round((a.weight / blendTotal) * 100)}% of blend</em> : <em>added</em>}
                </li>
              ))}
            </ul>
          ) : null}
        </LCInspectorSection>
      ) : null}

      {e?.cats?.length ? (
        <LCInspectorSection title="Comparability by category">
          <div className="ciw-cats lc-num">
            {e.cats.map((k) => (
              <div key={k.c} className="ciw-cat">
                <span>{CATEGORY[k.c] ?? k.c}<em>{k.w}%</em></span>
                <span className="ciw-cat__track"><i style={{ width: `${Math.max(0, Math.min(100, k.s ?? 0))}%` }} /></span>
                <b>{k.s !== null ? Math.round(k.s) : '—'}</b>
                <em className="ciw-cat__n">{k.n ?? 0} compared{k.m ? ` · ${k.m} missing` : ''}</em>
              </div>
            ))}
          </div>
          {e.dims?.length ? (
            <div className="ciw-dims">
              {e.dims.map((d) => <span key={d.f} className={cx('ciw-dim', `is-${d.st}`)} title={`${DIM[d.f] ?? d.f}: comp ${String(d.c)}${d.s !== undefined && d.s !== null ? ` · subject ${String(d.s)}` : ''}`}>{DIM[d.f] ?? d.f} {STATUS_WORD[d.st]}</span>)}
            </div>
          ) : null}
        </LCInspectorSection>
      ) : null}

      <LCInspectorSection title="Subject vs this sale">
        <table className="ciw-vs lc-num">
          <thead><tr><th /><th>Subject</th><th>Comp</th></tr></thead>
          <tbody>
            <tr><th>Type</th><td>{s.propertyType ?? '—'}</td><td className={cx(!c.assetMatch && 'is-attn')}>{c.propertyType ?? '—'}</td></tr>
            {m.kind === 'multifamily' || (c.units ?? 0) > 1 ? <tr><th>Units</th><td>{s.units ?? '—'}</td><td>{c.units ?? '—'}</td></tr> : null}
            {m.kind !== 'land' ? <tr><th>Beds / baths</th><td>{s.beds ?? '—'} / {s.baths ?? '—'}</td><td>{c.beds ?? '—'} / {c.baths ?? '—'}</td></tr> : null}
            {m.kind !== 'land' ? <tr><th>Sq ft</th><td>{fmtInt(s.sqft) ?? '—'}</td><td>{fmtInt(c.sqft) ?? '—'}{c.compare.sqftPct ? <em> {c.compare.sqftPct > 0 ? '+' : '−'}{Math.abs(c.compare.sqftPct)}%</em> : null}</td></tr> : null}
            <tr><th>Year built</th><td>{s.yearBuilt ?? '—'}</td><td>{c.yearBuilt ?? '—'}</td></tr>
            <tr><th>Lot</th><td>{fmtInt(s.lotSqft) ?? '—'}</td><td>{fmtInt(c.lotSqft) ?? '—'}</td></tr>
            <tr><th>Condition</th><td>{s.condition ?? '—'}</td><td>{c.condition ?? '—'}</td></tr>
          </tbody>
        </table>
      </LCInspectorSection>

      <LCInspectorSection title="Transaction">
        <LCFacts rows={[
          { label: 'Source', value: c.corpus === 'transaction_corpus' ? 'Recorded deed (transaction corpus)' : c.source ?? 'Engine pool' },
          { label: 'Arm’s-length', value: c.armsLength === true ? 'Yes' : c.armsLength === false ? 'No' : null },
          { label: 'Financing', value: c.cash === true ? 'Cash' : c.cash === false ? 'Financed' : null },
          { label: 'Deed', value: c.docType },
          { label: 'Buyer', value: c.buyerKind === 'company' ? c.buyerCompany ?? 'Company' : c.buyerKind === 'person' ? 'Individual' : null },
          { label: 'Seller', value: c.sellerKind === 'company' ? 'Company' : c.sellerKind === 'person' ? 'Individual' : null },
        ]} />
      </LCInspectorSection>

      {history.length > 1 ? (
        <LCInspectorSection title="Recorded sales of this property · in this search">
          <ol className="ciw-history lc-num">
            {history.map((h) => <li key={h.key} className={cx(h.key === c.key && 'is-this')}><b>{fmtDate(h.saleDate, 'long')}</b><span>{fmtMoney(h.salePrice, { exact: true })}</span><em>{h.corpus === 'transaction_corpus' ? h.docType ?? 'deed' : h.source}</em></li>)}
          </ol>
        </LCInspectorSection>
      ) : null}

      <LCInspectorSection title="Provenance">
        <p className="ciw-muted">{c.corpus === 'engine_pool' ? 'Engine pool — the sold-comp records the acquisition engine prices from.' : 'Transaction corpus — a recorded deed, reviewed here with the engine’s rules.'} Evidence read {fmtDate(m.w.generatedAt, 'long')}.</p>
      </LCInspectorSection>
    </LCInspector>
  )
}
