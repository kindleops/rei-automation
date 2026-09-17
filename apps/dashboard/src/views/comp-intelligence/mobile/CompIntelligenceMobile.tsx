import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { EvidenceMap } from '../components/EvidenceMap'
import { AdvancedModelDetails } from '../components/AdvancedModelDetails'
import { MapStatePanel } from '../components/MapStatePanel'
import {
  classifyComp,
  compMatchLabel,
  fmtCurrency,
  fmtDate,
  fmtNum,
  fmtPpsf,
  getAuthorityBadge,
  getFilterLabel,
  humanizeSourcePath,
  pricePerSqft,
  type CompFilterKey,
  type SubjectFacts,
} from '../utils/comp-display'
import type { EvidenceFilters } from '../hooks/useCompEvidenceFilters'
import type { useAnalystScenario } from '../hooks/useAnalystScenario'
import type { useCompDecisionProjection } from '../hooks/useCompDecisionProjection'
import { CompFilterSheet } from './CompFilterSheet'
import { CompDetailLayer } from './CompDetailLayer'
import './comp-intelligence-mobile.css'

/**
 * COMP INTELLIGENCE, composed for a phone.
 *
 * The desktop workspace is a two-column spatial tool: a map column beside a
 * ~50% analysis panel. At 390px that flexbox did not collapse — `is-pane-100`
 * keeps `flex-direction: row` — so mobile got a ~190px map sliver next to a
 * ~190px panel, which is the "unusable vertical sliver" §10 describes. Nothing
 * was hidden; everything was simply too narrow to read.
 *
 * This is a recomposition, not a reduction. Same hooks, same evidence, same V3
 * projection, same analyst include/exclude overrides. What changes is sequence:
 *
 *   SUBJECT      who are we valuing            compact sticky header
 *   VALUATION    what is it worth, how sure    one strip, no engine metadata
 *   MAP          where the evidence is         38vh, with a synchronized rail
 *   COMPARABLES  the evidence itself           rows; tap for the full comp
 *   EVIDENCE     why the number is the number  below, where depth belongs
 *
 * Nothing is deleted to make room. The advanced model details, the reconciliation
 * and the methodology all still render — they are last rather than absent, which
 * is the difference between progressive disclosure and removing power.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const FILTER_KEYS: CompFilterKey[] = ['all', 'strong', 'usable', 'review', 'excluded']

const evidenceId = (row: CompTransactionEvidence) => row.candidate_id || row.property_id || ''

type V3 = ReturnType<typeof useCompDecisionProjection>
type Scenario = ReturnType<typeof useAnalystScenario>

export interface CompIntelligenceMobileProps {
  subject: SubjectFacts
  address: string
  propertyId: string | null
  loading: boolean
  error: string | null
  hasCoords: boolean
  /** The resolver returns nulls when the subject could not be geocoded, so the
   *  shape must admit them; `hasCoords` is the guard, not the type. */
  coords: { lat: number | null; lng: number | null }
  /** Everything the map should show — canonical evidence merged with discovery. */
  displayEvidence: CompTransactionEvidence[]
  mappableEvidence: CompTransactionEvidence[]
  filters: EvidenceFilters
  scenario: Scenario
  v3: V3
  radius: number
  setRadius: (miles: number) => void
  monthsBack: number
  setMonthsBack: (months: number) => void
  canExpandFurther: boolean
  findMoreComps: () => unknown
  dataSource: string | null
  pipelineState: string | null
}

