import { useMemo, useState } from 'react'
import './styles/closing-desk.css'
import { useClosingDesk } from './hooks/useClosingDesk'
import type { ClosingCase } from '../../domain/closing-desk/closing-desk.types'
import { CLOSING_BOARD_COLUMNS, boardColumnLabel } from '../../domain/closing-desk/closing-board'
import { ClosingHealthBadge } from './components/ClosingHealthBadge'
import { ClosingCaseWorkspace } from './components/ClosingCaseWorkspace'

const money = (v: number) => `$${Math.round(v).toLocaleString()}`

interface MetricDef {
  key: keyof import('../../domain/closing-desk/closing-desk.types').ClosingDeskSummary
  label: string
  tone?: 'alert' | 'good'
  format?: 'money'
}

const METRICS: MetricDef[] = [
  { key: 'underContract', label: 'Under Contract' },
  { key: 'closingsThisWeek', label: 'Closings This Week' },
  { key: 'clearToClose', label: 'Clear to Close', tone: 'good' },
  { key: 'titleBlocked', label: 'Title Blocked', tone: 'alert' },
  { key: 'sellerActionRequired', label: 'Seller Action', tone: 'alert' },
  { key: 'buyerActionRequired', label: 'Buyer Action', tone: 'alert' },
  { key: 'emdOverdue', label: 'EMD Overdue', tone: 'alert' },
  { key: 'expectedRevenue', label: 'Expected Revenue', format: 'money' },
  { key: 'confirmedRevenueThisMonth', label: 'Confirmed (MTD)', format: 'money', tone: 'good' },
]

function CaseCard({ c, onOpen }: { c: ClosingCase; onOpen: (c: ClosingCase) => void }) {
  return (
    <button type="button" className="cd-card" onClick={() => onOpen(c)} data-testid="cd-card">
      <span className="cd-card__title">{c.displayName}</span>
      <span className="cd-card__sub">{c.sellerName ?? 'Unknown seller'} · {c.market ?? '—'}</span>
      <span className="cd-card__row">
        <ClosingHealthBadge health={c.health} />
        <span className="cd-card__money">
          {c.financials.sellerContractPrice !== null ? money(c.financials.sellerContractPrice) : '—'}
        </span>
      </span>
      {c.health.nextRequiredAction ? (
        <span className="cd-card__sub" style={{ color: 'var(--nx-text-faint,#67768c)' }}>→ {c.health.nextRequiredAction}</span>
      ) : null}
    </button>
  )
}

