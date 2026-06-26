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
  computeMarketSummary,
  subjectFactsFromPayload,
} from './utils/comp-display'
import './comp-intelligence.css'

type RightPaneTab = 'COMPS' | 'VALUE' | 'DECISION'
type ShellTabId = 'MAP' | 'PROPERTY'

interface Props {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  viewWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
  paneWidth?: ViewWidthPercent
  paused?: boolean
}

const QUALITY_FILTERS = [
  { id: 'all' as const, label: 'All comps' },
  { id: 'strong' as const, label: 'Strong' },
  { id: 'usable' as const, label: 'Usable' },
  { id: 'excluded' as const, label: 'Excluded' },
]

export function CompIntelligenceWorkspace({
  thread,
  dealContext,
  paneWidth = '75',
  layoutMode = 'split',
  paused = false,
}: Props) {
  const [rightTab, setRightTab] = useState<RightPaneTab>('COMPS')
  const [shellTab, setShellTab] = useState<ShellTabId>('MAP')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  const [mapStyleError, setMapStyleError] = useState(false)
  const [fitBoundsToken, setFitBoundsToken] = useState(0)
  const [recenterToken, setRecenterToken] = useState(0)
  const propertyPaneRef = useRef<HTMLDivElement | null>(null)

  const urlPropertyId = useMemo(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('property_id')
  }, [])

  const effectiveDealContext = useMemo(() => {
    if (dealContext?.propertyId || dealContext?.property_id) return dealContext
    if (!urlPropertyId) return dealContext
    return {
      ...(dealContext ?? {}),
      propertyId: urlPropertyId,
      property_id: urlPropertyId,
    } as DealContext
  }, [dealContext, urlPropertyId])

  const effectiveThread = useMemo(() => {
    if (thread) return thread
    const propertyId = urlPropertyId
      || effectiveDealContext?.propertyId
      || effectiveDealContext?.property_id
    if (!propertyId) return null
    return {
      thread_key: `proof-${propertyId}`,
      property_id: propertyId,
      subject: effectiveDealContext?.propertyAddress || effectiveDealContext?.property_address_full || 'Subject property',
    } as InboxWorkflowThread
  }, [thread, urlPropertyId, effectiveDealContext])

  const {
    propertyId,
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
    || 'Subject property'

  const subjectFacts = useMemo(
    () => subjectFactsFromPayload(subject, address),
    [subject, address],
  )

  const marketSummary = useMemo(
    () => computeMarketSummary(displayEvidence, radius, monthsBack, v3.isDegraded || !v3.isAuthoritative),
    [displayEvidence, radius, monthsBack, v3.isDegraded, v3.isAuthoritative],
  )

  const narrow = paneWidth === '25' || paneWidth === '50'
  const showMapPane = !narrow || shellTab === 'MAP'
  const showPropertyPane = !narrow || shellTab === 'PROPERTY'
  const canShowMap = mappableEvidence.length > 0 || hasCoords

  const openPopoverRow = useMemo(
    () => baseEvidence.find((row) => (row.candidate_id || row.property_id || '') === openPopoverId) ?? null,
    [baseEvidence, openPopoverId],
  )

  const showDecisionTab = v3.isAuthoritative
  const showValueTab = v3.isAuthoritative && v3.marketValue != null

  useEffect(() => {
    if (!filters.selectedId) return
    const stillPresent = baseEvidence.some((row) => (row.candidate_id || row.property_id || '') === filters.selectedId)
    if (!stillPresent) filters.setSelectedId(null)
  }, [baseEvidence, filters.selectedId, filters])

  const handleSelectComp = useCallback((id: string) => {
    filters.setSelectedId(id)
    setOpenPopoverId((prev) => (prev === id ? null : id))
    if (narrow) setShellTab('PROPERTY')
    setRightTab('COMPS')
    requestAnimationFrame(() => {
      propertyPaneRef.current
        ?.querySelector(`[data-evidence-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [filters, narrow])

  const handleViewFullComp = useCallback(() => {
    if (!openPopoverId) return
    handleSelectComp(openPopoverId)
    setOpenPopoverId(null)
  }, [openPopoverId, handleSelectComp])

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

  const mapColumn = (
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
          />
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
  )

  const propertyColumn = (
    <div className="ci-panel ci-panel--property" ref={propertyPaneRef}>
      <nav className="ci-tabs ci-tabs--secondary" role="tablist" aria-label="Property views">
        <button
          type="button"
          role="tab"
          aria-selected={rightTab === 'COMPS'}
          className={`ci-tab ${rightTab === 'COMPS' ? 'is-active' : ''}`}
          onClick={() => setRightTab('COMPS')}
        >
          Comps
        </button>
        {showValueTab && (
          <button
            type="button"
            role="tab"
            aria-selected={rightTab === 'VALUE'}
            className={`ci-tab ${rightTab === 'VALUE' ? 'is-active' : ''}`}
            onClick={() => setRightTab('VALUE')}
          >
            Value
          </button>
        )}
        {showDecisionTab && (
          <button
            type="button"
            role="tab"
            aria-selected={rightTab === 'DECISION'}
            className={`ci-tab ${rightTab === 'DECISION' ? 'is-active' : ''}`}
            onClick={() => setRightTab('DECISION')}
          >
            Decision
          </button>
        )}
      </nav>

      <div className="ci-panel__scroll" role="tabpanel">
        {rightTab === 'COMPS' && (
          <>
            <SubjectPropertyCard
              subject={subjectFacts}
              radiusMiles={radius}
              monthsBack={monthsBack}
              compCount={displayEvidence.length}
              loading={loading}
            />
            <CompMarketSummary summary={marketSummary} />
            <div className="ci-comp-filters" role="group" aria-label="Comp quality filters">
              {QUALITY_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`ci-comp-filter-btn${filters.qualityFilter === filter.id ? ' is-active' : ''}`}
                  onClick={() => filters.setQualityFilter(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <section className="ci-comp-list-section" aria-label="Comparable properties">
              <header className="ci-comp-list-section__head">
                <h3>Comparable Properties</h3>
                <span>{filters.filtered.length} shown</span>
              </header>
              {loading && !filters.filtered.length ? (
                <div className="ci-comp-skeleton-list" aria-hidden>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="ci-comp-skeleton" />
                  ))}
                </div>
              ) : !filters.filtered.length ? (
                <p className="ci-empty">No comps match the current search and filters.</p>
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
                        scenarioIncluded={scenario.includedOverrides.has(id)}
                        scenarioExcluded={scenario.excludedOverrides.has(id)}
                        onSelect={handleSelectComp}
                        onHover={setHoveredId}
                        onIncludeScenario={scenario.toggleInclude}
                        onExcludeScenario={scenario.toggleExclude}
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
          </>
        )}

        {rightTab === 'VALUE' && showValueTab && (
          <section className="ci-value-pane">
            <h3>Qualified Market Value</h3>
            <p className="ci-value-pane__amount tabular-nums">
              {v3.marketValue != null
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v3.marketValue)
                : '—'}
            </p>
            <p className="ci-value-pane__note">Official V3 valuation projection</p>
          </section>
        )}

        {rightTab === 'DECISION' && showDecisionTab && (
          <>
            <OfficialDecisionSection
              projection={v3.projection}
              isAuthoritative
              supportingCompCount={v3.evidence.filter((r) => r.pricing_eligibility).length}
            />
            <AdvancedModelDetails
              projection={v3.projection}
              modelHealth={v3.modelHealth}
              dataSource={dataSource}
              executionState={v3.executionState}
              canonicalLane={v3.canonicalLane}
            />
          </>
        )}
      </div>
    </div>
  )

  return (
    <div
      className={`ci-workspace ci-workspace--property-first is-pane-${paneWidth} is-layout-${layoutMode}`}
      data-comp-intelligence="true"
      data-pipeline={pipelineState}
      data-source={dataSource}
      data-property-id={propertyId}
      data-evidence-count={baseEvidence.length}
      data-mapped-count={mappableEvidence.length}
      data-radius={radius}
      data-months-back={monthsBack}
    >
      {narrow && (
        <nav className="ci-shell-tabs" role="tablist" aria-label="Workspace shell">
          <button type="button" className={shellTab === 'MAP' ? 'is-active' : ''} onClick={() => setShellTab('MAP')}>Map</button>
          <button type="button" className={shellTab === 'PROPERTY' ? 'is-active' : ''} onClick={() => setShellTab('PROPERTY')}>Property</button>
        </nav>
      )}

      <div className={`ci-split ${narrow ? 'ci-split--narrow' : ''}`}>
        {showMapPane && mapColumn}
        {showPropertyPane && propertyColumn}
      </div>
    </div>
  )
}

export default CompIntelligenceWorkspace