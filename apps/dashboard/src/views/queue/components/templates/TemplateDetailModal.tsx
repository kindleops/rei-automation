import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
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

const STAGE_TONE: Record<string, string> = {
  S1: 'blue', S2: 'cyan', S3: 'violet', S4: 'amber', S5: 'green', S6: 'teal', S1F: 'blue',
}

const OPT_STATUS_TONE: Record<string, string> = {
  'Performing well': 'green',
  'Gathering data': 'cyan',
  'Testing': 'cyan',
  'Needs review': 'amber',
  'Paused': 'amber',
  'Retired': 'muted',
}

const MOBILE_TAB_LABEL: Partial<Record<ModalTab, string>> = {
  Performance: 'Perf',
  'Selection Logic': 'Logic',
  'Change History': 'History',
  Executions: 'Exec',
  Optimization: 'Opt',
}

function DetailSection({ title, children, tone }: { title: string; children: ReactNode; tone?: 'warn' | 'diag' }) {
  return (
    <section className={cls('occ-tpl-detail-section', tone && `occ-tpl-detail-section--${tone}`)}>
      <h3 className="occ-tpl-detail-section__title">{title}</h3>
      {children}
    </section>
  )
}

function DetailChip({ children, tone, mono }: { children: ReactNode; tone?: string; mono?: boolean }) {
  return (
    <span className={cls('occ-mchip', 'occ-tpl-detail-chip', tone && `is-${tone}`, mono && 'is-mono')}>
      <span className="occ-mchip__val">{children}</span>
    </span>
  )
}

function DetailMetric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={cls('occ-tpl-detail-metric', tone && `is-${tone}`)} title={sub ? `${value} (${sub})` : value}>
      <span className="occ-tpl-detail-metric__lbl">{label}</span>
      <strong className="occ-tpl-detail-metric__val">{value}</strong>
      {sub && <span className="occ-tpl-detail-metric__sub">{sub}</span>}
    </div>
  )
}

function DetailKv({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="occ-tpl-detail-kv">
      <span>{label}</span>
      <span className={cls(tone && `is-${tone}`)}>{value}</span>
    </div>
  )
}

interface TemplateDetailModalProps {
  row: TemplateIntelligenceRow | null
  rows: TemplateIntelligenceRow[]
  dossier?: Record<string, unknown> | null
  loading?: boolean
  isMobileLayout?: boolean
  onClose: () => void
  onNavigate: (templateId: string) => void
  onViewQueueRows?: (templateId: string) => void
}

