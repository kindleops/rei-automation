import { useState, useEffect, useCallback, useMemo } from 'react'
import { Icon } from '../../shared/icons'
import { emitNotification } from '../../shared/NotificationToast'
import {
  loadCampaigns,
  fetchCampaignTargets,
  fetchCampaignQueue,
  fetchCampaignReplies,
  fetchCampaignFailures,
  fetchCampaignGeography,
  fetchCampaignTemplates,
  fetchCampaignLogs,
  buildSuppressionChecklist,
  queueBatch,
} from './campaigns.adapter'
import { CreateCampaignModal } from './CreateCampaignModal'
import type {
  CampaignModel,
  CampaignSummary,
  CampaignTarget,
  CampaignDetailTab,
  CampaignStatus,
  CampaignQueueRow,
  CampaignReply,
  CampaignFailureGroup,
  CampaignGeographyEntry,
  CampaignTemplateStats,
  CampaignLogEvent,
  SuppressionCheck,
  CampaignCommandState,
} from './campaigns.types'
import './campaigns.css'

// ── Helpers ──────────────────────────────────────────────────────────────────

export const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export const fmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const fmtPct = (n: number): string => `${n.toFixed(1)}%`

export const fmtInterval = (secs: number): string => {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

export const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = new Date(iso).getTime() - Date.now()
  if (diff < 0) {
    const ago = Math.abs(diff)
    const mins = Math.floor(ago / 60_000)
    if (mins < 60) return `${mins}m ago`
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
    return `${Math.floor(mins / 1440)}d ago`
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `in ${mins}m`
  if (mins < 1440) return `in ${Math.floor(mins / 60)}h`
  return `in ${Math.floor(mins / 1440)}d`
}

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const statusOrder: Record<CampaignStatus, number> = {
  active: 0,
  live_limited: 1,
  ready: 2,
  scheduled: 3,
  paused: 4,
  draft: 5,
  completed: 6,
  archived: 7,
}

// ── Primitive components ──────────────────────────────────────────────────────

const StatusBadge = ({ status }: { status: CampaignStatus }) => {
  const labels: Record<CampaignStatus, string> = {
    active: 'Active', ready: 'Ready', live_limited: 'Live Limited', paused: 'Paused', scheduled: 'Scheduled',
    draft: 'Draft', completed: 'Completed', archived: 'Archived',
  }
  return (
    <span className={cls('ccc-status', `is-${status}`)}>
      <span className="ccc-status__dot" />
      {labels[status] ?? status}
    </span>
  )
}

const RateCell = ({
  value, good = 90, warn = 70, isOptOut = false, isFailure = false,
}: { value: number; good?: number; warn?: number; isOptOut?: boolean; isFailure?: boolean }) => {
  let variant = 'is-good'
  if (isOptOut || isFailure) {
    variant = value > 8 ? 'is-bad' : value > 4 ? 'is-warn' : 'is-good'
  } else {
    variant = value >= good ? 'is-good' : value >= warn ? 'is-warn' : 'is-bad'
  }
  return <span className={cls('ccc-rate', variant)}>{fmtPct(value)}</span>
}

// ── KPI Strip ─────────────────────────────────────────────────────────────────

export const KpiStrip = ({ kpis }: { kpis: CampaignModel['kpis'] }) => {
  const cards = [
    { label: 'Active Campaigns', value: kpis.activeCampaigns, variant: 'is-success' },
    { label: 'Total Targets',    value: fmt(kpis.totalTargets),    variant: '' },
    { label: 'Ready Targets',    value: fmt(kpis.readyTargets),    variant: 'is-accent' },
    { label: 'Scheduled Sends',  value: fmt(kpis.scheduledSends),  variant: 'is-blue' },
    { label: 'Sent Today',       value: fmt(kpis.sentToday),       variant: '' },
    { label: 'Delivered Today',  value: fmt(kpis.deliveredToday),  variant: 'is-success' },
    { label: 'Reply Rate',       value: fmtPct(kpis.replyRate),    variant: 'is-accent' },
    { label: 'Positive Replies', value: fmt(kpis.positiveReplies), variant: 'is-success' },
    { label: 'Opt-Out Rate',     value: fmtPct(kpis.optOutRate),   variant: kpis.optOutRate > 6 ? 'is-danger' : kpis.optOutRate > 3 ? 'is-warning' : '' },
    { label: 'Failure Rate',     value: fmtPct(kpis.failureRate),  variant: kpis.failureRate > 8 ? 'is-danger' : kpis.failureRate > 4 ? 'is-warning' : '' },
  ]
  return (
    <div className="ccc__kpi-strip">
      {cards.map((c) => (
        <div key={c.label} className="ccc__kpi-card">
          <div className="ccc__kpi-label">{c.label}</div>
          <div className={cls('ccc__kpi-value', c.variant)}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

// ── Campaign Health Sidebar ────────────────────────────────────────────────────

export type HealthLevel = 'healthy' | 'caution' | 'dangerous'

export const computeHealth = (c: CampaignSummary): { level: HealthLevel; score: number; issues: string[] } => {
  const issues: string[] = []
  let score = 100

  if (c.delivery_rate < 90) { score -= 15; if (c.delivery_rate < 75) { score -= 15; issues.push(`Delivery rate ${fmtPct(c.delivery_rate)} is critically low`) } else { issues.push(`Delivery rate ${fmtPct(c.delivery_rate)} needs attention`) } }
  if (c.opt_out_rate > 3) { score -= 10; if (c.opt_out_rate > 6) { score -= 15; issues.push(`Opt-out rate ${fmtPct(c.opt_out_rate)} exceeds safe threshold`) } else { issues.push(`Opt-out rate ${fmtPct(c.opt_out_rate)} is elevated`) } }
  if (c.failed_count > 20) { score -= 10; issues.push(`${c.failed_count} failed sends detected`) }
  if (c.reply_rate < 5) { score -= 5; issues.push(`Reply rate ${fmtPct(c.reply_rate)} is below target`) }
  if (c.auto_send_enabled) { score -= 15; issues.push('Auto-send must stay disabled in Phase 1') }
  if (c.ready_targets === 0 && ['active', 'ready', 'live_limited'].includes(c.status)) { score -= 10; issues.push('No ready targets — build or refresh target list') }

  const level: HealthLevel = score >= 80 ? 'healthy' : score >= 55 ? 'caution' : 'dangerous'
  return { level, score: Math.max(0, score), issues }
}

export const CampaignHealthSidebar = ({ campaign }: { campaign: CampaignSummary | null }) => {
  if (!campaign) {
    return (
      <div className="ccc__health-sidebar">
        <div className="ccc__hs-header">
          <div className="ccc__hs-title">Campaign Health</div>
        </div>
        <div style={{ padding: 16, color: 'var(--text-2)', fontSize: 11, textAlign: 'center', marginTop: 24 }}>
          Select a campaign to view health analysis
        </div>
      </div>
    )
  }

  const { level, score, issues } = computeHealth(campaign)
  const levelLabel = level === 'healthy' ? 'Healthy' : level === 'caution' ? 'Caution' : 'Critical'

  const failRate = campaign.sent_count > 0
    ? (campaign.failed_count / campaign.sent_count) * 100
    : 0

  const metrics = [
    { label: 'Delivery',   value: fmtPct(campaign.delivery_rate), variant: campaign.delivery_rate >= 90 ? 'is-good' : campaign.delivery_rate >= 75 ? 'is-warn' : 'is-bad' },
    { label: 'Reply Rate', value: fmtPct(campaign.reply_rate), variant: campaign.reply_rate >= 12 ? 'is-good' : campaign.reply_rate >= 7 ? 'is-warn' : 'is-bad' },
    { label: 'Opt-Out',    value: fmtPct(campaign.opt_out_rate), variant: campaign.opt_out_rate <= 3 ? 'is-good' : campaign.opt_out_rate <= 6 ? 'is-warn' : 'is-bad' },
    { label: 'Fail Rate',  value: fmtPct(failRate), variant: failRate <= 3 ? 'is-good' : failRate <= 8 ? 'is-warn' : 'is-bad' },
    { label: 'Positive',   value: fmt(campaign.positive_reply_count), variant: campaign.positive_reply_count > 0 ? 'is-good' : '' },
    { label: 'Ready',      value: fmt(campaign.ready_targets), variant: campaign.ready_targets > 0 ? '' : 'is-warn' },
    { label: 'Next Send',  value: fmtRelative(campaign.next_send_at), variant: '' },
  ]

  return (
    <div className="ccc__health-sidebar">
      <div className="ccc__hs-header">
        <div className="ccc__hs-title">Campaign Health</div>
        <div className="ccc__hs-score-block">
          <div className={cls('ccc__hs-score-ring', `is-${level}`)}>{score}</div>
          <div className={cls('ccc__hs-score-label', `is-${level}`)}>{levelLabel}</div>
          {issues.length === 0 && (
            <div className="ccc__hs-score-reason">All systems nominal</div>
          )}
        </div>
      </div>

      <div className="ccc__hs-body">
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 8 }}>Metrics</div>
        {metrics.map((m) => (
          <div key={m.label} className="ccc__hs-metric">
            <span className="ccc__hs-metric-label">{m.label}</span>
            <span className={cls('ccc__hs-metric-value', m.variant)}>{m.value}</span>
          </div>
        ))}
      </div>

      {issues.length > 0 && (
        <div className="ccc__hs-issues">
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 6 }}>
            Issues ({issues.length})
          </div>
          {issues.map((issue, i) => {
            const isCritical = issue.includes('critically') || issue.includes('exceed')
            return (
              <div key={i} className="ccc__hs-issue">
                <div className={cls('ccc__hs-issue-dot', isCritical ? 'is-critical' : 'is-warn')} />
                <span>{issue}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Suppression Checklist ──────────────────────────────────────────────────────

const SuppressionChecklist = ({ checks }: { checks: SuppressionCheck[] }) => (
  <div className="ccc__suppression-list">
    {checks.map((check) => (
      <div key={check.key} className={cls('ccc__suppression-item', `is-${check.status}`)}>
        <div className={cls('ccc__suppression-icon', `is-${check.status}`)}>
          {check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✕'}
        </div>
        <div>
          <div className="ccc__suppression-label">{check.label}</div>
        </div>
        <div className={cls('ccc__suppression-detail', check.status !== 'pass' && `is-${check.status}`)}>
          {check.detail}
        </div>
      </div>
    ))}
  </div>
)

// ── Overview Tab ──────────────────────────────────────────────────────────────

const CampaignDetailOpsStrip = ({
  campaign,
  scopeLabel,
}: {
  campaign: CampaignSummary
  scopeLabel: string
}) => {
  const queueRows = campaign.queued_targets + campaign.scheduled_targets
  const deliveryState = campaign.sent_count > 0
    ? `${fmt(campaign.delivered_count)} of ${fmt(campaign.sent_count)} delivered`
    : 'No sends yet'
  const replies = campaign.reply_count || campaign.positive_reply_count + campaign.negative_reply_count

  return (
    <div className="ccc__detail-ops-strip">
      <div>
        <span>Graph Scope</span>
        <strong>{scopeLabel}</strong>
      </div>
      <div>
        <span>Target Count</span>
        <strong>{fmt(campaign.total_targets)}</strong>
      </div>
      <div>
        <span>Queue Rows</span>
        <strong>{fmt(queueRows)}</strong>
      </div>
      <div>
        <span>Delivery State</span>
        <strong>{deliveryState}</strong>
      </div>
      <div>
        <span>Replies</span>
        <strong>{fmt(replies)}</strong>
      </div>
    </div>
  )
}

const OverviewTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const checks = buildSuppressionChecklist(campaign)
  const totalCost = campaign.sent_count * 0.0075
  const totalReplies = campaign.positive_reply_count + campaign.negative_reply_count
  const costPerReply = totalReplies > 0 ? totalCost / totalReplies : 0
  const costPerLead = campaign.positive_reply_count > 0 ? totalCost / campaign.positive_reply_count : 0

  return (
    <div>
      <div className="ccc__section-title">Cost Estimates</div>
      <div className="ccc__cost-grid">
        <div className="ccc__cost-card">
          <div className="ccc__cost-label">Total Spend</div>
          <div className="ccc__cost-value">${totalCost.toFixed(2)}</div>
          <div className="ccc__cost-sub">{campaign.sent_count.toLocaleString()} sends @ $0.0075</div>
        </div>
        <div className="ccc__cost-card">
          <div className="ccc__cost-label">Cost / Reply</div>
          <div className="ccc__cost-value">{costPerReply > 0 ? `$${costPerReply.toFixed(2)}` : '—'}</div>
          <div className="ccc__cost-sub">{totalReplies} total replies</div>
        </div>
        <div className="ccc__cost-card is-accent">
          <div className="ccc__cost-label">Cost / Lead</div>
          <div className="ccc__cost-value">{costPerLead > 0 ? `$${costPerLead.toFixed(2)}` : '—'}</div>
          <div className="ccc__cost-sub">{campaign.positive_reply_count} positive</div>
        </div>
      </div>

      <div className="ccc__section-title">Target Funnel</div>
      {[
        { label: 'Total', value: campaign.total_targets, pct: 100, color: '' },
        { label: 'Ready', value: campaign.ready_targets, pct: campaign.total_targets > 0 ? (campaign.ready_targets / campaign.total_targets) * 100 : 0, color: 'is-blue' },
        { label: 'Scheduled', value: campaign.scheduled_targets, pct: campaign.total_targets > 0 ? (campaign.scheduled_targets / campaign.total_targets) * 100 : 0, color: '' },
        { label: 'Sent', value: campaign.sent_count, pct: campaign.total_targets > 0 ? (campaign.sent_count / campaign.total_targets) * 100 : 0, color: '' },
        { label: 'Delivered', value: campaign.delivered_count, pct: campaign.total_targets > 0 ? (campaign.delivered_count / campaign.total_targets) * 100 : 0, color: '' },
        { label: 'Failed', value: campaign.failed_count, pct: campaign.total_targets > 0 ? (campaign.failed_count / campaign.total_targets) * 100 : 0, color: 'is-danger' },
        { label: 'Opted Out', value: campaign.opt_out_count, pct: campaign.total_targets > 0 ? (campaign.opt_out_count / campaign.total_targets) * 100 : 0, color: 'is-warn' },
      ].map(({ label, value, pct, color }) => (
        <div key={label} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11 }}>
            <span style={{ color: 'var(--text-2)' }}>{label}</span>
            <span style={{ color: 'var(--text-0)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</span>
          </div>
          <div className="ccc__bar-track">
            <div className={cls('ccc__bar-fill', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </div>
      ))}

      <div className="ccc__section-title">Performance Rates</div>
      <div className="ccc__stat-grid">
        <div className="ccc__stat-card">
          <div className="ccc__stat-card-label">Delivery Rate</div>
          <div className={cls('ccc__stat-card-value', campaign.delivery_rate >= 90 ? 'is-success' : campaign.delivery_rate >= 75 ? 'is-warning' : 'is-danger')}>
            {fmtPct(campaign.delivery_rate)}
          </div>
        </div>
        <div className="ccc__stat-card">
          <div className="ccc__stat-card-label">Reply Rate</div>
          <div className={cls('ccc__stat-card-value', campaign.reply_rate >= 12 ? 'is-success' : campaign.reply_rate >= 7 ? 'is-warning' : 'is-danger')}>
            {fmtPct(campaign.reply_rate)}
          </div>
        </div>
        <div className="ccc__stat-card">
          <div className="ccc__stat-card-label">Opt-Out Rate</div>
          <div className={cls('ccc__stat-card-value', campaign.opt_out_rate <= 3 ? 'is-success' : campaign.opt_out_rate <= 6 ? 'is-warning' : 'is-danger')}>
            {fmtPct(campaign.opt_out_rate)}
          </div>
        </div>
        <div className="ccc__stat-card">
          <div className="ccc__stat-card-label">Positive Leads</div>
          <div className="ccc__stat-card-value is-success">{campaign.positive_reply_count}</div>
        </div>
      </div>

      <div className="ccc__section-title">Schedule</div>
      <div className="ccc__setting-row">
        <div><div className="ccc__setting-label">Next Send</div><div className="ccc__setting-desc">Next scheduled execution</div></div>
        <div className="ccc__setting-value">{fmtRelative(campaign.next_send_at)}</div>
      </div>
      <div className="ccc__setting-row">
        <div><div className="ccc__setting-label">Send Interval</div><div className="ccc__setting-desc">Delay between sends</div></div>
        <div className="ccc__setting-value">{fmtInterval(campaign.send_interval_seconds)}</div>
      </div>
      {campaign.send_window_start && (
        <div className="ccc__setting-row">
          <div><div className="ccc__setting-label">Send Window</div><div className="ccc__setting-desc">Active outreach hours</div></div>
          <div className="ccc__setting-value">{campaign.send_window_start} – {campaign.send_window_end ?? '—'}</div>
        </div>
      )}
      <div className="ccc__setting-row">
        <div><div className="ccc__setting-label">Auto Send</div><div className="ccc__setting-desc">Automated outreach engine</div></div>
        <div className={cls('ccc-toggle', campaign.auto_send_enabled && 'is-on')} />
      </div>

      <div className="ccc__section-title">Suppression Validation</div>
      <SuppressionChecklist checks={checks} />
    </div>
  )
}

// ── Targets Tab ───────────────────────────────────────────────────────────────

const TargetsTab = ({ campaignId }: { campaignId: string }) => {
  const [targets, setTargets] = useState<CampaignTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignTargets(campaignId).then((data) => {
      if (active) setTargets(data)
    }).catch(() => {
      if (active) setTargets([])
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [campaignId])

  const filtered = useMemo(() =>
    filter === 'all' ? targets : targets.filter((t) => t.target_status === filter),
    [targets, filter],
  )

  const statusOptions = ['all', 'ready', 'scheduled', 'sent', 'delivered', 'failed', 'opted_out']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {statusOptions.map((s) => (
          <button key={s} className={cls('ccc__chip', filter === s && 'is-active')} onClick={() => setFilter(s)}>
            {s === 'all' ? 'All' : s.replace(/_/g, ' ')}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-2)', alignSelf: 'center' }}>
          {filtered.length} of {targets.length}
        </span>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[1, 2, 3, 4].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 36, width: '100%' }} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="ccc__empty"><div className="ccc__empty-title">No real targets loaded for this campaign yet.</div><div className="ccc__empty-sub">Import or build targets to begin.</div></div>
      ) : (
        <div className="ccc__targets-scroll">
          <table className="ccc__targets-table">
            <thead>
              <tr>
                <th>Owner</th>
                <th>Property</th>
                <th>Market</th>
                <th>State</th>
                <th>Phone</th>
                <th>Lang</th>
                <th>Score</th>
                <th>Status</th>
                <th>Last Contact</th>
                <th>Suppressed</th>
                <th>Template</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 150).map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600, color: 'var(--text-0)' }}>{t.seller_full_name ?? '—'}</td>
                  <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-2)' }}>{t.property_address_full ?? '—'}</td>
                  <td>{t.market ?? '—'}</td>
                  <td>{t.property_address_state ?? '—'}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{t.canonical_e164 ?? '—'}</td>
                  <td>
                    {t.language && (
                      <span className="ccc__lang-badge">{t.language.toUpperCase()}</span>
                    )}
                  </td>
                  <td>
                    {t.final_acquisition_score != null && (
                      <span className={cls('ccc__score-badge', t.final_acquisition_score >= 75 ? 'is-high' : t.final_acquisition_score >= 40 ? 'is-mid' : 'is-low')}>
                        {t.final_acquisition_score}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={cls('ccc__target-status', `is-${t.target_status}`)}>
                      {t.target_status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-2)', fontSize: 10 }}>{t.last_contact_at ? fmtDate(t.last_contact_at) : '—'}</td>
                  <td>
                    {t.suppression_status === 'suppressed' && <span className="ccc__suppressed-badge">SUPP</span>}
                  </td>
                  <td style={{ color: 'var(--text-2)', fontSize: 10, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.template_name ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 150 && (
            <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-2)', padding: '8px 0' }}>
              Showing 150 of {filtered.length}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Queue Tab ─────────────────────────────────────────────────────────────────

const QueueTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [items, setItems] = useState<CampaignQueueRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignQueue(campaign.id).then((data) => {
      if (active) setItems(data)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  const groups = useMemo(() => {
    const map = new Map<string, CampaignQueueRow[]>()
    for (const item of items) {
      const key = fmtDate(item.scheduled_for)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }
    return map
  }, [items])

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'Ready',     value: campaign.ready_targets,     cls: 'is-success' },
          { label: 'Queued',    value: campaign.queued_targets,    cls: '' },
          { label: 'Scheduled', value: campaign.scheduled_targets, cls: 'is-warning' },
        ].map((s) => (
          <div key={s.label} className="ccc__stat-card" style={{ flex: 1 }}>
            <div className="ccc__stat-card-label">{s.label}</div>
            <div className={cls('ccc__stat-card-value', s.cls)}>{s.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[1, 2, 3].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 40, width: '100%' }} />)}
        </div>
      ) : items.length === 0 ? (
        <div className="ccc__empty"><div className="ccc__empty-title">Queue is empty</div><div className="ccc__empty-sub">No real targets ready or queued</div></div>
      ) : (
        Array.from(groups.entries()).map(([date, rows]) => (
          <div key={date} style={{ marginBottom: 12 }}>
            <div className="ccc__q-group-header">
              <Icon name="clock" size={10} />
              {date} — {rows.length} sends
            </div>
            {rows.map((item) => (
              <div key={item.id} className="ccc__q-row">
                <div className={cls('ccc__q-dot', `is-${item.queue_status}`)} />
                <div className="ccc__q-owner">{item.seller_full_name}</div>
                <div className="ccc__q-addr">{item.property_address_full}</div>
                <div className="ccc__q-preview">Template: {item.template_name || '—'}</div>
                <span style={{ fontSize: 10, color: 'var(--accent-blue)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {item.scheduled_for ? fmtTime(item.scheduled_for) : '—'}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}

// ── Replies Tab ───────────────────────────────────────────────────────────────

const RepliesTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [filter, setFilter] = useState<'all' | 'positive' | 'negative' | 'neutral' | 'opt_out' | 'question'>('all')
  const [replies, setReplies] = useState<CampaignReply[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignReplies(campaign.id).then((data) => {
      if (active) setReplies(data)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  const filtered = filter === 'all' ? replies : replies.filter((r) => r.reply_type === filter)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'Positive', value: campaign.positive_reply_count, cls: 'is-success' },
          { label: 'Negative', value: campaign.negative_reply_count, cls: 'is-danger' },
          { label: 'Opted Out', value: campaign.opt_out_count,    cls: 'is-warning' },
        ].map((s) => (
          <div key={s.label} className="ccc__stat-card" style={{ flex: 1 }}>
            <div className="ccc__stat-card-label">{s.label}</div>
            <div className={cls('ccc__stat-card-value', s.cls)}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
        {(['all', 'positive', 'negative', 'neutral', 'opt_out', 'question'] as const).map((f) => (
          <button key={f} className={cls('ccc__chip', filter === f && 'is-active')} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[1, 2, 3].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 60, width: '100%' }} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="ccc__empty"><div className="ccc__empty-title">No replies found</div><div className="ccc__empty-sub">Replies will appear after sends begin</div></div>
      ) : (
        filtered.map((r) => (
          <div key={r.id} className={cls('ccc__reply-card', `is-${r.reply_type}`)}>
            <div className="ccc__reply-header">
              <div className="ccc__reply-seller">{r.seller_full_name}</div>
              <span className={cls('ccc__sentiment', `is-${r.sentiment}`)}>{r.sentiment}</span>
              <span className={cls('ccc__classification', `is-${r.reply_type}`)}>
                {r.reply_type.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="ccc__reply-message">"{r.inbound_message}"</div>
            <div style={{ fontSize: 10, color: 'var(--text-2)', marginBottom: 5 }}>{r.property_address_full}</div>
            <div className="ccc__reply-footer">
              <span>{fmtDate(r.created_at)}</span>
              <span className="ccc__reply-next-action">{r.next_action}</span>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// ── Failures Tab ──────────────────────────────────────────────────────────────

const FailuresTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [groups, setGroups] = useState<CampaignFailureGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignFailures(campaign.id).then((data) => {
      if (active) setGroups(data)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  if (loading) return <div className="ccc__shimmer" style={{ height: 100 }} />

  if (groups.length === 0) {
    return (
      <div className="ccc__empty">
        <div className="ccc__empty-icon"><Icon name="check" size={32} /></div>
        <div className="ccc__empty-title">No Failures</div>
        <div className="ccc__empty-sub">All sends delivered successfully</div>
      </div>
    )
  }

  return (
    <div>
      <div className="ccc__section-title">Failure Groups — {campaign.failed_count} Total Failed</div>
      {groups.map((g) => (
        <div key={g.failure_category} className={cls('ccc__failure-card', `is-${g.severity}`)}>
          <div className="ccc__failure-header">
            <div className="ccc__failure-reason">{g.failure_category}</div>
            <div className={cls('ccc__failure-count', `is-${g.severity}`)}>{g.count}</div>
            <span className={cls('ccc__severity-badge', `is-${g.severity}`)}>{g.severity}</span>
          </div>
          {g.sample_reasons[0] && (
            <div className="ccc__failure-example">"{g.sample_reasons[0]}"</div>
          )}
          <div className="ccc__failure-numbers">
            {g.sample_numbers.slice(0, 6).map((n) => (
              <span key={n} className="ccc__failure-number">{n}</span>
            ))}
            {g.sample_numbers.length > 6 && (
              <span className="ccc__failure-number">+{g.sample_numbers.length - 6} more</span>
            )}
          </div>
          <div className="ccc__bar-track" style={{ marginTop: 8 }}>
            <div
              className={cls('ccc__bar-fill', g.severity === 'critical' ? 'is-danger' : g.severity === 'warning' ? 'is-warn' : 'is-blue')}
              style={{ width: `${Math.min((g.count / campaign.failed_count) * 100, 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Geography Tab ─────────────────────────────────────────────────────────────

const GeographyTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [entries, setEntries] = useState<CampaignGeographyEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetchCampaignGeography(campaign.id).then((data) => {
      if (active) setEntries(data)
      setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  if (loading) return <div className="ccc__shimmer" style={{ height: 100 }} />
  if (entries.length === 0) return <div className="ccc__empty"><div className="ccc__empty-title">No data</div></div>

  return (
    <div>
      <div className="ccc__section-title">Geographic Performance</div>
      <div className="ccc__geo-grid">
        {entries.map((e) => (
          <div key={e.label} className="ccc__geo-card">
            <div className="ccc__geo-header">
              <div className="ccc__geo-label">{e.label}</div>
              <span className="ccc__geo-type">{e.type}</span>
            </div>
            <div className="ccc__geo-stats">
              <div>
                <div className="ccc__geo-stat-val">{fmt(e.fresh_targets)}</div>
                <div className="ccc__geo-stat-lbl">Fresh</div>
              </div>
              <div>
                <div className="ccc__geo-stat-val" style={{ color: 'var(--success)' }}>{fmtPct(e.reply_rate)}</div>
                <div className="ccc__geo-stat-lbl">Reply%</div>
              </div>
              <div>
                <div className="ccc__geo-stat-val" style={{ color: e.optout_rate > 5 ? 'var(--danger)' : 'var(--text-1)' }}>{fmtPct(e.optout_rate)}</div>
                <div className="ccc__geo-stat-lbl">Opt-Out</div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--text-2)' }}>{fmt(e.sent)} sent · {fmt(e.delivered)} dlv</div>
              <span className={cls('ccc__perf-badge', `is-${e.performance}`)}>{e.performance}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Templates Tab ─────────────────────────────────────────────────────────────

const TemplatesTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [templates, setTemplates] = useState<CampaignTemplateStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetchCampaignTemplates(campaign.id).then((data) => {
      if (active) setTemplates(data)
      setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  if (loading) return <div className="ccc__shimmer" style={{ height: 100 }} />
  if (templates.length === 0) return <div className="ccc__empty"><div className="ccc__empty-title">No template data</div></div>

  return (
    <div>
      <div className="ccc__section-title">Template Performance</div>
      <table className="ccc__tmpl-table">
        <thead>
          <tr>
            <th>Template Name</th>
            <th>Lang</th>
            <th>Uses</th>
            <th>Dlv%</th>
            <th>Reply%</th>
            <th>Opt-Out%</th>
            <th>Last Used</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.template_id}>
              <td className="ccc__tmpl-name">{t.template_name}</td>
              <td><span className="ccc__lang-badge">{t.language.toUpperCase()}</span></td>
              <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{t.use_count}</td>
              <td><RateCell value={t.delivery_rate} /></td>
              <td><RateCell value={t.reply_rate} good={12} warn={7} /></td>
              <td><RateCell value={t.opt_out_rate} isOptOut /></td>
              <td style={{ color: 'var(--text-2)', fontSize: 10 }}>{t.last_used_at ? fmtDate(t.last_used_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────

const LogsTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [logs, setLogs] = useState<CampaignLogEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetchCampaignLogs(campaign.id).then((data) => {
      if (active) setLogs(data)
      setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  if (loading) return <div className="ccc__shimmer" style={{ height: 100 }} />
  if (logs.length === 0) return <div className="ccc__empty"><div className="ccc__empty-title">No log events</div></div>

  return (
    <div>
      <div className="ccc__section-title">Activity Log</div>
      {logs.map((entry) => (
        <div key={entry.id} className="ccc__log-entry">
          <div className={cls('ccc__log-dot', `is-${entry.severity}`)} />
          <div className="ccc__log-ts">{fmtTime(entry.created_at)}</div>
          <div>
            <div className="ccc__log-event">{entry.title}</div>
            <div className="ccc__log-detail">{entry.description}</div>
          </div>
          <span className={cls('ccc__log-severity', `is-${entry.severity}`)}>{entry.severity}</span>
        </div>
      ))}
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

export const primaryAction = (campaign: CampaignSummary): { label: string; variant: string; action: string } => {
  if (campaign.status === 'active') return { label: 'Pause', variant: 'is-danger', action: 'pause' }
  if (campaign.status === 'paused') return { label: 'Resume', variant: 'is-primary', action: 'resume' }
  if (campaign.status === 'draft' && campaign.total_targets === 0) return { label: 'Build Targets', variant: 'is-blue', action: 'targets' }
  if (campaign.status === 'draft') return { label: 'Start Campaign', variant: 'is-primary', action: 'start' }
  if (campaign.status === 'scheduled') return { label: 'Cancel Schedule', variant: 'is-danger', action: 'cancel' }
  return { label: 'Activate', variant: 'is-primary', action: 'start' }
}

export const DetailPanel = ({
  campaign,
  commandState,
  onClose,
  onAction,
}: {
  campaign: CampaignSummary | null
  commandState: CampaignCommandState
  onClose: () => void
  onAction: (action: string, campaign: CampaignSummary) => void
}) => {
  const [activeTab, setActiveTab] = useState<CampaignDetailTab>('overview')

  useEffect(() => { setActiveTab('overview') }, [campaign?.id])

  const TABS: Array<{ id: CampaignDetailTab; label: string }> = [
    { id: 'overview',   label: 'Overview' },
    { id: 'targets',    label: 'Targets' },
    { id: 'queue',      label: 'Queue' },
    { id: 'replies',    label: 'Replies' },
    { id: 'failures',   label: 'Failures' },
    { id: 'geography',  label: 'Geography' },
    { id: 'templates',  label: 'Templates' },
    { id: 'logs',       label: 'Logs' },
  ]

  if (!campaign) {
    return (
      <div className="ccc__detail-panel">
        <div className="ccc__detail-empty">
          <div className="ccc__detail-empty-icon"><Icon name="send" size={36} /></div>
          <div className="ccc__detail-empty-title">Select a Campaign</div>
          <div className="ccc__detail-empty-sub">Click any campaign row to view details, targets, queue, and performance</div>
        </div>
      </div>
    )
  }

  const pAction = primaryAction(campaign)

  // Compute Queue Batch button logic
  const health = computeHealth(campaign)
  const canQueueBatch = campaign.ready_targets > 0 && health.level !== 'dangerous'

  const scopeLabel = (() => {
    switch (commandState.displayScope) {
      case 'property': return 'Property Scope'
      case 'target': return 'Target Scope'
      case 'thread': return 'Thread Scope'
      case 'queue_row': return 'Queue Scope'
      default: return 'Campaign Scope'
    }
  })()

  return (
    <div className="ccc__detail-panel">
      {/* Context Breadcrumb */}
      {commandState.displayScope !== 'campaign' && (
        <div style={{ padding: '8px 16px 0', fontSize: 11, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Campaign Command</span>
          <Icon name="chevron-right" size={10} />
          <span>{campaign.campaign_name}</span>
          <Icon name="chevron-right" size={10} />
          <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>{scopeLabel}</span>
        </div>
      )}

      <div className="ccc__detail-header">
        <div className="ccc__detail-title-row">
          <div className="ccc__detail-campaign-name">
            {campaign.campaign_name}
            <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 6px', background: 'var(--surface-3)', borderRadius: 4, color: 'var(--text-2)' }}>
              {scopeLabel}
            </span>
          </div>
          <button className="ccc__drawer-close" onClick={onClose} title="Close">
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="ccc__detail-meta-row">
          <StatusBadge status={campaign.status} />
          <span>·</span>
          <span>{campaign.total_targets.toLocaleString()} targets</span>
          <span>·</span>
          <span style={{ color: 'var(--success)', fontVariantNumeric: 'tabular-nums' }}>
            {campaign.positive_reply_count} leads
          </span>
          {campaign.auto_send_enabled && (
            <><span>·</span><span style={{ color: 'var(--accent)' }}>Auto-Send ON</span></>
          )}
          <span style={{ marginLeft: 'auto', color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
            Next: {fmtRelative(campaign.next_send_at)}
          </span>
        </div>
        <div className="ccc__detail-actions">
          <button className={cls('ccc-btn', pAction.variant)} onClick={() => onAction(pAction.action, campaign)}>
            <Icon name={pAction.action === 'pause' ? 'pause' : 'play'} size={11} />
            {pAction.label}
          </button>
          
          <button 
            className="ccc-btn is-blue" 
            onClick={() => {
              if (canQueueBatch) onAction('queue-batch', campaign)
            }}
            disabled={!canQueueBatch}
            title={!canQueueBatch ? 'Cannot queue batch: Check health issues or ready targets' : ''}
          >
            <Icon name="zap" size={11} />
            Queue Batch ({fmt(campaign.ready_targets)})
          </button>
          
          <button className="ccc-btn" onClick={() => onAction('schedule', campaign)}>
            <Icon name="calendar" size={11} />
            Schedule
          </button>
          <button className="ccc-btn" onClick={() => onAction('refresh', campaign)}>
            <Icon name="refresh-cw" size={11} />
            Refresh
          </button>
        </div>
        <CampaignDetailOpsStrip campaign={campaign} scopeLabel={scopeLabel} />
      </div>

      <div className="ccc__detail-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={cls('ccc__detail-tab', activeTab === tab.id && 'is-active')}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="ccc__detail-body">
        {activeTab === 'overview'  && <OverviewTab campaign={campaign} />}
        {activeTab === 'targets'   && <TargetsTab campaignId={campaign.id} />}
        {activeTab === 'queue'     && <QueueTab campaign={campaign} />}
        {activeTab === 'replies'   && <RepliesTab campaign={campaign} />}
        {activeTab === 'failures'  && <FailuresTab campaign={campaign} />}
        {activeTab === 'geography' && <GeographyTab campaign={campaign} />}
        {activeTab === 'templates' && <TemplatesTab campaign={campaign} />}
        {activeTab === 'logs'      && <LogsTab campaign={campaign} />}
      </div>
    </div>
  )
}

// ── Campaign List Panel ────────────────────────────────────────────────────────

export const CampaignListPanel = ({
  campaigns,
  loading,
  selectedId,
  onSelect,
  onCampaignAction,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
}: {
  campaigns: CampaignSummary[]
  loading: boolean
  selectedId: string | null
  onSelect: (c: CampaignSummary | null) => void
  onCampaignAction: (action: string, campaign: CampaignSummary) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  statusFilter: CampaignStatus | 'all'
  setStatusFilter: (s: CampaignStatus | 'all') => void
}) => {
  const statusFilters: Array<{ key: CampaignStatus | 'all'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Live' },
    { key: 'paused', label: 'Paused' },
    { key: 'scheduled', label: 'Sched' },
    { key: 'draft', label: 'Draft' },
  ]

  return (
    <div className="ccc__list-panel">
      <div className="ccc__list-toolbar">
        <div className="ccc__list-search">
          <Icon name="search" size={11} />
          <input
            placeholder="Search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '5px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {statusFilters.map((f) => (
          <button key={f.key} className={cls('ccc__chip', statusFilter === f.key && 'is-active')} onClick={() => setStatusFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      <div style={{ padding: '5px 12px', fontSize: 9, color: 'var(--text-2)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)', background: 'rgba(8,11,18,0.4)' }}>
        {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
      </div>
      <div className="ccc__list-scroll">
        {loading ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 56, width: '100%' }} />)}
          </div>
        ) : campaigns.length === 0 ? (
          <div className="ccc__empty" style={{ padding: 24 }}>
            <div className="ccc__empty-title">No campaigns</div>
            <div className="ccc__empty-sub">Try adjusting filters</div>
          </div>
        ) : (
          campaigns.map((c) => {
            const pAction = primaryAction(c)
            const isSelected = c.id === selectedId
            return (
              <div
                key={c.id}
                className={cls('ccc__list-row', isSelected && 'is-selected')}
                onClick={() => onSelect(isSelected ? null : c)}
              >
                <div className={cls('ccc__list-dot', `is-${c.status}`)} />
                <div style={{ minWidth: 0 }}>
                  <div className="ccc__list-name">{c.campaign_name}</div>
                  <div className="ccc__list-meta">
                    <span className={cls('ccc__list-metric', c.delivery_rate >= 90 ? 'is-good' : c.delivery_rate >= 75 ? 'is-warn' : 'is-bad')}>
                      {fmtPct(c.delivery_rate)} dlv
                    </span>
                    <span>·</span>
                    <span className={cls('ccc__list-metric', c.reply_rate >= 12 ? 'is-good' : 'is-warn')}>
                      {fmtPct(c.reply_rate)} reply
                    </span>
                    <span>·</span>
                    <span className="ccc__list-metric is-good">{c.positive_reply_count} leads</span>
                  </div>
                  <div className="ccc__list-meta" style={{ marginTop: 1 }}>
                    <span>{fmt(c.total_targets)} targets</span>
                    <span>·</span>
                    <span className="ccc__list-metric is-blue">{fmt(c.ready_targets)} ready</span>
                    {c.last_send_at && (
                      <><span>·</span><span style={{ color: 'var(--text-2)' }}>{fmtRelative(c.last_send_at)}</span></>
                    )}
                  </div>
                </div>
                <div className="ccc__list-action" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={cls('ccc__list-action-btn', pAction.variant)}
                    onClick={() => onCampaignAction(pAction.action, c)}
                  >
                    {pAction.label}
                  </button>
                  {c.next_send_at && (
                    <div className="ccc__list-lastsend">{fmtRelative(c.next_send_at)}</div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export const CampaignsPage = () => {
  const [model, setModel] = useState<CampaignModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  
  const [commandState, setCommandState] = useState<CampaignCommandState>({
    activeCampaignId: null,
    activeCampaignContext: null,
    displayScope: 'campaign'
  })
  
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | 'all'>('all')
  const [sortKey] = useState<keyof CampaignSummary>('status')
  const [sortDir] = useState<'asc' | 'desc'>('asc')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await loadCampaigns()
      setModel(data)
    } catch (err) {
      console.error('[CampaignsPage] load failed', err)
      emitNotification({ title: 'Campaign load failed', detail: 'Could not fetch campaign data.', severity: 'critical' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const campaigns = useMemo(() => {
    if (!model) return []
    let list = [...model.campaigns]

    if (statusFilter !== 'all') list = list.filter((c) => c.status === statusFilter)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter((c) => c.campaign_name.toLowerCase().includes(q))
    }

    list.sort((a, b) => {
      let av: number | string | boolean = typeof a[sortKey] === 'object' ? '' : a[sortKey] ?? ''
      let bv: number | string | boolean = typeof b[sortKey] === 'object' ? '' : b[sortKey] ?? ''
      if (sortKey === 'status') { av = statusOrder[a.status] ?? 99; bv = statusOrder[b.status] ?? 99 }
      if (typeof av === 'boolean') av = av ? 1 : 0
      if (typeof bv === 'boolean') bv = bv ? 1 : 0
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [model, statusFilter, searchQuery, sortKey, sortDir])

  const selectedCampaign = useMemo(() => {
    return campaigns.find((c) => c.id === commandState.activeCampaignId) || null
  }, [campaigns, commandState.activeCampaignId])

  const handleCampaignAction = useCallback(
    async (action: string, campaign: CampaignSummary) => {
      if (action === 'queue-batch') {
        const h = computeHealth(campaign)
        if (h.level === 'dangerous') {
          emitNotification({ title: 'Cannot Queue Batch', detail: 'Campaign health is critical', severity: 'critical' })
          return
        }
        await queueBatch(campaign.id, {
          limit: campaign.ready_targets,
          dry_run: false,
          respect_send_window: true,
          interval_seconds: campaign.send_interval_seconds || 15
        })
      }
      
      const messages: Record<string, string> = {
        pause:        `"${campaign.campaign_name}" paused.`,
        resume:       `"${campaign.campaign_name}" resumed.`,
        start:        `"${campaign.campaign_name}" started.`,
        cancel:       `Schedule cancelled for "${campaign.campaign_name}".`,
        'queue-batch': `Batch queued for "${campaign.campaign_name}".`,
        targets:      `Build Targets wizard opening…`,
        schedule:     `Schedule opened for "${campaign.campaign_name}".`,
        refresh:      `Metrics refreshed.`,
      }
      emitNotification({
        title: messages[action] ?? action,
        severity: action === 'pause' || action === 'cancel' ? 'warning' : 'success',
      })
      if (action === 'refresh') load()
    },
    [load],
  )

  const handleGlobalAction = (action: string) => {
    if (action === 'create') {
      setIsCreateModalOpen(true)
      return
    }

    const msgs: Record<string, string> = {
      targets:  'Build Targets wizard coming soon.',
      schedule: 'Schedule Targets dialog coming soon.',
      autosend: 'Auto Send control coming soon.',
      refresh:  'Refreshing campaign metrics…',
    }
    emitNotification({ title: msgs[action] ?? action, severity: 'info' })
    if (action === 'refresh') load()
  }

  const handleSelectCampaign = (c: CampaignSummary | null) => {
    setCommandState((prev) => ({
      ...prev,
      activeCampaignId: c?.id ?? null,
      activeCampaignContext: null, // Clear context on sidebar click
      displayScope: 'campaign'
    }))
  }

  return (
    <div className="ccc">
      {/* Header */}
      <div className="ccc__header">
        <div className="ccc__brand">
          <div className="ccc__brand-icon"><Icon name="send" size={14} /></div>
          <div>
            <div className="ccc__title">Campaign Command Center</div>
            <div className="ccc__subtitle">SMS campaign intelligence &amp; outreach management</div>
          </div>
        </div>
        <div className="ccc__actions">
          <button className="ccc-btn is-primary" onClick={() => handleGlobalAction('create')}>
            <Icon name="bolt" size={11} />
            Create Campaign
          </button>
          <button className="ccc-btn is-blue" onClick={() => handleGlobalAction('targets')}>
            <Icon name="users" size={11} />
            Build Targets
          </button>
          <button className="ccc-btn" onClick={() => handleGlobalAction('schedule')}>
            <Icon name="calendar" size={11} />
            Schedule Targets
          </button>
          {selectedCampaign?.status === 'active' && (
            <button className="ccc-btn is-danger" onClick={() => handleCampaignAction('pause', selectedCampaign)}>
              <Icon name="pause" size={11} />
              Pause Campaign
            </button>
          )}
          <button className="ccc-btn" onClick={() => handleGlobalAction('refresh')}>
            <Icon name="refresh-cw" size={11} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      {loading && !model ? (
        <div className="ccc__kpi-strip">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="ccc__kpi-card">
              <div className="ccc__shimmer" style={{ height: 9, width: 80, marginBottom: 6 }} />
              <div className="ccc__shimmer" style={{ height: 20, width: 50 }} />
            </div>
          ))}
        </div>
      ) : model ? (
        <KpiStrip kpis={model.kpis} />
      ) : null}

      {/* Body: 3 columns */}
      <div className="ccc__body">
        <CampaignListPanel
          campaigns={campaigns}
          loading={loading}
          selectedId={commandState.activeCampaignId}
          onSelect={handleSelectCampaign}
          onCampaignAction={handleCampaignAction}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
        />

        <DetailPanel
          campaign={selectedCampaign}
          commandState={commandState}
          onClose={() => handleSelectCampaign(null)}
          onAction={handleCampaignAction}
        />

        <CampaignHealthSidebar campaign={selectedCampaign} />
      </div>

      {isCreateModalOpen && (
        <CreateCampaignModal 
          onClose={() => setIsCreateModalOpen(false)}
          onSuccess={(newId) => {
            setIsCreateModalOpen(false)
            load().then(() => {
              setCommandState(p => ({ ...p, activeCampaignId: newId }))
            })
          }}
        />
      )}
    </div>
  )
}
