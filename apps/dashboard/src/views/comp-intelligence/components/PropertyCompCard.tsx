import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { StreetViewThumb } from './StreetViewThumb'
import { CompComparisonTable } from './CompComparisonTable'
import {
  buildComparisonRows,
  compMatchLabel,
  compQuality,
  compQualityLabel,
  fmtCurrency,
  fmtDate,
  fmtNum,
  fmtPpsf,
  humanizeSourcePath,
  pricePerSqft,
  type SubjectFacts,
} from '../utils/comp-display'

interface Props {
  row: CompTransactionEvidence
  subject: SubjectFacts
  selected?: boolean
  hovered?: boolean
  expanded?: boolean
  scenarioIncluded?: boolean
  scenarioExcluded?: boolean
  cardRef?: (el: HTMLButtonElement | null) => void
  onSelect?: (id: string) => void
  onHover?: (id: string | null) => void
  onIncludeScenario?: (id: string) => void
  onExcludeScenario?: (id: string) => void
}

export function PropertyCompCard({
  row,
  subject,
  selected,
  hovered,
  expanded,
  scenarioIncluded,
  scenarioExcluded,
  cardRef,
  onSelect,
  onHover,
  onIncludeScenario,
  onExcludeScenario,
}: Props) {
  const id = row.candidate_id || row.property_id || ''
  const quality = compQuality(row)
  const qualityLabel = compQualityLabel(quality)
  const match = compMatchLabel(row)
  const ppsf = pricePerSqft(row)
  const isPreliminary = quality === 'preliminary'
  const comparisonRows = expanded ? buildComparisonRows(subject, row) : []

  const cardCls = [
    'ci-evidence-card',
    'ci-property-comp-card',
    selected ? 'is-selected' : '',
    hovered ? 'is-hovered' : '',
    expanded ? 'is-expanded' : '',
    scenarioExcluded ? 'is-excluded' : '',
    quality === 'strong' ? 'is-strong' : '',
    quality === 'usable' ? 'is-usable' : '',
    quality === 'weak' ? 'is-weak' : '',
    quality === 'excluded' ? 'is-excluded' : '',
  ].filter(Boolean).join(' ')

  return (
    <article className={cardCls} data-evidence-id={id}>
      <button
        ref={cardRef}
        type="button"
        className="ci-property-comp-card__main"
        onClick={() => onSelect?.(id)}
        onMouseEnter={() => onHover?.(id)}
        onMouseLeave={() => onHover?.(null)}
        aria-pressed={selected}
      >
        <div className="ci-ev-main">
          <div className="ci-ev-thumb">
            <StreetViewThumb
              address={row.address}
              lat={row.geography.latitude}
              lng={row.geography.longitude}
              size="row"
            />
            {isPreliminary && (
              <div className="ci-ev-thumb-badge is-preliminary">Preliminary</div>
            )}
          </div>
          <div className="ci-ev-content">
            <div className="ci-ev-price tabular-nums">{fmtCurrency(row.sale_price)}</div>
            <div className="ci-ev-addr">{row.address ?? 'Address unknown'}</div>
            <div className="ci-ev-role-badges">
              <span className={`ci-role-badge is-${quality}`}>{qualityLabel}</span>
              <span className="ci-role-badge is-core">{match}</span>
            </div>
          </div>
        </div>

        <div className="ci-ev-metrics">
          <Metric label="Sold" value={fmtDate(row.sale_date)} />
          <Metric label="Distance" value={row.geography.distance_miles != null ? `${row.geography.distance_miles.toFixed(2)} mi` : '—'} />
          <Metric label="Type" value={row.property_type ?? row.canonical_asset_lane ?? '—'} />
          <Metric label="Bd/Ba" value={`${row.bedrooms ?? '—'}/${row.bathrooms ?? '—'}`} />
          <Metric label="Sqft" value={row.square_feet ? fmtNum(row.square_feet) : '—'} />
          <Metric label="PPSF" value={fmtPpsf(ppsf)} />
          {row.year_built != null && <Metric label="Built" value={String(row.year_built)} />}
          {row.units != null && row.units > 1 && <Metric label="Units" value={String(row.units)} />}
        </div>

        {isPreliminary && (
          <p className="ci-property-comp-card__prelim-note">
            Preliminary · Not yet used in official valuation
          </p>
        )}
      </button>

      {expanded && (
        <div className="ci-property-comp-card__expanded">
          <CompComparisonTable rows={comparisonRows} />
          <div className="ci-property-comp-card__actions">
            <button type="button" className="ci-comp-action" onClick={() => onSelect?.(id)}>View on map</button>
            <button type="button" className="ci-comp-action" onClick={() => onSelect?.(id)}>Compare to subject</button>
            <button
              type="button"
              className={`ci-comp-action ${scenarioIncluded ? 'is-on' : ''}`}
              onClick={() => onIncludeScenario?.(id)}
            >
              {scenarioIncluded ? 'Included in scenario' : 'Include in analyst scenario'}
            </button>
            <button
              type="button"
              className={`ci-comp-action ${scenarioExcluded ? 'is-on' : ''}`}
              onClick={() => onExcludeScenario?.(id)}
            >
              {scenarioExcluded ? 'Excluded from scenario' : 'Exclude from analyst scenario'}
            </button>
          </div>
          <details className="ci-comp-details-fold">
            <summary>Expand details</summary>
            <dl className="ci-comp-details-list">
              <div><dt>Source</dt><dd>{humanizeSourcePath(row.source_path ?? row.source_lineage?.source_table)}</dd></div>
              {row.lot_square_feet != null && <div><dt>Lot size</dt><dd>{fmtNum(row.lot_square_feet)} sf</dd></div>}
            </dl>
          </details>
        </div>
      )}
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ci-ev-metric">
      <span className="ci-ev-metric__label">{label}</span>
      <strong className="ci-ev-metric__value">{value}</strong>
    </div>
  )
}