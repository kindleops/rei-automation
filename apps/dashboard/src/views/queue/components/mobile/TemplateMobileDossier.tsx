import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
import type { TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import {
  formatConfidence,
  formatDecisionReason,
  formatOptimizationState,
  formatRateDisplay,
} from '../../../../domain/templates/template-operator-labels'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type MobileTab = 'Overview' | 'Performance' | 'Logic'
const TABS: MobileTab[] = ['Overview', 'Performance', 'Logic']

const OPT_TONE: Record<string, string> = {
  'Performing well': 'green',
  'Gathering data': 'cyan',
  Testing: 'cyan',
  'Needs review': 'amber',
  Paused: 'amber',
  Retired: 'muted',
}

const LANGUAGE_LABEL: Record<string, string> = { en: 'English', es: 'Spanish' }

type Rate = { value?: number | null; numerator?: number; denominator?: number }

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="qms-block">
      <h3 className="qms-block__title">{title}</h3>
      {children}
    </section>
  )
}

function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="qm-tpl-collapse">
      <button type="button" className="qm-tpl-collapse__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>
      {open && <div className="qm-tpl-collapse__body">{children}</div>}
    </section>
  )
}

function Kv({ rows }: { rows: Array<{ k: string; v: string; tone?: string }> }) {
  if (rows.length === 0) return null
  return (
    <div className="qms-kv">
      {rows.map((r) => (
        <div key={r.k} className="qms-kv__row">
          <span>{r.k}</span>
          <span className={cls(r.tone && `is-${r.tone}`)}>{r.v}</span>
        </div>
      ))}
    </div>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={cls('qm-tpl-metric', tone && `is-${tone}`)}>
      <span className="qm-tpl-metric__lbl">{label}</span>
      <strong className="qm-tpl-metric__val">{value}</strong>
      {sub && <span className="qm-tpl-metric__sub">{sub}</span>}
    </div>
  )
}

interface TemplateMobileDossierProps {
  row: TemplateIntelligenceRow
  rows: TemplateIntelligenceRow[]
  dossier?: Record<string, unknown> | null
  loading?: boolean
  onClose: () => void
  onNavigate: (templateId: string) => void
  onViewQueueRows?: (templateId: string) => void
}

