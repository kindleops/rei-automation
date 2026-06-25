import { useCallback, useEffect, useMemo, useState } from 'react'
import './styles/closing-desk.css'
import { useClosingDesk } from './hooks/useClosingDesk'
import type { ClosingBoardColumn, ClosingCase } from '../../domain/closing-desk/closing-desk.types'
import {
  groupCasesByLane,
  resolveClosingDeskSurfaceState,
  resolveDisplaySummary,
  resolveRenderableCases,
} from './closing-desk-state'
import { ClosingCaseWorkspace } from './components/ClosingCaseWorkspace'
import { ClosingDeskMetrics } from './components/ClosingDeskMetrics'
import { ClosingDeskCommandCard } from './components/ClosingDeskCommandCard'
import { ClosingDeskBoard } from './components/ClosingDeskBoard'
import { ClosingDeskTable } from './components/ClosingDeskTable'
import { ClosingDeskControls } from './components/ClosingDeskControls'
import { ClosingDeskIntelligenceRail } from './components/ClosingDeskIntelligenceRail'
import { ClosingDeskHeader } from './components/ClosingDeskHeader'
import { ClosingDeskEnvironment } from './components/ClosingDeskEnvironment'
import { ClosingDeskDiagnosticsPanel } from './components/ClosingDeskDiagnosticsPanel'

export function ClosingDeskView() {
  const fixtureQuery = useMemo(() => {
    if (typeof window === 'undefined') return false
    const p = new URLSearchParams(window.location.search)
    return p.get('demo') === '1' || p.get('fixture') === '1'
  }, [])

  const { model, loading, error, filters, setFilters, markets, filteredCases } = useClosingDesk({ fixture: fixtureQuery })
  const [mode, setMode] = useState<'board' | 'table'>('board')
  const [active, setActive] = useState<ClosingCase | null>(null)
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagTab, setDiagTab] = useState<'diagnostics' | 'lifecycle'>('diagnostics')
  const [mobileLane, setMobileLane] = useState<ClosingBoardColumn | 'all'>('all')

  const renderableCases = useMemo(
    () => resolveRenderableCases(filteredCases, { fixtureQuery, modelMode: model?.mode ?? null }),
    [filteredCases, model, fixtureQuery],
  )

  const displaySummary = useMemo(
    () => resolveDisplaySummary(renderableCases, model?.summary, { fixtureQuery, modelMode: model?.mode ?? null }),
    [renderableCases, model, fixtureQuery],
  )

  const surfaceState = resolveClosingDeskSurfaceState(model, { fixtureQuery, loading, error })
  const grouped = useMemo(() => groupCasesByLane(renderableCases), [renderableCases])

  const degradedNotes = useMemo(() => {
    const notes = [...(model?.provenance.degraded ?? [])]
    if (model?.mode !== 'live' && !fixtureQuery) {
      notes.unshift('Live closing projection is incomplete — metrics and cases are withheld until canonical mirror exists.')
    }
    return notes
  }, [model, fixtureQuery])

  const openDiagnostics = useCallback((tab: 'diagnostics' | 'lifecycle' = 'diagnostics') => {
    setDiagTab(tab)
    setDiagOpen(true)
  }, [])

  const openDemo = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('demo', '1')
    window.location.assign(url.toString())
  }, [])

  const showFilteredEmpty =
    !loading &&
    !error &&
    renderableCases.length === 0 &&
    (filters.search || filters.market !== 'all' || filters.risk !== 'all' || filters.boardColumn !== 'all')

  const selectedId = active?.identity.closingCaseId ?? null

  useEffect(() => {
    const root = document.querySelector('.closing-desk-view')
    if (!root) return
    if (selectedId) root.setAttribute('data-selected-case', selectedId)
    else root.removeAttribute('data-selected-case')
    return () => root.removeAttribute('data-selected-case')
  }, [selectedId])

  const verifyCounts = useMemo(() => {
    let boardCards = 0
    grouped.forEach((cases) => { boardCards += cases.length })
    return { boardCards, tableRows: renderableCases.length, cases: renderableCases.length }
  }, [grouped, renderableCases])

  return (
    <main
      className={`closing-desk-view ${surfaceState === 'demo' ? 'is-demo' : ''} ${selectedId ? 'has-selection' : ''}`}
      data-verify-board={verifyCounts.boardCards}
      data-verify-table={verifyCounts.tableRows}
    >
      <ClosingDeskHeader surfaceState={surfaceState} summary={displaySummary} cases={renderableCases} loading={loading} />

      <ClosingDeskEnvironment
        surfaceState={surfaceState}
        degradedNotes={degradedNotes}
        diagnostics={model?.diagnostics ?? []}
      />

      <ClosingDeskMetrics summary={displaySummary} loading={loading} onFilter={setFilters} />

      <ClosingDeskCommandCard
        surfaceState={surfaceState}
        diagnostics={model?.diagnostics ?? []}
        degradedNotes={degradedNotes}
        onOpenDemo={openDemo}
        onScrollDiagnostics={() => openDiagnostics('diagnostics')}
        onOpenLifecycleGuide={() => openDiagnostics('lifecycle')}
      />

      <ClosingDeskControls
        filters={filters}
        markets={markets}
        mode={mode}
        fixtureQuery={fixtureQuery}
        mobileLane={mobileLane}
        onFiltersChange={setFilters}
        onModeChange={setMode}
        onMobileLaneChange={setMobileLane}
        onOpenDemo={openDemo}
        onOpenDiagnostics={() => openDiagnostics('diagnostics')}
      />

      <div className="cd-canvas">
        {loading ? (
          <div className="cd-state" data-testid="cd-loading">
            <div className="cd-skeleton cd-skeleton--board" />
            <span>Loading closing portfolio…</span>
          </div>
        ) : error ? (
          <div className="cd-state" data-testid="cd-error">
            <span className="cd-state__title">Couldn’t load Closing Desk</span>
            <span>{error}</span>
          </div>
        ) : showFilteredEmpty ? (
          <div className="cd-filter-empty" data-testid="cd-filter-empty" role="status">
            <span>No cases match the current filters.</span>
            <button type="button" className="cd-btn cd-btn--ghost" onClick={() => setFilters({ search: '', market: 'all', risk: 'all', boardColumn: 'all' })}>
              Clear filters
            </button>
          </div>
        ) : null}

        {mode === 'board' ? (
          <ClosingDeskBoard
            grouped={grouped}
            selectedId={selectedId}
            mobileLane={mobileLane}
            onOpenCase={setActive}
          />
        ) : (
          <ClosingDeskTable cases={renderableCases} selectedId={selectedId} onOpenCase={setActive} />
        )}
      </div>

      <ClosingDeskIntelligenceRail
        cases={renderableCases}
        degraded={surfaceState === 'degraded' || surfaceState === 'zero'}
      />

      <ClosingDeskDiagnosticsPanel
        open={diagOpen}
        onClose={() => setDiagOpen(false)}
        degradedNotes={degradedNotes}
        diagnostics={model?.diagnostics ?? []}
        initialTab={diagTab}
      />

      {active ? <ClosingCaseWorkspace closingCase={active} onClose={() => setActive(null)} /> : null}
    </main>
  )
}