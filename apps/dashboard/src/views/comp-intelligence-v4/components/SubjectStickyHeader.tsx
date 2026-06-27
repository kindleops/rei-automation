/**
 * Comp Intelligence V4 — sticky subject-property header with media hero.
 * Always visible; never unmounts on filter / scroll / selection / drawer changes.
 */

import type { V4Subject } from '../state/types'
import { fmtMoneyShort, fmtNumber, fmtSqft } from '../adapters/format'
import { PropertyMedia } from './PropertyMedia'

interface SubjectStickyHeaderProps {
  subject: V4Subject
  radiusMiles: number
  monthsBack: number
  qualifiedCount: number
  onOpenDossier: () => void
}

export function SubjectStickyHeader(props: SubjectStickyHeaderProps) {
  const { subject, radiusMiles, monthsBack, qualifiedCount, onOpenDossier } = props
  const facts: Array<{ label: string; value: string }> = [
    { label: 'Asset', value: subject.assetLaneLabel ?? '—' },
    { label: 'Beds', value: subject.beds != null ? fmtNumber(subject.beds) : '—' },
    { label: 'Baths', value: subject.baths != null ? fmtNumber(subject.baths) : '—' },
    { label: 'Sq Ft', value: subject.buildingSqft != null ? fmtSqft(subject.buildingSqft) : '—' },
    { label: 'Lot', value: subject.lotSqft != null ? fmtSqft(subject.lotSqft) : '—' },
    { label: 'Year', value: subject.yearBuilt != null ? String(subject.yearBuilt) : '—' },
    { label: 'Units', value: subject.units != null ? fmtNumber(subject.units) : '—' },
    { label: 'Construction', value: subject.constructionType ?? '—' },
    { label: 'Condition', value: subject.condition ?? '—' },
  ]
  const values: Array<{ label: string; value: string }> = [
    { label: 'Provider est.', value: fmtMoneyShort(subject.providerEstimate) },
    { label: 'Tax value', value: fmtMoneyShort(subject.taxAssessedValue) },
    { label: 'Last sale', value: fmtMoneyShort(subject.lastSalePrice) },
  ]

  return (
    <header className="civ4-subject" aria-label="Subject property">
      <PropertyMedia
        url={subject.imageUrl}
        alt={subject.address ?? 'Subject property'}
        className="civ4-subject__media"
      />
      <div className="civ4-subject__body">
        <div className="civ4-subject__topline">
          <h2 className="civ4-subject__address" title={subject.address ?? undefined}>
            {subject.address ?? 'Subject property'}
          </h2>
          {!subject.hasCoord && (
            <span className="civ4-pill civ4-pill--warn" title={subject.coordFailureReason ?? undefined}>
              No coordinates
            </span>
          )}
          {subject.isMarketFallback && <span className="civ4-pill civ4-pill--warn">Market fallback</span>}
        </div>
        <div className="civ4-subject__facts">
          {facts.map((f) => (
            <span key={f.label} className="civ4-fact">
              <span className="civ4-fact__label">{f.label}</span>
              <span className="civ4-fact__value">{f.value}</span>
            </span>
          ))}
          {values.map((f) => (
            <span key={f.label} className="civ4-fact civ4-fact--accent">
              <span className="civ4-fact__label">{f.label}</span>
              <span className="civ4-fact__value">{f.value}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="civ4-subject__meta">
        <div className="civ4-subject__metarow">
          <span className="civ4-chip">{radiusMiles} mi</span>
          <span className="civ4-chip">{monthsBack} mo</span>
          <span className="civ4-chip civ4-chip--qualified">{qualifiedCount} qualified</span>
        </div>
        <button type="button" className="civ4-btn civ4-btn--ghost" onClick={onOpenDossier}>
          Open Subject Dossier
        </button>
      </div>
    </header>
  )
}
