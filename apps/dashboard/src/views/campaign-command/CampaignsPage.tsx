import { useState, useEffect, useCallback, useMemo } from 'react'
import { Icon } from '../../shared/icons'
import { emitNotification } from '../../shared/NotificationToast'
import {
  loadCampaigns,
  fetchCampaignTargetsPageData,
  fetchCampaignDetail,
  fetchCampaignQueue,
  fetchCampaignReplies,
  fetchCampaignFailures,
  fetchCampaignGeography,
  fetchCampaignTemplates,
  fetchCampaignLogs,
  buildSuppressionChecklist,
  updateCampaignDraft,
} from './campaigns.adapter'
import { executeCampaignAction } from './campaign-actions'
import {
  computeCampaignHealth,
  computeCampaignReadiness,
  getDetailActions,
  getPrimaryAction,
  matchesListFilter,
  type CampaignListFilter,
} from './campaign-health'
import { isTestModeCampaign, operatorStateLabel } from './campaign-operator'
import { CampaignActivationModal } from './components/CampaignActivationModal'
import { computeCampaignCostMetrics, formatCostUsd } from './campaign-cost'
import { CreateCampaignModal } from './CreateCampaignModal'
import { CampaignScheduleModal } from './CampaignScheduleModal'
import { CampaignContextMenu, CampaignOverflowButton } from './CampaignContextMenu'
import { CampaignControlCenter } from './CampaignControlCenter'
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
import './campaign-command.css'

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
  activating: 1,
  live_limited: 2,
  queued: 3,
  scheduled: 4,
  built: 5,
  previewed: 6,
  ready: 7,
  paused: 8,
  failed: 9,
  draft: 10,
  completed: 11,
  archived: 12,
}

// ── Primitive components ──────────────────────────────────────────────────────

