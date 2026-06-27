import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCompIntelligence } from '../../domain/comp-intelligence/useCompIntelligence'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../lib/data/dealContext'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { EvidenceMap } from './components/EvidenceMap'
import { MapCommandRail } from './components/MapCommandRail'
import { MapStatePanel } from './components/MapStatePanel'
import { SelectedCompPreview } from './components/SelectedCompPreview'
import { SubjectPropertyCard } from './components/SubjectPropertyCard'
import { CompMarketSummary } from './components/CompMarketSummary'
import { PropertyCompCard } from './components/PropertyCompCard'
import { OfficialDecisionSection } from './components/OfficialDecisionSection'
import { AdvancedModelDetails } from './components/AdvancedModelDetails'
import { useCompDecisionProjection } from './hooks/useCompDecisionProjection'
import { useCompEvidenceFilters } from './hooks/useCompEvidenceFilters'
import { useAnalystScenario } from './hooks/useAnalystScenario'
import {
  evidenceWithValidCoordinates,
  filterEvidenceByMapMode,
  mergeMapEvidence,
} from './adapters/transactionEvidenceAdapter'
import {
  classifyComp,
  computeMarketSummary,
  fmtCurrency,
  fmtDate,
  fmtPpsf,
  getFilterLabel,
  pricePerSqft,
  subjectFactsFromPayload,
  type CompFilterKey,
} from './utils/comp-display'
import './comp-intelligence.css'

interface Props {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  viewWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
  paneWidth?: ViewWidthPercent
  paused?: boolean
}

const FILTER_KEYS: CompFilterKey[] = ['all', 'strong', 'usable', 'review', 'excluded']

