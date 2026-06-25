import { useCallback, useMemo, useRef, useState } from 'react'
import './styles/closing-desk.css'
import { useClosingDesk } from './hooks/useClosingDesk'
import type { ClosingCase } from '../../domain/closing-desk/closing-desk.types'
import { CLOSING_BOARD_COLUMNS, boardColumnLabel } from '../../domain/closing-desk/closing-board'
import { casesForDisplay, resolveClosingDeskSurfaceState } from './closing-desk-state'
import { ClosingHealthBadge } from './components/ClosingHealthBadge'
import { ClosingCaseWorkspace } from './components/ClosingCaseWorkspace'
import { ClosingDeskMetrics } from './components/ClosingDeskMetrics'
import { ClosingDeskCommandCard } from './components/ClosingDeskCommandCard'
import { ClosingDeskBoard } from './components/ClosingDeskBoard'
import { ClosingDeskControls } from './components/ClosingDeskControls'
import { ClosingDeskIntelligenceRail } from './components/ClosingDeskIntelligenceRail'
import { ClosingDeskLifecycleReqs } from './components/ClosingDeskLifecycleReqs'

const money = (v: number) => `$${Math.round(v).toLocaleString()}`

export function ClosingDeskView() {
  const fixtureQuery = useMemo(() => {
    if (typeof window === 'undefined') return false
    const p = new URLSearchParams(window.location.search)
    return p.get('demo') === '1' || p.get('fixture') === '1'
  }, [])

  const { model, loading, error, filters, setFilters, markets, filteredCases } = useClosingDesk({ fixture: fixtureQuery })
  const [mode, setMode] = useState<'board' | 'table'>('board')
  const [active, setActive] = useState<ClosingCase | null>(null)
  const diagnosticsRef = useRef<HTMLDivElement>(null)

  const displayCases = useMemo(
    () => casesForDisplay(filteredCases, model, fixtureQuery),
    [filteredCases, model, fixtureQuery],
  )

  const surfaceState = resolveClosingDeskSurfaceState(model, { fixtureQuery, loading, error })

  const grouped = useMemo(() => {
    const map = new Map<string, ClosingCase[]>()
    for (const col of CLOSING_BOARD_COLUMNS) map.set(col.id, [])
    for (const c of displayCases) map.get(c.boardColumn)?.push(c)
    return map
  }, [displayCases])

  const degradedNotes = useMemo(() => {
    const notes = [...(model?.provenance.degraded ?? [])]
    if (model?.mode !== 'live' && !fixtureQuery) {
      notes.unshift('Live closing projection is incomplete — display is degraded, not fixture-backed.')
    }
    return notes
  }, [model, fixtureQuery])

  const showDiagnostics = fixtureQuery
    ? false
    : surfaceState === 'zero' || surfaceState === 'degraded' || (model?.diagnostics?.length ?? 0) > 0

  const scrollDiagnostics = useCallback(() => {
    diagnosticsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const openDemo = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('demo', '1')
    window.location.assign(url.toString())
  }, [])

  const showFilteredEmpty = !loading && !error && displayCases.length === 0 && (filters.search || filters.market !== 'all' || filters.risk !== 'all' || filters.boardColumn !== 'all')

  return (
    <main className="closing-desk-view">
      <header className="cd-header">
        <p className="cd-header__eyebrow">NEXUS · POST-CONTRACT COMMAND</p>
        <h1>Closing Desk</h1>
        <p className="cd-header__sub">
          Post-contract command center — Formal Contract → Under Contract → Disposition → Prepared to Close → Closed.
        </p>
      </header>

      {fixtureQuery ? (
        <div className="cd-demo-banner" role="status" data-testid="cd-demo-banner">
          DEMO DATA — synthetic fixtures. Live closing data is unavailable; nothing here reflects a real deal.
        </div>
      ) : null}

      <ClosingDeskMetrics summary={model?.summary ?? null} loading={loading} />

      <ClosingDeskCommandCard
        surfaceState={surfaceState}
        diagnostics={model?.diagnostics ?? []}
        degradedNotes={degradedNotes}
        onOpenDemo={openDemo}
        onScrollDiagnostics={scrollDiagnostics}
      />

      <ClosingDeskControls
        filters={filters}
        markets={markets}
        mode={mode}
        fixtureQuery={fixtureQuery}
        onFiltersChange={setFilters}
        onModeChange={setMode}
        onOpenDemo={openDemo}
        onScrollDiagnostics={scrollDiagnostics}
      />

      <div className="cd-workspace">
        {loading ? (
          <div className="cd-state" data-testid="cd-loading">
            <div className="cd-skeleton" style={{ width: 280, height: 80 }} />
            <span>Loading closing cases…</span>
          </div>
        ) : error ? (
          <div className="cd-state" data-testid="cd-error">
            <span className="cd-state__title">Couldn’t load Closing Desk</span>
            <span>{error}</span>
          </div>
        ) : showFilteredEmpty ? (
          <div className="cd-filter-empty" data-testid="cd-filter-empty" role="status">
            <span>No cases match the current filters.</span>
            <button type="button" className="cd-btn cd-btn--ghost cd-btn--sm" onClick={() => setFilters({ search: '', market: 'all', risk: 'all', boardColumn: 'all' })}>
              Clear filters
            </button>
          </div>
        ) : null}

        {mode === 'board' ? (
          <ClosingDeskBoard grouped={grouped} onOpenCase={setActive} />
        ) : (
          <div className="cd-table-wrap" data-testid="cd-table">
            <table className="cd-table">
              <thead>
                <tr>
                  <th>Property</th><th>Seller</th><th>Market</th><th>Lane</th><th>Stage</th><th>Health</th><th>Seller Price</th><th>Next Action</th>
                </tr>
              </thead>
              <tbody>
                {displayCases.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="cd-table__empty">No cases in table view — adjust filters or wait for projection.</td>
                  </tr>
                ) : (
                  displayCases.map((c) => (
                    <tr
                      key={c.identity.closingCaseId}
                      onClick={() => setActive(c)}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setActive(c) }}
                    >
                      <td>{c.displayName}</td>
                      <td>{c.sellerName ?? '—'}</td>
                      <td>{c.market ?? '—'}</td>
                      <td>{boardColumnLabel(c.boardColumn)}</td>
                      <td>{c.universalStage.replace(/_/g, ' ')}</td>
                      <td><ClosingHealthBadge health={c.health} /></td>
                      <td>{c.financials.sellerContractPrice !== null ? money(c.financials.sellerContractPrice) : '—'}</td>
                      <td>{c.health.nextRequiredAction ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ClosingDeskIntelligenceRail cases={displayCases} degraded={surfaceState === 'degraded' || surfaceState === 'zero'} />

      {showDiagnostics ? (
        <div className="cd-diagnostics-panel" ref={diagnosticsRef} data-testid="cd-diagnostics-panel">
          <h3>Source diagnostics</h3>
          {[...degradedNotes, ...(model?.diagnostics ?? [])].filter((v, i, a) => a.indexOf(v) === i).map((d, i) => (
            <p className="cd-diagnostics" key={i} role="status">{d}</p>
          ))}
        </div>
      ) : null}

      <ClosingDeskLifecycleReqs />

      <aside className="cd-copilot-hint" aria-hidden="true">
        <span>Closing Copilot — read-only recommendations</span>
      </aside>

      {active ? <ClosingCaseWorkspace closingCase={active} onClose={() => setActive(null)} /> : null}
    </main>
  )
}