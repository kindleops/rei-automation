import { CLOSING_BOARD_COLUMNS } from '../../../domain/closing-desk/closing-board'
import type { ClosingBoardColumn } from '../../../domain/closing-desk/closing-desk.types'
import type { ClosingDeskFilters } from '../hooks/useClosingDesk'

export interface ClosingDeskControlsProps {
  filters: ClosingDeskFilters
  markets: string[]
  mode: 'board' | 'table'
  fixtureQuery: boolean
  mobileLane: ClosingBoardColumn | 'all'
  onFiltersChange: (next: ClosingDeskFilters) => void
  onModeChange: (mode: 'board' | 'table') => void
  onMobileLaneChange: (lane: ClosingBoardColumn | 'all') => void
  onOpenDemo: () => void
  onOpenDiagnostics: () => void
}

export function ClosingDeskControls({
  filters,
  markets,
  mode,
  fixtureQuery,
  mobileLane,
  onFiltersChange,
  onModeChange,
  onMobileLaneChange,
  onOpenDemo,
  onOpenDiagnostics,
}: ClosingDeskControlsProps) {
  return (
    <div className="cd-command-bar">
      <div className="cd-command-bar__filters" role="toolbar" aria-label="Closing Desk filters">
        <label className="cd-field cd-field--grow">
          <span className="cd-field__label">Search</span>
          <input
            type="search"
            className="cd-input"
            placeholder="Address, seller, market…"
            aria-label="Search closing cases"
            value={filters.search}
            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          />
        </label>
        <label className="cd-field">
          <span className="cd-field__label">Market</span>
          <select className="cd-select" aria-label="Market filter" value={filters.market} onChange={(e) => onFiltersChange({ ...filters, market: e.target.value })}>
            <option value="all">All</option>
            {markets.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="cd-field">
          <span className="cd-field__label">Risk</span>
          <select className="cd-select" aria-label="Risk filter" value={filters.risk} onChange={(e) => onFiltersChange({ ...filters, risk: e.target.value })}>
            <option value="all">All</option>
            <option value="severe">Severe</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="cd-field cd-field--lane">
          <span className="cd-field__label">Lane</span>
          <select className="cd-select" aria-label="Lane filter" value={filters.boardColumn} onChange={(e) => onFiltersChange({ ...filters, boardColumn: e.target.value })}>
            <option value="all">All lanes</option>
            {CLOSING_BOARD_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="cd-field cd-field--mobile-lane">
          <span className="cd-field__label">Pipeline lane</span>
          <select className="cd-select" aria-label="Mobile pipeline lane" value={mobileLane} onChange={(e) => onMobileLaneChange(e.target.value as ClosingBoardColumn | 'all')}>
            <option value="all">All lanes</option>
            {CLOSING_BOARD_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <div className="cd-seg" role="tablist" aria-label="View mode">
          <button type="button" role="tab" aria-selected={mode === 'board'} className={mode === 'board' ? 'is-active' : ''} onClick={() => onModeChange('board')}>Board</button>
          <button type="button" role="tab" aria-selected={mode === 'table'} className={mode === 'table' ? 'is-active' : ''} onClick={() => onModeChange('table')}>Table</button>
        </div>
      </div>
      <div className="cd-command-bar__actions">
        <button type="button" className="cd-btn cd-btn--ghost" data-testid="cd-diagnostics-btn" onClick={onOpenDiagnostics}>Diagnostics</button>
        {!fixtureQuery ? (
          <button type="button" className="cd-btn cd-btn--ghost" onClick={onOpenDemo}>Demo workspace</button>
        ) : (
          <span className="cd-env__pill cd-env__pill--inline">Demo active</span>
        )}
      </div>
    </div>
  )
}