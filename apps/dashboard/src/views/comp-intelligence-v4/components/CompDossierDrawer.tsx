/**
 * Comp Intelligence V4 — canonical dossier drawer.
 *
 * One drawer, two targets (the canonical dossier controller):
 *   { kind: 'subject' }            → full subject-property dossier
 *   { kind: 'comp', id }           → comparable dossier (compare / txn / buyer / qualification)
 *
 * The drawer is driven entirely by `target` (no stray "open" boolean). It opens
 * immediately, retains the map + comp list behind it, traps + restores focus,
 * closes on the close button and Escape, and shows a visible error state when a
 * comp target cannot be resolved — it never silently does nothing.
 */

import { useEffect, useMemo, useRef } from 'react'
import type {
  DossierTarget,
} from '../hooks/useCompV4Search'
import type {
  V4DecisionRibbon,
  V4Evidence,
  V4Model,
  V4Subject,
  V4SubjectComparison,
} from '../state/types'
import { evidenceStateLongLabel, matchTierLabel } from '../adapters/labels'
import { fmtDate, fmtMiles, fmtMoneyFull, fmtMoneyShort, fmtNumber, fmtPpsf, fmtSqft } from '../adapters/format'
import { PropertyMedia } from './PropertyMedia'

interface DossierDrawerProps {
  target: DossierTarget | null
  subject: V4Subject
  /** Resolved comp evidence when target.kind === 'comp'. Null = unresolved. */
  evidence: V4Evidence | null
  decision: V4DecisionRibbon
  search: V4Model['search']
  onClose: () => void
}

function pctTriBool(v: boolean | null): string {
  if (v == null) return 'Unknown'
  return v ? 'Yes' : 'No'
}

