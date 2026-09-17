import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import {
  classifyComp,
  compMatchLabel,
  fmtCurrency,
  fmtDate,
  fmtNum,
  fmtPpsf,
  getAuthorityBadge,
  humanizeEvidenceRole,
  humanizeSourcePath,
  pricePerSqft,
  type SubjectFacts,
} from '../utils/comp-display'

/**
 * ONE COMPARABLE, in full.
 *
 * The desktop equivalent is an inline drawer inside the analysis panel that pushes
 * the comp list down; on a phone that is a modal in disguise, so this is the modal.
 *
 * Its job is the subject comparison — the reason a comp is or is not evidence. Every
 * row states the subject value beside the comp value and the delta, because "3 bd"
 * on its own says nothing about whether this sale supports the valuation.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/**
 * A percentage is only meaningful for a magnitude. Year built is a POSITION on a
 * timeline, so "+0%" for 1925 vs 1926 was both technically true and useless — the
 * operator wants "1 year newer". `absolute` says which kind of number this is.
 */
const delta = (
  comp: number | null | undefined,
  subj: number | null | undefined,
  mode: 'ratio' | 'absolute' = 'ratio',
  unit = '',
): string => {
  if (comp == null || subj == null) return '—'
  const diff = comp - subj
  if (diff === 0) return 'Exact'
  const sign = diff > 0 ? '+' : '−'
  if (mode === 'absolute' || subj === 0) {
    return `${sign}${Math.abs(diff)}${unit ? ` ${unit}` : ''}`
  }
  return `${sign}${Math.abs(Math.round((diff / subj) * 100))}%`
}

export interface CompDetailLayerProps {
  row: CompTransactionEvidence | null
  subject: SubjectFacts
  excluded: boolean
  onToggleExclude: (id: string) => void
  onClose: () => void
}

