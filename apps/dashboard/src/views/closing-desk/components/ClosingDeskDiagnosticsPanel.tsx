import { useEffect, useState } from 'react'
import { CLOSING_BOARD_COLUMNS, LANE_GUIDANCE } from '../../../domain/closing-desk/closing-board'

export interface ClosingDeskDiagnosticsPanelProps {
  open: boolean
  onClose: () => void
  degradedNotes: string[]
  diagnostics: string[]
  initialTab?: 'diagnostics' | 'lifecycle'
}

export function ClosingDeskDiagnosticsPanel({
  open,
  onClose,
  degradedNotes,
  diagnostics,
  initialTab = 'diagnostics',
}: ClosingDeskDiagnosticsPanelProps) {
  const [tab, setTab] = useState<'diagnostics' | 'lifecycle'>(initialTab)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  if (!open) return null

  const lines = [...degradedNotes, ...diagnostics].filter((v, i, a) => a.indexOf(v) === i)

  return (
    <div className="cd-diag-overlay" role="dialog" aria-modal="true" aria-label="Closing Desk diagnostics" onClick={onClose}>
      <div className="cd-diag-panel" onClick={(e) => e.stopPropagation()} data-testid="cd-diagnostics-panel">
        <header className="cd-diag-panel__head">
          <h2>Closing Desk Intelligence</h2>
          <button type="button" className="cd-diag-panel__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="cd-diag-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'diagnostics'} className={tab === 'diagnostics' ? 'is-active' : ''} onClick={() => setTab('diagnostics')}>Source Diagnostics</button>
          <button type="button" role="tab" aria-selected={tab === 'lifecycle'} className={tab === 'lifecycle' ? 'is-active' : ''} onClick={() => setTab('lifecycle')}>Lifecycle Guide</button>
        </div>
        {tab === 'diagnostics' ? (
          <div className="cd-diag-body" data-testid="cd-diag-source">
            {lines.length === 0 ? <p className="cd-diag-line">No diagnostics reported.</p> : null}
            {lines.map((d, i) => (
              <p className="cd-diag-line" key={i} role="status">{d}</p>
            ))}
          </div>
        ) : (
          <div className="cd-diag-body cd-diag-lifecycle" data-testid="cd-lifecycle-reqs">
            <p className="cd-diag-lead">
              Board lanes derive from universal stage, title/disposition/funding status, and active blockers — never from a stored column.
            </p>
            <ol>
              {CLOSING_BOARD_COLUMNS.map((col) => (
                <li key={col.id}>
                  <strong>{col.label}</strong>
                  <span>{LANE_GUIDANCE[col.id].qualifies}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}