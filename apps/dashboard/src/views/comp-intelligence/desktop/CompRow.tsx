import { memo, useState, type KeyboardEvent } from 'react'
import { LCButton, LCTooltip, cx } from '../../../shared/lc'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import {
  fmtAge, fmtDate, fmtInt, fmtMiles, fmtMoney, fmtUnitValue, saleAgeDays, unitValue, weaknesses, whyExcluded, whyIncluded,
  type AssetKind, type ExplainContext, type UnitMetric,
} from '../../../domain/comp-intelligence/comps-workstation-model'
import { saleTypeOfComp } from '../../../domain/comp-intelligence/comp-sale-type'
import { CompStreetView } from './CompStreetView'
import type { Tier } from './derive-workstation'
import { SaleTypeBadge } from './SaleType'
import { useFocusOf, type FocusStore } from './focus-store'
import { displayAddress } from '../utils/comp-display'

export interface CompRowProps {
  c: EvidenceComp
  tier: Tier
  rank: number | null
  /** share of the shown set's total engine weight */
  weightShare: number | null
  maxShare: number
  kind: AssetKind
  metric: UnitMetric
  ctx: ExplainContext
  store: FocusStore
  onOpen: (c: EvidenceComp) => void
  onInclude: (c: EvidenceComp) => void
  onExclude: (c: EvidenceComp) => void
  /** roving focus: the one row in the list that is a tab stop */
  tabStop: boolean
  onKeyNav: (e: KeyboardEvent<HTMLDivElement>, c: EvidenceComp) => void
}

