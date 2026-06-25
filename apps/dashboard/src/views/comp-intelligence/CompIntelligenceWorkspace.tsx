import { useMemo, useState } from 'react'
import { useCompIntelligence } from '../../domain/comp-intelligence/useCompIntelligence'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../lib/data/dealContext'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { CompDecisionHeader } from './components/CompDecisionHeader'
import { CompDecisionOverview } from './components/CompDecisionOverview'
import { ValuationUniverseGrid } from './components/ValuationUniverseGrid'
import { EvidenceMap } from './components/EvidenceMap'
import { EvidenceFilterBar } from './components/EvidenceFilterBar'
import { TransactionEvidenceList } from './components/TransactionEvidenceList'
import { OfferBridge } from './components/OfferBridge'
import { StrategyMatrix } from './components/StrategyMatrix'
import { ModelHealthDrawer } from './components/ModelHealthDrawer'
import { AnalystScenarioLab } from './components/AnalystScenarioLab'
import { useCompDecisionProjection } from './hooks/useCompDecisionProjection'
import { useCompEvidenceFilters } from './hooks/useCompEvidenceFilters'
import { useAnalystScenario } from './hooks/useAnalystScenario'
import './comp-intelligence.css'

type TabId = 'DECISION' | 'UNIVERSES' | 'EVIDENCE' | 'STRATEGIES' | 'MODEL_HEALTH' | 'ANALYST_LAB'

interface Props {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  viewWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
  paused?: boolean
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'DECISION', label: 'Decision' },
  { id: 'UNIVERSES', label: 'Valuation Universes' },
  { id: 'EVIDENCE', label: 'Transaction Evidence' },
  { id: 'STRATEGIES', label: 'Strategies' },
  { id: 'MODEL_HEALTH', label: 'Model Health' },
  { id: 'ANALYST_LAB', label: 'Analyst Lab' },
]

export function CompIntelligenceWorkspace({ thread, dealContext, paused = false }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('DECISION')
  const [modelHealthOpen, setModelHealthOpen] = useState(false)

  const {
    payload,
    subject,
    coords,
    hasCoords,
    loading,
    error,
    dataSource,
    pipelineState,
  } = useCompIntelligence({ thread, dealContext, paused })

  const v3 = useCompDecisionProjection(payload)
  const filters = useCompEvidenceFilters(v3.evidence)
  const analyst = useAnalystScenario(v3.evidence, v3.marketValue)

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

  const narrow = false

  return (
    <div className="ci-workspace ci-workspace--v3" data-pipeline={pipelineState} data-source={dataSource}>
      <CompDecisionHeader
        address={address}
        projection={v3.projection}
        dataSourceLabel={dataSourceLabel}
      />

      {loading && <div className="ci-banner ci-banner--loading">Loading V3 decision evidence…</div>}
      {error && <div className="ci-banner ci-banner--warn" role="alert">{error}</div>}
      {v3.isDegraded && (
        <div className="ci-banner ci-banner--degraded" role="status">
          V3 decision evidence unavailable — showing evidence-only degraded recovery. No authoritative valuation or offer.
        </div>
      )}
      {v3.legacy && !v3.isAuthoritative && (
        <div className="ci-banner ci-banner--legacy" role="status">
          {v3.legacy.label}
        </div>
      )}

      <nav className="ci-tabs" role="tablist" aria-label="Comp intelligence sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`ci-tab ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => {
              setActiveTab(tab.id)
              if (tab.id === 'MODEL_HEALTH') setModelHealthOpen(true)
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className={`ci-body ${narrow ? 'ci-body--stacked' : ''}`}>
        <div className="ci-map-pane">
          {hasCoords && coords.lat != null && coords.lng != null ? (
            <EvidenceMap
              subjectLat={coords.lat}
              subjectLng={coords.lng}
              subjectAddress={address}
              evidence={filters.filtered}
              mapMode={filters.mapMode}
              selectedId={filters.selectedId}
              onSelect={filters.setSelectedId}
            />
          ) : (
            <div className="ci-map-placeholder">Subject coordinates required for spatial evidence.</div>
          )}
        </div>

        <div className="ci-intel-pane" role="tabpanel">
          {activeTab === 'DECISION' && (
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
            </>
          )}

          {activeTab === 'UNIVERSES' && <ValuationUniverseGrid universes={v3.universes} />}

          {activeTab === 'EVIDENCE' && (
            <>
              <EvidenceFilterBar
                filters={filters.filters}
                setFilters={filters.setFilters}
                evidence={v3.evidence}
              />
              <div className="ci-map-mode-bar" role="toolbar" aria-label="Map mode">
                {(['PRICING', 'DEMAND', 'RISK'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={filters.mapMode === mode ? 'is-active' : ''}
                    onClick={() => filters.setMapMode(mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <TransactionEvidenceList
                rows={filters.filtered}
                selectedId={filters.selectedId}
                onSelect={filters.setSelectedId}
              />
            </>
          )}

          {activeTab === 'STRATEGIES' && (
            <StrategyMatrix ranked={v3.projection?.strategy_ranking?.ranked} />
          )}

          {activeTab === 'MODEL_HEALTH' && (
            <ModelHealthDrawer
              health={v3.modelHealth}
              open={modelHealthOpen || activeTab === 'MODEL_HEALTH'}
              onClose={() => setModelHealthOpen(false)}
            />
          )}

          {activeTab === 'ANALYST_LAB' && (
            <AnalystScenarioLab
              scenario={analyst.scenario}
              evidence={v3.evidence}
              onToggleInclude={analyst.toggleInclude}
              onToggleExclude={analyst.toggleExclude}
              onReset={analyst.reset}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default CompIntelligenceWorkspace