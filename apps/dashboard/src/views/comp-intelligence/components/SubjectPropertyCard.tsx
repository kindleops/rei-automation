import { StreetViewThumb } from './StreetViewThumb'
import { fmtCurrency, fmtNum, type SubjectFacts } from '../utils/comp-display'

interface Props {
  subject: SubjectFacts
  radiusMiles: number
  monthsBack: number
  compCount: number
  loading?: boolean
  valueLabel?: string
  coordinateStatus?: string
  lastSale?: string | null
  taxValue?: number | null
}

export function SubjectPropertyCard({
  subject,
  radiusMiles,
  monthsBack,
  compCount,
  loading = false,
  valueLabel = 'Provider Estimate',
  coordinateStatus,
  lastSale,
  taxValue,
}: Props) {
  const cityState = [subject.city, subject.state, subject.zip].filter(Boolean).join(', ')

  const resolvedCoord = subject.coordinateResolved && subject.lat != null && subject.lng != null
  const coordLabel = coordinateStatus || (resolvedCoord ? 'Exact coords' : 'Recovered / approximate')

  // Never show bare value — always label the source
  const valueSourceLabel = valueLabel

  return (
    <section className="ci-subject-header ci-subject-header--hero" aria-label="Subject property">
      <div className="ci-subject-hero__media">
        <StreetViewThumb
          address={subject.address}
          lat={subject.lat}
          lng={subject.lng}
          size="hero"
        />
        <div className="ci-hero-gradient" />
      </div>

      <div className="ci-subject-hero__body">
        <div className="ci-subject-header__eyebrow">SUBJECT PROPERTY</div>
        <h2 className="ci-subject-header__addr">{subject.address}</h2>
        {cityState && <div className="ci-subject-header__citystate">{cityState}</div>}

        {subject.estimatedValue != null && (
          <div className="ci-subject-hero__value-wrap">
            <div className="ci-subject-hero__value tabular-nums">{fmtCurrency(subject.estimatedValue)}</div>
            <div className="ci-subject-hero__value-label">{valueSourceLabel}</div>
          </div>
        )}

        <div className="ci-subject-hero__specs">
          {subject.propertyType && <Spec label="Type" value={subject.propertyType} />}
          {subject.beds != null && <Spec label="Beds" value={String(subject.beds)} />}
          {subject.baths != null && <Spec label="Baths" value={String(subject.baths)} />}
          {subject.sqft != null && subject.sqft > 0
            ? <Spec label="Sq Ft" value={fmtNum(subject.sqft)} />
            : <Spec label="Sq Ft" value="Unknown" warn />}
          {subject.lotSqft != null && subject.lotSqft > 0 && (
            <Spec label="Lot" value={`${fmtNum(subject.lotSqft)} sf`} />
          )}
          {subject.yearBuilt != null && <Spec label="Built" value={String(subject.yearBuilt)} />}
          {subject.units != null && subject.units > 1 && <Spec label="Units" value={String(subject.units)} />}
        </div>

        <div className="ci-subject-hero__meta">
          <span>{radiusMiles} mi radius</span>
          <span>{monthsBack} mo lookback</span>
          <span>{loading ? 'Searching…' : `${compCount} comps`}</span>
          <span className="ci-coord-status">{coordLabel}</span>
        </div>

        {(lastSale || taxValue) && (
          <div className="ci-subject-extra">
            {lastSale && <span>Last sale: {lastSale}</span>}
            {taxValue != null && <span>Tax: {fmtCurrency(taxValue)}</span>}
          </div>
        )}
      </div>
    </section>
  )
}

function Spec({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`ci-subject-spec${warn ? ' is-warn' : ''}`}>
      <span className="ci-subject-spec__label">{label}</span>
      <strong className="ci-subject-spec__value">{value}</strong>
    </div>
  )
}