export function CompIntelligenceWorkspace({
  thread,
  dealContext,
  paneWidth = '100',
  layoutMode = 'medium',
  paused = false,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  const [mapStyleError, setMapStyleError] = useState(false)
  const [fitBoundsToken, setFitBoundsToken] = useState(0)
  const [recenterToken, setRecenterToken] = useState(0)
  const [mapStyleMode, setMapStyleMode] = useState<'STREET' | 'SATELLITE' | 'HYBRID'>(() => {
    if (typeof window === 'undefined') return 'STREET'
    return (sessionStorage.getItem('ci-map-style') as any) || 'STREET'
  })
  const propertyPaneRef = useRef<HTMLDivElement | null>(null)

  // Always read current URL on render so SPA navigations with ?property_id update subject (fixes disappearing/wrong subject card)
  const urlPropertyId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('property_id')
    : null

  const effectiveDealContext = useMemo(() => {
    if (urlPropertyId) {
      return {
        ...(dealContext ?? {}),
        propertyId: urlPropertyId,
        property_id: urlPropertyId,
      } as DealContext
    }
    if (dealContext?.propertyId || dealContext?.property_id) return dealContext
    return dealContext ?? null
  }, [dealContext, urlPropertyId])

  const effectiveThread = useMemo(() => {
    if (urlPropertyId) {
      return {
        thread_key: `direct-${urlPropertyId}`,
        property_id: urlPropertyId,
        subject: dealContext?.propertyAddress
          || dealContext?.property_address_full
          || '',
      } as unknown as InboxWorkflowThread
    }
    if (thread) return thread
    const propertyId = effectiveDealContext?.propertyId || effectiveDealContext?.property_id
    if (!propertyId) return null
    return {
      thread_key: `proof-${propertyId}`,
      property_id: propertyId,
      subject: effectiveDealContext?.propertyAddress || effectiveDealContext?.property_address_full || 'Subject property',
    } as unknown as InboxWorkflowThread
  }, [thread, urlPropertyId, effectiveDealContext, dealContext])

  const {
    propertyId,
    canonical,
    payload,
    subject,
    discovery,
    coords,
    hasCoords,
    loading,
    error,
    dataSource,
    pipelineState,
    radius,
    setRadius,
    monthsBack,
    setMonthsBack,
    expansionLog,
    findMoreComps,
    canExpandFurther,
  } = useCompIntelligence({ thread: effectiveThread, dealContext: effectiveDealContext, paused })

  const v3 = useCompDecisionProjection(payload)
  const baseEvidence = useMemo(
    () => mergeMapEvidence(v3.evidence, discovery?.candidates ?? []),
    [v3.evidence, discovery?.candidates],
  )
  const displayEvidence = useMemo(
    () => filterEvidenceByMapMode(baseEvidence, 'PRICING'),
    [baseEvidence],
  )
  const filters = useCompEvidenceFilters(displayEvidence)
  const scenario = useAnalystScenario(baseEvidence, v3.marketValue)

  const mappableEvidence = useMemo(
    () => evidenceWithValidCoordinates(filters.filtered),
    [filters.filtered],
  )

  const address = subject?.canonical_address?.value
    || subject?.normalized_address?.value
    || canonical?.display_address
    || canonical?.normalized_address
    || effectiveThread?.subject
    || effectiveDealContext?.propertyAddress
    || effectiveDealContext?.property_address_full
    || 'Subject property'

  const subjectFacts = useMemo(
    () => subjectFactsFromPayload(subject, address),
    [subject, address],
  )

  const qualifiedEvidence = useMemo(
    () => displayEvidence.filter((r: any) => {
      const st = (r.qualification_status || '').toUpperCase();
      const sim = r.similarity ?? r.qualification_score ?? 0;
      const c = classifyComp(r);
      // For degraded/direct, use similarity or tier; prefer not excluded and reasonable match
      return (st === 'ACCEPTED' || r.pricing_eligibility === true) || (c.quality === 'STRONG' || c.quality === 'USABLE' || sim >= 65);
    }),
    [displayEvidence],
  );
  const marketSummary = useMemo(
    () => computeMarketSummary(qualifiedEvidence, radius, monthsBack, v3.isDegraded || !v3.isAuthoritative),
    [qualifiedEvidence, radius, monthsBack, v3.isDegraded, v3.isAuthoritative],
  )

  const showPreliminaryNotice = v3.isDegraded || !v3.isAuthoritative
  const canShowMap = mappableEvidence.length > 0 || hasCoords

  const openPopoverRow = useMemo(
    () => baseEvidence.find((row) => (row.candidate_id || row.property_id || '') === openPopoverId) ?? null,
    [baseEvidence, openPopoverId],
  )

  const selectedRow = useMemo(
    () => baseEvidence.find((r) => (r.candidate_id || r.property_id || '') === filters.selectedId) ?? null,
    [baseEvidence, filters.selectedId],
  )

  // Selection clear on filter change is handled inside the hook (graceful)
  const handleSelectComp = useCallback((id: string) => {
    filters.setSelectedId(id)
    setOpenPopoverId((prev) => (prev === id ? null : id))
    requestAnimationFrame(() => {
      propertyPaneRef.current
        ?.querySelector(`[data-evidence-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [filters])

  const handleViewFullComp = useCallback(() => {
    if (!openPopoverId) return
    handleSelectComp(openPopoverId)
    setOpenPopoverId(null)
  }, [openPopoverId, handleSelectComp])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('ci-map-style', mapStyleMode)
    }
  }, [mapStyleMode])

  const mapState = useMemo(() => {
    if (mapStyleError) return 'style_error' as const
    if (loading && !baseEvidence.length) return 'loading_subject' as const
    if (loading) return 'loading_comps' as const
    if (!canShowMap) return 'no_coords' as const
    if (!hasCoords && mappableEvidence.length) return 'comps_only' as const
    if (!mappableEvidence.length && baseEvidence.length) return 'no_coord_evidence' as const
    if (!baseEvidence.length) return 'no_comps' as const
    return null
  }, [mapStyleError, loading, canShowMap, hasCoords, mappableEvidence.length, baseEvidence.length])

  if (!effectiveThread) {
    return (
      <div className={`ci-workspace ci-workspace--empty is-pane-${paneWidth} is-layout-${layoutMode}`} data-comp-intelligence="true">
        <div className="ci-empty-state">
          <div className="ci-empty-state__icon">⌖</div>
          <strong>No Subject Selected</strong>
          <p>Select a seller or property to launch comp intelligence.</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`ci-workspace is-pane-${paneWidth} is-layout-${layoutMode}`}
      data-comp-intelligence="true"
      data-pipeline={pipelineState}
      data-source={dataSource}
      data-property-id={propertyId}
      data-evidence-count={baseEvidence.length}
      data-mapped-count={mappableEvidence.length}
      data-radius={radius}
      data-months-back={monthsBack}
    >
      <div className="ci-workspace__map-col">
        {canShowMap && !mapStyleError ? (
          <>
            <EvidenceMap
              subjectLat={hasCoords ? coords.lat : null}
              subjectLng={hasCoords ? coords.lng : null}
              subjectAddress={address}
              evidence={displayEvidence}
              radiusMiles={radius}
              selectedId={filters.selectedId}
              hoveredId={hoveredId}
              loading={loading}
              onSelect={handleSelectComp}
              onHover={setHoveredId}
              onStyleError={() => setMapStyleError(true)}
              fitBoundsToken={fitBoundsToken}
              recenterToken={recenterToken}
              mapStyle={mapStyleMode}
            />
            {!hasCoords && mappableEvidence.length > 0 && (
              <div className="ci-map-subject-notice" role="note">
                Subject pin unavailable — displaying recovered comp evidence on map
              </div>
            )}
            <MapCommandRail
              radius={radius}
              setRadius={setRadius}
              visibleCount={displayEvidence.length}
              loading={loading}
              onResetBounds={() => setFitBoundsToken((n) => n + 1)}
              onFitComps={() => setFitBoundsToken((n) => n + 1)}
              onRecenter={() => setRecenterToken((n) => n + 1)}
              onFindMoreComps={() => { void findMoreComps() }}
              expansionLog={expansionLog}
              canExpand={canExpandFurther}
              // expansion details for reporting (populated via hook expansionLog for now)
            />

            {/* Compact map style selector (STREET / SATELLITE / HYBRID) persisted per session */}
            <div className="ci-map-style-switch" role="group" aria-label="Map style">
              {(['STREET', 'SATELLITE', 'HYBRID'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`ci-map-style-btn${mapStyleMode === mode ? ' is-active' : ''}`}
                  onClick={() => setMapStyleMode(mode)}
                  title={mode}
                >
                  {mode === 'STREET' ? 'S' : mode === 'SATELLITE' ? '◉' : 'H'}
                </button>
              ))}
            </div>
            {openPopoverRow && (
              <SelectedCompPreview
                row={openPopoverRow}
                onClose={() => setOpenPopoverId(null)}
                onViewFull={handleViewFullComp}
              />
            )}
          </>
        ) : (
          <div className="ci-map-canvas ci-map-no-coords-wrap">
            <MapStatePanel
              state={mapState ?? 'no_coords'}
              detail={error || subject?.coordinate_failure_reason || `Property ${propertyId}`}
            />
          </div>
        )}

        {mapState && canShowMap && mapState !== 'comps_only' && (
          <div className="ci-map-state-overlay">
            <MapStatePanel state={mapState} detail={error} />
          </div>
        )}
      </div>

      <div className="ci-panel" ref={propertyPaneRef}>
        <SubjectPropertyCard
          subject={subjectFacts}
          radiusMiles={radius}
          monthsBack={monthsBack}
          compCount={displayEvidence.length}
          loading={loading}
          valueLabel={subject?.estimated_value?.source ? 'Provider / ' + (subject.estimated_value.source || 'Estimate') : 'Provider Estimate'}
          coordinateStatus={subject?.coordinate_source ? `${subject.coordinate_source} (${subject.coordinate_confidence ?? 0})` : undefined}
        />

        <CompMarketSummary summary={marketSummary} />

        {/* Basic search controls (Phase 3 start) - radius already in map rail, add date */}
        <div className="ci-search-controls" role="group" aria-label="Search controls">
          <span>Lookback:</span>
          {[3,6,12,18,24,36].map(m => (
            <button
              key={m}
              className={`ci-ctrl-btn${monthsBack === m ? ' is-active' : ''}`}
              onClick={() => setMonthsBack(m)}
              disabled={loading}
            >{m}mo</button>
          ))}
          <span className="ci-ctrl-note"> (affects discovery; V3 may use different windows)</span>
        </div>

        {selectedRow && (
          <div className="ci-detail-drawer" role="dialog" aria-label="Comp detail">
            <div className="ci-detail-head">
              <strong>Comp Detail</strong>
              <button className="ci-detail-close" onClick={() => filters.setSelectedId(null)}>Close</button>
            </div>
            <div className="ci-detail-body">
              <div className="ci-detail-price">{fmtCurrency(selectedRow.sale_price)}</div>
              <div className="ci-detail-addr">{selectedRow.address}</div>
              <div className="ci-detail-meta">
                {fmtDate(selectedRow.sale_date)} · {selectedRow.geography.distance_miles?.toFixed(2)} mi · {selectedRow.source_path || selectedRow.evidence_role || 'Recorded'}
              </div>

              <div className="ci-detail-section">
                <h4>Sale Summary</h4>
                <div>Price: {fmtCurrency(selectedRow.sale_price)} · PPSF {fmtPpsf(pricePerSqft(selectedRow))}</div>
              </div>

              <div className="ci-detail-section">
                <h4>Subject Comparison</h4>
                <table className="ci-compare-table">
                  <thead><tr><th>Attr</th><th>Subject</th><th>Comp</th><th>Δ</th></tr></thead>
                  <tbody>
                    <tr><td>Beds</td><td>{subjectFacts.beds ?? '—'}</td><td>{selectedRow.bedrooms ?? '—'}</td><td>{selectedRow.bedrooms === subjectFacts.beds ? 'Exact' : '—'}</td></tr>
                    <tr><td>Sq Ft</td><td>{subjectFacts.sqft ?? '—'}</td><td>{selectedRow.square_feet ?? '—'}</td><td>—</td></tr>
                    <tr><td>Price</td><td>—</td><td>{fmtCurrency(selectedRow.sale_price)}</td><td>—</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="ci-detail-section">
                <h4>Buyer / Transaction</h4>
                <div>{selectedRow.buyer || 'Not available'} · {selectedRow.buyer_archetype || 'Unknown'} · {selectedRow.transaction_channel || 'Not available'}</div>
                <div>Source: {selectedRow.source_lineage?.source_table || selectedRow.evidence_role || 'Unknown'} | Status: {selectedRow.qualification_status || 'N/A'} | Eligible: {selectedRow.pricing_eligibility ? 'Pricing' : 'Context'}</div>
              </div>

              <div className="ci-detail-section">
                <h4>More Evidence</h4>
                <div>Distance: {selectedRow.geography.distance_miles} mi | Recency: {selectedRow.recency || 'N/A'}</div>
              </div>

              <div className="ci-detail-actions">
                <button onClick={() => { /* view on map already selected */ }}>View on Map</button>
                <button onClick={() => filters.setSelectedId(null)}>Close</button>
              </div>
            </div>
          </div>
        )}

        {showPreliminaryNotice && (
          <p className="ci-prelim-list-notice" role="note">
            Preliminary comps are shown for review and are not part of an official underwriting decision.
          </p>
        )}

        {/* Subject card is ALWAYS rendered above any filter-dependent comp list */}
        {/* Filters only affect comp cards + map markers. Subject hero is outside this branch. */}

        <div className="ci-comp-filters" role="group" aria-label="Comp quality filters">
          {FILTER_KEYS.map((key) => {
            const count = filters.counts[key]
            const isActive = filters.filter === key
            const isZero = count === 0
            return (
              <button
                key={key}
                type="button"
                className={`ci-comp-filter-btn${isActive ? ' is-active' : ''}${isZero ? ' is-disabled' : ''}`}
                onClick={() => {
                  if (!isZero) filters.setFilter(key)
                }}
                disabled={isZero}
                aria-pressed={isActive}
              >
                {getFilterLabel(key)} <span className="ci-filter-count">{count}</span>
              </button>
            )
          })}
        </div>

        <section className="ci-list-section" aria-label="Comparable properties">
          <header className="ci-list-section__head">
            <h3>Comparable Properties (Qualified focus)</h3>
            <span>
              Qualified {qualifiedEvidence.length} / Discovered {displayEvidence.length}
            </span>
          </header>

          {loading && !filters.filtered.length ? (
            <div className="ci-list-status">
              <strong>Searching comps</strong>
              <p>Scanning sales within {radius} miles…</p>
            </div>
          ) : !filters.filtered.length ? (
            <div className="ci-list-status">
              <strong>No matching comps in this filter</strong>
              <p>Showing {filters.counts.all} total results. Select another filter or expand radius.</p>
            </div>
          ) : (
            <div className="ci-evidence-list">
              {filters.filtered.map((row) => {
                const id = row.candidate_id || row.property_id || ''
                return (
                  <PropertyCompCard
                    key={id || row.address || ''}
                    row={row}
                    subject={subjectFacts}
                    selected={filters.selectedId === id}
                    hovered={hoveredId === id}
                    expanded={filters.selectedId === id}
                    scenarioExcluded={scenario.excludedOverrides.has(id)}
                    onSelect={handleSelectComp}
                    onHover={setHoveredId}
                    onIncludeScenario={scenario.toggleInclude}
                  />
                )
              })}
            </div>
          )}
        </section>

        <OfficialDecisionSection
          projection={v3.projection}
          isAuthoritative={v3.isAuthoritative}
          supportingCompCount={v3.evidence.filter((r) => r.pricing_eligibility).length}
        />

        <AdvancedModelDetails
          projection={v3.projection}
          modelHealth={v3.modelHealth}
          dataSource={dataSource}
          executionState={v3.executionState}
          canonicalLane={v3.canonicalLane}
        />
      </div>
    </div>
  )
}

export default CompIntelligenceWorkspace