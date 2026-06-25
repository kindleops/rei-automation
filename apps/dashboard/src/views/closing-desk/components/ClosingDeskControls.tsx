import { CLOSING_BOARD_COLUMNS } from '../../../domain/closing-desk/closing-board'
import type { ClosingDeskFilters } from '../hooks/useClosingDesk'

export interface ClosingDeskControlsProps {
  filters: ClosingDeskFilters
  markets: string[]
  mode: 'board' | 'table'
  fixtureQuery: boolean
  onFiltersChange: (next: ClosingDeskFilters) => void
  onModeChange: (mode: 'board' | 'table') => void
  onOpenDemo: () => void
  onScrollDiagnostics: () => void
}

export function ClosingDeskControls({
  filters,
  markets,
  mode,
  fixtureQuery,
  onFiltersChange,
  onModeChange,
  onOpenDemo,
  onScrollDiagnostics,
}: ClosingDeskControlsProps) {
  return (
    <div className="cd-controls-bar">
      <div className="cd-controls" role="toolbar" aria-label="Closing Desk filters">
        <label className="cd-field cd-field--search">
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
          <select
            className="cd-select"
            aria-label="Market filter"
            value={filters.market}
            onChange={(e) => onFiltersChange({ ...filters, market: e.target.value })}
          >
            <option value="all">All markets</option>
            {markets.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="cd-field">
          <span className="cd-field__label">Risk</span>
          <select
            className="cd-select"
            aria-label="Risk filter"
            value={filters.risk}
            onChange={(e) => onFiltersChange({ ...filters, risk: e.target.value })}
          >
            <option value="all">All risk</option>
            <option value="severe">Severe</option>
            <option value="high">High</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
          </select>
        </label>
        <label className="cd-field">
          <span className="cd-field__label">Lane</span>
          <select
            className="cd-select"
            aria-label="Lane filter"
            value={filters.boardColumn}
            onChange={(e) => onFiltersChange({ ...filters, boardColumn: e.target.value })}
          >
            <option value="all">All lanes</option>
            {CLOSING_BOARD_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <div className="cd-seg" role="tablist" aria-label="View mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'board'}
            className={mode === 'board' ? 'is-active' : ''}
            onClick={() => onModeChange('board')}
          >
            Board
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'table'}
            className={mode === 'table' ? 'is-active' : ''}
            onClick={() => onModeChange('table')}
          >
            Table
          </button>
        </div>
      </div>
      <div className="cd-controls__aux">
        <button type="button" className="cd-btn cd-btn--ghost cd-btn--sm" onClick={onScrollDiagnostics}>
          Diagnostics
        </button>
        {!fixtureQuery ? (
          <button type="button" className="cd-btn cd-btn--ghost cd-btn--sm" onClick={onOpenDemo}>
            Demo workspace
          </button>
        ) : (
          <span className="cd-controls__demo-tag" role="status">DEMO ACTIVE</span>
        )}
      </div>
    </div>
  )
}