const StatusBadge = ({
  status,
  executionProof,
}: {
  status: CampaignStatus
  executionProof?: CampaignSummary['execution_proof']
}) => {
  const labels: Record<CampaignStatus, string> = {
    active: 'Active', ready: 'Ready', built: 'Targets Built', queued: 'Queued',
    live_limited: 'Live Limited', paused: 'Paused', scheduled: 'Scheduled',
    draft: 'Draft', previewed: 'Previewed', activating: 'Activating', failed: 'Failed',
    completed: 'Completed', archived: 'Archived',
  }
  const operatorLabel = executionProof?.proof_mode ? 'Test' : null
  const label = operatorLabel
    ?? (executionProof?.proof_mode
      ? operatorStateLabel({ status, execution_proof: executionProof } as CampaignSummary)
      : (labels[status] ?? status))
  return (
    <span className={cls('ccc-status', `is-${status}`, executionProof?.proof_mode && 'is-proof')}>
      <span className="ccc-status__dot" />
      {label}
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
    { label: 'Scheduled Queue Rows', value: fmt(kpis.scheduledQueueRows), variant: 'is-blue' },
    { label: 'Planned Targets',  value: fmt(kpis.plannedTargets),  variant: '' },
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

export type HealthLevel = 'healthy' | 'caution' | 'dangerous' | 'not_started' | 'awaiting'

export const computeHealth = computeCampaignHealth

export const CampaignIntelligenceRail = ({ campaign }: { campaign: CampaignSummary | null }) => {
  if (!campaign) {
    return (
      <div className="ccc__intel-rail">
        <div className="ccc__intel-header">
          <div className="ccc__intel-title">Campaign Intelligence</div>
        </div>
        <div style={{ padding: 16, color: 'var(--text-2)', fontSize: 11, textAlign: 'center', marginTop: 24 }}>
          Select a campaign for launch readiness and health
        </div>
      </div>
    )
  }

  const { level, score, issues, label: levelLabel, sampleSufficient } = computeHealth(campaign)
  const readiness = computeCampaignReadiness(campaign)
  const isPreLaunch = campaign.sent_count === 0

  const failRate = campaign.sent_count > 0
    ? (campaign.failed_count / campaign.sent_count) * 100
    : 0

  const rateVariant = (value: number, good: number, warn: number, invert = false) => {
    if (!sampleSufficient) return ''
    const ok = invert ? value <= good : value >= good
    const mid = invert ? value <= warn : value >= warn
    return ok ? 'is-good' : mid ? 'is-warn' : 'is-bad'
  }

  const metrics = [
    {
      label: 'Delivery',
      value: sampleSufficient ? fmtPct(campaign.delivery_rate) : levelLabel,
      variant: rateVariant(campaign.delivery_rate, 90, 75),
    },
    {
      label: 'Reply Rate',
      value: sampleSufficient ? fmtPct(campaign.reply_rate) : '—',
      variant: rateVariant(campaign.reply_rate, 12, 7),
    },
    {
      label: 'Opt-Out',
      value: sampleSufficient ? fmtPct(campaign.opt_out_rate) : '—',
      variant: rateVariant(campaign.opt_out_rate, 3, 6, true),
    },
    {
      label: 'Fail Rate',
      value: sampleSufficient ? fmtPct(failRate) : '—',
      variant: rateVariant(failRate, 3, 8, true),
    },
    { label: 'Positive', value: fmt(campaign.positive_reply_count), variant: campaign.positive_reply_count > 0 ? 'is-good' : '' },
    { label: 'Ready', value: fmt(campaign.ready_targets), variant: campaign.ready_targets > 0 ? '' : 'is-warn' },
    { label: 'Readiness', value: readiness.label, variant: readiness.level === 'ready' ? 'is-good' : readiness.level === 'warnings' ? 'is-warn' : 'is-bad' },
    { label: 'Next Send', value: fmtRelative(campaign.next_send_at), variant: '' },
  ]

  return (
    <div className="ccc__intel-rail">
      <div className="ccc__intel-header">
        <div className="ccc__intel-title">Campaign Intelligence</div>
        {!isPreLaunch && (
          <div className="ccc__hs-score-block" style={{ marginTop: 10 }}>
            <div className={cls('ccc__hs-score-ring', `is-${level}`)}>{score ?? '—'}</div>
            <div className={cls('ccc__hs-score-label', `is-${level}`)}>{levelLabel}</div>
          </div>
        )}
      </div>

      <div className="ccc__intel-body">
        {isPreLaunch ? (
          <>
            <div className={cls('ccc__intel-card', `is-${readiness.level === 'ready' ? 'ready' : readiness.level === 'warnings' ? 'warn' : 'blocked'}`)}>
              <div className="ccc__intel-card-label">Launch Readiness</div>
              <div className="ccc__intel-card-value">{readiness.label}</div>
            </div>
            <div className="ccc__intel-card">
              <div className="ccc__intel-card-label">Target Snapshot</div>
              <div className="ccc__intel-metric-row"><span>Total</span><strong>{fmt(campaign.total_targets)}</strong></div>
              <div className="ccc__intel-metric-row"><span>Ready</span><strong>{fmt(campaign.ready_targets)}</strong></div>
              <div className="ccc__intel-metric-row"><span>Planned targets</span><strong>{fmt(campaign.planned_targets ?? 0)}</strong></div>
              <div className="ccc__intel-metric-row"><span>Scheduled queue rows</span><strong>{fmt(campaign.scheduled_queue_rows ?? campaign.scheduled_targets)}</strong></div>
            </div>
            <div className="ccc__intel-card">
              <div className="ccc__intel-card-label">Schedule</div>
              <div className="ccc__intel-card-value">{campaign.next_send_at ? fmtRelative(campaign.next_send_at) : 'Not scheduled'}</div>
            </div>
            {readiness.blockers.map((b) => (
              <div key={b} className="ccc__intel-issue"><span>⛔</span>{b}</div>
            ))}
            {readiness.warnings.map((w) => (
              <div key={w} className="ccc__intel-issue"><span>⚠</span>{w}</div>
            ))}
          </>
        ) : (
          <>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 4 }}>Metrics</div>
            {metrics.map((m) => (
              <div key={m.label} className="ccc__hs-metric">
                <span className="ccc__hs-metric-label">{m.label}</span>
                <span className={cls('ccc__hs-metric-value', m.variant)}>{m.value}</span>
              </div>
            ))}
            {issues.map((issue, i) => (
              <div key={i} className="ccc__intel-issue">{issue}</div>
            ))}
          </>
        )}
      </div>
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
  const cost = computeCampaignCostMetrics(campaign)
  const health = computeHealth(campaign)
  const readiness = computeCampaignReadiness(campaign)
  const totalReplies = campaign.positive_reply_count + campaign.negative_reply_count
  const sampleSufficient = health.sampleSufficient

  return (
    <div>
      <div className="ccc__section-title">Launch Readiness</div>
      <div className={cls('ccc__readiness-banner', `is-${readiness.level}`)}>
        <strong>{readiness.label}</strong>
        {readiness.blockers.map((b) => <span key={b} className="ccc__readiness-blocker">{b}</span>)}
        {readiness.warnings.map((w) => <span key={w} className="ccc__readiness-warning">{w}</span>)}
      </div>

      <div className="ccc__section-title">Cost &amp; Spend</div>
      <div className="ccc__cost-grid">
        <div className="ccc__cost-card">
          <div className="ccc__cost-label">Actual Spend</div>
          <div className="ccc__cost-value">{formatCostUsd(cost.totalSpend)}</div>
          <div className="ccc__cost-sub">
            {cost.available
              ? `${campaign.sent_count.toLocaleString()} sends · est. rate`
              : 'Cost unavailable — no configured rate'}
          </div>
        </div>
        <div className="ccc__cost-card">
          <div className="ccc__cost-label">Cost / Reply</div>
          <div className="ccc__cost-value">{formatCostUsd(cost.costPerReply)}</div>
          <div className="ccc__cost-sub">{totalReplies} total replies</div>
        </div>
        <div className="ccc__cost-card is-accent">
          <div className="ccc__cost-label">Cost / Lead</div>
          <div className="ccc__cost-value">{formatCostUsd(cost.costPerLead)}</div>
          <div className="ccc__cost-sub">{campaign.positive_reply_count} positive</div>
        </div>
      </div>

      <div className="ccc__section-title">Target Funnel</div>
      {[
        { label: 'Total', value: campaign.total_targets, pct: 100, color: '' },
        { label: 'Ready', value: campaign.ready_targets, pct: campaign.total_targets > 0 ? (campaign.ready_targets / campaign.total_targets) * 100 : 0, color: 'is-blue' },
        { label: 'Planned targets', value: campaign.planned_targets ?? 0, pct: campaign.total_targets > 0 ? ((campaign.planned_targets ?? 0) / campaign.total_targets) * 100 : 0, color: '' },
        { label: 'Scheduled queue rows', value: campaign.scheduled_queue_rows ?? campaign.scheduled_targets, pct: campaign.total_targets > 0 ? ((campaign.scheduled_queue_rows ?? campaign.scheduled_targets) / campaign.total_targets) * 100 : 0, color: '' },
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
      {sampleSufficient ? (
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
      ) : (
        <div className="ccc__empty" style={{ padding: '12px 0' }}>
          <div className="ccc__empty-sub">{health.label} — performance rates require sufficient send sample</div>
        </div>
      )}

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
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [totalCount, setTotalCount] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignTargetsPageData(campaignId, {
      page,
      page_size: pageSize,
      status: filter === 'all' ? undefined : filter,
      search: search.trim() || undefined,
    }).then((data) => {
      if (!active) return
      setTargets(data.targets)
      setTotalCount(data.total_count)
      setTotalPages(data.total_pages)
    }).catch(() => {
      if (active) {
        setTargets([])
        setTotalCount(0)
        setTotalPages(0)
      }
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [campaignId, filter, page, pageSize, search])

  const statusOptions = ['all', 'ready', 'planned', 'queued', 'scheduled', 'sent', 'delivered', 'failed', 'blocked', 'opted_out']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search"
          className="ccc__chip"
          placeholder="Search owner, property, phone…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          style={{ minWidth: 200, padding: '4px 8px' }}
        />
        {statusOptions.map((s) => (
          <button
            key={s}
            className={cls('ccc__chip', filter === s && 'is-active')}
            onClick={() => { setFilter(s); setPage(1) }}
          >
            {s === 'all' ? 'All' : s.replace(/_/g, ' ')}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-2)', alignSelf: 'center' }}>
          Page {page} of {Math.max(totalPages, 1)} · {totalCount.toLocaleString()} recipients
        </span>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[1, 2, 3, 4].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 36, width: '100%' }} />)}
        </div>
      ) : targets.length === 0 ? (
        <div className="ccc__empty"><div className="ccc__empty-title">No targets match this filter.</div><div className="ccc__empty-sub">Build targets or adjust filters.</div></div>
      ) : (
        <>
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
                {targets.map((t) => (
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
                      {t.template_name ?? (t.template_id ? t.template_id : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <button type="button" className="ccc-btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-2)' }}>
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount.toLocaleString()}
            </span>
            <button type="button" className="ccc-btn" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
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

const FailureSection = ({
  title,
  groups,
  total,
  emptyTitle,
  emptySub,
}: {
  title: string
  groups: CampaignFailureGroup[]
  total: number
  emptyTitle: string
  emptySub: string
}) => (
  <div style={{ marginBottom: 20 }}>
    <div className="ccc__section-title">{title} — {total}</div>
    {groups.length === 0 ? (
      <div className="ccc__empty" style={{ padding: '16px 0' }}>
        <div className="ccc__empty-title">{emptyTitle}</div>
        <div className="ccc__empty-sub">{emptySub}</div>
      </div>
    ) : (
      groups.map((g) => (
        <div key={`${title}-${g.failure_category}`} className={cls('ccc__failure-card', `is-${g.severity}`)}>
          <div className="ccc__failure-header">
            <div className="ccc__failure-reason">{g.failure_category}</div>
            <div className={cls('ccc__failure-count', `is-${g.severity}`)}>{g.count}</div>
            <span className={cls('ccc__severity-badge', `is-${g.severity}`)}>{g.severity}</span>
          </div>
          {g.sample_reasons[0] && <div className="ccc__failure-example">"{g.sample_reasons[0]}"</div>}
          <div className="ccc__failure-numbers">
            {g.sample_numbers.slice(0, 6).map((n) => (
              <span key={n} className="ccc__failure-number">{n}</span>
            ))}
          </div>
        </div>
      ))
    )}
  </div>
)

const FailuresTab = ({ campaign }: { campaign: CampaignSummary }) => {
  const [result, setResult] = useState<Awaited<ReturnType<typeof fetchCampaignFailures>> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignFailures(campaign.id).then((data) => {
      if (active) setResult(data)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [campaign.id])

  if (loading) return <div className="ccc__shimmer" style={{ height: 100 }} />

  const targetTotal = result?.targetTotal ?? campaign.failed_target_rows ?? 0
  const executionTotal = result?.executionTotal ?? campaign.failed_execution_rows ?? 0

  return (
    <div>
      <FailureSection
        title="Target Preparation Failures"
        groups={result?.targetPreparation ?? []}
        total={targetTotal}
        emptyTitle="No target preparation failures"
        emptySub="Eligible targets blocked during build or routing show here."
      />
      <FailureSection
        title="Execution Failures"
        groups={result?.execution ?? []}
        total={executionTotal}
        emptyTitle="No failed execution rows for the selected run"
        emptySub="Provider and queue terminal failures for the current run appear here."
      />
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
      <div className="ccc__section-title">
        {campaign.sent_count > 0 ? 'Template Performance' : 'Template Assignment'}
      </div>
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



export const DetailPanel = ({
  campaign,
  commandState,
  onClose,
  onAction,
  initialTab,
}: {
  campaign: CampaignSummary | null
  commandState: CampaignCommandState
  onClose: () => void
  onAction: (action: string, campaign: CampaignSummary) => void
  initialTab?: CampaignDetailTab
}) => {
  const [activeTab, setActiveTab] = useState<CampaignDetailTab>(initialTab ?? 'overview')

  useEffect(() => { setActiveTab(initialTab ?? 'overview') }, [campaign?.id, initialTab])

  const TABS: Array<{ id: CampaignDetailTab; label: string }> = [
    { id: 'overview',   label: 'Overview' },
    { id: 'execution',  label: 'Execution' },
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
      <div className="ccc__detail-panel ccc-glass-workspace">
        <div className="ccc__detail-empty">
          <div className="ccc__detail-empty-icon"><Icon name="send" size={36} /></div>
          <div className="ccc__detail-empty-title">Select a Campaign</div>
          <div className="ccc__detail-empty-sub">Click any campaign row to view details, targets, queue, and performance</div>
        </div>
      </div>
    )
  }

  const detailActions = getDetailActions(campaign)

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
    <div className="ccc__detail-panel ccc-glass-workspace">
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
        {isTestModeCampaign(campaign) && (
          <div className="ccc__test-mode-banner">
            <span>TEST MODE — NO MESSAGES WILL TRANSMIT</span>
            <button
              type="button"
              className="ccc-btn is-primary"
              style={{ marginLeft: 'auto' }}
              onClick={() => onAction('convert_to_live', campaign)}
            >
              Convert to Live Campaign
            </button>
          </div>
        )}
        <div className="ccc__detail-meta-row">
          <StatusBadge status={campaign.status} executionProof={campaign.execution_proof} />
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
          {detailActions.map((act) => (
            <button
              key={act.id}
              className={cls('ccc-btn', act.variant)}
              onClick={() => onAction(act.id, campaign)}
            >
              <Icon
                name={
                  act.id === 'pause' ? 'pause'
                    : act.id === 'queue_batch' ? 'zap'
                      : act.id === 'schedule' || act.id === 'reschedule' ? 'calendar'
                        : act.id === 'build_targets' ? 'users'
                          : 'play'
                }
                size={11}
              />
              {act.id === 'queue_batch' ? `Queue Batch (${fmt(campaign.ready_targets)})` : act.label}
            </button>
          ))}
          <button className="ccc-btn is-blue" onClick={() => onAction('sync_metrics', campaign)}>
            <Icon name="activity" size={11} />
            Sync Metrics
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
        {activeTab === 'execution' && (
          <CampaignControlCenter
            campaignId={campaign.id}
            campaign={campaign}
            onLifecycleChange={() => onAction('refresh', campaign)}
          />
        )}
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
  allCampaigns,
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
  allCampaigns: CampaignSummary[]
  loading: boolean
  selectedId: string | null
  onSelect: (c: CampaignSummary | null) => void
  onCampaignAction: (action: string, campaign: CampaignSummary) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  statusFilter: CampaignListFilter
  setStatusFilter: (s: CampaignListFilter) => void
}) => {
  const [contextMenu, setContextMenu] = useState<{ campaign: CampaignSummary; x: number; y: number } | null>(null)

  const statusFilters: Array<{ key: CampaignListFilter; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Draft' },
    { key: 'ready', label: 'Ready' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'live', label: 'Live' },
    { key: 'paused', label: 'Paused' },
    { key: 'completed', label: 'Done' },
    { key: 'archived', label: 'Archived' },
    { key: 'needs_attention', label: 'Attention' },
  ]

  const filterCounts = useMemo(() => {
    const count = (key: CampaignListFilter) =>
      key === 'all' ? allCampaigns.length : allCampaigns.filter((c) => matchesListFilter(c, key)).length
    return Object.fromEntries(
      statusFilters.map((f) => [f.key, count(f.key)]),
    ) as Record<CampaignListFilter, number>
  }, [allCampaigns, statusFilters])

  return (
    <div className="ccc__list-panel ccc-glass-rail">
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
      <div className="ccc__filter-bar">
        {statusFilters.map((f) => (
          <button
            key={f.key}
            type="button"
            className={cls('ccc__filter-segment', statusFilter === f.key && 'is-active')}
            onClick={() => setStatusFilter(f.key)}
          >
            {f.label}
            <span className="ccc__filter-count">{filterCounts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div style={{ padding: '5px 12px', fontSize: 9, color: 'var(--text-2)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
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
            const pAction = getPrimaryAction(c)
            const isSelected = c.id === selectedId
            const health = computeHealth(c)
            return (
              <div
                key={c.id}
                className={cls('ccc__list-row', isSelected && 'is-selected')}
                onClick={() => onSelect(isSelected ? null : c)}
              >
                <div className={cls('ccc__list-dot', `is-${c.status}`)} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ccc__list-name" title={c.campaign_name}>{c.campaign_name}</div>
                  <div className="ccc__list-meta">
                    <StatusBadge status={c.status} executionProof={c.execution_proof} />
                    <span>·</span>
                    <span>{fmt(c.total_targets)} tgt</span>
                    <span>·</span>
                    <span className="ccc__list-metric is-blue">{fmt(c.ready_targets)} ready</span>
                    <span>·</span>
                    <span>{fmt(c.sent_count)} sent</span>
                  </div>
                  <div className="ccc__list-meta" style={{ marginTop: 1 }}>
                    {health.sampleSufficient ? (
                      <>
                        <span className={cls('ccc__list-metric', c.delivery_rate >= 90 ? 'is-good' : 'is-warn')}>
                          {fmtPct(c.delivery_rate)} dlv
                        </span>
                        <span>·</span>
                        <span className="ccc__list-metric is-good">{c.positive_reply_count} +reply</span>
                      </>
                    ) : (
                      <span className="ccc__list-metric">{health.label}</span>
                    )}
                    {c.next_send_at && (
                      <><span>·</span><span style={{ color: 'var(--text-2)' }}>next {fmtRelative(c.next_send_at)}</span></>
                    )}
                  </div>
                </div>
                <div className="ccc__list-action" onClick={(e) => e.stopPropagation()}>
                  <CampaignOverflowButton
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setContextMenu({ campaign: c, x: rect.left, y: rect.bottom + 4 })
                    }}
                  />
                  <button
                    className={cls('ccc__list-action-btn', pAction.variant)}
                    onClick={() => onCampaignAction(pAction.id, c)}
                  >
                    {pAction.label}
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
      {contextMenu && (
        <CampaignContextMenu
          campaign={contextMenu.campaign}
          x={contextMenu.x}
          y={contextMenu.y}
          onAction={onCampaignAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export const CampaignsPage = () => {
  const [model, setModel] = useState<CampaignModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editCampaignId, setEditCampaignId] = useState<string | null>(null)
  const [builderMode, setBuilderMode] = useState<'create' | 'edit' | 'build'>('create')
  const [scheduleCampaign, setScheduleCampaign] = useState<CampaignSummary | null>(null)
  const [scheduleMode, setScheduleMode] = useState<'schedule' | 'reschedule'>('schedule')
  const [activationCampaign, setActivationCampaign] = useState<CampaignSummary | null>(null)
  const [detailTab, setDetailTab] = useState<CampaignDetailTab | undefined>(undefined)
  
  const [commandState, setCommandState] = useState<CampaignCommandState>({
    activeCampaignId: null,
    activeCampaignContext: null,
    displayScope: 'campaign'
  })
  
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<CampaignListFilter>('all')
  const [sortKey] = useState<keyof CampaignSummary>('status')
  const [sortDir] = useState<'asc' | 'desc'>('asc')

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (opts.silent) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await loadCampaigns()
      setModel(data)
      setLastRefreshedAt(new Date())
    } catch (err) {
      console.error('[CampaignsPage] load failed', err)
      emitNotification({ title: 'Campaign load failed', detail: 'Could not fetch campaign data.', severity: 'critical' })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const campaigns = useMemo(() => {
    if (!model) return []
    let list = [...model.campaigns]

    if (statusFilter !== 'all') list = list.filter((c) => matchesListFilter(c, statusFilter))
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

  const [enrichedCampaign, setEnrichedCampaign] = useState<CampaignSummary | null>(null)

  useEffect(() => {
    const id = commandState.activeCampaignId
    if (!id) {
      setEnrichedCampaign(null)
      return
    }
    let active = true
    fetchCampaignDetail(id).then((detail) => {
      if (active) setEnrichedCampaign(detail)
    }).catch(() => {
      if (active) setEnrichedCampaign(null)
    })
    return () => { active = false }
  }, [commandState.activeCampaignId])

  const selectedCampaign = useMemo(() => {
    const base = campaigns.find((c) => c.id === commandState.activeCampaignId) || null
    if (!base) return null
    if (enrichedCampaign?.id === base.id) return { ...base, ...enrichedCampaign }
    return base
  }, [campaigns, commandState.activeCampaignId, enrichedCampaign])

  const actionCallbacks = useMemo(() => ({
    onRefresh: () => load({ silent: true }),
    onOpenBuilder: (campaign: CampaignSummary, mode: 'edit' | 'build' | 'schedule') => {
      setEditCampaignId(campaign.id)
      setBuilderMode(mode === 'build' ? 'build' : 'edit')
      setIsCreateModalOpen(true)
      setCommandState((prev) => ({ ...prev, activeCampaignId: campaign.id }))
    },
    onOpenSchedule: (campaign: CampaignSummary, mode: 'schedule' | 'reschedule') => {
      setScheduleCampaign(campaign)
      setScheduleMode(mode)
    },
    onOpenActivate: (campaign: CampaignSummary) => {
      setActivationCampaign(campaign)
    },
    onSelectTab: (campaignId: string, tab: string) => {
      setCommandState((prev) => ({ ...prev, activeCampaignId: campaignId }))
      setDetailTab(tab as CampaignDetailTab)
    },
  }), [load])

  const handleCampaignAction = useCallback(
    async (action: string, campaign: CampaignSummary) => {
      if (action === 'open') {
        setCommandState((prev) => ({ ...prev, activeCampaignId: campaign.id, displayScope: 'campaign' }))
        return
      }
      if (action === 'rename') {
        const next = window.prompt('Rename campaign', campaign.campaign_name)
        if (!next?.trim()) return
        await updateCampaignDraft(campaign.id, { name: next.trim() })
        await load({ silent: true })
        return
      }
      await executeCampaignAction(action, campaign, actionCallbacks)
    },
    [actionCallbacks, load],
  )

  const handleGlobalAction = (action: string) => {
    if (action === 'create') {
      setEditCampaignId(null)
      setBuilderMode('create')
      setIsCreateModalOpen(true)
      return
    }
    if (action === 'targets') {
      if (selectedCampaign) {
        void handleCampaignAction('build_targets', selectedCampaign)
      } else {
        setEditCampaignId(null)
        setBuilderMode('create')
        setIsCreateModalOpen(true)
      }
      return
    }
    if (action === 'schedule') {
      if (selectedCampaign) void handleCampaignAction('schedule', selectedCampaign)
      else emitNotification({ title: 'Select a campaign to schedule', severity: 'info' })
      return
    }
    if (action === 'refresh') {
      emitNotification({ title: 'Refreshing campaigns', severity: 'info' })
      void load({ silent: true })
    }
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
    <div className="ccc ccc--glass">
      {/* Header */}
      <div className="ccc__header">
        <div className="ccc__brand">
          <div className="ccc__brand-icon"><Icon name="send" size={14} /></div>
          <div>
            <div className="ccc__title">Campaign Command</div>
            <div className="ccc__subtitle">
              {model ? `${model.kpis.activeCampaigns} active · ${model.campaigns.filter((c) => c.status === 'scheduled').length} scheduled · ${model.campaigns.filter((c) => c.status === 'paused').length} paused` : 'Loading…'}
              {lastRefreshedAt && ` · refreshed ${fmtRelative(lastRefreshedAt.toISOString())}`}
            </div>
          </div>
        </div>
        <div className="ccc__actions">
          <button className="ccc-btn is-primary" onClick={() => handleGlobalAction('create')}>
            <Icon name="bolt" size={11} />
            New Campaign
          </button>
          <button className="ccc-btn is-blue" onClick={() => handleGlobalAction('targets')}>
            <Icon name="users" size={11} />
            Build Targets
          </button>
          <button className="ccc-btn" onClick={() => handleGlobalAction('schedule')}>
            <Icon name="calendar" size={11} />
            Schedule
          </button>
          {selectedCampaign?.status === 'active' && (
            <button className="ccc-btn is-danger" onClick={() => handleCampaignAction('pause', selectedCampaign)}>
              <Icon name="pause" size={11} />
              Pause Campaign
            </button>
          )}
          <button className={cls('ccc-btn', refreshing && 'is-refreshing')} onClick={() => handleGlobalAction('refresh')} disabled={refreshing}>
            <Icon name="refresh-cw" size={11} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
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
        <>
          <div className="ccc__portfolio-label">Campaign Portfolio</div>
          <KpiStrip kpis={model.kpis} />
        </>
      ) : null}

      {/* Body: 3 columns */}
      <div className="ccc__body">
        <CampaignListPanel
          campaigns={campaigns}
          allCampaigns={model?.campaigns ?? []}
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
          initialTab={detailTab}
        />

        <CampaignIntelligenceRail campaign={selectedCampaign} />
      </div>

      {isCreateModalOpen && (
        <CreateCampaignModal
          campaignId={editCampaignId ?? undefined}
          mode={builderMode}
          onClose={() => {
            setIsCreateModalOpen(false)
            setEditCampaignId(null)
            setBuilderMode('create')
          }}
          onSuccess={(newId) => {
            setIsCreateModalOpen(false)
            setEditCampaignId(null)
            setBuilderMode('create')
            load().then(() => {
              setCommandState((p) => ({ ...p, activeCampaignId: newId }))
            })
          }}
        />
      )}

      {scheduleCampaign && (
        <CampaignScheduleModal
          campaign={scheduleCampaign}
          mode={scheduleMode}
          onClose={() => setScheduleCampaign(null)}
          onSuccess={() => load({ silent: true })}
        />
      )}

      {activationCampaign && (
        <CampaignActivationModal
          campaign={activationCampaign}
          onClose={() => setActivationCampaign(null)}
          onSuccess={(result) => {
            const isProof = result.proofHydration || result.activationMode === 'test'
            emitNotification({
              title: result.idempotent
                ? (isProof ? 'Test hydration replay' : 'Already activated')
                : (isProof ? 'Test hydration complete' : 'Live activation complete'),
              detail: result.idempotent
                ? 'Idempotent replay — no duplicate queue rows.'
                : isProof
                  ? `${result.inserted} proof rows inserted · no SMS will transmit`
                  : `${result.inserted} live rows inserted · ${result.skipped} skipped · sends wait for brakes + schedule`,
              severity: isProof ? 'warning' : 'success',
            })
            setActivationCampaign(null)
            void load({ silent: true })
          }}
        />
      )}
    </div>
  )
}
