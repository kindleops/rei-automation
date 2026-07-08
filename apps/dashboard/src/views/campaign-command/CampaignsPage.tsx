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
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import { CampaignFilterMenu } from './components/CampaignFilterMenu'
import { CampaignDetailHeader } from './components/CampaignDetailHeader'
import { CampaignDetailTabBar } from './components/CampaignDetailTabBar'
import { CampaignStatusBadge } from './components/CampaignStatusBadge'
import { CampaignMobileActionDock } from './components/CampaignMobileActionDock'
import { CampaignMobileIntelRibbon } from './components/CampaignMobileIntelRibbon'
import { CampaignChipFilterMenu } from './components/CampaignChipFilterMenu'
import { cls, fmt, fmtInterval, fmtPct, fmtRelative } from './campaign-formatters'
import '../../modules/inbox/queue-ops.css'
import './campaigns.css'
import './campaign-command.css'
import './campaign-command-glass.css'
import './campaign-mobile.css'

export { cls, fmt, fmtPct, fmtInterval, fmtRelative }

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

export const KpiStrip = ({
  kpis,
  isMobileLayout = false,
}: {
  kpis: CampaignModel['kpis']
  isMobileLayout?: boolean
}) => {
  const allCards = [
    { label: 'Active', value: kpis.activeCampaigns, variant: 'is-success' },
    { label: 'Total Targets', value: fmt(kpis.totalTargets), variant: '' },
    { label: 'Ready', value: fmt(kpis.readyTargets), variant: 'is-accent' },
    { label: 'Scheduled', value: fmt(kpis.scheduledQueueRows), variant: 'is-blue' },
    { label: 'Planned', value: fmt(kpis.plannedTargets), variant: '' },
    { label: 'Sent Today', value: fmt(kpis.sentToday), variant: '' },
    { label: 'Delivered', value: fmt(kpis.deliveredToday), variant: 'is-success' },
    { label: 'Reply Rate', value: fmtPct(kpis.replyRate), variant: 'is-accent' },
    { label: 'Positive', value: fmt(kpis.positiveReplies), variant: 'is-success' },
    {
      label: 'Opt-Out',
      value: fmtPct(kpis.optOutRate),
      variant: kpis.optOutRate > 6 ? 'is-danger' : kpis.optOutRate > 3 ? 'is-warning' : '',
    },
    {
      label: 'Failures',
      value: fmtPct(kpis.failureRate),
      variant: kpis.failureRate > 8 ? 'is-danger' : kpis.failureRate > 4 ? 'is-warning' : '',
    },
  ]

  const cards = isMobileLayout
    ? allCards.filter((c) => ['Active', 'Ready', 'Sent Today', 'Reply Rate'].includes(c.label))
    : allCards

  return (
    <div className={cls(
      'ccc__kpi-strip',
      'ccc__kpi-strip--glass',
      isMobileLayout && 'ccc__kpi-strip--mobile',
    )}>
      {cards.map((c) => (
        <div key={c.label} className="ccc__kpi-card ccc__kpi-card--glass">
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

const OverviewTab = ({ campaign, isMobileLayout = false }: { campaign: CampaignSummary; isMobileLayout?: boolean }) => {
  const checks = buildSuppressionChecklist(campaign)
  const cost = computeCampaignCostMetrics(campaign)
  const health = computeHealth(campaign)
  const readiness = computeCampaignReadiness(campaign)
  const totalReplies = campaign.positive_reply_count + campaign.negative_reply_count
  const sampleSufficient = health.sampleSufficient

  return (
    <div className={cls('ccc-detail-overview', isMobileLayout && 'ccc-detail-overview--mobile')}>
      {isMobileLayout && <CampaignMobileIntelRibbon campaign={campaign} />}

      <section className={cls('ccc-detail-section', isMobileLayout && 'ccc-detail-section--collapsible')}>
        <div className="ccc-detail-section__head">
          <h3>Launch readiness</h3>
          <span className={cls('ccc-detail-section__badge', `is-${readiness.level}`)}>{readiness.label}</span>
        </div>
        <div className={cls('ccc__readiness-banner', 'ccc-detail-readiness', `is-${readiness.level}`)}>
          {readiness.blockers.map((b) => <span key={b} className="ccc__readiness-blocker">{b}</span>)}
          {readiness.warnings.map((w) => <span key={w} className="ccc__readiness-warning">{w}</span>)}
          {readiness.blockers.length === 0 && readiness.warnings.length === 0 && (
            <span className="ccc-detail-readiness__ok">All checks passed — campaign is ready to launch.</span>
          )}
        </div>
      </section>

      <section className="ccc-detail-section">
        <div className="ccc-detail-section__head"><h3>Cost &amp; spend</h3></div>
        <div className="ccc__cost-grid ccc-detail-cost-grid">
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
      </section>

      <section className="ccc-detail-section">
        <div className="ccc-detail-section__head"><h3>Target funnel</h3></div>
        <div className="ccc-detail-funnel">
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
        <div key={label} className="ccc-detail-funnel__row">
          <div className="ccc-detail-funnel__top">
            <span>{label}</span>
            <strong>{fmt(value)}</strong>
          </div>
          <div className="ccc__bar-track">
            <div className={cls('ccc__bar-fill', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </div>
      ))}
        </div>
      </section>

      <section className="ccc-detail-section">
        <div className="ccc-detail-section__head"><h3>Performance</h3></div>
      {sampleSufficient ? (
        <div className="ccc__stat-grid ccc-detail-stat-grid">
          <div className="ccc__stat-card ccc-detail-stat-card">
            <div className="ccc__stat-card-label">Delivery Rate</div>
            <div className={cls('ccc__stat-card-value', campaign.delivery_rate >= 90 ? 'is-success' : campaign.delivery_rate >= 75 ? 'is-warning' : 'is-danger')}>
              {fmtPct(campaign.delivery_rate)}
            </div>
          </div>
          <div className="ccc__stat-card ccc-detail-stat-card">
            <div className="ccc__stat-card-label">Reply Rate</div>
            <div className={cls('ccc__stat-card-value', campaign.reply_rate >= 12 ? 'is-success' : campaign.reply_rate >= 7 ? 'is-warning' : 'is-danger')}>
              {fmtPct(campaign.reply_rate)}
            </div>
          </div>
          <div className="ccc__stat-card ccc-detail-stat-card">
            <div className="ccc__stat-card-label">Opt-Out Rate</div>
            <div className={cls('ccc__stat-card-value', campaign.opt_out_rate <= 3 ? 'is-success' : campaign.opt_out_rate <= 6 ? 'is-warning' : 'is-danger')}>
              {fmtPct(campaign.opt_out_rate)}
            </div>
          </div>
          <div className="ccc__stat-card ccc-detail-stat-card">
            <div className="ccc__stat-card-label">Positive Leads</div>
            <div className="ccc__stat-card-value is-success">{campaign.positive_reply_count}</div>
          </div>
        </div>
      ) : (
        <div className="ccc-detail-empty-note">{health.label} — performance rates require sufficient send sample</div>
      )}
      </section>

      <section className="ccc-detail-section">
        <div className="ccc-detail-section__head"><h3>Schedule</h3></div>
        <div className="ccc-detail-settings">
      <div className="ccc__setting-row ccc-detail-setting-row">
        <div><div className="ccc__setting-label">Next Send</div><div className="ccc__setting-desc">Next scheduled execution</div></div>
        <div className="ccc__setting-value">{fmtRelative(campaign.next_send_at)}</div>
      </div>
      <div className="ccc__setting-row ccc-detail-setting-row">
        <div><div className="ccc__setting-label">Send Interval</div><div className="ccc__setting-desc">Delay between sends</div></div>
        <div className="ccc__setting-value">{fmtInterval(campaign.send_interval_seconds)}</div>
      </div>
      {campaign.send_window_start && (
        <div className="ccc__setting-row ccc-detail-setting-row">
          <div><div className="ccc__setting-label">Send Window</div><div className="ccc__setting-desc">Active outreach hours</div></div>
          <div className="ccc__setting-value">{campaign.send_window_start} – {campaign.send_window_end ?? '—'}</div>
        </div>
      )}
      <div className="ccc__setting-row ccc-detail-setting-row">
        <div><div className="ccc__setting-label">Auto Send</div><div className="ccc__setting-desc">Automated outreach engine</div></div>
        <div className={cls('ccc-toggle', campaign.auto_send_enabled && 'is-on')} />
      </div>
        </div>
      </section>

      <section className="ccc-detail-section">
        <div className="ccc-detail-section__head"><h3>Suppression</h3></div>
        <SuppressionChecklist checks={checks} />
      </section>
    </div>
  )
}

// ── Targets Tab ───────────────────────────────────────────────────────────────

const TargetsTab = ({ campaignId, isMobileLayout = false }: { campaignId: string; isMobileLayout?: boolean }) => {
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
  const filterOptions = statusOptions.map((s) => ({
    key: s,
    label: s === 'all' ? 'All statuses' : s.replace(/_/g, ' '),
  }))

  return (
    <div className={cls('ccc-targets-tab', isMobileLayout && 'ccc-targets-tab--mobile')}>
      <div className={cls('ccc-targets-toolbar', isMobileLayout && 'ccc-targets-toolbar--mobile')}>
        <div className="ccc__list-search ccc__list-search--glass ccc-targets-search">
          <Icon name="search" size={12} />
          <input
            type="search"
            placeholder="Search owner, property, phone…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        {isMobileLayout ? (
          <CampaignChipFilterMenu
            label="Status"
            value={filter}
            options={filterOptions}
            onChange={(key) => { setFilter(key); setPage(1) }}
          />
        ) : (
          <div className="ccc__filter-chips">
            {statusOptions.map((s) => (
              <button
                key={s}
                className={cls('ccc__chip', filter === s && 'is-active')}
                onClick={() => { setFilter(s); setPage(1) }}
              >
                {s === 'all' ? 'All' : s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        )}
        <span className="ccc-targets-count">
          {totalCount.toLocaleString()} recipients · p{page}/{Math.max(totalPages, 1)}
        </span>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[1, 2, 3, 4].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 36, width: '100%' }} />)}
        </div>
      ) : targets.length === 0 ? (
        <div className="ccc__empty"><div className="ccc__empty-title">No targets match this filter.</div><div className="ccc__empty-sub">Build targets or adjust filters.</div></div>
      ) : isMobileLayout ? (
        <>
          <div className="ccc-mobile-target-list">
            {targets.map((t) => (
              <article key={t.id} className="ccc-mobile-target-card">
                <div className="ccc-mobile-target-card__head">
                  <strong>{t.seller_full_name ?? 'Unknown owner'}</strong>
                  <span className={cls('ccc__target-status', `is-${t.target_status}`)}>
                    {t.target_status.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="ccc-mobile-target-card__addr">{t.property_address_full ?? '—'}</p>
                <div className="ccc-mobile-target-card__meta">
                  <span>{t.market ?? '—'}</span>
                  <span>{t.canonical_e164 ?? '—'}</span>
                  {t.final_acquisition_score != null && (
                    <span className={cls('ccc__score-badge', t.final_acquisition_score >= 75 ? 'is-high' : t.final_acquisition_score >= 40 ? 'is-mid' : 'is-low')}>
                      {t.final_acquisition_score}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="ccc-mobile-pager">
            <button type="button" className="ccc-btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount.toLocaleString()}</span>
            <button type="button" className="ccc-btn" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
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

const QueueTab = ({ campaign, isMobileLayout = false }: { campaign: CampaignSummary; isMobileLayout?: boolean }) => {
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
    <div className={cls('ccc-queue-tab', isMobileLayout && 'ccc-queue-tab--mobile')}>
      <div className={cls('ccc-mobile-kpi-row', isMobileLayout && 'ccc-mobile-kpi-row--3')}>
        {[
          { label: 'Ready', value: campaign.ready_targets, tone: 'is-success' },
          { label: 'Queued', value: campaign.queued_targets, tone: '' },
          { label: 'Scheduled', value: campaign.scheduled_targets, tone: 'is-warning' },
        ].map((s) => (
          <div key={s.label} className={cls('ccc-mobile-kpi', s.tone)}>
            <span>{s.label}</span>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="ccc-mobile-shimmer-stack">
          {[1, 2, 3].map((i) => <div key={i} className="ccc__shimmer ccc-mobile-shimmer-card" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="ccc__empty"><div className="ccc__empty-title">Queue is empty</div><div className="ccc__empty-sub">No real targets ready or queued</div></div>
      ) : (
        Array.from(groups.entries()).map(([date, rows]) => (
          <section key={date} className="ccc-mobile-queue-group">
            <header className="ccc-mobile-queue-group__head">
              <Icon name="clock" size={11} />
              <span>{date}</span>
              <strong>{rows.length} sends</strong>
            </header>
            {rows.map((item) => (
              <article key={item.id} className="ccc-mobile-queue-card">
                <div className="ccc-mobile-queue-card__top">
                  <div className={cls('ccc__q-dot', `is-${item.queue_status}`)} />
                  <strong>{item.seller_full_name}</strong>
                  <span>{item.scheduled_for ? fmtTime(item.scheduled_for) : '—'}</span>
                </div>
                <p>{item.property_address_full}</p>
                <span className="ccc-mobile-queue-card__tmpl">Template: {item.template_name || '—'}</span>
              </article>
            ))}
          </section>
        ))
      )}
    </div>
  )
}

// ── Replies Tab ───────────────────────────────────────────────────────────────

const RepliesTab = ({ campaign, isMobileLayout = false }: { campaign: CampaignSummary; isMobileLayout?: boolean }) => {
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

  const replyFilterOptions = (['all', 'positive', 'negative', 'neutral', 'opt_out', 'question'] as const).map((f) => ({
    key: f,
    label: f === 'all' ? 'All replies' : f.replace(/_/g, ' '),
  }))

  return (
    <div className={cls('ccc-replies-tab', isMobileLayout && 'ccc-replies-tab--mobile')}>
      <div className={cls('ccc-mobile-kpi-row', isMobileLayout && 'ccc-mobile-kpi-row--3')}>
        {[
          { label: 'Positive', value: campaign.positive_reply_count, tone: 'is-success' },
          { label: 'Negative', value: campaign.negative_reply_count, tone: 'is-danger' },
          { label: 'Opted out', value: campaign.opt_out_count, tone: 'is-warning' },
        ].map((s) => (
          <div key={s.label} className={cls('ccc-mobile-kpi', s.tone)}>
            <span>{s.label}</span>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>

      {isMobileLayout ? (
        <CampaignChipFilterMenu
          label="Reply type"
          value={filter}
          options={replyFilterOptions}
          onChange={(key) => setFilter(key as typeof filter)}
        />
      ) : (
        <div className="ccc__filter-chips" style={{ marginBottom: 12 }}>
          {(['all', 'positive', 'negative', 'neutral', 'opt_out', 'question'] as const).map((f) => (
            <button key={f} className={cls('ccc__chip', filter === f && 'is-active')} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      )}

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
  isMobileLayout = false,
}: {
  campaign: CampaignSummary | null
  commandState: CampaignCommandState
  onClose: () => void
  onAction: (action: string, campaign: CampaignSummary) => void
  initialTab?: CampaignDetailTab
  isMobileLayout?: boolean
}) => {
  const [activeTab, setActiveTab] = useState<CampaignDetailTab>(initialTab ?? 'overview')

  useEffect(() => { setActiveTab(initialTab ?? 'overview') }, [campaign?.id, initialTab])

  const TABS = [
    { id: 'overview' as const, label: 'Overview', group: 'primary' as const },
    { id: 'execution' as const, label: 'Execution', group: 'primary' as const },
    { id: 'targets' as const, label: 'Targets', group: 'primary' as const },
    { id: 'queue' as const, label: 'Queue', group: 'primary' as const },
    { id: 'replies' as const, label: 'Replies', group: 'primary' as const },
    { id: 'failures' as const, label: 'Failures', group: 'more' as const },
    { id: 'geography' as const, label: 'Geography', group: 'more' as const },
    { id: 'templates' as const, label: 'Templates', group: 'more' as const },
    { id: 'logs' as const, label: 'Logs', group: 'more' as const },
  ]

  if (!campaign) {
    return (
      <div className="ccc__detail-panel ccc-glass-workspace ccc__detail-panel--glass">
        <div className="ccc__detail-empty ccc__detail-empty--glass">
          <div className="ccc__detail-empty-icon"><Icon name="send" size={36} /></div>
          <div className="ccc__detail-empty-title">Select a campaign</div>
          <div className="ccc__detail-empty-sub">Tap a row to view targets, queue, execution, and performance.</div>
        </div>
      </div>
    )
  }

  const detailActions = getDetailActions(campaign)

  return (
    <div className={cls('ccc__detail-panel', 'ccc-glass-workspace', 'ccc__detail-panel--glass', isMobileLayout && 'is-mobile-detail')}>
      <div className={cls('ccc-mobile-detail-chrome', isMobileLayout && 'is-sticky')}>
        <CampaignDetailHeader
          campaign={campaign}
          commandState={commandState}
          detailActions={detailActions}
          isMobileLayout={isMobileLayout}
          onClose={onClose}
          onAction={onAction}
        />
        <CampaignDetailTabBar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          isMobileLayout={isMobileLayout}
        />
      </div>

      <div className={cls('ccc__detail-body', 'ccc__detail-body--glass', isMobileLayout && 'ccc__detail-body--mobile-dock')}>
        {activeTab === 'overview'  && <OverviewTab campaign={campaign} isMobileLayout={isMobileLayout} />}
        {activeTab === 'execution' && (
          <CampaignControlCenter
            campaignId={campaign.id}
            campaign={campaign}
            onLifecycleChange={() => onAction('refresh', campaign)}
          />
        )}
        {activeTab === 'targets'   && <TargetsTab campaignId={campaign.id} isMobileLayout={isMobileLayout} />}
        {activeTab === 'queue'     && <QueueTab campaign={campaign} isMobileLayout={isMobileLayout} />}
        {activeTab === 'replies'   && <RepliesTab campaign={campaign} isMobileLayout={isMobileLayout} />}
        {activeTab === 'failures'  && <FailuresTab campaign={campaign} />}
        {activeTab === 'geography' && <GeographyTab campaign={campaign} />}
        {activeTab === 'templates' && <TemplatesTab campaign={campaign} />}
        {activeTab === 'logs'      && <LogsTab campaign={campaign} />}
      </div>

      {isMobileLayout && (
        <CampaignMobileActionDock
          campaign={campaign}
          detailActions={detailActions}
          onAction={onAction}
        />
      )}
    </div>
  )
}

// ── Campaign List Panel ────────────────────────────────────────────────────────

export const CampaignListPanel = ({
  campaigns,
  allCampaigns,
  loading,
  loadFailed = false,
  loadErrorType,
  loadErrorMessage,
  loadRetryable = true,
  loadDegraded = false,
  onRetry,
  selectedId,
  onSelect,
  onCampaignAction,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  isMobileLayout = false,
}: {
  campaigns: CampaignSummary[]
  allCampaigns: CampaignSummary[]
  loading: boolean
  loadFailed?: boolean
  loadErrorType?: CampaignModel['errorType']
  loadErrorMessage?: string
  loadRetryable?: boolean
  loadDegraded?: boolean
  onRetry?: () => void
  selectedId: string | null
  onSelect: (c: CampaignSummary | null) => void
  onCampaignAction: (action: string, campaign: CampaignSummary) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  statusFilter: CampaignListFilter
  setStatusFilter: (s: CampaignListFilter) => void
  isMobileLayout?: boolean
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

  const filterOptions = statusFilters.map((f) => ({
    key: f.key,
    label: f.label,
    count: filterCounts[f.key] ?? 0,
  }))

  return (
    <div className="ccc__list-panel ccc-glass-rail">
      <div className="ccc__list-toolbar ccc__list-toolbar--glass">
        <div className="ccc__list-search ccc__list-search--glass">
          <Icon name="search" size={12} />
          <input
            placeholder="Search campaigns…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="ccc__list-toolbar-row">
          <CampaignFilterMenu
            statusFilter={statusFilter}
            options={filterOptions}
            onStatusFilter={setStatusFilter}
            isMobileLayout={isMobileLayout}
          />
          <span className="ccc__list-count-pill">
            {campaigns.length} shown
          </span>
        </div>
      </div>
      <div className="ccc__list-scroll ccc__list-scroll--glass">
        {loading ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 56, width: '100%' }} />)}
          </div>
        ) : loadFailed ? (
          <div className="ccc__empty" style={{ padding: 24 }}>
            <div className="ccc__empty-title">
              {loadErrorType === 'auth_error'
                ? 'Campaign authentication failed'
                : loadErrorType === 'backend_unavailable'
                  ? 'Campaign backend unavailable'
                  : loadErrorType === 'missing_view'
                    ? 'Campaign data source missing'
                    : 'Campaign load failed'}
            </div>
            <div className="ccc__empty-sub">{loadErrorMessage ?? 'Could not reach canonical campaign API.'}</div>
            {loadRetryable && onRetry && (
              <button type="button" className="ccc__action-btn" onClick={() => onRetry()}>Retry</button>
            )}
          </div>
        ) : campaigns.length === 0 ? (
          <div className="ccc__empty" style={{ padding: 24 }}>
            <div className="ccc__empty-title">
              {allCampaigns.length === 0 ? 'No campaigns available' : 'No campaigns match filters'}
            </div>
            <div className="ccc__empty-sub">
              {allCampaigns.length === 0
                ? 'Canonical campaign list returned zero eligible campaigns.'
                : 'Try adjusting filters'}
            </div>
            {loadDegraded && <div className="ccc__empty-sub">Showing degraded canonical fallback data.</div>}
          </div>
        ) : (
          campaigns.map((c) => {
            const pAction = getPrimaryAction(c)
            const isSelected = c.id === selectedId
            const health = computeHealth(c)
            return (
              <div
                key={c.id}
                className={cls('ccc__list-row', 'ccc__list-row--glass', isSelected && 'is-selected')}
                onClick={() => onSelect(isSelected ? null : c)}
              >
                <div className={cls('ccc__list-dot', `is-${c.status}`)} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ccc__list-row-top">
                    <div className="ccc__list-name" title={c.campaign_name}>{c.campaign_name}</div>
                    <CampaignStatusBadge status={c.status} executionProof={c.execution_proof} />
                  </div>
                  <div className="ccc__list-stats">
                    <span className="ccc__list-stat">
                      <strong>{fmt(c.total_targets)}</strong> tgt
                    </span>
                    <span className="ccc__list-stat is-accent">
                      <strong>{fmt(c.ready_targets)}</strong> ready
                    </span>
                    <span className="ccc__list-stat">
                      <strong>{fmt(c.sent_count)}</strong> sent
                    </span>
                    {health.sampleSufficient ? (
                      <>
                        <span className={cls('ccc__list-stat', c.delivery_rate >= 90 ? 'is-good' : 'is-warn')}>
                          <strong>{fmtPct(c.delivery_rate)}</strong> dlv
                        </span>
                        {c.positive_reply_count > 0 && (
                          <span className="ccc__list-stat is-good">
                            <strong>{c.positive_reply_count}</strong> leads
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="ccc__list-stat">{health.label}</span>
                    )}
                  </div>
                </div>
                {isMobileLayout ? (
                  <span className="ccc__list-chevron" aria-hidden="true">
                    <Icon name="chevron-right" size={14} />
                  </span>
                ) : (
                  <div
                    className="ccc__list-action ccc__list-action--compact ccc__list-action--desktop"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CampaignOverflowButton
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setContextMenu({ campaign: c, x: rect.left, y: rect.bottom + 4 })
                      }}
                    />
                    <button
                      className={cls('ccc__list-action-btn', 'ccc__list-action-btn--icon', pAction.variant)}
                      title={pAction.label}
                      onClick={() => onCampaignAction(pAction.id, c)}
                    >
                      <Icon
                        name={
                          pAction.id === 'pause' ? 'pause'
                            : pAction.id === 'queue_batch' ? 'zap'
                              : pAction.id === 'schedule' || pAction.id === 'reschedule' ? 'calendar'
                                : pAction.id === 'build_targets' ? 'users'
                                  : 'play'
                        }
                        size={12}
                      />
                    </button>
                  </div>
                )}
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
  const { isMobile } = useBreakpoint()
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

  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)

  const portfolioSubtitle = model
    ? `${model.kpis.activeCampaigns} active · ${model.campaigns.filter((c) => c.status === 'scheduled').length} scheduled`
    : 'Loading…'

  return (
    <div className={cls(
      'ccc',
      'ccc--glass',
      isMobile && 'is-mobile',
      isMobile && selectedCampaign && 'is-detail-open',
      isMobile && selectedCampaign && 'ccc--mobile-campaign-detail',
    )}>
      {/* Header — hidden on mobile when viewing campaign detail */}
      {!(isMobile && selectedCampaign) && (
      <div className={cls('ccc__header', isMobile && 'ccc__header--compact')}>
        <div className="ccc__brand">
          <div className="ccc__brand-icon"><Icon name="send" size={14} /></div>
          <div>
            <div className="ccc__title">Campaign Command</div>
            <div className="ccc__subtitle">
              {portfolioSubtitle}
              {!isMobile && lastRefreshedAt && ` · refreshed ${fmtRelative(lastRefreshedAt.toISOString())}`}
            </div>
          </div>
        </div>
        <div className="ccc__actions ccc__actions--desktop">
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
        <div className="ccc__actions ccc__actions--mobile">
          <button className="ccc-btn is-primary" onClick={() => handleGlobalAction('create')}>
            <Icon name="bolt" size={11} />
            New
          </button>
          <div className="ccc__header-menu-wrap">
            <button
              type="button"
              className="ccc__header-menu-btn"
              aria-expanded={headerMenuOpen}
              aria-label="More actions"
              onClick={() => setHeaderMenuOpen((v) => !v)}
            >
              <Icon name="more" size={16} />
            </button>
            {headerMenuOpen && (
              <>
                <button
                  type="button"
                  className="occ-liquid-filter__backdrop"
                  aria-label="Close menu"
                  onClick={() => setHeaderMenuOpen(false)}
                />
                <div className="ccc__header-menu" role="menu">
                  <button type="button" className="ccc__header-menu-item" role="menuitem" onClick={() => { handleGlobalAction('targets'); setHeaderMenuOpen(false) }}>
                    <Icon name="users" size={12} /> Build Targets
                  </button>
                  <button type="button" className="ccc__header-menu-item" role="menuitem" onClick={() => { handleGlobalAction('schedule'); setHeaderMenuOpen(false) }}>
                    <Icon name="calendar" size={12} /> Schedule
                  </button>
                  {selectedCampaign?.status === 'active' && (
                    <button
                      type="button"
                      className="ccc__header-menu-item is-danger"
                      role="menuitem"
                      onClick={() => { void handleCampaignAction('pause', selectedCampaign); setHeaderMenuOpen(false) }}
                    >
                      <Icon name="pause" size={12} /> Pause Campaign
                    </button>
                  )}
                  <button
                    type="button"
                    className="ccc__header-menu-item"
                    role="menuitem"
                    disabled={refreshing}
                    onClick={() => { handleGlobalAction('refresh'); setHeaderMenuOpen(false) }}
                  >
                    <Icon name="refresh-cw" size={12} /> {refreshing ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {/* KPI Strip */}
      {!(isMobile && selectedCampaign) && (loading && !model ? (
        <div className="ccc__kpi-zone">
          <div className={cls('ccc__kpi-strip', 'ccc__kpi-strip--glass', isMobile && 'ccc__kpi-strip--mobile')}>
            {Array.from({ length: isMobile ? 4 : 8 }).map((_, i) => (
              <div key={i} className="ccc__kpi-card ccc__kpi-card--glass">
                <div className="ccc__shimmer" style={{ height: 9, width: 80, marginBottom: 6 }} />
                <div className="ccc__shimmer" style={{ height: 20, width: 50 }} />
              </div>
            ))}
          </div>
        </div>
      ) : model ? (
        <div className="ccc__kpi-zone">
          {!isMobile && <div className="ccc__portfolio-label">Campaign Portfolio</div>}
          <KpiStrip kpis={model.kpis} isMobileLayout={isMobile} />
        </div>
      ) : null)}

      {/* Body: 3 columns */}
      <div className="ccc__body">
        <CampaignListPanel
          campaigns={campaigns}
          allCampaigns={model?.campaigns ?? []}
          loading={loading}
          loadFailed={model?.ok === false}
          loadErrorType={model?.errorType}
          loadErrorMessage={model?.errorMessage}
          loadRetryable={model?.retryable ?? true}
          loadDegraded={model?.degraded === true}
          onRetry={() => void load()}
          selectedId={commandState.activeCampaignId}
          onSelect={handleSelectCampaign}
          onCampaignAction={handleCampaignAction}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          isMobileLayout={isMobile}
        />

        <DetailPanel
          campaign={selectedCampaign}
          commandState={commandState}
          onClose={() => handleSelectCampaign(null)}
          onAction={handleCampaignAction}
          initialTab={detailTab}
          isMobileLayout={isMobile}
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
