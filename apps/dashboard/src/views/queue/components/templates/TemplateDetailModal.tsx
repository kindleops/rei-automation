import { useEffect, useState } from 'react'
import type { TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import {
  formatConfidence,
  formatDecisionReason,
  formatOptimizationState,
  formatRateDisplay,
  VIEW_TAB_LABELS,
} from '../../../../domain/templates/template-operator-labels'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const ALL_TABS = [
  'Overview',
  'Performance',
  'Funnel',
  'Cohorts',
  'Executions',
  'Selection Logic',
  'Optimization',
  'Change History',
] as const

type ModalTab = typeof ALL_TABS[number]

interface TemplateDetailModalProps {
  row: TemplateIntelligenceRow | null
  rows: TemplateIntelligenceRow[]
  dossier?: Record<string, unknown> | null
  loading?: boolean
  onClose: () => void
  onNavigate: (templateId: string) => void
  onViewQueueRows?: (templateId: string) => void
}

export function TemplateDetailModal({
  row,
  rows,
  dossier,
  loading,
  onClose,
  onNavigate,
  onViewQueueRows,
}: TemplateDetailModalProps) {
  const [tab, setTab] = useState<ModalTab>('Overview')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (!row) return
      const idx = rows.findIndex((r) => r.identity.template_id === row.identity.template_id)
      if (e.key === 'ArrowLeft' && idx > 0) onNavigate(rows[idx - 1].identity.template_id)
      if (e.key === 'ArrowRight' && idx >= 0 && idx < rows.length - 1) onNavigate(rows[idx + 1].identity.template_id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [row, rows, onClose, onNavigate])

  if (!row) return null

  const tabsAvailable = (dossier?.tabs_available ?? {}) as Record<string, boolean>
  const visibleTabs = ALL_TABS.filter((t) => {
    const key = t.toLowerCase().replace(/ /g, '_')
    if (key === 'selection_logic') return tabsAvailable.selection_logic !== false
    if (key === 'change_history') return tabsAvailable.change_history === true
    if (key === 'executions') return tabsAvailable.executions !== false
    if (key === 'funnel') return tabsAvailable.funnel !== false
    if (key === 'cohorts') return tabsAvailable.cohorts !== false
    if (key === 'optimization') return tabsAvailable.optimization !== false
    return true
  })

  const idx = rows.findIndex((r) => r.identity.template_id === row.identity.template_id)
  const overview = dossier?.overview as Record<string, unknown> | undefined
  const performance = dossier?.performance as Record<string, unknown> | undefined
  const funnel = dossier?.funnel as { stages?: Array<{ key: string; label?: string; value: number }> } | undefined
  const resolver = dossier?.resolver as Record<string, unknown> | undefined
  const cohorts = dossier?.cohorts as Record<string, unknown> | undefined
  const executions = (dossier?.executions as Array<Record<string, unknown>>) ?? []
  const optimization = (dossier?.optimization ?? row.autopilot) as Record<string, unknown> | null
  const decisionHistory = (dossier?.decision_history as Array<Record<string, unknown>>) ?? []
  const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>

  return (
    <div className="occ-tpl-modal-overlay" onClick={onClose} role="presentation">
      <div className="occ-tpl-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="tpl-modal-title">
        <div className="occ-tpl-modal__head">
          <div>
            <h3 id="tpl-modal-title" className="occ-tpl-modal__title">{row.identity.canonical_display_name}</h3>
            <code className="occ-tpl-modal__id">{row.identity.template_id}</code>
          </div>
          <div className="occ-tpl-modal__nav">
            <button type="button" className="occ-icon-btn" disabled={idx <= 0} onClick={() => idx > 0 && onNavigate(rows[idx - 1].identity.template_id)} aria-label="Previous template">‹</button>
            <span className="occ-tpl-modal__pos">{idx + 1} / {rows.length}</span>
            <button type="button" className="occ-icon-btn" disabled={idx >= rows.length - 1} onClick={() => idx < rows.length - 1 && onNavigate(rows[idx + 1].identity.template_id)} aria-label="Next template">›</button>
            <button type="button" className="occ-icon-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="occ-tpl-modal__tabs" role="tablist">
          {visibleTabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={cls('occ-tpl-modal__tab', tab === t && 'is-active')} onClick={() => setTab(t)}>
              {VIEW_TAB_LABELS[t] ?? t}
            </button>
          ))}
        </div>

        <div className="occ-tpl-modal__body">
          {loading && <p className="occ-tpl-modal__note">Loading details…</p>}

          {tab === 'Overview' && (
            <>
              <div className="occ-tpl-modal__section">
                <div className="occ-tpl-modal__section-title">Message</div>
                <p className="occ-tpl-modal__body-text">{row.identity.canonical_body || '—'}</p>
              </div>
              {row.identity.english_translation && (
                <div className="occ-tpl-modal__section">
                  <div className="occ-tpl-modal__section-title">Translation</div>
                  <p className="occ-tpl-modal__body-text">{row.identity.english_translation}</p>
                </div>
              )}
              <div className="occ-tpl-modal__grid">
                <div><span>Stage</span><strong>{row.identity.stage_label}</strong></div>
                <div><span>Touch</span><strong>{row.identity.touch_number ?? '—'}</strong></div>
                <div><span>Follow-up</span><strong>{row.identity.follow_up_number}</strong></div>
                <div><span>Use case</span><strong>{row.identity.use_case ?? '—'}</strong></div>
                <div><span>Language</span><strong>{row.identity.language}</strong></div>
                <div><span>Property scope</span><strong>{row.identity.asset_scope ?? '—'}</strong></div>
                <div><span>Status</span><strong>{row.identity.active_state}</strong></div>
                <div><span>Last used</span><strong>{overview?.last_used ? new Date(String(overview.last_used)).toLocaleString() : '—'}</strong></div>
                <div><span>Sends</span><strong>{String(overview?.sends ?? row.metrics.current.sends ?? 0)}</strong></div>
                <div><span>Replies</span><strong>{overview?.replies == null ? 'Unattributed' : String(overview.replies)}</strong></div>
                <div><span>Latest campaign</span><strong>{String(overview?.latest_campaign ?? '—')}</strong></div>
                <div><span>Latest sender</span><strong>{String(overview?.latest_sender ?? '—')}</strong></div>
              </div>
              <div className="occ-tpl-modal__section">
                <div className="occ-tpl-modal__section-title">Required variables</div>
                <p>{row.identity.variable_contract?.length ? row.identity.variable_contract.join(', ') : 'None declared'}</p>
              </div>
            </>
          )}

          {tab === 'Performance' && (
            <div className="occ-tpl-modal__metrics">
              <p className="occ-tpl-modal__range-note">Selected period · prior equal period · all-time windows in data</p>
              {([
                { label: 'Delivery', rate: rates.delivery?.current },
                { label: 'Reply', rate: rates.reply?.current },
                { label: 'Positive', rate: rates.positive_reply?.current },
                { label: 'Negative', rate: (rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>).negative_reply?.current },
                { label: 'Ownership', rate: rates.ownership_confirmation?.current },
                { label: 'Stage advancement', rate: rates.stage_advancement?.current },
                { label: 'Opt-out', rate: rates.opt_out?.current },
                { label: 'Wrong number', rate: (rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>).wrong_number?.current },
              ] as const).map(({ label, rate }) => {
                const fmt = formatRateDisplay(rate as { value?: number | null; numerator?: number; denominator?: number })
                return (
                  <div key={label} className="occ-tpl-metric">
                    <span className="occ-tpl-metric__lbl">{label}</span>
                    <span className="occ-tpl-metric__val">{fmt.primary}</span>
                    {fmt.secondary && <span className="occ-tpl-metric__sub">{fmt.secondary}</span>}
                  </div>
                )
              })}
              <div className="occ-tpl-metric">
                <span className="occ-tpl-metric__lbl">Confidence</span>
                <span className="occ-tpl-metric__val">{formatConfidence(row.metrics.confidence.current_range.bucket)}</span>
              </div>
              {(performance?.all_windows as Record<string, unknown>) && (
                <div className="occ-tpl-modal__section">
                  <div className="occ-tpl-modal__section-title">All-time snapshot</div>
                  <p className="occ-tpl-modal__note">Window breakdowns available in API performance payload.</p>
                </div>
              )}
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

          {tab === 'Cohorts' && (
            <div className="occ-tpl-cohorts">
              <p className="occ-tpl-modal__note">{String(cohorts?.backfill_note ?? '')}</p>
              {['market', 'language', 'campaign', 'sender', 'asset'].map((dim) => {
                const items = (cohorts?.[dim] as Array<{ key: string; sends?: number; concentration_pct?: number }>) ?? []
                if (!items.length) return null
                return (
                  <div key={dim} className="occ-tpl-cohort-block">
                    <strong>{dim}</strong>
                    {items.map((c) => (
                      <div key={c.key}>
                        {c.key}: {c.sends ?? 0} sends{c.concentration_pct != null ? ` · ${c.concentration_pct}% concentration` : ''}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'Executions' && (
            <div className="occ-tpl-exec-list">
              {executions.length === 0 && <p className="occ-tpl-modal__note">No recent executions in range.</p>}
              {executions.map((e) => (
                <button key={String(e.queue_id)} type="button" className="occ-tpl-exec-row" onClick={() => onViewQueueRows?.(row.identity.template_id)}>
                  <div className="occ-tpl-exec-row__meta">
                    <span>{String(e.delivery_result ?? e.status)}</span>
                    <span className="occ-mono">{String(e.sender ?? '').slice(-4)}</span>
                    <span>{e.sent_at ? new Date(String(e.sent_at)).toLocaleString() : new Date(String(e.selected_at ?? e.created_at)).toLocaleString()}</span>
                  </div>
                  <p>{String(e.rendered_body ?? '').slice(0, 160)}</p>
                </button>
              ))}
            </div>
          )}

          {tab === 'Selection Logic' && (
            <div className="occ-tpl-resolver">
              <p><strong>Why eligible:</strong> {String(resolver?.eligible_reason ?? '—')}</p>
              <p><strong>Why selected:</strong> {String(resolver?.selected_reason ?? '—')}</p>
              <p><strong>Language match:</strong> {String(resolver?.language_match ?? '—')}</p>
              <p><strong>Property match:</strong> {String(resolver?.property_match ?? '—')}</p>
              <p><strong>Variables:</strong> {String(resolver?.variables_available ?? '—')}</p>
              <p><strong>Concentration:</strong> {String(resolver?.concentration_limits ?? '—')}</p>
              {Boolean(resolver?.fallback_used) && <p><strong>Fallback:</strong> Yes — used when primary match unavailable</p>}
            </div>
          )}

          {tab === 'Optimization' && optimization && (
            <div className="occ-tpl-autopilot">
              <p><strong>State:</strong> {formatOptimizationState(String(optimization.rotation_state))}</p>
              <p><strong>Recommended state:</strong> {formatOptimizationState(String(optimization.proposed_state))}</p>
              <p><strong>Current traffic share:</strong> {optimization.traffic_weight != null ? `${Math.round(Number(optimization.traffic_weight) * 100)}%` : '—'}</p>
              <p><strong>Recommended share:</strong> {optimization.proposed_weight != null ? `${Math.round(Number(optimization.proposed_weight) * 100)}%` : '—'}</p>
              <p><strong>Reason:</strong> {formatDecisionReason(String(optimization.decision_reason))}</p>
              <p><strong>Confidence:</strong> {formatConfidence((optimization.intelligence as { current_range_confidence?: { bucket?: string } })?.current_range_confidence?.bucket)}</p>
              <p><strong>Next review:</strong> {optimization.next_evaluation ? new Date(String(optimization.next_evaluation)).toLocaleString() : '—'}</p>
              <p className="occ-tpl-shadow-note">Recommendations only — no automatic changes</p>
            </div>
          )}

          {tab === 'Change History' && (
            <div className="occ-tpl-decision-history">
              {decisionHistory.length === 0 && <p className="occ-tpl-modal__note">No change history recorded.</p>}
              {decisionHistory.map((d, i) => (
                <div key={i} className="occ-tpl-decision-row">
                  <span>{String(d.action)}</span>
                  <span>{d.timestamp ? new Date(String(d.timestamp)).toLocaleString() : '—'}</span>
                  <span>{String(d.actor ?? 'operator')}</span>
                  <p>{String(d.reason ?? '')}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="occ-tpl-modal__foot">
          {onViewQueueRows && (
            <button type="button" className="occ-action-btn is-secondary" onClick={() => onViewQueueRows(row.identity.template_id)}>
              View queue rows
            </button>
          )}
        </div>
      </div>
    </div>
  )
}