export const CompIntelligenceMobile = ({
  subject,
  address,
  propertyId,
  loading,
  error,
  hasCoords,
  coords,
  displayEvidence,
  mappableEvidence,
  filters,
  scenario,
  v3,
  radius,
  setRadius,
  monthsBack,
  setMonthsBack,
  canExpandFurther,
  findMoreComps,
  dataSource,
  pipelineState,
}: CompIntelligenceMobileProps) => {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [mapStyleError, setMapStyleError] = useState(false)
  const [fitBoundsToken, setFitBoundsToken] = useState(0)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const railRef = useRef<HTMLDivElement | null>(null)

  const selectedId = filters.selectedId
  const canShowMap = mappableEvidence.length > 0 || hasCoords

  /**
   * Selecting from the list scrolls the rail to the same comp and vice versa.
   * §10 requires marker selection and comparable selection to be ONE selection;
   * two independent ones is how an operator ends up reading comp A's numbers
   * while looking at comp B's pin.
   */
  useEffect(() => {
    if (!selectedId || !railRef.current) return
    const node = railRef.current.querySelector(`[data-rail-id="${CSS.escape(selectedId)}"]`)
    node?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const handleSelect = useCallback((id: string) => {
    filters.setSelectedId(id === selectedId ? null : id)
  }, [filters, selectedId])

  const detailRow = useMemo(
    () => displayEvidence.find((row) => evidenceId(row) === detailId) ?? null,
    [displayEvidence, detailId],
  )

  const activeFilterCount = filters.filter === 'all' ? 0 : 1

  const mapState = useMemo(() => {
    if (mapStyleError) return 'style_error' as const
    if (loading && !displayEvidence.length) return 'loading_subject' as const
    if (loading) return 'loading_comps' as const
    if (!canShowMap) return 'no_coords' as const
    if (!hasCoords && mappableEvidence.length) return 'comps_only' as const
    if (!mappableEvidence.length && displayEvidence.length) return 'no_coord_evidence' as const
    if (!displayEvidence.length) return 'no_comps' as const
    return null
  }, [mapStyleError, loading, canShowMap, hasCoords, mappableEvidence.length, displayEvidence.length])

  const qmv = v3.projection?.value_contract?.qualified_market_value ?? null
  const confidence = v3.finalConfidence
  const offer = v3.projection?.offer_authorization?.authorized_recommended_offer
    ?? v3.projection?.offer_authorization?.scenario_recommended_offer
    ?? null

  return (
    <div
      className="ci-m"
      data-comp-intelligence="mobile"
      data-property-id={propertyId ?? undefined}
      data-evidence-count={displayEvidence.length}
      data-mapped-count={mappableEvidence.length}
    >
      {/* ── SUBJECT ─────────────────────────────────────────────────────────
          Compact by design. §10 explicitly rules out a hero card: the operator
          needs to know WHICH property, not to admire it. */}
      <header className="ci-m__subject">
        <strong>{address}</strong>
        <span className="ci-m__subject-meta">
          {[
            [subject.city, subject.state].filter(Boolean).join(', ') || null,
            subject.beds != null ? `${subject.beds} bd` : null,
            subject.baths != null ? `${subject.baths} ba` : null,
            subject.sqft != null ? `${fmtNum(subject.sqft)} sf` : null,
            subject.yearBuilt != null ? `${subject.yearBuilt}` : null,
          ].filter(Boolean).join(' · ') || 'Property facts unavailable'}
        </span>
      </header>

      <div className="ci-m__scroll">
        {/* ── VALUATION ───────────────────────────────────────────────────── */}
        <section className="ci-m__valuation" aria-label="Valuation conclusion">
          {v3.isAuthoritative && v3.projection ? (
            <>
              <div className="ci-m__value">
                <span>Qualified market value</span>
                <strong>{formatRange(qmv)}</strong>
              </div>
              <div className="ci-m__value-strip">
                <div>
                  <span>Recommended offer</span>
                  <b>{fmtCurrency(offer)}</b>
                </div>
                <div>
                  <span>Confidence</span>
                  <b>{confidence != null ? `${Math.round(confidence)}%` : '—'}</b>
                </div>
                <div>
                  <span>Pricing comps</span>
                  <b>{v3.evidence.filter((row) => row.pricing_eligibility).length}</b>
                </div>
              </div>
              {v3.executionState && v3.executionState !== 'EXECUTABLE' ? (
                <p className="ci-m__notice is-warning">
                  {v3.executionState === 'DATA_REQUIRED'
                    ? 'The engine needs more data before this valuation is executable.'
                    : v3.executionState === 'REVIEW_REQUIRED'
                      ? 'This valuation is held for review before it can be executed.'
                      : `Execution state: ${v3.executionState}`}
                </p>
              ) : null}
            </>
          ) : (
            /* Preliminary is a STATE, not a smaller number. Nothing here falls
               back to a legacy property column to avoid showing it. */
            <div className="ci-m__value is-preliminary">
              <span>Valuation</span>
              <strong>Preliminary</strong>
              <p className="ci-m__notice">
                {loading
                  ? 'Running comp discovery…'
                  : 'No qualified V3 valuation for this property yet. The comps below are research evidence and are not an underwriting decision.'}
              </p>
            </div>
          )}
        </section>

        {/* ── MAP ─────────────────────────────────────────────────────────────
            38vh, which is the smallest height at which a subject pin and its
            surrounding comps are both legible at 390px. §10's hard rule is that
            this may never become a sliver, so the height is viewport-relative
            and the rail overlays it rather than stealing from it. */}
        <section className="ci-m__map" aria-label="Comparable evidence map">
          {canShowMap && !mapStyleError ? (
            <>
              <EvidenceMap
                subjectLat={hasCoords ? coords.lat : null}
                subjectLng={hasCoords ? coords.lng : null}
                subjectAddress={address}
                evidence={displayEvidence}
                radiusMiles={radius}
                selectedId={selectedId}
                hoveredId={null}
                loading={loading}
                onSelect={handleSelect}
                onHover={() => { /* no hover on a touch screen — §30.24 */ }}
                onStyleError={() => setMapStyleError(true)}
                fitBoundsToken={fitBoundsToken}
              />
              <button
                type="button"
                className="ci-m__map-fit"
                aria-label="Fit map to comparables"
                onClick={() => setFitBoundsToken((n) => n + 1)}
              >
                Fit
              </button>

              {/* The synchronized rail. Selecting here selects the marker. */}
              {filters.filtered.length > 0 ? (
                <div className="ci-m__rail" ref={railRef} role="listbox" aria-label="Comparables">
                  {filters.filtered.map((row) => {
                    const id = evidenceId(row)
                    const active = id === selectedId
                    return (
                      <button
                        key={id || row.address}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-rail-id={id}
                        className={cls('ci-m__rail-card', active && 'is-active')}
                        onClick={() => handleSelect(id)}
                      >
                        <b>{fmtCurrency(row.sale_price)}</b>
                        <span>{row.address}</span>
                        <em>
                          {row.geography?.distance_miles != null
                            ? `${row.geography.distance_miles.toFixed(1)} mi`
                            : '—'}
                          {' · '}
                          {fmtPpsf(pricePerSqft(row))}
                        </em>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <div className="ci-m__map-state">
              <MapStatePanel
                state={mapState ?? 'no_coords'}
                detail={error || `Property ${propertyId ?? 'unknown'}`}
              />
            </div>
          )}
        </section>

        {/* ── COMPARABLES ─────────────────────────────────────────────────── */}
        <section className="ci-m__comps" aria-label="Comparable properties">
          <header className="ci-m__comps-head">
            <h3>
              Comparables
              <b>{filters.filtered.length}</b>
            </h3>
            <button
              type="button"
              className={cls('ci-m__filter-btn', activeFilterCount > 0 && 'is-active')}
              onClick={() => setFilterSheetOpen(true)}
            >
              {filters.filter === 'all' ? 'Filters' : getFilterLabel(filters.filter)}
              {activeFilterCount > 0 ? <i>{activeFilterCount}</i> : null}
            </button>
          </header>

          {loading && filters.filtered.length === 0 ? (
            <div className="ci-m__state" role="status">
              <span className="ci-m__spinner" aria-hidden />
              <strong>Searching comps</strong>
              <span>Scanning recorded sales within {radius} miles.</span>
            </div>
          ) : error && filters.filtered.length === 0 ? (
            <div className="ci-m__state is-error">
              <strong>Comp discovery failed</strong>
              <span>{error}</span>
            </div>
          ) : filters.filtered.length === 0 ? (
            <div className="ci-m__state">
              <strong>
                {filters.counts.all === 0 ? 'No comps found' : 'Nothing matches this filter'}
              </strong>
              <span>
                {filters.counts.all === 0
                  ? `No recorded sales within ${radius} miles over the last ${monthsBack} months.`
                  : `${filters.counts.all} comps found in total — widen the filter to see them.`}
              </span>
              {canExpandFurther ? (
                <button type="button" onClick={() => { void findMoreComps() }}>Search wider</button>
              ) : null}
            </div>
          ) : (
            <div className="ci-m__list">
              {filters.filtered.map((row) => {
                const id = evidenceId(row)
                const classification = classifyComp(row)
                const excluded = scenario.excludedOverrides.has(id)
                return (
                  <div
                    key={id || row.address}
                    className={cls(
                      'ci-m__comp',
                      id === selectedId && 'is-selected',
                      excluded && 'is-excluded',
                    )}
                  >
                    {/*
                      ONE tap, both effects. Selecting highlights the pin and the
                      rail card; opening shows the comparison. Tapping a list row
                      and getting a detail view is what a list row means on a
                      phone, and the previous split — tap to select, DOUBLE-tap
                      for detail — hid the detail behind a gesture no mobile
                      operator will discover.
                    */}
                    <button
                      type="button"
                      className="ci-m__comp-main"
                      onClick={() => {
                        filters.setSelectedId(id)
                        setDetailId(id)
                      }}
                    >
                      <span className="ci-m__comp-row">
                        <b>{fmtCurrency(row.sale_price)}</b>
                        <em className={cls('ci-m__comp-tier', `is-${classification.quality.toLowerCase()}`)}>
                          {compMatchLabel(row)}
                        </em>
                      </span>
                      <span className="ci-m__comp-addr">{row.address}</span>
                      <span className="ci-m__comp-meta">
                        {fmtDate(row.sale_date)}
                        {row.geography?.distance_miles != null ? ` · ${row.geography.distance_miles.toFixed(2)} mi` : ''}
                        {` · ${fmtPpsf(pricePerSqft(row))}`}
                        {row.bedrooms != null ? ` · ${row.bedrooms} bd` : ''}
                        {row.square_feet != null ? ` · ${fmtNum(row.square_feet)} sf` : ''}
                      </span>
                      <span className="ci-m__comp-source">
                        {getAuthorityBadge(classification.authority)} · {humanizeSourcePath(row.source_path)}
                      </span>
                    </button>
                    {/* Manual evidence selection survives §10: the analyst scenario
                        is the only way to answer "what if this sale does not belong".
                        One control, not two — the row itself is the detail affordance. */}
                    <button
                      type="button"
                      className={cls('ci-m__comp-toggle', excluded && 'is-on')}
                      aria-pressed={excluded}
                      aria-label={excluded ? `Include ${row.address} in the scenario` : `Exclude ${row.address} from the scenario`}
                      onClick={() => scenario.toggleExclude(id)}
                    >
                      {excluded ? 'Excluded' : 'Exclude'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {scenario.hasOverrides ? (
            <div className="ci-m__scenario" role="status">
              <div>
                <strong>Analyst scenario</strong>
                <small>
                  {scenario.scenario?.scenario_market_value?.mid != null
                    ? `${fmtCurrency(scenario.scenario.scenario_market_value.mid)} from ${scenario.scenario.included_candidate_ids.length + (filters.counts.all - scenario.excludedOverrides.size)} comps`
                    : 'Not enough pricing-eligible comps remain to value this scenario.'}
                </small>
              </div>
              <button type="button" onClick={scenario.reset}>Reset</button>
            </div>
          ) : null}
        </section>

        {/* ── EVIDENCE / METHODOLOGY ──────────────────────────────────────────
            Present, and last. §10 is explicit that the sophisticated evidence
            still has to exist — it is sequenced, not deleted. */}
        <section className="ci-m__evidence">
          <button
            type="button"
            className="ci-m__evidence-toggle"
            aria-expanded={evidenceOpen}
            onClick={() => setEvidenceOpen((open) => !open)}
          >
            <span>Evidence &amp; methodology</span>
            <i className={cls(evidenceOpen && 'is-open')} aria-hidden />
          </button>
          {evidenceOpen ? (
            <div className="ci-m__evidence-body">
              <AdvancedModelDetails
                projection={v3.projection}
                modelHealth={v3.modelHealth}
                dataSource={dataSource}
                executionState={v3.executionState}
                canonicalLane={v3.canonicalLane}
              />
              <dl className="ci-m__facts">
                <div><dt>Search radius</dt><dd>{radius} mi</dd></div>
                <div><dt>Lookback</dt><dd>{monthsBack} months</dd></div>
                <div><dt>Discovered</dt><dd>{displayEvidence.length}</dd></div>
                <div><dt>Mapped</dt><dd>{mappableEvidence.length}</dd></div>
                <div><dt>Pipeline</dt><dd>{pipelineState ?? '—'}</dd></div>
                <div><dt>Subject coordinates</dt><dd>{subject.coordinateResolved ? subject.coordinateSource ?? 'resolved' : 'unresolved'}</dd></div>
              </dl>
            </div>
          ) : null}
        </section>
      </div>

      <CompFilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filterKeys={FILTER_KEYS}
        filter={filters.filter}
        counts={filters.counts}
        onFilterChange={filters.setFilter}
        radius={radius}
        onRadiusChange={setRadius}
        monthsBack={monthsBack}
        onMonthsBackChange={setMonthsBack}
        canExpandFurther={canExpandFurther}
        onFindMore={() => { void findMoreComps() }}
        loading={loading}
      />

      <CompDetailLayer
        row={detailRow}
        subject={subject}
        excluded={detailRow ? scenario.excludedOverrides.has(evidenceId(detailRow)) : false}
        onToggleExclude={(id) => scenario.toggleExclude(id)}
        onClose={() => setDetailId(null)}
      />
    </div>
  )
}

function formatRange(
  range: { low?: number | null; mid?: number | null; high?: number | null } | null | undefined,
): string {
  if (!range) return '—'
  const mid = range.mid ?? range.high ?? range.low
  if (mid == null) return '—'
  if (range.low != null && range.high != null && range.low !== range.high) {
    return `${fmtCurrency(range.low)} – ${fmtCurrency(range.high)}`
  }
  return fmtCurrency(mid)
}
