import { useCallback, useMemo, useRef, useState } from 'react'
import { useCompIntelligence } from '../../domain/comp-intelligence/useCompIntelligence'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../lib/data/dealContext'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { CompDecisionHeader } from './components/CompDecisionHeader'
import { CompOverviewHero } from './components/CompOverviewHero'
import { CompStatusBar } from './components/CompStatusBar'
import { ValuationUniverseGrid } from './components/ValuationUniverseGrid'
import { EvidenceMap } from './components/EvidenceMap'
import { MapCommandRail } from './components/MapCommandRail'
import { MapStatePanel } from './components/MapStatePanel'
import { MapDetailPopover } from './components/MapDetailPopover'
import { TransactionEvidenceList } from './components/TransactionEvidenceList'
import { OfferBridge } from './components/OfferBridge'
import { StrategyMatrix } from './components/StrategyMatrix'
import { ModelHealthDrawer } from './components/ModelHealthDrawer'
import { useCompDecisionProjection } from './hooks/useCompDecisionProjection'
import { useCompEvidenceFilters } from './hooks/useCompEvidenceFilters'
import {
  evidenceWithValidCoordinates,
  filterEvidenceByMapMode,
  mergeMapEvidence,
} from './adapters/transactionEvidenceAdapter'
import './comp-intelligence.css'

type IntelTabId = 'OVERVIEW' | 'COMPS' | 'STRATEGIES' | 'MODEL'
type ShellTabId = 'MAP' | 'INTELLIGENCE'

interface Props {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  viewWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
  paneWidth?: ViewWidthPercent
  paused?: boolean
}

const INTEL_TABS: { id: IntelTabId; label: string }[] = [
  { id: 'OVERVIEW', label: 'Overview' },
  { id: 'COMPS', label: 'Comps' },
  { id: 'STRATEGIES', label: 'Strategies' },
  { id: 'MODEL', label: 'Model' },
]