export function CompDossierDrawer(props: DossierDrawerProps) {
  const { target, subject, evidence, decision, search, onClose } = props
  const open = target != null
  const mode = target?.kind ?? null

  const closeRef = useRef<HTMLButtonElement>(null!)
  const restoreRef = useRef<HTMLElement | null>(null)

  // Focus management: capture the opener, move focus into the drawer, and
  // restore focus to the opener on close. Escape closes.
  useEffect(() => {
    if (!open) return
    restoreRef.current = (document.activeElement as HTMLElement) ?? null
    const t = window.setTimeout(() => closeRef.current?.focus(), 60)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey, true)
      restoreRef.current?.focus?.()
    }
  }, [open, onClose])

  const ariaLabel = mode === 'subject' ? 'Subject property dossier' : 'Comparable dossier'

  return (
    <>
      <div
        className={`civ4-drawer__scrim ${open ? 'is-open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`civ4-drawer ${open ? 'is-open' : ''} ${mode ? `civ4-drawer--${mode}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-hidden={!open}
      >
        {mode === 'subject' && (
          <SubjectDossier
            subject={subject}
            decision={decision}
            search={search}
            closeRef={closeRef}
            onClose={onClose}
          />
        )}
        {mode === 'comp' && evidence && (
          <CompDossier subject={subject} evidence={evidence} closeRef={closeRef} onClose={onClose} />
        )}
        {mode === 'comp' && !evidence && (
          <div className="civ4-drawer__error" role="alert">
            <header className="civ4-drawer__head">
              <div>
                <div className="civ4-drawer__price">Comp unavailable</div>
                <div className="civ4-drawer__subline">This record could not be loaded.</div>
              </div>
              <button ref={closeRef} type="button" className="civ4-drawer__close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </header>
            <div className="civ4-drawer__body">
              <p className="civ4-dsection__pending">
                The selected comparable is no longer in the current evidence set. Close this dossier and reselect.
              </p>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}

// ── shared section nav ──────────────────────────────────────────────────────

function SectionNav(props: { sections: Array<{ id: string; label: string }> }) {
  return (
    <nav className="civ4-drawer__nav" aria-label="Dossier sections">
      {props.sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="civ4-drawer__navlink">
          {s.label}
        </a>
      ))}
    </nav>
  )
}

// ── subject dossier ─────────────────────────────────────────────────────────

function SubjectDossier(props: {
  subject: V4Subject
  decision: V4DecisionRibbon
  search: V4Model['search']
  closeRef: React.RefObject<HTMLButtonElement>
  onClose: () => void
}) {
  const { subject: s, decision, search, closeRef, onClose } = props
  const sections = [
    { id: 'civ4-sub-overview', label: 'Overview' },
    { id: 'civ4-sub-physical', label: 'Physical' },
    { id: 'civ4-sub-value', label: 'Value & tax' },
    { id: 'civ4-sub-owner', label: 'Ownership' },
    { id: 'civ4-sub-sale', label: 'Sale history' },
    { id: 'civ4-sub-v3', label: 'Acquisition V3' },
    { id: 'civ4-sub-source', label: 'Source' },
  ]

  return (
    <>
      <header className="civ4-drawer__head">
        <div>
          <div className="civ4-drawer__eyebrow">Subject property</div>
          <div className="civ4-drawer__address">{s.address ?? 'Subject property'}</div>
          <div className="civ4-drawer__subline">
            {s.assetLaneLabel ?? '—'} · {s.propertyId}
            {s.isMarketFallback ? ' · market fallback' : ''}
          </div>
        </div>
        <button ref={closeRef} type="button" className="civ4-drawer__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <SectionNav sections={sections} />

      <div className="civ4-drawer__body">
        <section className="civ4-dsection">
          <PropertyMedia url={s.imageUrl} alt={s.address ?? 'Subject property'} className="civ4-drawer__media" />
        </section>

        <section id="civ4-sub-overview" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Property overview</h3>
          <dl className="civ4-deflist">
            <Def label="Address" value={s.address ?? '—'} />
            <Def label="Asset lane" value={s.assetLaneLabel ?? '—'} />
            <Def label="Subtype" value={s.propertySubtype ?? '—'} />
            <Def label="Property ID" value={s.propertyId} />
            <Def label="Coordinates" value={s.coord ? `${s.coord.lat.toFixed(5)}, ${s.coord.lng.toFixed(5)}` : 'Unresolved'} />
            <Def label="Zoning" value={s.zoning ?? '—'} />
          </dl>
        </section>

        <section id="civ4-sub-physical" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Physical characteristics</h3>
          <dl className="civ4-deflist">
            <Def label="Beds" value={s.beds != null ? fmtNumber(s.beds) : '—'} />
            <Def label="Baths" value={s.baths != null ? fmtNumber(s.baths) : '—'} />
            <Def label="Building SF" value={s.buildingSqft != null ? fmtSqft(s.buildingSqft) : '—'} />
            <Def label="Lot SF" value={s.lotSqft != null ? fmtSqft(s.lotSqft) : '—'} />
            <Def label="Units" value={s.units != null ? fmtNumber(s.units) : '—'} />
            <Def label="Year built" value={s.yearBuilt != null ? String(s.yearBuilt) : '—'} />
            <Def label="Construction" value={s.constructionType ?? '—'} />
            <Def label="Condition" value={s.condition ?? '—'} />
          </dl>
        </section>

        <section id="civ4-sub-value" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Value &amp; tax</h3>
          <dl className="civ4-deflist">
            <Def label="Provider estimate" value={fmtMoneyFull(s.providerEstimate)} />
            <Def label="Tax assessed value" value={fmtMoneyFull(s.taxAssessedValue)} />
          </dl>
        </section>

        <section id="civ4-sub-owner" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Ownership</h3>
          <dl className="civ4-deflist">
            <Def label="Owner" value={s.ownerName ?? 'Not available'} />
            <Def label="Owner type" value={s.ownerType ?? 'Not available'} />
            <Def label="Master owner ID" value={s.masterOwnerId ?? '—'} />
          </dl>
          {!s.ownerName && (
            <p className="civ4-dsection__pending">Owner identity not available from current source.</p>
          )}
        </section>

        <section id="civ4-sub-sale" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Sale history</h3>
          <dl className="civ4-deflist">
            <Def label="Last sale price" value={fmtMoneyFull(s.lastSalePrice)} />
            <Def label="Last sale date" value={fmtDate(s.lastSaleDate)} />
          </dl>
        </section>

        <section id="civ4-sub-v3" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Acquisition Engine V3</h3>
          {decision.available ? (
            <dl className="civ4-deflist">
              <Def label={decision.valueClassificationLabel ?? 'Qualified market value'} value={fmtMoneyFull(decision.qualifiedMarketValue)} />
              <Def label="Conservative exit" value={fmtMoneyFull(decision.conservativeBuyerExit)} />
              <Def label="Recommended shadow offer" value={fmtMoneyFull(decision.recommendedShadowOffer)} />
              <Def label="Strategy" value={decision.primaryStrategyLabel ?? '—'} />
              <Def label="Confidence" value={decision.confidence != null ? `${Math.round(decision.confidence * 100)}%` : '—'} />
              <Def label="Qualified evidence" value={fmtNumber(decision.qualifiedEvidenceCount)} />
              {decision.largestBlocker && <Def label="Largest blocker" value={decision.largestBlocker} />}
            </dl>
          ) : (
            <div className="civ4-verdict civ4-verdict--candidate">
              {decision.executionLabel ?? 'Comp research mode'}
              <div className="civ4-verdict__reason">{decision.unavailableNote ?? 'Canonical underwriting is unavailable for this subject.'}</div>
            </div>
          )}
        </section>

        <section id="civ4-sub-source" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Source &amp; lineage</h3>
          <dl className="civ4-deflist">
            <Def label="Coordinate source" value={s.coordSource ?? '—'} />
            <Def label="Coordinate confidence" value={s.coordConfidence != null ? `${s.coordConfidence}` : '—'} />
            <Def label="Subject resolved" value={pctTriBool(s.isResolved)} />
            <Def label="Market fallback" value={pctTriBool(s.isMarketFallback)} />
            <Def label="Search radius" value={`${search.effectiveRadiusMiles} mi`} />
            <Def label="Lookback" value={`${search.effectiveLookbackMonths} mo`} />
            <Def label="Data freshness" value={s.dataFreshness ?? '—'} />
          </dl>
        </section>
      </div>
    </>
  )
}

// ── comp dossier ────────────────────────────────────────────────────────────

function CompDossier(props: {
  subject: V4Subject
  evidence: V4Evidence
  closeRef: React.RefObject<HTMLButtonElement>
  onClose: () => void
}) {
  const { subject, evidence, closeRef, onClose } = props
  const rows = useMemo(() => buildComparison(subject, evidence), [subject, evidence])
  const sections = [
    { id: 'civ4-comp-overview', label: 'Overview' },
    { id: 'civ4-comp-compare', label: 'Compare' },
    { id: 'civ4-comp-txn', label: 'Transaction' },
    { id: 'civ4-comp-buyer', label: 'Buyer' },
    { id: 'civ4-comp-qual', label: 'Qualification' },
  ]

  return (
    <>
      <header className="civ4-drawer__head">
        <div>
          <div className="civ4-drawer__price">{fmtMoneyFull(evidence.salePrice)}</div>
          <div className="civ4-drawer__address">{evidence.address ?? 'Address unavailable'}</div>
          <div className="civ4-drawer__subline">
            {fmtDate(evidence.saleDate)} · {fmtMiles(evidence.distanceMiles)} · {matchTierLabel(evidence.matchTier)}
          </div>
        </div>
        <button ref={closeRef} type="button" className="civ4-drawer__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <SectionNav sections={sections} />

      <div className="civ4-drawer__body">
        <section id="civ4-comp-overview" className="civ4-dsection">
          <PropertyMedia url={evidence.imageUrl} alt={evidence.address ?? 'Comparable property'} className="civ4-drawer__media" />
        </section>

        <section className="civ4-dsection">
          <h3 className="civ4-dsection__title">Classification</h3>
          <div className={`civ4-verdict civ4-verdict--${evidence.state}`}>
            {evidenceStateLongLabel(evidence.state)}
          </div>
          <div className="civ4-verdict__reason">{evidence.basis.reason}</div>
          {evidence.reasons.length > 1 && (
            <ul className="civ4-reasonlist">
              {evidence.reasons.slice(1).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </section>

        <section id="civ4-comp-compare" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Subject comparison</h3>
          <table className="civ4-matrix">
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Subject</th>
                <th>Comp</th>
                <th>Δ</th>
                <th>Assessment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.attribute}>
                  <td>{r.attribute}</td>
                  <td>{r.subject}</td>
                  <td>{r.comp}</td>
                  <td>{r.difference ?? '—'}</td>
                  <td>
                    <span className={`civ4-assess civ4-assess--${r.assessment}`}>{assessLabel(r.assessment)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section id="civ4-comp-txn" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Transaction &amp; source</h3>
          <dl className="civ4-deflist">
            <Def label="Sale price" value={fmtMoneyFull(evidence.salePrice)} />
            <Def label="Sale date" value={fmtDate(evidence.saleDate)} />
            <Def label="Source" value={evidence.sourceLabel ?? '—'} />
            <Def label="Price / sf" value={fmtPpsf(evidence.ppsf)} />
            <Def label="Price / unit" value={evidence.ppu != null ? fmtMoneyShort(evidence.ppu) : '—'} />
            <Def label="Distance" value={fmtMiles(evidence.distanceMiles)} />
            <Def label="Asset class" value={evidence.assetLane ?? '—'} />
            <Def label="Units" value={evidence.units != null ? fmtNumber(evidence.units) : '—'} />
          </dl>
          {evidence.transactionBadges.length > 0 && (
            <div className="civ4-card__tags" style={{ marginTop: 8 }}>
              {evidence.transactionBadges.map((b) => (
                <span key={b.label} className={`civ4-tag civ4-tag--${b.tone}`}>{b.label}</span>
              ))}
            </div>
          )}
        </section>

        <section id="civ4-comp-buyer" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Buyer / grantee</h3>
          <dl className="civ4-deflist">
            <Def label="Buyer" value={evidence.buyerName ?? 'Not available'} />
            <Def label="Entity type" value={evidence.buyerEntityType ?? 'Not available'} />
            <Def label="Archetype" value={evidence.buyerArchetype ?? 'Not available'} />
          </dl>
          {!evidence.buyerName && (
            <p className="civ4-dsection__pending">Buyer identity unavailable from current source.</p>
          )}
        </section>

        <section id="civ4-comp-qual" className="civ4-dsection">
          <h3 className="civ4-dsection__title">Qualification basis</h3>
          <dl className="civ4-deflist">
            <Def label="Authority" value={authorityLabel(evidence.basis.authority)} />
            <Def label="Pricing eligible" value={pctTriBool(evidence.basis.pricingEligible)} />
            <Def label="Single-asset" value={pctTriBool(evidence.basis.singleAssetEligible)} />
            <Def label="Asset-lane match" value={pctTriBool(evidence.basis.assetLaneCompatible)} />
            <Def label="Evidence universe" value={evidence.basis.evidenceUniverse ?? 'Not routed'} />
            <Def label="Evidence role" value={evidence.basis.evidenceRole ?? '—'} />
            <Def label="Package status" value={packageLabel(evidence.basis.packageStatus)} />
            <Def label="Outlier" value={outlierLabel(evidence.basis.outlierStatus)} />
            <Def
              label="Physical data"
              value={
                evidence.basis.physicalCompleteness != null
                  ? `${Math.round(evidence.basis.physicalCompleteness * 100)}% complete`
                  : '—'
              }
            />
            <Def
              label="ESS contribution"
              value={evidence.basis.essContribution != null ? fmtNumber(evidence.basis.essContribution, 2) : '—'}
            />
          </dl>
        </section>
      </div>
    </>
  )
}

function Def(props: { label: string; value: string }) {
  return (
    <div className="civ4-def">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  )
}

function authorityLabel(a: string): string {
  if (a === 'canonical_v3') return 'Canonical Acquisition Engine V3'
  if (a === 'frontend_defensive') return 'Conservative defensive (V3 unavailable)'
  return 'Unknown'
}
function packageLabel(p: string | null): string {
  if (p === 'package_likely') return 'Package likely'
  if (p === 'single_asset') return 'Single asset'
  return 'Unknown'
}
function outlierLabel(o: string | null): string {
  if (o === 'extreme') return 'Extreme outlier'
  if (o === 'moderate') return 'Moderate outlier'
  if (o === 'within_band') return 'Within band'
  return 'Unknown'
}
function assessLabel(a: V4SubjectComparison['assessment']): string {
  return a === 'exact' ? 'Exact' : a === 'close' ? 'Close' : a === 'material' ? 'Material' : 'Unknown'
}

function buildComparison(subject: V4Subject, comp: V4Evidence): V4SubjectComparison[] {
  const rows: V4SubjectComparison[] = []
  rows.push({
    attribute: 'Asset lane',
    subject: subject.assetLaneLabel ?? '—',
    comp: comp.assetLane ?? '—',
    difference: null,
    assessment:
      subject.assetLane && comp.assetLane
        ? String(subject.assetLane).toLowerCase() === String(comp.assetLane).toLowerCase()
          ? 'exact'
          : 'material'
        : 'unknown',
  })
  rows.push(exactRow('Units', subject.units, comp.units))
  rows.push(exactRow('Beds', subject.beds, comp.beds))
  rows.push(exactRow('Baths', subject.baths, comp.baths, 0.5))
  rows.push(pctRow('Building SF', subject.buildingSqft, comp.buildingSqft, fmtSqft))
  rows.push(pctRow('Lot SF', subject.lotSqft, comp.lotSqft, fmtSqft))
  rows.push(yearRow('Year built', subject.yearBuilt, comp.yearBuilt))
  rows.push({
    attribute: 'Distance',
    subject: '—',
    comp: fmtMiles(comp.distanceMiles),
    difference: null,
    assessment:
      comp.distanceMiles == null
        ? 'unknown'
        : comp.distanceMiles <= 1
          ? 'exact'
          : comp.distanceMiles <= 3
            ? 'close'
            : 'material',
  })
  return rows
}

function exactRow(attribute: string, s: number | null, c: number | null, band = 0): V4SubjectComparison {
  if (s == null || c == null) {
    return { attribute, subject: s != null ? fmtNumber(s) : '—', comp: c != null ? fmtNumber(c) : '—', difference: null, assessment: 'unknown' }
  }
  const d = c - s
  const assessment = d === 0 ? 'exact' : Math.abs(d) <= band ? 'close' : 'material'
  return { attribute, subject: fmtNumber(s), comp: fmtNumber(c), difference: `${d >= 0 ? '+' : ''}${d}`, assessment }
}

function pctRow(attribute: string, s: number | null, c: number | null, fmt: (v: number) => string): V4SubjectComparison {
  if (s == null || c == null || s === 0) {
    return { attribute, subject: s != null ? fmt(s) : '—', comp: c != null ? fmt(c) : '—', difference: null, assessment: 'unknown' }
  }
  const pct = ((c - s) / s) * 100
  const assessment = Math.abs(pct) <= 5 ? 'exact' : Math.abs(pct) <= 15 ? 'close' : 'material'
  return { attribute, subject: fmt(s), comp: fmt(c), difference: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, assessment }
}

function yearRow(attribute: string, s: number | null, c: number | null): V4SubjectComparison {
  if (s == null || c == null) {
    return { attribute, subject: s != null ? String(s) : '—', comp: c != null ? String(c) : '—', difference: null, assessment: 'unknown' }
  }
  const d = c - s
  const assessment = d === 0 ? 'exact' : Math.abs(d) <= 10 ? 'close' : 'material'
  return { attribute, subject: String(s), comp: String(c), difference: `${d >= 0 ? '+' : ''}${d} yr`, assessment }
}
