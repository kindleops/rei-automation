import { useCallback, useMemo, useRef, useState } from 'react'
import { useCompIntelligence } from '../../domain/comp-intelligence/useCompIntelligence'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../lib/data/dealContext'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { CompDecisionHeader } from './components/CompDecisionHeader'
import { CompDecisionOverview } from './components/CompDecisionOverview'
import { ValuationUniverseGrid } from './components/ValuationUniverseGrid'
import { EvidenceMap } from './components/EvidenceMap'
import { MapCommandRail } from './components/MapCommandRail'
import { MapStatePanel } from './components/MapStatePanel'
import { MapDetailPopover } from './components/MapDetailPopover'
import { TransactionEvidenceList } from './components/TransactionEvidenceList'
import { OfferBridge } from './components/OfferBridge'
import { StrategyMatrix } from './components/StrategyMatrix'
import { ModelHealthDrawer } from './components/ModelHealthDrawer'
import { AnalystScenarioLab } from './components/AnalystScenarioLab'
import { useCompDecisionProjection } from './hooks/useCompDecisionProjection'
import { useCompEvidenceFilters } from './hooks/useCompEvidenceFilters'
import { useAnalystScenario } from './hooks/useAnalystScenario'
import {
  evidenceWithValidCoordinates,
  filterEvidenceByMapMode,
  mergeMapEvidence,
} from './adapters/transactionEvidenceAdapter'
import './comp-intelligence.css'

type IntelTabId = 'DECISION' | 'UNIVERSES' | 'EVIDENCE' | 'STRATEGIES' | 'MODEL_HEALTH' | 'ANALYST_LAB'
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
  { id: 'DECISION', label: 'Decision' },
  { id: 'UNIVERSES', label: 'Valuation Universes' },
  { id: 'EVIDENCE', label: 'Transaction Evidence' },
  { id: 'STRATEGIES', label: 'Strategies' },
  { id: 'MODEL_HEALTH', label: 'Model Health' },
  { id: 'ANALYST_LAB', label: 'Analyst Lab' },
]