export const CompDetailLayer = ({ row, subject, excluded, onToggleExclude, onClose }: CompDetailLayerProps) => {
  useEffect(() => {
    if (!row) return
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
  }, [row, onClose])

  if (!row || typeof document === 'undefined') return null

  const id = row.candidate_id || row.property_id || ''
  const classification = classifyComp(row)
  const compPpsf = pricePerSqft(row)
  const subjectPpsf = subject.estimatedValue != null && subject.sqft
    ? Math.round(subject.estimatedValue / subject.sqft)
    : null

  const layer = (
    <div className="ci-mdl" role="dialog" aria-modal="true" aria-label={`Comparable ${row.address}`}>
      <header className="ci-mdl__bar">
        <button type="button" className="ci-mdl__back" onClick={onClose} aria-label="Back to comparables">
          <Icon name="chevron-left" size={17} />
        </button>
        <div className="ci-mdl__title">
          <strong>{fmtCurrency(row.sale_price)}</strong>
          <span>{row.address}</span>
        </div>
      </header>

      <div className="ci-mdl__body">
        <div className="ci-mdl__badges">
          <span className={cls('ci-mdl__badge', `is-${classification.quality.toLowerCase()}`)}>
            {compMatchLabel(row)}
          </span>
          <span className="ci-mdl__badge is-muted">{getAuthorityBadge(classification.authority)}</span>
          {row.pricing_eligibility ? (
            <span className="ci-mdl__badge is-muted">Pricing eligible</span>
          ) : (
            <span className="ci-mdl__badge is-muted">Context only</span>
          )}
        </div>

        <section className="ci-mdl__section">
          <h4>Sale</h4>
          <dl className="ci-mdl__facts">
            <div><dt>Sale price</dt><dd>{fmtCurrency(row.sale_price)}</dd></div>
            <div><dt>Sale date</dt><dd>{fmtDate(row.sale_date)}</dd></div>
            <div><dt>Price / sf</dt><dd>{fmtPpsf(compPpsf)}</dd></div>
            <div>
              <dt>Distance</dt>
              <dd>{row.geography?.distance_miles != null ? `${row.geography.distance_miles.toFixed(2)} mi` : '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="ci-mdl__section">
          <h4>Against the subject</h4>
          <div className="ci-mdl__compare">
            <div className="ci-mdl__compare-head">
              <span>Attribute</span><span>Subject</span><span>Comp</span><span>Δ</span>
            </div>
            <CompareRow label="Beds" subject={subject.beds} comp={row.bedrooms} />
            <CompareRow label="Baths" subject={subject.baths} comp={row.bathrooms ?? null} />
            <CompareRow
              label="Sq ft"
              subject={subject.sqft}
              comp={row.square_feet}
              format={(v) => (v == null ? '—' : fmtNum(v))}
            />
            <CompareRow
              label="Year built"
              subject={subject.yearBuilt}
              comp={row.year_built ?? null}
              format={(v) => (v == null ? '—' : String(v))}
              mode="absolute"
              unit="yr"
            />
            <CompareRow
              label="Price / sf"
              subject={subjectPpsf}
              comp={compPpsf}
              format={(v) => fmtPpsf(v)}
            />
          </div>
          {/* Name the MISSING input rather than both possible ones — telling an
              operator the subject has no square footage when it plainly shows 992 sf
              two rows above is how a surface loses their trust. */}
          {subjectPpsf == null ? (
            <p className="ci-mdl__note">
              {subject.estimatedValue == null
                ? 'The subject has no provider value estimate, so no price-per-foot comparison can be made.'
                : 'The subject has no square footage on record, so no price-per-foot comparison can be made.'}
            </p>
          ) : null}
        </section>

        <section className="ci-mdl__section">
          <h4>Transaction</h4>
          <dl className="ci-mdl__facts">
            <div><dt>Buyer</dt><dd>{row.buyer || 'Not available'}</dd></div>
            <div><dt>Buyer type</dt><dd>{row.buyer_archetype || 'Unknown'}</dd></div>
            <div><dt>Channel</dt><dd>{row.transaction_channel || 'Not available'}</dd></div>
            <div><dt>Qualification</dt><dd>{row.qualification_status || 'Not qualified'}</dd></div>
          </dl>
        </section>

        <section className="ci-mdl__section">
          <h4>Provenance</h4>
          <dl className="ci-mdl__facts">
            <div><dt>Source</dt><dd>{humanizeSourcePath(row.source_path)}</dd></div>
            <div><dt>Role</dt><dd>{humanizeEvidenceRole(row.evidence_role) ?? '—'}</dd></div>
            <div><dt>Table</dt><dd>{row.source_lineage?.source_table ?? '—'}</dd></div>
            <div>
              <dt>Similarity</dt>
              <dd>{classification.score != null ? `${Math.round(classification.score)}` : '—'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <footer className="ci-mdl__actions">
        <button
          type="button"
          className={cls('ci-mdl__action', excluded && 'is-on')}
          onClick={() => onToggleExclude(id)}
        >
          {excluded ? 'Include in scenario' : 'Exclude from scenario'}
        </button>
        <button type="button" className="ci-mdl__action is-primary" onClick={onClose}>Done</button>
      </footer>
    </div>
  )

  return createPortal(layer, document.body)
}

const CompareRow = ({
  label,
  subject,
  comp,
  format = (v: number | null | undefined) => (v == null ? '—' : String(v)),
  mode = 'ratio',
  unit = '',
}: {
  label: string
  subject: number | null | undefined
  comp: number | null | undefined
  format?: (value: number | null | undefined) => string
  mode?: 'ratio' | 'absolute'
  unit?: string
}) => (
  <div className="ci-mdl__compare-row">
    <span>{label}</span>
    <span>{format(subject)}</span>
    <span>{format(comp)}</span>
    <span className={cls(comp != null && subject != null && comp !== subject && 'is-delta')}>
      {delta(comp, subject, mode, unit)}
    </span>
  </div>
)
