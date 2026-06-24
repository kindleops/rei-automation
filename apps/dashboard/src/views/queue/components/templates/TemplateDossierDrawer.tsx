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

function formatRate(rate: { value?: number | null; numerator?: number; denominator?: number } | undefined) {
  if (!rate || !rate.denominator) return '—'
  if (rate.value == null) return 'Insufficient data'
  return `${rate.value}% (${rate.numerator}/${rate.denominator})`
}

interface TemplateDossierDrawerProps {
  row: TemplateIntelligenceRow | null
  dossier?: Record<string, unknown> | null
  loading?: boolean
  onClose: () => void
  onControl?: (action: string) => void
  onViewQueueRows?: (templateId: string) => void
}

export function TemplateDossierDrawer({ row, dossier, loading, onClose, onControl, onViewQueueRows }: TemplateDossierDrawerProps) {
  const [tab, setTab] = useState<DossierTab>('Overview')
  if (!row) return null

  const overview = dossier?.overview as Record<string, unknown> | undefined
  const funnel = dossier?.funnel as { stages?: Array<{ key: string; label?: string; value: number }> } | undefined
  const resolver = dossier?.resolver as Record<string, unknown> | undefined
  const cohorts = dossier?.cohorts as Record<string, unknown> | undefined
  const executions = (dossier?.executions as Array<Record<string, unknown>>) ?? []
  const autopilot = (dossier?.autopilot ?? row.autopilot) as Record<string, unknown> | null
  const decisionHistory = (dossier?.decision_history as Array<Record<string, unknown>>) ?? []
  const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>

  return (
    <aside className="occ-tpl-dossier occ-tpl-dossier--wide">
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
            <div className="occ-tpl-dossier__grid">
              <div><span>Stage</span><strong>{row.identity.stage_label}</strong></div>
              <div><span>Touch</span><strong>{row.identity.touch_number ?? '—'}</strong></div>
              <div><span>Follow-up</span><strong>{row.identity.follow_up_number}</strong></div>
              <div><span>Use case</span><strong>{row.identity.use_case ?? '—'}</strong></div>
              <div><span>Language</span><strong>{row.identity.language}</strong></div>
              <div><span>Asset scope</span><strong>{row.identity.asset_scope ?? '—'}</strong></div>
              <div><span>Lifecycle</span><strong>{row.identity.lifecycle}</strong></div>
              <div><span>Rotation</span><strong>{String((row.autopilot as { rotation_state?: string })?.rotation_state ?? '—')}</strong></div>
            </div>
            <div className="occ-tpl-dossier__section">
              <div className="occ-tpl-dossier__section-title">Required variables</div>
              <p>{row.identity.variable_contract?.length ? row.identity.variable_contract.join(', ') : 'None declared'}</p>
            </div>
            {overview?.recent_rendered_executions && (
              <div className="occ-tpl-dossier__section">
                <div className="occ-tpl-dossier__section-title">Recent rendered executions (not canonical)</div>
                {(overview.recent_rendered_executions as Array<Record<string, unknown>>).map((e) => (
                  <p key={String(e.queue_id)} className="occ-tpl-dossier__rendered">{String(e.preview)}</p>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'Performance' && (
          <div className="occ-tpl-dossier__metrics">
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Delivery</span><span className="occ-tpl-metric__val">{formatRate(rates.delivery?.current)}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Reply</span><span className="occ-tpl-metric__val">{formatRate(rates.reply?.current)}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Positive</span><span className="occ-tpl-metric__val">{formatRate(rates.positive_reply?.current)}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Ownership</span><span className="occ-tpl-metric__val">{formatRate(rates.ownership_confirmation?.current)}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Stage advancement</span><span className="occ-tpl-metric__val">{formatRate(rates.stage_advancement?.current)}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Opt-out</span><span className="occ-tpl-metric__val">{formatRate(rates.opt_out?.current)}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Confidence</span><span className="occ-tpl-metric__val">{row.metrics.confidence.current_range.bucket.replace(/_/g, ' ')}</span></div>
            <div className="occ-tpl-metric"><span className="occ-tpl-metric__lbl">Sample (sends)</span><span className="occ-tpl-metric__val">{String((row.metrics.current as { sends?: number }).sends ?? 0)}</span></div>
          </div>
        )}

        {tab === 'Funnel' && (
          <div className="occ-tpl-funnel occ-tpl-funnel--vertical">
            {(funnel?.stages ?? []).map((s) => (
              <div key={s.key} className="occ-tpl-funnel__step">
                <span>{s.label ?? s.key.replace(/_/g, ' ')}</span>
                <strong>{s.value}</strong>
              </div>
            ))}
          </div>
        )}

        {tab === 'Executions' && (
          <div className="occ-tpl-exec-list">
            {executions.length === 0 && <p className="occ-tpl-dossier__note">No attributable executions in selected range.</p>}
            {executions.map((e) => (
              <button
                key={String(e.queue_id)}
                type="button"
                className="occ-tpl-exec-row"
                onClick={() => onViewQueueRows?.(row.identity.template_id)}
              >
                <span>{String(e.status)}</span>
                <span className="occ-mono">…{String(e.sender ?? '').slice(-4)}</span>
                <p>{String(e.rendered_body ?? '').slice(0, 120)}</p>
              </button>
            ))}
          </div>
        )}

        {tab === 'Resolver' && (
          <div className="occ-tpl-resolver">
            <p><strong>Selection reason:</strong> {String(resolver?.selection_reason ?? 'No resolver evidence in range')}</p>
            <p><strong>Candidate pool:</strong> {String(resolver?.candidate_pool_size ?? '—')}</p>
            <p><strong>Selected rank:</strong> {String(resolver?.selected_rank ?? '—')}</p>
            <p><strong>Policy version:</strong> template-intelligence-shadow-v1</p>
          </div>
        )}

        {tab === 'Autopilot' && autopilot && (
          <div className="occ-tpl-autopilot">
            <p>State: {String(autopilot.rotation_state)} → proposed {String(autopilot.proposed_state)}</p>
            <p>Weight: {String(autopilot.traffic_weight)} → {String(autopilot.proposed_weight)}</p>
            <p>Decision: {String(autopilot.decision_reason).replace(/_/g, ' ')}</p>
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

        {tab === 'Cohorts' && (
          <div className="occ-tpl-cohorts">
            {['market', 'asset', 'sender', 'campaign'].map((dim) => {
              const items = (cohorts?.[dim] as Array<{ key: string; sends?: number }>) ?? []
              if (!items.length) {
                const missing = (cohorts?.missing_fields as string[]) ?? []
                return (
                  <p key={dim} className="occ-tpl-dossier__note">
                    {dim}: {missing.length ? `Missing ${missing.join(', ')}` : 'No cohort data'} — {String(cohorts?.backfill_note ?? '')}
                  </p>
                )
              }
              return (
                <div key={dim} className="occ-tpl-cohort-block">
                  <strong>{dim}</strong>
                  {items.map((c) => <div key={c.key}>{c.key}: {c.sends ?? 0} sends</div>)}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'Decision History' && (
          <div className="occ-tpl-decision-history">
            {decisionHistory.length === 0 && (
              <p className="occ-tpl-dossier__note">No manual or policy decisions logged yet. Shadow evaluations will append immutable audit entries.</p>
            )}
            {decisionHistory.map((d, i) => (
              <div key={i} className="occ-tpl-decision-row">
                <span>{String(d.action ?? d.type)}</span>
                <small>{String(d.timestamp ?? '')}</small>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}