import { StreetViewThumb } from './StreetViewThumb'
import { fmtCurrency, fmtNum, type SubjectFacts } from '../utils/comp-display'

interface Props {
  subject: SubjectFacts
  radiusMiles: number
  monthsBack: number
  compCount: number
  loading?: boolean
}

export function SubjectPropertyCard({
  subject,
  radiusMiles,
  monthsBack,
  compCount,
  loading = false,
}: Props) {
  const cityState = [subject.city, subject.state, subject.zip].filter(Boolean).join(', ')

  return (
    <section className="ci-subject-header ci-subject-header--property" aria-label="Subject property">
      <div className="ci-subject-header__top">
        <div className="ci-subject-header__img ci-subject-header__img--hero">
          <StreetViewThumb
            address={subject.address}
            lat={subject.lat}
            lng={subject.lng}
            size="subject"
          />
        </div>
        <div className="ci-subject-header__info">
          <div className="ci-subject-header__eyebrow">Subject Property</div>
          <h2 className="ci-subject-header__addr">{subject.address}</h2>
          {cityState && <span className="ci-subject-header__citystate">{cityState}</span>}
          <div className="ci-subject-header__specs">
            {subject.propertyType && <span>{subject.propertyType}</span>}
            {subject.beds != null && subject.baths != null && (
              <span>{subject.beds} bd / {subject.baths} ba</span>
            )}
            {subject.sqft != null && subject.sqft > 0
              ? <span>{fmtNum(subject.sqft)} sf</span>
              : <span className="is-warn-text">Sqft unknown</span>}
            {subject.lotSqft != null && subject.lotSqft > 0 && <span>{fmtNum(subject.lotSqft)} lot sf</span>}
            {subject.yearBuilt != null && <span>Built {subject.yearBuilt}</span>}
            {subject.units != null && subject.units > 1 && <span>{subject.units} units</span>}
          </div>
          {subject.estimatedValue != null && (
            <div className="ci-subject-header__value">
              Est. value <strong>{fmtCurrency(subject.estimatedValue)}</strong>
            </div>
          )}
        </div>
      </div>

      <div className="ci-subject-header__chips">
        <span className="ci-status-chip is-info">{radiusMiles} mi search</span>
        <span className="ci-status-chip is-info">{monthsBack} mo lookback</span>
        <span className="ci-status-chip is-info">{loading ? 'Searching…' : `${compCount} comps`}</span>
        <span className={`ci-status-chip ${subject.coordinateResolved ? 'is-ok' : 'is-warn'}`}>
          {subject.coordinateResolved ? 'Coordinates confirmed' : 'Coordinates pending'}
        </span>
        {subject.freshness && (
          <span className="ci-status-chip is-info">Source: {subject.freshness.replace(/_/g, ' ')}</span>
        )}
      </div>
    </section>
  )
}