export function TemplateDetailModal({
  row,
  rows,
  dossier,
  loading,
  isMobileLayout = false,
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

  useEffect(() => {
    setTab('Overview')
  }, [row?.identity.template_id])

  if (!row || typeof document === 'undefined') return null

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
  const hasPrev = idx > 0
  const hasNext = idx < rows.length - 1
  const overview = dossier?.overview as Record<string, unknown> | undefined
  const performance = dossier?.performance as Record<string, unknown> | undefined
  const funnel = dossier?.funnel as { stages?: Array<{ key: string; label?: string; value: number }> } | undefined
  const resolver = dossier?.resolver as Record<string, unknown> | undefined
  const cohorts = dossier?.cohorts as Record<string, unknown> | undefined
  const executions = (dossier?.executions as Array<Record<string, unknown>>) ?? []
  const optimization = (dossier?.optimization ?? row.autopilot) as Record<string, unknown> | null
  const decisionHistory = (dossier?.decision_history as Array<Record<string, unknown>>) ?? []
  const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>
  const m = row.metrics.current as Record<string, number | null>

  const displayName = row.identity.canonical_display_name || row.identity.template_name
  const stageCode = row.identity.stage_code ?? '—'
  const stageTone = row.identity.stage_code ? (STAGE_TONE[row.identity.stage_code] ?? 'muted') : 'muted'
  const optState = formatOptimizationState(String(optimization?.rotation_state ?? ''))
  const optTone = OPT_STATUS_TONE[optState] ?? 'muted'
  const deliveryFmt = formatRateDisplay(rates.delivery?.current, Number(m.sends ?? 0))
  const replyFmt = formatRateDisplay(rates.reply?.current, Number(m.sends ?? 0))
  const confidence = formatConfidence(row.metrics.confidence.current_range.bucket)

  const panel = (
    <div className={cls('occ-tpl-detail', isMobileLayout && 'is-mobile')}>
      <div className="occ-tpl-detail__hero">
        <div className="occ-tpl-detail__hero-scrim" aria-hidden="true" />
        <div className="occ-tpl-detail__signals">
          <span className={cls('occ-mtpl-stage', `is-${stageTone}`)}>{stageCode}</span>
          <span className={cls('occ-mtpl-status', `is-${optTone}`)}>{optState}</span>
          <DetailChip tone={row.identity.active_state === 'active' ? 'green' : 'amber'}>{row.identity.active_state}</DetailChip>
        </div>
        <h2 id="tpl-modal-title" className="occ-tpl-detail__title">{displayName}</h2>
        <p className="occ-tpl-detail__sub">{row.identity.stage_label} · {row.identity.language} · Touch {row.identity.touch_number ?? '—'}</p>
        <div className="occ-tpl-detail__hero-metrics">
          <DetailMetric label="Sends" value={String(overview?.sends ?? m.sends ?? 0)} />
          <DetailMetric label="Del %" value={deliveryFmt.primary} sub={deliveryFmt.secondary} tone="green" />
          <DetailMetric label="Reply %" value={replyFmt.primary} sub={replyFmt.secondary} tone="cyan" />
          <DetailMetric label="Confidence" value={confidence} tone="muted" />
        </div>
      </div>

      <div className="occ-tpl-detail__tabs" role="tablist" aria-label="Template detail views">
        {visibleTabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={cls('occ-tpl-detail__tab', tab === t && 'is-active')}
            onClick={() => setTab(t)}
          >
            {isMobileLayout ? (MOBILE_TAB_LABEL[t] ?? VIEW_TAB_LABELS[t] ?? t) : (VIEW_TAB_LABELS[t] ?? t)}
          </button>
        ))}
      </div>

      <div className="occ-tpl-detail__body">
        {loading && <p className="occ-tpl-detail__loading">Loading dossier…</p>}

        {tab === 'Overview' && (
          <>
            <DetailSection title="Message">
              <blockquote className="occ-tpl-detail-quote">
                <span className="occ-tpl-detail-quote__mark" aria-hidden="true">"</span>
                <p>{row.identity.canonical_body || 'No message body on file'}</p>
              </blockquote>
            </DetailSection>
            {row.identity.english_translation && (
              <DetailSection title="English translation">
                <p className="occ-tpl-detail-copy">{row.identity.english_translation}</p>
              </DetailSection>
            )}
            <DetailSection title="Template identity">
              <div className="occ-tpl-detail-kv-grid">
                <DetailKv label="Use case" value={row.identity.use_case?.replace(/_/g, ' ') ?? '—'} />
                <DetailKv label="Follow-up" value={row.identity.follow_up_number ?? '—'} />
                <DetailKv label="Property scope" value={row.identity.asset_scope ?? '—'} />
                <DetailKv label="Last used" value={overview?.last_used ? new Date(String(overview.last_used)).toLocaleString() : '—'} />
                <DetailKv label="Replies" value={overview?.replies == null ? 'Unattributed' : String(overview.replies)} />
                <DetailKv label="Latest campaign" value={String(overview?.latest_campaign ?? '—')} />
                <DetailKv label="Latest sender" value={String(overview?.latest_sender ?? '—')} />
              </div>
            </DetailSection>
            <DetailSection title="Required variables">
              <p className="occ-tpl-detail-copy">
                {row.identity.variable_contract?.length ? row.identity.variable_contract.join(', ') : 'None declared'}
              </p>
            </DetailSection>
            <DetailSection title="Template ID" tone="diag">
              <code className="occ-tpl-detail-id">{row.identity.template_id}</code>
            </DetailSection>
          </>
        )}

        {tab === 'Performance' && (
          <DetailSection title="Period performance">
            <p className="occ-tpl-detail-hint">Selected range vs prior equal period</p>
            <div className="occ-tpl-detail-metric-grid">
              {([
                { label: 'Delivery', rate: rates.delivery?.current, tone: 'green' },
                { label: 'Reply', rate: rates.reply?.current, tone: 'cyan' },
                { label: 'Positive', rate: rates.positive_reply?.current, tone: 'green' },
                { label: 'Negative', rate: (rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>).negative_reply?.current, tone: 'red' },
                { label: 'Ownership', rate: rates.ownership_confirmation?.current, tone: 'blue' },
                { label: 'Stage +', rate: rates.stage_advancement?.current, tone: 'violet' },
                { label: 'Opt-out', rate: rates.opt_out?.current, tone: 'amber' },
                { label: 'Wrong #', rate: (rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>).wrong_number?.current, tone: 'red' },
              ] as const).map(({ label, rate, tone }) => {
                const fmt = formatRateDisplay(rate as { value?: number | null; numerator?: number; denominator?: number })
                return <DetailMetric key={label} label={label} value={fmt.primary} sub={fmt.secondary} tone={tone} />
              })}
              <DetailMetric label="Sends" value={String(m.sends ?? 0)} />
              <DetailMetric label="Delivered" value={String(m.delivered ?? 0)} tone="green" />
              <DetailMetric label="Failed" value={String(m.failed ?? 0)} tone={Number(m.failed) > 0 ? 'red' : 'muted'} />
              <DetailMetric label="Confidence" value={confidence} tone="muted" />
            </div>
            {(performance?.all_windows as Record<string, unknown>) && (
              <p className="occ-tpl-detail-hint">All-time window breakdowns available in API payload.</p>
            )}
          </DetailSection>
        )}

        {tab === 'Funnel' && (
          <DetailSection title="Stage funnel">
            <div className="occ-tpl-detail-funnel">
              {(funnel?.stages ?? []).map((s, i) => (
                <div key={s.key} className="occ-tpl-detail-funnel__step">
                  <span className="occ-tpl-detail-funnel__dot" aria-hidden="true" />
                  <div className="occ-tpl-detail-funnel__copy">
                    <span>{s.label ?? s.key.replace(/_/g, ' ')}</span>
                    <strong>{s.value}</strong>
                  </div>
                  {i < (funnel?.stages?.length ?? 0) - 1 && <span className="occ-tpl-detail-funnel__rail" aria-hidden="true" />}
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        {tab === 'Cohorts' && (
          <DetailSection title="Cohort breakdown">
            {cohorts?.backfill_note != null && String(cohorts.backfill_note).trim() ? (
              <p className="occ-tpl-detail-hint">{String(cohorts.backfill_note)}</p>
            ) : null}
            {['market', 'language', 'campaign', 'sender', 'asset'].map((dim) => {
              const items = (cohorts?.[dim] as Array<{ key: string; sends?: number; concentration_pct?: number }>) ?? []
              if (!items.length) return null
              return (
                <div key={dim} className="occ-tpl-detail-cohort">
                  <h4>{dim}</h4>
                  {items.map((c) => (
                    <DetailKv
                      key={c.key}
                      label={c.key}
                      value={`${c.sends ?? 0} sends${c.concentration_pct != null ? ` · ${c.concentration_pct}%` : ''}`}
                    />
                  ))}
                </div>
              )
            })}
          </DetailSection>
        )}

        {tab === 'Executions' && (
          <DetailSection title="Recent executions">
            {executions.length === 0 && <p className="occ-tpl-detail-hint">No recent executions in range.</p>}
            {executions.map((e) => (
              <button
                key={String(e.queue_id)}
                type="button"
                className="occ-tpl-detail-exec"
                onClick={() => onViewQueueRows?.(row.identity.template_id)}
              >
                <div className="occ-tpl-detail-exec__meta">
                  <DetailChip tone="muted">{String(e.delivery_result ?? e.status)}</DetailChip>
                  <DetailChip mono>···{String(e.sender ?? '').slice(-4)}</DetailChip>
                  <span>{e.sent_at ? new Date(String(e.sent_at)).toLocaleString() : new Date(String(e.selected_at ?? e.created_at)).toLocaleString()}</span>
                </div>
                <p>{String(e.rendered_body ?? '').slice(0, 200)}</p>
              </button>
            ))}
          </DetailSection>
        )}

        {tab === 'Selection Logic' && (
          <DetailSection title="Resolver logic">
            <div className="occ-tpl-detail-kv-grid">
              <DetailKv label="Why eligible" value={String(resolver?.eligible_reason ?? '—')} />
              <DetailKv label="Why selected" value={String(resolver?.selected_reason ?? '—')} />
              <DetailKv label="Language match" value={String(resolver?.language_match ?? '—')} />
              <DetailKv label="Property match" value={String(resolver?.property_match ?? '—')} />
              <DetailKv label="Variables" value={String(resolver?.variables_available ?? '—')} />
              <DetailKv label="Concentration" value={String(resolver?.concentration_limits ?? '—')} />
              {Boolean(resolver?.fallback_used) && (
                <DetailKv label="Fallback" value="Used when primary match unavailable" tone="amber" />
              )}
            </div>
          </DetailSection>
        )}

        {tab === 'Optimization' && optimization && (
          <DetailSection title="Optimization posture">
            <div className="occ-tpl-detail-kv-grid">
              <DetailKv label="State" value={formatOptimizationState(String(optimization.rotation_state))} tone={optTone} />
              <DetailKv label="Recommended" value={formatOptimizationState(String(optimization.proposed_state))} />
              <DetailKv label="Current share" value={optimization.traffic_weight != null ? `${Math.round(Number(optimization.traffic_weight) * 100)}%` : '—'} />
              <DetailKv label="Recommended share" value={optimization.proposed_weight != null ? `${Math.round(Number(optimization.proposed_weight) * 100)}%` : '—'} />
              <DetailKv label="Reason" value={formatDecisionReason(String(optimization.decision_reason))} />
              <DetailKv label="Confidence" value={formatConfidence((optimization.intelligence as { current_range_confidence?: { bucket?: string } })?.current_range_confidence?.bucket)} />
              <DetailKv label="Next review" value={optimization.next_evaluation ? new Date(String(optimization.next_evaluation)).toLocaleString() : '—'} />
            </div>
            <p className="occ-tpl-detail-shadow-note">Recommendations only — no automatic changes</p>
          </DetailSection>
        )}

        {tab === 'Change History' && (
          <DetailSection title="Change history">
            {decisionHistory.length === 0 && <p className="occ-tpl-detail-hint">No change history recorded.</p>}
            {decisionHistory.map((d, i) => (
              <div key={i} className="occ-tpl-detail-history">
                <div className="occ-tpl-detail-history__head">
                  <strong>{String(d.action)}</strong>
                  <span>{d.timestamp ? new Date(String(d.timestamp)).toLocaleString() : '—'}</span>
                </div>
                <span className="occ-tpl-detail-history__actor">{String(d.actor ?? 'operator')}</span>
                {d.reason != null && String(d.reason).trim() ? <p>{String(d.reason)}</p> : null}
              </div>
            ))}
          </DetailSection>
        )}
      </div>

      <footer className="occ-tpl-detail__foot">
        {onViewQueueRows && (
          <button type="button" className="occ-action-btn is-primary" onClick={() => onViewQueueRows(row.identity.template_id)}>
            View queue rows
          </button>
        )}
      </footer>
    </div>
  )

  const chrome = (
    <div className="occ-tpl-detail-sheet__chrome">
      <div className="occ-tpl-detail-sheet__lead">
        <span className="occ-tpl-detail-sheet__eyebrow">Template dossier</span>
        <strong className="occ-tpl-detail-sheet__name">{displayName}</strong>
      </div>
      <div className="occ-tpl-detail-sheet__nav">
        <button type="button" className="occ-tpl-detail-sheet__nav-btn" disabled={!hasPrev} onClick={() => hasPrev && onNavigate(rows[idx - 1].identity.template_id)} aria-label="Previous template">
          <Icon name="chevron-left" size={16} />
          <span>Prev</span>
        </button>
        <span className="occ-tpl-detail-sheet__counter">{idx + 1} / {rows.length}</span>
        <button type="button" className="occ-tpl-detail-sheet__nav-btn" disabled={!hasNext} onClick={() => hasNext && onNavigate(rows[idx + 1].identity.template_id)} aria-label="Next template">
          <span>Next</span>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <button type="button" className="occ-tpl-detail-sheet__close" onClick={onClose} aria-label="Close template dossier">
        <Icon name="close" size={14} />
      </button>
    </div>
  )

  if (isMobileLayout) {
    return createPortal(
      <MobileBottomSheet open snap="expanded" onClose={onClose} className="occ-tpl-mobile-sheet">
        {chrome}
        {panel}
      </MobileBottomSheet>,
      document.body,
    )
  }

  return createPortal(
    <div className="occ-tpl-modal-overlay" onClick={onClose} role="presentation">
      <div className="occ-tpl-modal occ-tpl-modal--v2" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="tpl-modal-title">
        <header className="occ-tpl-modal__head occ-tpl-modal__head--v2">
          <span className="occ-tpl-detail-sheet__eyebrow">Template dossier</span>
          <div className="occ-tpl-modal__nav">
            <button type="button" className="occ-tpl-detail-sheet__nav-btn" disabled={!hasPrev} onClick={() => hasPrev && onNavigate(rows[idx - 1].identity.template_id)} aria-label="Previous template">
              <Icon name="chevron-left" size={14} />
            </button>
            <span className="occ-tpl-modal__pos">{idx + 1} / {rows.length}</span>
            <button type="button" className="occ-tpl-detail-sheet__nav-btn" disabled={!hasNext} onClick={() => hasNext && onNavigate(rows[idx + 1].identity.template_id)} aria-label="Next template">
              <Icon name="chevron-right" size={14} />
            </button>
            <button type="button" className="occ-tpl-detail-sheet__close" onClick={onClose} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>
        </header>
        {panel}
      </div>
    </div>,
    document.body,
  )
}