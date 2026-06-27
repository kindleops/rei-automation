/**
 * Comp Intelligence V4 — full comp dossier drawer.
 * Dedicated right-edge drawer. Property media, subject-comparison matrix,
 * sale/source intelligence, buyer/grantee (honest), and an explicit
 * QUALIFICATION BASIS that states exactly why the record was classified.
 */

import { useMemo } from 'react'
import type { V4Evidence, V4Subject, V4SubjectComparison } from '../state/types'
import { evidenceStateLongLabel, matchTierLabel } from '../adapters/labels'
import { fmtDate, fmtMiles, fmtMoneyFull, fmtNumber, fmtPpsf, fmtSqft } from '../adapters/format'
import { PropertyMedia } from './PropertyMedia'

interface CompDossierDrawerProps {
  open: boolean
  subject: V4Subject
  evidence: V4Evidence | null
  onClose: () => void
}

function pctTriBool(v: boolean | null): string {
  if (v == null) return 'Unknown'
  return v ? 'Yes' : 'No'
}

export function CompDossierDrawer(props: CompDossierDrawerProps) {
  const { open, subject, evidence, onClose } = props
  const rows = useMemo(
    () => (evidence ? buildComparison(subject, evidence) : []),
    [subject, evidence],
  )

  return (
    <>
      <div
        className={`civ4-drawer__scrim ${open ? 'is-open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`civ4-drawer ${open ? 'is-open' : ''}`}
        role="dialog"
        aria-label="Comp dossier"
        aria-hidden={!open}
      >
        {evidence && (
          <>
            <header className="civ4-drawer__head">
              <div>
                <div className="civ4-drawer__price">{fmtMoneyFull(evidence.salePrice)}</div>
                <div className="civ4-drawer__address">{evidence.address ?? 'Address unavailable'}</div>
                <div className="civ4-drawer__subline">
                  {fmtDate(evidence.saleDate)} · {fmtMiles(evidence.distanceMiles)} ·{' '}
                  {matchTierLabel(evidence.matchTier)}
                </div>
              </div>
              <button type="button" className="civ4-drawer__close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </header>

            <div className="civ4-drawer__body">
              <section className="civ4-dsection">
                <PropertyMedia
                  url={evidence.imageUrl}
                  alt={evidence.address ?? 'Comparable property'}
                  className="civ4-drawer__media"
                />
              </section>

              <section className="civ4-dsection">
                <h3 className="civ4-dsection__title">V3 qualification</h3>
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

              <section className="civ4-dsection">
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

              <section className="civ4-dsection">
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
                          <span className={`civ4-assess civ4-assess--${r.assessment}`}>
                            {assessLabel(r.assessment)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="civ4-dsection">
                <h3 className="civ4-dsection__title">Sale &amp; source</h3>
                <dl className="civ4-deflist">
                  <Def label="Sale price" value={fmtMoneyFull(evidence.salePrice)} />
                  <Def label="Sale date" value={fmtDate(evidence.saleDate)} />
                  <Def label="Source" value={evidence.sourceLabel ?? '—'} />
                  <Def label="Price / sf" value={fmtPpsf(evidence.ppsf)} />
                  <Def label="Distance" value={fmtMiles(evidence.distanceMiles)} />
                  <Def label="Asset class" value={evidence.assetLane ?? '—'} />
                  <Def label="Units" value={evidence.units != null ? fmtNumber(evidence.units) : '—'} />
                </dl>
              </section>

              <section className="civ4-dsection">
                <h3 className="civ4-dsection__title">Buyer / grantee</h3>
                <dl className="civ4-deflist">
                  <Def label="Buyer" value={evidence.buyerName ?? 'Not available'} />
                  <Def label="Entity type" value={evidence.buyerEntityType ?? 'Not available'} />
                  <Def label="Archetype" value={evidence.buyerArchetype ?? 'Not available'} />
                </dl>
                {!evidence.buyerName && (
                  <p className="civ4-dsection__pending">Buyer identity not available from current source.</p>
                )}
              </section>
            </div>
          </>
        )}
      </aside>
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
  return a === 'exact'
    ? 'Exact'
    : a === 'close'
      ? 'Close'
      : a === 'material'
        ? 'Material'
        : 'Unknown'
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