export function CompIntelligenceWorkspace({
  thread,
  dealContext,
  paneWidth = '75',
  layoutMode = 'split',
  paused = false,
}: Props) {
  const [intelTab, setIntelTab] = useState<IntelTabId>('OVERVIEW')
  const [shellTab, setShellTab] = useState<ShellTabId>('MAP')
  const [radius, setRadius] = useState(1)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  const [mapStyleError, setMapStyleError] = useState(false)
  const [fitBoundsToken, setFitBoundsToken] = useState(0)
  const intelPaneRef = useRef<HTMLDivElement | null>(null)

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
  } = useCompIntelligence({ thread: effectiveThread, dealContext: effectiveDealContext, radius, paused })

  const v3 = useCompDecisionProjection(payload)
  const baseEvidence = useMemo(
    () => mergeMapEvidence(v3.evidence, discovery?.candidates ?? []),
    [v3.evidence, discovery?.candidates],
  )
  const filters = useCompEvidenceFilters(baseEvidence)

  const mapModeFiltered = useMemo(
    () => filterEvidenceByMapMode(filters.filtered, filters.mapMode),
    [filters.filtered, filters.mapMode],
  )
  const mappableEvidence = useMemo(
    () => evidenceWithValidCoordinates(mapModeFiltered),
    [mapModeFiltered],
  )

  const universes = useMemo(
    () => [...new Set(baseEvidence.map((row) => row.routed_universe).filter(Boolean))] as string[],
    [baseEvidence],
  )

  const address = subject?.canonical_address?.value
    || subject?.normalized_address?.value
    || 'Subject property'

  const narrow = paneWidth === '25' || paneWidth === '50'
  const showMapPane = !narrow || shellTab === 'MAP'
  const showIntelPane = !narrow || shellTab === 'INTELLIGENCE'
  const canShowMap = mappableEvidence.length > 0 || hasCoords

  const openPopoverRow = useMemo(
    () => baseEvidence.find((row) => (row.candidate_id || row.property_id || '') === openPopoverId) ?? null,
    [baseEvidence, openPopoverId],
  )

  const handleSelectMarker = useCallback((id: string) => {
    filters.setSelectedId(id)
    setOpenPopoverId((prev) => (prev === id ? null : id))
    if (narrow) setShellTab('INTELLIGENCE')
    setIntelTab('COMPS')
  }, [filters, narrow])

  const handleViewEvidence = useCallback(() => {
    if (!openPopoverId) return
    filters.setSelectedId(openPopoverId)
    setIntelTab('COMPS')
    if (narrow) setShellTab('INTELLIGENCE')
    setOpenPopoverId(null)
    requestAnimationFrame(() => {
      intelPaneRef.current
        ?.querySelector(`[data-evidence-id="${CSS.escape(openPopoverId)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [openPopoverId, filters, narrow])

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
          <p>Select a seller or property to launch comp intelligence evidence.</p>
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
            evidence={mapModeFiltered}
            radiusMiles={radius}
            selectedId={filters.selectedId}
            hoveredId={hoveredId}
            loading={loading}
            onSelect={handleSelectMarker}
            onHover={setHoveredId}
            onStyleError={() => setMapStyleError(true)}
            fitBoundsToken={fitBoundsToken}
          />
          {!hasCoords && mappableEvidence.length > 0 && (
            <div className="ci-map-subject-notice" role="note">
              Subject pin unavailable — displaying market-level comp evidence
            </div>
          )}
          <MapCommandRail
            mapMode={filters.mapMode}
            setMapMode={filters.setMapMode}
            radius={radius}
            setRadius={setRadius}
            filters={filters.filters}
            setFilters={filters.setFilters}
            visibleCount={mappableEvidence.length}
            totalCount={baseEvidence.length}
            loading={loading}
            onResetBounds={() => setFitBoundsToken((n) => n + 1)}
            universes={universes}
          />
          {openPopoverRow && (
            <MapDetailPopover
              row={openPopoverRow}
              onClose={() => setOpenPopoverId(null)}
              onViewEvidence={handleViewEvidence}
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

  const intelColumn = (
    <div className="ci-panel ci-panel--v3" ref={intelPaneRef}>
      <CompDecisionHeader
        address={address}
        projection={v3.projection}
        dataSourceLabel={v3.isDegraded ? 'Evidence recovered' : dataSource === 'api' ? 'V3 projection' : 'Direct RPC'}
      />

      <CompStatusBar
        evidenceCount={baseEvidence.length}
        mappedCount={mappableEvidence.length}
        isDegraded={v3.isDegraded}
        isAuthoritative={v3.isAuthoritative}
        searchMode={discovery?.search_mode}
        subjectResolved={hasCoords}
        liveAuthOff={!v3.authorizedOffer}
      />

      <nav className="ci-tabs ci-tabs--intel" role="tablist" aria-label="Intelligence sections">
        {INTEL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={intelTab === tab.id}
            className={`ci-tab ${intelTab === tab.id ? 'is-active' : ''}`}
            onClick={() => setIntelTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="ci-panel__scroll" role="tabpanel">
        {intelTab === 'OVERVIEW' && (
          <>
            <CompOverviewHero
              isDegraded={v3.isDegraded}
              isAuthoritative={v3.isAuthoritative}
              projection={v3.projection}
              marketValue={v3.marketValue}
              marketClassification={v3.marketClassification}
              conservativeBuyerExit={v3.conservativeBuyerExit}
              shadowOffer={v3.shadowOffer}
              authorizedOffer={v3.authorizedOffer}
              evidenceCount={baseEvidence.length}
              mappedCount={mappableEvidence.length}
              searchMode={discovery?.search_mode}
              subjectResolved={hasCoords}
              primaryStrategy={v3.primaryStrategy}
            />
            {!v3.isDegraded && (
              <OfferBridge
                bridge={[]}
                scenarioOffer={v3.offerAuthorization?.scenario_recommended_offer ?? null}
                shadowOffer={v3.shadowOffer}
                authorizedOffer={v3.authorizedOffer}
              />
            )}
            <section className="ci-evidence-strip" aria-label="Top transaction evidence">
              <header>
                <h3>Transaction Evidence</h3>
                <span>{baseEvidence.length} records · {mappableEvidence.length} mapped</span>
              </header>
              <TransactionEvidenceList
                rows={filters.filtered.slice(0, 5)}
                selectedId={filters.selectedId}
                hoveredId={hoveredId}
                onSelect={handleSelectMarker}
                onHover={setHoveredId}
                height={360}
                compact
              />
            </section>
          </>
        )}

        {intelTab === 'COMPS' && (
          <TransactionEvidenceList
            rows={filters.filtered}
            selectedId={filters.selectedId}
            hoveredId={hoveredId}
            onSelect={handleSelectMarker}
            onHover={setHoveredId}
            height={720}
          />
        )}

        {intelTab === 'STRATEGIES' && (
          <StrategyMatrix ranked={v3.projection?.strategy_ranking?.ranked} />
        )}

        {intelTab === 'MODEL' && (
          <>
            <ValuationUniverseGrid universes={v3.universes} />
            <ModelHealthDrawer health={v3.modelHealth} open onClose={() => setIntelTab('OVERVIEW')} />
          </>
        )}
      </div>
    </div>
  )

  return (
    <div
      className={`ci-workspace ci-workspace--v3-mapfirst is-pane-${paneWidth} is-layout-${layoutMode} is-mode-${filters.mapMode}`}
      data-comp-intelligence="true"
      data-pipeline={pipelineState}
      data-source={dataSource}
      data-property-id={propertyId}
      data-evidence-count={baseEvidence.length}
      data-mapped-count={mappableEvidence.length}
    >
      {narrow && (
        <nav className="ci-shell-tabs" role="tablist" aria-label="Workspace shell">
          <button type="button" className={shellTab === 'MAP' ? 'is-active' : ''} onClick={() => setShellTab('MAP')}>Map</button>
          <button type="button" className={shellTab === 'INTELLIGENCE' ? 'is-active' : ''} onClick={() => setShellTab('INTELLIGENCE')}>Intelligence</button>
        </nav>
      )}

      <div className={`ci-split ${narrow ? 'ci-split--narrow' : ''}`}>
        {showMapPane && mapColumn}
        {showIntelPane && intelColumn}
      </div>
    </div>
  )
}

export default CompIntelligenceWorkspace