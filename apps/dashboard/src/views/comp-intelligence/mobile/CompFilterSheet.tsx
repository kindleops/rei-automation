import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { getFilterLabel, type CompFilterKey } from '../utils/comp-display'
import './comp-mobile-surfaces.css'

/**
 * COMP FILTERS, as a deliberate mobile sheet (§10 / §14).
 *
 * The desktop workspace exposes its whole control matrix at once: a five-chip
 * quality rail, a radius rail inside the map command rail, and a six-button
 * lookback row, all visible simultaneously. At 390px that is three competing
 * control strips above the evidence they filter.
 *
 * Progressive disclosure here means the CONTROLS move, not the capability: every
 * control the desktop matrix offers is present, one decision at a time, with the
 * active selection readable from the closed button before the sheet is opened.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const RADIUS_OPTIONS = [0.25, 0.5, 1, 2, 3, 5]
const LOOKBACK_OPTIONS = [3, 6, 12, 18, 24, 36]

export interface CompFilterSheetProps {
  open: boolean
  onClose: () => void
  filterKeys: CompFilterKey[]
  filter: CompFilterKey
  counts: Record<CompFilterKey, number>
  onFilterChange: (next: CompFilterKey) => void
  radius: number
  onRadiusChange: (miles: number) => void
  monthsBack: number
  onMonthsBackChange: (months: number) => void
  canExpandFurther: boolean
  onFindMore: () => void
  loading: boolean
}

export const CompFilterSheet = ({
  open,
  onClose,
  filterKeys,
  filter,
  counts,
  onFilterChange,
  radius,
  onRadiusChange,
  monthsBack,
  onMonthsBackChange,
  canExpandFurther,
  onFindMore,
  loading,
}: CompFilterSheetProps) => {
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const sheet = (
    <div className="ci-mfs" role="dialog" aria-modal="true" aria-label="Comparable filters">
      <button type="button" className="ci-mfs__scrim" aria-label="Close filters" onClick={onClose} />
      <div className="ci-mfs__sheet">
        <div className="ci-mfs__grab" aria-hidden />
        <header className="ci-mfs__head">
          <strong>Filter comparables</strong>
          <button type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={15} /></button>
        </header>

        <div className="ci-mfs__body">
          <section>
            <h4>Match quality</h4>
            <div className="ci-mfs__options">
              {filterKeys.map((key) => {
                const count = counts[key]
                const disabled = count === 0 && key !== 'all'
                return (
                  <button
                    key={key}
                    type="button"
                    className={cls('ci-mfs__option', filter === key && 'is-active')}
                    disabled={disabled}
                    aria-pressed={filter === key}
                    onClick={() => { onFilterChange(key); onClose() }}
                  >
                    <span>{getFilterLabel(key)}</span>
                    <b>{count}</b>
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <h4>Search radius</h4>
            <div className="ci-mfs__chips">
              {RADIUS_OPTIONS.map((miles) => (
                <button
                  key={miles}
                  type="button"
                  className={cls('ci-mfs__chip', radius === miles && 'is-active')}
                  disabled={loading}
                  onClick={() => onRadiusChange(miles)}
                >
                  {miles < 1 ? `${miles} mi` : `${miles} mi`}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4>Lookback</h4>
            <div className="ci-mfs__chips">
              {LOOKBACK_OPTIONS.map((months) => (
                <button
                  key={months}
                  type="button"
                  className={cls('ci-mfs__chip', monthsBack === months && 'is-active')}
                  disabled={loading}
                  onClick={() => onMonthsBackChange(months)}
                >
                  {months}mo
                </button>
              ))}
            </div>
            {/* The desktop rail says this in a caption; the constraint is real and
                the operator has to know their lookback is a DISCOVERY window, not
                the window V3 used to qualify. */}
            <p className="ci-mfs__note">
              Affects discovery. The V3 qualification may use its own window.
            </p>
          </section>
        </div>

        <footer className="ci-mfs__actions">
          {canExpandFurther ? (
            <button
              type="button"
              className="ci-mfs__action"
              disabled={loading}
              onClick={() => { onFindMore(); onClose() }}
            >
              Search wider
            </button>
          ) : null}
          <button type="button" className="ci-mfs__action is-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )

  return createPortal(sheet, document.body)
}
