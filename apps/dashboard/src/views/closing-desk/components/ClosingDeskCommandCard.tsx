import type { ClosingDeskSurfaceState } from '../closing-desk-state'

export interface ClosingDeskCommandCardProps {
  surfaceState: ClosingDeskSurfaceState
  diagnostics: string[]
  degradedNotes: string[]
  onOpenDemo: () => void
  onScrollDiagnostics: () => void
  onOpenLifecycleGuide?: () => void
}

export function ClosingDeskCommandCard({
  surfaceState,
  diagnostics,
  degradedNotes,
  onOpenDemo,
  onScrollDiagnostics,
  onOpenLifecycleGuide,
}: ClosingDeskCommandCardProps) {
  if (surfaceState === 'demo' || surfaceState === 'live') return null

  const isZero = surfaceState === 'zero'
  const title = isZero ? 'No active closing cases' : 'Closing Desk awaiting full projection'
  const lead = isZero
    ? 'No deals currently map to Stages 6–10 in the canonical pipeline. The lifecycle board below shows where cases will appear once they enter post-contract execution.'
    : 'Closing Desk is read-only today. Deep title, escrow, disposition, funding, and revenue fields are not yet projected from Podio into Supabase — metrics and dossiers will remain sparse until that mirror exists.'

  const detail = isZero
    ? diagnostics[0] ?? 'Stages 6–10 (Formal Contract → Closed) are empty in acquisition_opportunities.'
    : degradedNotes[0] ?? diagnostics[0] ?? 'Canonical Podio → Supabase closing projection is not yet live.'

  return (
    <section className={`cd-command-card ${isZero ? 'is-zero' : 'is-degraded'}`} data-testid="cd-command-card" aria-labelledby="cd-command-title">
      <div className="cd-command-card__badge">{isZero ? 'Zero-state' : 'Degraded source'}</div>
      <h2 id="cd-command-title" className="cd-command-card__title">{title}</h2>
      <p className="cd-command-card__lead">{lead}</p>
      <p className="cd-command-card__detail">{detail}</p>
      <div className="cd-command-card__actions">
        <button type="button" className="cd-btn cd-btn--ghost" onClick={onScrollDiagnostics}>
          View Source Diagnostics
        </button>
        <button type="button" className="cd-btn cd-btn--accent" onClick={onOpenDemo}>
          Open Demo Workspace
        </button>
        <button type="button" className="cd-btn cd-btn--ghost" onClick={onOpenLifecycleGuide ?? onScrollDiagnostics}>
          Review Lifecycle Requirements
        </button>
      </div>
    </section>
  )
}