export function TemplateMobileDossier({
  row,
  rows,
  dossier,
  loading,
  onClose,
  onNavigate,
  onViewQueueRows,
}: TemplateMobileDossierProps) {
  // Tab selection is keyed to the template, so Prev / Next resets to Overview
  // without an effect round-trip.
  const [selectedTab, setSelectedTab] = useState<{ id: string; tab: MobileTab } | null>(null)
  const tab: MobileTab = selectedTab?.id === row.identity.template_id ? selectedTab.tab : 'Overview'
  const setTab = (next: MobileTab) => setSelectedTab({ id: row.identity.template_id, tab: next })

  const idx = rows.findIndex((r) => r.identity.template_id === row.identity.template_id)
  const overview = dossier?.overview as Record<string, unknown> | undefined
  const funnel = dossier?.funnel as { stages?: Array<{ key: string; label?: string; value: number }> } | undefined
  const resolver = dossier?.resolver as Record<string, unknown> | undefined
  const cohorts = dossier?.cohorts as Record<string, unknown> | undefined
  const executions = (dossier?.executions as Array<Record<string, unknown>>) ?? []
  const optimization = (dossier?.optimization ?? row.autopilot) as Record<string, unknown> | null
  const rates = row.metrics.comparison.rates as Record<string, { current?: Rate }>
  const m = row.metrics.current as Record<string, number | null>

  const sends = Number(overview?.sends ?? m.sends ?? 0)
  const hasData = sends > 0
  const name = row.identity.canonical_display_name || row.identity.template_name
  const stage = row.identity.stage_code ?? '—'
  const language = LANGUAGE_LABEL[row.identity.language] ?? row.identity.language
  const optState = formatOptimizationState(String(optimization?.rotation_state ?? ''))
  const optTone = OPT_TONE[optState] ?? 'muted'

  // A translation only earns space when it says something the body does not.
  const body = row.identity.canonical_body?.trim() ?? ''
  const translation = row.identity.english_translation?.trim() ?? ''
  const showTranslation = useMemo(() => {
    if (!translation) return false
    if (row.identity.language === 'en') return false
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    return norm(translation) !== norm(body)
  }, [translation, body, row.identity.language])

  const primaryRates: Array<{ label: string; rate?: Rate; tone: string }> = [
    { label: 'Delivery', rate: rates.delivery?.current, tone: 'green' },
    { label: 'Reply', rate: rates.reply?.current, tone: 'cyan' },
    { label: 'Positive', rate: rates.positive_reply?.current, tone: 'green' },
    { label: 'Opt-out', rate: rates.opt_out?.current, tone: 'amber' },
  ]

  const secondaryRates: Array<{ label: string; rate?: Rate }> = [
    { label: 'Negative', rate: (rates as Record<string, { current?: Rate }>).negative_reply?.current },
    { label: 'Wrong number', rate: (rates as Record<string, { current?: Rate }>).wrong_number?.current },
    { label: 'Ownership', rate: rates.ownership_confirmation?.current },
    { label: 'Stage advance', rate: rates.stage_advancement?.current },
  ]

  return createPortal(
    <MobileBottomSheet open snap="expanded" onClose={onClose} className="qm-tpl-sheet">
      <header className="qms-chrome">
        <div className="qms-chrome__lead">
          <span className="qms-chrome__eyebrow">{stage} · {name}</span>
          <strong className="qms-chrome__name">
            {[row.identity.touch_number != null ? `Touch ${row.identity.touch_number}` : null, language].filter(Boolean).join(' · ')}
          </strong>
        </div>
        <div className="qms-chrome__nav">
          <button type="button" className="qms-chrome__btn" disabled={idx <= 0} onClick={() => idx > 0 && onNavigate(rows[idx - 1].identity.template_id)} aria-label="Previous template">
            <Icon name="chevron-left" size={15} />
          </button>
          <span className="qms-chrome__counter">{idx + 1} / {rows.length}</span>
          <button type="button" className="qms-chrome__btn" disabled={idx >= rows.length - 1} onClick={() => idx < rows.length - 1 && onNavigate(rows[idx + 1].identity.template_id)} aria-label="Next template">
            <Icon name="chevron-right" size={15} />
          </button>
          <button type="button" className="qms-chrome__btn is-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      <div className="qm-tpl-status">
        <span className={cls('qm-tag', row.identity.active_state === 'active' ? 'is-green' : 'is-amber')}>
          {row.identity.active_state}
        </span>
        <span className={cls('qm-tag', `is-${optTone}`)}>{optState}</span>
      </div>

      <div className="qm-tpl-tabs" role="tablist" aria-label="Template views">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={cls('qm-tpl-tab', tab === t && 'is-active')}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="qms-body">
        {loading && <p className="qm-tpl-loading">Loading dossier…</p>}

        {tab === 'Overview' && (
          <>
            <Block title="Message">
              <blockquote className="qms-msg">{body || 'No message body on file'}</blockquote>
            </Block>

            {showTranslation && (
              <Block title="English translation">
                <p className="qm-tpl-copy">{translation}</p>
              </Block>
            )}

            {/* The state is already named by the header chip — this only has to
                explain the consequence once. */}
            {!hasData && (
              <p className="qm-tpl-zero-note">
                No sends in the selected range. Performance becomes available after this template runs.
              </p>
            )}

            <Block title="Identity">
              <Kv
                rows={[
                  { k: 'Stage', v: row.identity.stage_label || stage },
                  { k: 'Touch', v: row.identity.touch_number != null ? String(row.identity.touch_number) : '—' },
                  { k: 'Language', v: language },
                  ...(row.identity.use_case ? [{ k: 'Use case', v: row.identity.use_case.replace(/_/g, ' ') }] : []),
                  ...(row.identity.asset_scope ? [{ k: 'Property scope', v: row.identity.asset_scope }] : []),
                  ...(overview?.last_used ? [{ k: 'Last used', v: new Date(String(overview.last_used)).toLocaleString() }] : []),
                ]}
              />
            </Block>

            {optimization && (
              <Block title="Optimization posture">
                {/* The headline is the decision, not a second copy of the state
                    already shown in the header chip. */}
                <div className={cls('qm-tpl-decision', `is-${optTone}`)}>
                  <strong>{hasData ? optState : 'Optimization paused'}</strong>
                  <p>{formatDecisionReason(String(optimization.decision_reason ?? ''))}</p>
                  <div className="qm-tpl-decision__shares">
                    <span>Current share <b>{optimization.traffic_weight != null ? `${Math.round(Number(optimization.traffic_weight) * 100)}%` : '—'}</b></span>
                    <span>Recommended <b>{optimization.proposed_weight != null ? `${Math.round(Number(optimization.proposed_weight) * 100)}%` : '—'}</b></span>
                  </div>
                  {optimization.next_evaluation != null && String(optimization.next_evaluation).trim() ? (
                    <span className="qm-tpl-decision__next">
                      Next review {new Date(String(optimization.next_evaluation)).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>
                <span className="qm-tpl-note">Recommendations only — no automatic changes</span>
              </Block>
            )}

            <Collapsible title="Template ID">
              <code className="qm-tpl-id">{row.identity.template_id}</code>
            </Collapsible>
          </>
        )}

        {tab === 'Performance' && (
          !hasData ? (
            <p className="qm-tpl-zero-note">
              No sends in the selected range. Performance becomes available after this template runs.
            </p>
          ) : (
            <>
              <Block title="Selected range">
                <div className="qm-tpl-metrics">
                  <Metric label="Sends" value={sends.toLocaleString()} />
                  {primaryRates.map(({ label, rate, tone }) => {
                    const fmt = formatRateDisplay(rate, sends)
                    return <Metric key={label} label={label} value={fmt.primary} sub={fmt.secondary} tone={tone} />
                  })}
                  <Metric label="Confidence" value={formatConfidence(row.metrics.confidence.current_range.bucket)} tone="muted" />
                </div>
              </Block>

              <Collapsible title="More performance">
                <div className="qm-tpl-metrics">
                  {secondaryRates.map(({ label, rate }) => {
                    const fmt = formatRateDisplay(rate, sends)
                    return <Metric key={label} label={label} value={fmt.primary} sub={fmt.secondary} />
                  })}
                  <Metric label="Delivered" value={String(m.delivered ?? 0)} tone="green" />
                  <Metric label="Failed" value={String(m.failed ?? 0)} tone={Number(m.failed) > 0 ? 'red' : 'muted'} />
                </div>
              </Collapsible>

              {(funnel?.stages?.length ?? 0) > 0 && (
                <Collapsible title="Stage funnel">
                  <div className="qm-tpl-funnel">
                    {funnel!.stages!.map((s) => (
                      <div key={s.key} className="qm-tpl-funnel__step">
                        <span>{s.label ?? s.key.replace(/_/g, ' ')}</span>
                        <strong>{s.value}</strong>
                      </div>
                    ))}
                  </div>
                </Collapsible>
              )}

              {cohorts != null && ['market', 'language', 'campaign', 'sender', 'asset'].some(
                (d) => ((cohorts[d] as Array<unknown>) ?? []).length > 0,
              ) && (
                <Collapsible title="Cohorts">
                  {['market', 'language', 'campaign', 'sender', 'asset'].map((dim) => {
                    const list = (cohorts[dim] as Array<{ key: string; sends?: number }>) ?? []
                    if (!list.length) return null
                    return (
                      <div key={dim} className="qm-tpl-cohort">
                        <h4>{dim}</h4>
                        <Kv rows={list.map((c) => ({ k: c.key, v: `${c.sends ?? 0} sends` }))} />
                      </div>
                    )
                  })}
                </Collapsible>
              )}

              {executions.length > 0 && (
                <Collapsible title={`Recent executions (${executions.length})`}>
                  {executions.slice(0, 8).map((e) => (
                    <div key={String(e.queue_id)} className="qm-tpl-exec">
                      <span className="qm-tpl-exec__meta">
                        {String(e.delivery_result ?? e.status)} · ···{String(e.sender ?? '').slice(-4)}
                      </span>
                      <p>{String(e.rendered_body ?? '').slice(0, 160)}</p>
                    </div>
                  ))}
                </Collapsible>
              )}
            </>
          )
        )}

        {tab === 'Logic' && (
          <>
            <Block title="Why this template gets selected">
              <Kv
                rows={[
                  { k: 'Eligible because', v: String(resolver?.eligible_reason ?? 'No resolver evidence in range') },
                  { k: 'Selected because', v: String(resolver?.selected_reason ?? '—') },
                  { k: 'Language match', v: String(resolver?.language_match ?? '—') },
                  { k: 'Property match', v: String(resolver?.property_match ?? '—') },
                  ...(resolver?.fallback_used ? [{ k: 'Fallback', v: 'Used when primary match unavailable', tone: 'amber' }] : []),
                ]}
              />
            </Block>

            <Block title="Required variables">
              <p className="qm-tpl-copy">
                {row.identity.variable_contract?.length
                  ? row.identity.variable_contract.join(', ')
                  : 'None declared'}
              </p>
            </Block>

            {(row.identity.allowed_property_groups?.length > 0 || row.identity.prohibited_property_groups?.length > 0) && (
              <Collapsible title="Eligibility">
                <Kv
                  rows={[
                    ...(row.identity.allowed_property_groups?.length
                      ? [{ k: 'Allowed', v: row.identity.allowed_property_groups.join(', ') }] : []),
                    ...(row.identity.prohibited_property_groups?.length
                      ? [{ k: 'Prohibited', v: row.identity.prohibited_property_groups.join(', ') }] : []),
                  ]}
                />
              </Collapsible>
            )}

            {optimization && (
              <Collapsible title="Optimization logic">
                <Kv
                  rows={[
                    { k: 'State', v: optState },
                    { k: 'Recommended', v: formatOptimizationState(String(optimization.proposed_state ?? '')) },
                    { k: 'Reason', v: formatDecisionReason(String(optimization.decision_reason ?? '')) },
                    {
                      k: 'Confidence',
                      v: formatConfidence(
                        (optimization.intelligence as { current_range_confidence?: { bucket?: string } })?.current_range_confidence?.bucket,
                      ),
                    },
                  ]}
                />
              </Collapsible>
            )}
          </>
        )}

        {onViewQueueRows && (
          <button
            type="button"
            className="qm-tpl-queuelink"
            onClick={() => onViewQueueRows(row.identity.template_id)}
          >
            View queue rows
            <Icon name="chevron-right" size={13} />
          </button>
        )}
      </div>
    </MobileBottomSheet>,
    document.body,
  )
}
