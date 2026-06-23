import { useState } from 'react'
import type { TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const TABS = [
  'Overview',
  'Performance',
  'Funnel',
  'Cohorts',
  'Executions',
  'Resolver',
  'Autopilot',
  'Decision History',
] as const

type DossierTab = typeof TABS[number]

interface TemplateDossierDrawerProps {
  row: TemplateIntelligenceRow | null
  dossier?: Record<string, unknown> | null
  loading?: boolean
  width?: number
  onClose: () => void
  onControl?: (action: string) => void
}

export function TemplateDossierDrawer({ row, dossier, loading, width = 520, onClose, onControl }: TemplateDossierDrawerProps) {
  const [tab, setTab] = useState<DossierTab>('Overview')
  if (!row) return null

  const overview = dossier?.overview as Record<string, unknown> | undefined
  const funnel = dossier?.funnel as { stages?: Array<{ key: string; value: number }> } | undefined
  const resolver = dossier?.resolver as Record<string, unknown> | undefined
  const executions = (dossier?.executions as Array<Record<string, unknown>>) ?? []
  const autopilot = (dossier?.autopilot ?? row.autopilot) as Record<string, unknown> | null

  return (
    <aside className="occ-tpl-dossier occ-tpl-dossier--wide" style={{ width }}>
      <div className="occ-tpl-dossier__head">
        <div>
          <h3 className="occ-tpl-dossier__title">{row.identity.canonical_display_name}</h3>
          <code className="occ-tpl-dossier__id">{row.identity.template_id}</code>
        </div>
        <button type="button" className="occ-icon-btn" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="occ-tpl-dossier__tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={cls('occ-tpl-dossier__tab', tab === t && 'is-active')} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="occ-tpl-dossier__body">
        {loading && <p className="occ-tpl-dossier__note">Loading dossier…</p>}

        {tab === 'Overview' && (
          <>
            <div className="occ-tpl-dossier__section">
              <div className="occ-tpl-dossier__section-title">Canonical Body</div>
              <p className="occ-tpl-dossier__body-text">{row.identity.canonical_body || '—'}</p>
            </div>
            {row.identity.english_translation && (
              <div className="occ-tpl-dossier__section">
                <div className="occ-tpl-dossier__section-title">English Translation</div>
                <p className="occ-tpl-dossier__body-text">{row.identity.english_translation}</p>
              </div>
            )}
            {overview?.recent_rendered_executions && (
              <div className="occ-tpl-dossier__section">
                <div className="occ-tpl-dossier__section-title">Recent Rendered Executions (not canonical)</div>
                {(overview.recent_rendered_executions as Array<Record<string, unknown>>).map((e) => (
                  <p key={String(e.queue_id)} className="occ-tpl-dossier__rendered">{String(e.preview)}</p>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'Performance' && (
          <div className="occ-tpl-dossier__metrics">
            {Object.entries(row.metrics.comparison.metrics).slice(0, 12).map(([k, v]) => (
              <div key={k} className="occ-tpl-metric">
                <span className="occ-tpl-metric__val">{v.current}</span>
                <span className="occ-tpl-metric__lbl">{k.replace(/_/g, ' ')}</span>
                <small>Δ {v.delta_absolute} · base {v.baseline}</small>
              </div>
            ))}
          </div>
        )}

        {tab === 'Funnel' && (
          <div className="occ-tpl-funnel">
            {(funnel?.stages ?? []).map((s, i, arr) => (
              <div key={s.key} className="occ-tpl-funnel__step">
                <span>{s.key}</span>
                <strong>{s.value}</strong>
                {i < arr.length - 1 && <span className="occ-tpl-funnel__arrow">→</span>}
              </div>
            ))}
          </div>
        )}

        {tab === 'Executions' && (
          <div className="occ-tpl-exec-list">
            {executions.length === 0 && <p className="occ-tpl-dossier__note">No recent executions.</p>}
            {executions.map((e) => (
              <div key={String(e.queue_id)} className="occ-tpl-exec-row">
                <span>{String(e.status)}</span>
                <span className="occ-mono">…{String(e.sender ?? '').slice(-4)}</span>
                <p>{String(e.rendered_body ?? '').slice(0, 120)}</p>
              </div>
            ))}
          </div>
        )}

        {tab === 'Resolver' && (
          <div className="occ-tpl-resolver">
            <p><strong>Selection reason:</strong> {String(resolver?.selection_reason ?? '—')}</p>
            <p><strong>Candidate pool:</strong> {String(resolver?.candidate_pool_size ?? '—')}</p>
            <p><strong>Selected rank:</strong> {String(resolver?.selected_rank ?? '—')}</p>
          </div>
        )}

        {tab === 'Autopilot' && autopilot && (
          <div className="occ-tpl-autopilot">
            <p>State: {String(autopilot.rotation_state)} → proposed {String(autopilot.proposed_state)}</p>
            <p>Weight: {String(autopilot.traffic_weight)} → {String(autopilot.proposed_weight)}</p>
            <p>Decision: {String(autopilot.decision_reason)}</p>
            <p className="occ-tpl-shadow-note">Shadow mode — no production mutations</p>
            <div className="occ-tpl-dossier__controls">
              {['pause', 'resume', 'cooldown', 'lock_autopilot'].map((action) => (
                <button key={action} type="button" className="occ-action-btn is-secondary" onClick={() => onControl?.(action)}>
                  {action.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'Cohorts' && <p className="occ-tpl-dossier__note">Cohort breakdown requires data backfill.</p>}
        {tab === 'Decision History' && <p className="occ-tpl-dossier__note">Decision log populates as shadow evaluations run.</p>}
      </div>
    </aside>
  )
}