export function ClosingDeskView() {
  // `?demo=1` (or ?fixture=1) renders clearly-labeled fixtures for demo/QA only.
  const fixture = useMemo(() => {
    if (typeof window === 'undefined') return false
    const p = new URLSearchParams(window.location.search)
    return p.get('demo') === '1' || p.get('fixture') === '1'
  }, [])
  const { model, loading, error, filters, setFilters, markets, filteredCases } = useClosingDesk({ fixture })
  const [mode, setMode] = useState<'board' | 'table'>('board')
  const [active, setActive] = useState<ClosingCase | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<string, ClosingCase[]>()
    for (const col of CLOSING_BOARD_COLUMNS) map.set(col.id, [])
    for (const c of filteredCases) map.get(c.boardColumn)?.push(c)
    return map
  }, [filteredCases])

  return (
    <main className="closing-desk-view">
      <header className="cd-header">
        <p className="eyebrow">NEXUS · CLOSING DESK</p>
        <h1>Closing Desk</h1>
        <p>Post-contract command center — Formal Contract → Under Contract → Disposition → Prepared to Close → Closed.</p>
      </header>

      {model?.mode === 'fixture' ? (
        <div className="cd-demo-banner" role="status" data-testid="cd-demo-banner">
          DEMO DATA — synthetic fixtures. Live closing data is unavailable; nothing here reflects a real deal.
        </div>
      ) : null}
      {model?.diagnostics?.map((d, i) => (
        <div className="cd-diagnostics" key={i} role="status">{d}</div>
      ))}

      {/* Header command layer */}
      <div className="cd-metrics" data-testid="cd-metrics">
        {METRICS.map((m) => {
          const raw = model ? (model.summary[m.key] as number) : 0
          const value = m.format === 'money' ? money(raw) : String(raw)
          const source = model?.summary.metricSources?.[m.key] ?? 'absent'
          return (
            <div className={`cd-metric ${m.tone === 'alert' && raw > 0 ? 'is-alert' : ''} ${m.tone === 'good' ? 'is-good' : ''}`} key={m.key}>
              <span className="cd-metric__value">{loading ? '…' : value}</span>
              <span className="cd-metric__label">{m.label}</span>
              <span className="cd-metric__source">src: {source}</span>
            </div>
          )
        })}
      </div>

      {/* Controls */}
      <div className="cd-controls">
        <input
          type="search"
          placeholder="Search address, seller, market…"
          aria-label="Search closing cases"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
        <select aria-label="Market filter" value={filters.market} onChange={(e) => setFilters({ ...filters, market: e.target.value })}>
          <option value="all">All markets</option>
          {markets.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select aria-label="Risk filter" value={filters.risk} onChange={(e) => setFilters({ ...filters, risk: e.target.value })}>
          <option value="all">All risk</option>
          <option value="severe">Severe</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select aria-label="Lane filter" value={filters.boardColumn} onChange={(e) => setFilters({ ...filters, boardColumn: e.target.value })}>
          <option value="all">All lanes</option>
          {CLOSING_BOARD_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <div className="cd-seg" role="tablist" aria-label="View mode">
          <button role="tab" aria-selected={mode === 'board'} className={mode === 'board' ? 'is-active' : ''} onClick={() => setMode('board')}>Board</button>
          <button role="tab" aria-selected={mode === 'table'} className={mode === 'table' ? 'is-active' : ''} onClick={() => setMode('table')}>Table</button>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="cd-state"><div className="cd-skeleton" style={{ width: 280, height: 80 }} /><span>Loading closing cases…</span></div>
      ) : error ? (
        <div className="cd-state"><span className="cd-state__title">Couldn’t load Closing Desk</span><span>{error}</span></div>
      ) : filteredCases.length === 0 ? (
        <div className="cd-state" data-testid="cd-empty">
          <span className="cd-state__title">No closing cases</span>
          <span>{model?.diagnostics?.[0] ?? 'No deals are currently in the closing lifecycle (Stages 6–10).'}</span>
        </div>
      ) : mode === 'board' ? (
        <div className="cd-board" data-testid="cd-board">
          {CLOSING_BOARD_COLUMNS.map((col) => {
            const cases = grouped.get(col.id) ?? []
            return (
              <div className={`cd-col ${col.id === 'issues_curative' ? 'is-curative' : ''}`} key={col.id}>
                <div className="cd-col__head">
                  <span>{col.label}</span>
                  <span className="cd-col__count">{cases.length}</span>
                </div>
                <div className="cd-col__body">
                  {cases.map((c) => <CaseCard key={c.identity.closingCaseId} c={c} onOpen={setActive} />)}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="cd-table-wrap" data-testid="cd-table">
          <table className="cd-table">
            <thead>
              <tr>
                <th>Property</th><th>Seller</th><th>Market</th><th>Lane</th><th>Stage</th><th>Health</th><th>Seller Price</th><th>Next Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((c) => (
                <tr key={c.identity.closingCaseId} onClick={() => setActive(c)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setActive(c) }}>
                  <td>{c.displayName}</td>
                  <td>{c.sellerName ?? '—'}</td>
                  <td>{c.market ?? '—'}</td>
                  <td>{boardColumnLabel(c.boardColumn)}</td>
                  <td>{c.universalStage.replace(/_/g, ' ')}</td>
                  <td><ClosingHealthBadge health={c.health} /></td>
                  <td>{c.financials.sellerContractPrice !== null ? money(c.financials.sellerContractPrice) : '—'}</td>
                  <td>{c.health.nextRequiredAction ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active ? <ClosingCaseWorkspace closingCase={active} onClose={() => setActive(null)} /> : null}
    </main>
  )
}