const signed = (n: number, unit = '') => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}${unit}`

function specLine(c: EvidenceComp, kind: AssetKind): string {
  const parts: Array<string | null> = []
  if (kind === 'multifamily') {
    parts.push(c.units ? `${c.units} units${c.compare.units ? ` (${signed(c.compare.units)})` : ''}` : null)
    parts.push(c.sqft ? `${fmtInt(c.sqft)} sf` : null)
  } else if (kind === 'land') {
    parts.push(c.lotSqft ? `${(c.lotSqft / 43_560).toFixed(2)} ac${c.compare.lotPct !== null ? ` (${signed(c.compare.lotPct, '%')})` : ''}` : null)
  } else {
    parts.push(c.beds !== null ? `${c.beds} bd` : null)
    parts.push(c.baths !== null ? `${c.baths} ba` : null)
    parts.push(c.sqft ? `${fmtInt(c.sqft)} sf${c.compare.sqftPct !== null && c.compare.sqftPct !== 0 ? ` (${signed(c.compare.sqftPct, '%')})` : ''}` : null)
  }
  parts.push(c.yearBuilt ? `${c.yearBuilt}` : null)
  return parts.filter(Boolean).join(' · ')
}

/**
 * A comparable as an explainable evidence object (§26–27, §69–70): what,
 * where, when, for how much, how similar, why it is or is not evidence —
 * and how much of the valuation's weight it carries.
 */
export const CompRow = memo(function CompRow({ c, tier, rank, weightShare, maxShare, kind, metric, ctx, store, onOpen, onInclude, onExclude, tabStop, onKeyNav }: CompRowProps) {
  const { hot, selected } = useFocusOf(store, c.key)
  const [why, setWhy] = useState(false)
  const inSet = tier === 'set' || tier === 'added'
  const days = saleAgeDays(c, ctx.now)
  const unit = unitValue(c, metric)
  const reasons = tier === 'excluded' ? whyExcluded(c, ctx) : whyIncluded(c, ctx)
  const weak = tier === 'excluded' ? [] : weaknesses(c, ctx)
  const headline = tier === 'excluded'
    ? reasons[0]?.text ?? 'Ruled out'
    : weak.find((w) => w.tone === 'crit')?.text ?? null
  const stateLabel = tier === 'set' ? 'Priced by the engine' : tier === 'added' ? 'Added by you' : tier === 'removed' ? 'Removed by you' : tier === 'excluded' ? 'Excluded' : 'Candidate'
  const canAct = tier !== 'excluded' && c.engine?.eligible
  const sale = saleTypeOfComp(c)

  return (
    <div
      role="listitem"
      data-comp-row=""
      data-key={c.key}
      tabIndex={tabStop ? 0 : -1}
      aria-label={`${c.address ?? 'Comparable sale'}, ${stateLabel}`}
      aria-current={selected || undefined}
      className={cx('ciw-row', `is-${tier}`, hot && 'is-hot', selected && 'is-selected')}
      onPointerEnter={() => store.hover(c.key, 'list')}
      onPointerLeave={() => store.hover(null, null)}
      onFocus={() => store.hover(c.key, 'list')}
      onClick={() => onOpen(c)}
      onKeyDown={(e) => onKeyNav(e, c)}
    >
      <CompStreetView
        className="ciw-row__photo"
        size="thumb"
        photo={c.photo}
        lat={c.lat}
        lng={c.lng}
        address={c.address}
        load={tier === 'excluded' ? 'intent' : 'visible'}
        active={hot || selected}
        badge={<span className="ciw-row__glyph" aria-hidden="true">{rank !== null ? <b>{rank}</b> : null}</span>}
      />
      <div className="ciw-row__main">
        <div className="ciw-row__title">
          <span className="ciw-row__addr">{displayAddress(c.address) ?? 'Address not recorded'}</span>
          {tier === 'added' ? <span className="ciw-pill is-added">Added</span> : null}
          {tier === 'removed' ? <span className="ciw-pill is-removed">Removed</span> : null}
          {c.corpus === 'transaction_corpus' ? <LCTooltip content="Recorded deed from the transaction corpus — reviewed with the engine's rules, but not in the engine's own pricing pool."><span className="ciw-pill is-deed">Deed</span></LCTooltip> : null}
        </div>
        <div className="ciw-row__meta lc-num">
          <SaleTypeBadge v={sale} withBuyer />
          <span>{[fmtMiles(c.distanceMiles), c.saleDate ? `${fmtDate(c.saleDate)}${days !== null ? ` · ${fmtAge(days)}` : ''}` : 'Undated sale'].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="ciw-row__spec lc-num">{specLine(c, kind)}</div>
        {headline ? <div className={cx('ciw-row__headline', tier === 'excluded' ? 'is-excluded' : 'is-crit')}>{headline}</div> : null}
        {inSet && weightShare !== null ? (
          <div className="ciw-row__weight" title={`${(weightShare * 100).toFixed(1)}% of the set's total engine weight`}>
            <span className="ciw-row__weightbar"><i style={{ width: `${Math.max(4, (weightShare / Math.max(maxShare, 1e-9)) * 100)}%` }} /></span>
            <span className="lc-num">{(weightShare * 100).toFixed(1)}% of weight</span>
          </div>
        ) : null}
        {why ? (
          <ul className="ciw-row__why" onClick={(e) => e.stopPropagation()}>
            {reasons.map((r) => <li key={r.code} data-tone={r.tone}>{r.text}</li>)}
            {weak.map((r) => <li key={r.code} data-tone={r.tone}>{r.text}</li>)}
          </ul>
        ) : null}
      </div>
      <div className="ciw-row__figures lc-num">
        <b className="ciw-row__price">{fmtMoney(c.salePrice) ?? '—'}</b>
        <span className="ciw-row__unit">{unit !== null ? `${fmtUnitValue(unit, metric)}${metric.short}` : ' '}</span>
        {c.engine?.eligible && c.engine.adjustedPrice ? <span className="ciw-row__adj" title="Adjusted to the subject by the engine">adj {fmtMoney(c.engine.adjustedPrice)}</span> : null}
      </div>
      <div className="ciw-row__actions" onClick={(e) => e.stopPropagation()}>
        <LCButton variant="ghost" size="sm" aria-expanded={why} onClick={() => setWhy((v) => !v)}>{tier === 'excluded' ? 'Why not' : 'Why'}</LCButton>
        {canAct ? (
          inSet
            ? <LCButton variant="quiet" size="sm" icon="slash" data-act="exclude" onClick={() => onExclude(c)} title="Exclude from your set (X)">Exclude</LCButton>
            : <LCButton variant="quiet" size="sm" icon="check" data-act="include" onClick={() => onInclude(c)} title="Include in your set (I)">{tier === 'removed' ? 'Restore' : 'Include'}</LCButton>
        ) : null}
      </div>
    </div>
  )
})
