import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { StreetViewThumb } from './StreetViewThumb'
import {
  classifyComp,
  compMatchLabel,
  fmtCurrency,
  fmtDate,
  fmtNum,
  fmtPpsf,
  getAuthorityBadge,
  getQualityLabel,
  pricePerSqft,
  type SubjectFacts,
} from '../utils/comp-display'

interface Props {
  row: CompTransactionEvidence
  subject: SubjectFacts
  selected?: boolean
  hovered?: boolean
  expanded?: boolean
  scenarioExcluded?: boolean
  onSelect?: (id: string) => void
  onHover?: (id: string | null) => void
  onIncludeScenario?: (id: string) => void
}

function scoreClass(score: number | null | undefined): string {
  if (score == null) return 'is-ok'
  if (score >= 80) return 'is-hi'
  if (score >= 65) return 'is-mid'
  return 'is-lo'
}

function matchLabelClass(label: string): string {
  if (label.includes('Elite')) return 'is-elite'
  if (label.includes('Strong')) return 'is-strong'
  if (label.includes('Usable')) return 'is-usable'
  if (label.includes('Weak')) return 'is-weak'
  return 'is-review'
}

export function PropertyCompCard({
  row,
  subject: _subject, // eslint-disable-line @typescript-eslint/no-unused-vars
  selected,
  hovered,
  expanded,
  scenarioExcluded,
  onSelect,
  onHover,
  onIncludeScenario,
}: Props) {
  const id = row.candidate_id || row.property_id || ''
  const classification = classifyComp(row)
  const match = compMatchLabel(row)
  const score = classification.score
  const ppsf = pricePerSqft(row)
  const authorityBadge = getAuthorityBadge(classification.authority)
  const qualityLabel = getQualityLabel(classification.quality)
  const isExcluded = classification.isExcluded
  // subject kept for future comparison / detail drawer (used in props)

  const cardCls = [
    'ci-evidence-card',
    selected ? 'is-open is-selected' : '',
    hovered ? 'is-hover' : '',
    scenarioExcluded || isExcluded ? 'is-excluded' : '',
    classification.quality === 'WEAK' ? 'is-weak' : '',
    classification.quality === 'STRONG' || classification.quality === 'USABLE' ? 'is-included' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={cardCls}
      data-evidence-id={id}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(id)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect?.(id)}
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="ci-ev-header">
        <span className="ci-ev-source-badge">{authorityBadge}</span>
        <span className="ci-ev-date">{fmtDate(row.sale_date)}</span>
        <span className="ci-ev-distance">
          {row.geography.distance_miles != null ? `${row.geography.distance_miles.toFixed(2)} mi` : '—'}
        </span>
        <div className="ci-ev-match-score">
          <span className={`ci-ev-score-num ${scoreClass(score)}`}>{score != null ? Math.round(score) : '—'}</span>
          <span className={`ci-ev-match-label ${matchLabelClass(match)}`}>{match.split(' ')[0]}</span>
        </div>
      </div>

      <div className="ci-ev-main">
        <div className="ci-ev-thumb ci-ev-thumb--card">
          <StreetViewThumb
            address={row.address}
            lat={row.geography.latitude}
            lng={row.geography.longitude}
            size="card"
          />
        </div>
        <div className="ci-ev-content">
          <div className="ci-ev-price tabular-nums">{fmtCurrency(row.sale_price)}</div>
          <div className="ci-ev-addr">{row.address ?? 'Address unknown'}</div>
          <div className="ci-ev-role-badges">
            <span className={`ci-role-badge ${isExcluded ? 'is-excluded' : ''}`}>{qualityLabel}</span>
            {classification.authority !== 'OFFICIAL_V3' && (
              <span className="ci-role-badge is-prelim">{authorityBadge}</span>
            )}
          </div>
        </div>
      </div>

      <div className="ci-ev-metrics">
        <Metric label="Bd/Ba" value={`${row.bedrooms ?? '—'} / ${row.bathrooms ?? '—'}`} />
        <Metric label="Sq Ft" value={row.square_feet ? fmtNum(row.square_feet) : '—'} />
        <Metric label="Lot" value={row.lot_square_feet ? fmtNum(row.lot_square_feet) : '—'} />
        <Metric label="Built" value={row.year_built != null ? String(row.year_built) : '—'} />
        <Metric label="PPSF" value={fmtPpsf(ppsf)} />
        <Metric label="Type" value={row.property_type ?? row.canonical_asset_lane ?? '—'} />
      </div>

      {/* More contract fields to address blank data complaints */}
      <div className="ci-ev-intel">
        {row.buyer && <div className="ci-ev-buyer">Buyer: {row.buyer} {row.buyer_archetype ? `(${row.buyer_archetype})` : ''}</div>}
        {row.transaction_channel && <div className="ci-ev-channel">Channel: {row.transaction_channel}</div>}
        {row.source_lineage?.source_table && <div className="ci-ev-source">Source: {row.source_lineage.source_table}</div>}
        {row.evidence_role && <div className="ci-ev-role">Role: {row.evidence_role}</div>}
      </div>

      {/* Drawer handles full detail. Keep minimal actions. */}
      {expanded && (
        <div className="ci-ev-actions">
          <button type="button" className="ci-ev-action-btn" onClick={(e) => { e.stopPropagation(); onSelect?.(id) }}>Open Detail</button>
          <button type="button" className="ci-ev-action-btn" onClick={(e) => { e.stopPropagation(); onIncludeScenario?.(id) }}>Scenario</button>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ci-ev-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}