export function CompIntelligenceWorkspace({
  thread,
  dealContext,
  paneWidth = '75',
  layoutMode = 'split',
  paused = false,
}: Props) {
  const [intelTab, setIntelTab] = useState<IntelTabId>('DECISION')
  const [shellTab, setShellTab] = useState<ShellTabId>('MAP')
  const [radius, setRadius] = useState(1)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  const [mapStyleError, setMapStyleError] = useState(false)
  const [fitBoundsToken, setFitBoundsToken] = useState(0)
  const intelPaneRef = useRef<HTMLDivElement | null>(null)

  const {
    payload,
    subject,
    discovery,
    coords,
    hasCoords,
    loading,
    error,
    dataSource,
    pipelineState,
  } = useCompIntelligence({ thread, dealContext, radius, paused })

  const v3 = useCompDecisionProjection(payload)
  const baseEvidence = useMemo(
    () => mergeMapEvidence(v3.evidence, discovery?.candidates ?? []),
    [v3.evidence, discovery?.candidates],
  )
  const filters = useCompEvidenceFilters(baseEvidence)
  const analyst = useAnalystScenario(baseEvidence, v3.marketValue)

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

  const dataSourceLabel = useMemo(() => {
    if (v3.isDegraded) return 'Evidence-only degraded'
    if (dataSource === 'api') return 'V3 API projection'
    if (dataSource === 'direct_rpc') return 'Direct RPC degraded'
    return 'Loading'
  }, [dataSource, v3.isDegraded])

  const offerBridge = useMemo(() => {
    const bridge = (v3.cashOffer?.bridge as Array<{ label?: string; amount?: number }>) ?? []
    return bridge.map((step) => ({
      label: step.label ?? 'Step',
      amount: typeof step.amount === 'number' ? step.amount : null,
      tier: v3.authorizedOffer != null ? 'authorized' as const : v3.shadowOffer != null ? 'shadow' as const : 'scenario' as const,
    }))
  }, [v3.cashOffer, v3.authorizedOffer, v3.shadowOffer])

  const narrow = paneWidth === '25' || paneWidth === '50'
  const showMapPane = !narrow || shellTab === 'MAP'
  const showIntelPane = !narrow || shellTab === 'INTELLIGENCE'

  const openPopoverRow = useMemo(
    () => baseEvidence.find((row) => (row.candidate_id || row.property_id || '') === openPopoverId) ?? null,
    [baseEvidence, openPopoverId],
  )

  const handleSelectMarker = useCallback((id: string) => {
    filters.setSelectedId(id)
    setOpenPopoverId((prev) => (prev === id ? null : id))
    if (narrow) setShellTab('INTELLIGENCE')
    setIntelTab('EVIDENCE')
  }, [filters, narrow])

  const handleViewEvidence = useCallback(() => {
    if (!openPopoverId) return
    filters.setSelectedId(openPopoverId)
    setIntelTab('EVIDENCE')
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
    if (loading && !hasCoords) return 'loading_subject' as const
    if (!hasCoords || coords.lat == null || coords.lng == null) return 'no_coords' as const
    if (loading) return 'loading_comps' as const
    if (v3.isDegraded) return 'degraded' as const
    if (!mappableEvidence.length && baseEvidence.length) return 'no_coord_evidence' as const
    if (!baseEvidence.length) return 'no_comps' as const
    return null
  }, [mapStyleError, loading, hasCoords, coords.lat, coords.lng, v3.isDegraded, mappableEvidence.length, baseEvidence.length])

  if (!thread) {
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
      {hasCoords && coords.lat != null && coords.lng != null ? (
        <>
          <EvidenceMap
            subjectLat={coords.lat}
            subjectLng={coords.lng}
            subjectAddress={address}
            evidence={mapModeFiltered}
            radiusMiles={radius}
            selectedId={filters.selectedId}
            hoveredId={hoveredId}
            loading={loading}
            onSelect={handleSelectMarker}
            onHover={setHoveredId}
            onStyleError={() => setMapStyleError(true)}
            onReady={() => setFitBoundsToken((n) => n + 1)}
            fitBoundsToken={fitBoundsToken}
          />
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
          <MapStatePanel state={mapState ?? 'no_coords'} detail={subject?.coordinate_failure_reason} />
        </div>
      )}

      {mapState && hasCoords && (
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
        dataSourceLabel={dataSourceLabel}
      />

      {error && <div className="ci-banner ci-banner--warn" role="alert">{error}</div>}
      {v3.isDegraded && (
        <div className="ci-banner ci-banner--degraded" role="status">
          V3 decision evidence unavailable — evidence-only degraded recovery.
        </div>
      )}

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
        {intelTab === 'DECISION' && (
          <>
            <CompDecisionOverview
              projection={v3.projection}
              marketValue={v3.marketValue}
              marketClassification={v3.marketClassification}
              conservativeBuyerExit={v3.conservativeBuyerExit}
              shadowOffer={v3.shadowOffer}
              authorizedOffer={v3.authorizedOffer}
            />
            <OfferBridge
              bridge={offerBridge}
              scenarioOffer={v3.offerAuthorization?.scenario_recommended_offer ?? null}
              shadowOffer={v3.shadowOffer}
              authorizedOffer={v3.authorizedOffer}
            />
            <section className="ci-evidence-strip" aria-label="Top transaction evidence">
              <header>
                <h3>Transaction Evidence</h3>
                <span>{baseEvidence.length} records · {mappableEvidence.length} mapped</span>
              </header>
              <TransactionEvidenceList
                rows={filters.filtered.slice(0, 6)}
                selectedId={filters.selectedId}
                hoveredId={hoveredId}
                onSelect={handleSelectMarker}
                onHover={setHoveredId}
                height={320}
                compact
              />
            </section>
          </>
        )}

        {intelTab === 'UNIVERSES' && <ValuationUniverseGrid universes={v3.universes} />}

        {intelTab === 'EVIDENCE' && (
          <TransactionEvidenceList
            rows={filters.filtered}
            selectedId={filters.selectedId}
            hoveredId={hoveredId}
            onSelect={handleSelectMarker}
            onHover={setHoveredId}
            height={640}
          />
        )}

        {intelTab === 'STRATEGIES' && (
          <StrategyMatrix ranked={v3.projection?.strategy_ranking?.ranked} />
        )}

        {intelTab === 'MODEL_HEALTH' && (
          <ModelHealthDrawer health={v3.modelHealth} open onClose={() => setIntelTab('DECISION')} />
        )}

        {intelTab === 'ANALYST_LAB' && (
          <AnalystScenarioLab
            scenario={analyst.scenario}
            evidence={baseEvidence}
            onToggleInclude={analyst.toggleInclude}
            onToggleExclude={analyst.toggleExclude}
            onReset={analyst.reset}
          />
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