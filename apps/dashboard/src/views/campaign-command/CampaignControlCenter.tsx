import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import { emitNotification } from '../../shared/NotificationToast'
import {
  getCampaignProgress,
  setCampaignLifecycle,
  type CampaignRuntimeSummary,
} from '../../lib/api/backendClient'
import { operatorModeLabel, operatorStateLabel } from './campaign-operator'
import type { CampaignSummary } from './campaigns.types'

// ── Self-contained helpers (avoid a circular import with CampaignsPage) ──────
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const clampPct = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0))
const fmtNum = (n: number | null | undefined) => (Number(n) || 0).toLocaleString()

const fmtClock = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const fmtAgo = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const fmtDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 90) return `~${Math.round(seconds)}s`
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`
  if (seconds < 172800) return `~${(seconds / 3600).toFixed(1)} hr`
  return `~${Math.round(seconds / 86400)} days`
}

const LIVE_STATES = new Set(['active', 'activating', 'live_limited'])

type Tone = 'live' | 'paused' | 'scheduled' | 'failed' | 'done' | 'idle'
const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'idle' },
  previewed: { label: 'Previewed', tone: 'idle' },
  scheduled: { label: 'Scheduled', tone: 'scheduled' },
  activating: { label: 'Activating', tone: 'live' },
  active: { label: 'Active', tone: 'live' },
  live_limited: { label: 'Live', tone: 'live' },
  paused: { label: 'Paused', tone: 'paused' },
  completed: { label: 'Completed', tone: 'done' },
  failed: { label: 'Failed', tone: 'failed' },
  archived: { label: 'Archived', tone: 'done' },
}

const POLL_MS = 15_000

export function CampaignControlCenter({
  campaignId,
  campaign,
  onLifecycleChange,
}: {
  campaignId: string
  campaign: CampaignSummary
  onLifecycleChange?: () => void
}) {
  const [summary, setSummary] = useState<CampaignRuntimeSummary | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const [showDiag, setShowDiag] = useState(false)

  // Refs guard against overlapping fetches and post-unmount state writes so the
  // light poll never piles up requests or destabilizes the surrounding app.
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const load = useCallback(async (recompute: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await getCampaignProgress(campaignId, { recompute })
      if (!mounted.current) return
      if (res.ok && res.data?.summary) {
        setSummary(res.data.summary)
        setDegraded(Boolean(res.data.degraded))
        setError(null)
        setSyncedAt(Date.now())
      } else if (!res.ok) {
        setError(res.message || res.error || 'progress_unavailable')
      } else {
        setError('progress_unavailable')
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [campaignId])

  // Initial + on campaign change.
  useEffect(() => {
    mounted.current = true
    setLoading(true)
    setSummary(null)
    void load(false)
    return () => { mounted.current = false }
  }, [load])

  // Light poll — only while live and the tab is visible.
  const status = campaign.status
  const isLive = LIVE_STATES.has(status)
  const proof = campaign.execution_proof
  useEffect(() => {
    if (!isLive) return
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void load(false)
    }
    const id = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(id)
  }, [isLive, load])

  const runAction = useCallback(async (
    action: 'pause' | 'resume' | 'archive',
    label: string,
  ) => {
    setBusy(action)
    try {
      const res = await setCampaignLifecycle(campaignId, action)
      if (res.ok && res.data?.ok) {
        emitNotification({ title: `Campaign ${label}`, detail: `Now ${res.data.to ?? action}.`, severity: 'success' })
        await load(true)
        onLifecycleChange?.()
      } else {
        const msg = (res.ok ? res.data?.error : res.message) || 'transition_failed'
        emitNotification({
          title: `Could not ${label.toLowerCase()}`,
          detail: msg === 'illegal_campaign_transition' ? `Not allowed from "${status}".` : String(msg),
          severity: 'critical',
        })
      }
    } catch (e) {
      emitNotification({ title: `Could not ${label.toLowerCase()}`, detail: e instanceof Error ? e.message : String(e), severity: 'critical' })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [campaignId, load, onLifecycleChange, status])

  const stateLabel = operatorStateLabel(campaign)
  const modeLabel = operatorModeLabel(campaign)
  const meta = proof?.proof_mode
    ? { label: stateLabel, tone: 'paused' as Tone }
    : { label: stateLabel, tone: (STATUS_META[status]?.tone ?? 'idle') as Tone }

  // Derived counters (no fake values — fall back to the list summary when the
  // progress engine has not been populated/migrated yet).
  const queued = proof?.hydrated_rows ?? summary?.queued_count ?? campaign.canonical_queued_count ?? campaign.queued_targets ?? 0
  const sent = summary?.sent_count ?? campaign.sent_count ?? 0
  const delivered = summary?.delivered_count ?? campaign.delivered_count ?? 0
  const replied = summary?.replied_count ?? campaign.reply_count ?? 0
  const positive = summary?.positive_count ?? campaign.positive_reply_count ?? 0
  const optOut = summary?.opt_out_count ?? campaign.opt_out_count ?? 0
  const failed = summary?.failed_count ?? campaign.failed_count ?? 0
  const hydrationPct = clampPct(summary?.hydration_progress_pct ?? (queued + sent > 0 ? (sent / (queued + sent)) * 100 : 0))

  // Pacing + estimated completion (derived from real config + real counters).
  const intervalSec = Number(campaign.send_interval_seconds) || 0
  const targetPerHour = intervalSec > 0 ? Math.round(3600 / intervalSec) : null
  const activatedAt = summary?.activated_at ?? null
  const elapsedSec = activatedAt ? Math.max(1, (Date.now() - new Date(activatedAt).getTime()) / 1000) : null
  const observedPerHour = elapsedSec && sent > 0 ? Math.round((sent / elapsedSec) * 3600) : null
  const remaining = queued
  const etaSeconds = targetPerHour && remaining > 0 ? (remaining / targetPerHour) * 3600 : (intervalSec > 0 ? remaining * intervalSec : 0)
  const paceUtilPct = targetPerHour && observedPerHour ? clampPct((observedPerHour / targetPerHour) * 100) : null

  const metrics: Array<{ key: string; label: string; value: number; tone?: string }> = [
    { key: 'queued', label: 'Queued', value: queued },
    { key: 'sent', label: 'Sent', value: sent },
    { key: 'delivered', label: 'Delivered', value: delivered },
    { key: 'replied', label: 'Replied', value: replied },
    { key: 'positive', label: 'Positive', value: positive, tone: 'good' },
    { key: 'optout', label: 'Opt-Out', value: optOut, tone: optOut > 0 ? 'warn' : undefined },
    { key: 'failed', label: 'Failed', value: failed, tone: failed > 0 ? 'bad' : undefined },
  ]

  const rates: Array<{ label: string; value: number; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = [
    { label: 'Delivery', value: summary?.delivery_rate_pct ?? campaign.delivery_rate ?? 0, tone: 'good' },
    { label: 'Reply', value: summary?.reply_rate_pct ?? campaign.reply_rate ?? 0, tone: 'neutral' },
    { label: 'Positive', value: summary?.positive_rate_pct ?? campaign.positive_rate ?? 0, tone: 'good' },
    { label: 'Opt-Out', value: summary?.opt_out_rate_pct ?? campaign.opt_out_rate ?? 0, tone: 'warn' },
  ]

  const timeline: Array<{ label: string; at: string | null }> = [
    { label: 'Scheduled for', at: summary?.scheduled_for ?? null },
    { label: 'Activated', at: summary?.activated_at ?? null },
    { label: 'Paused', at: summary?.paused_at ?? null },
    { label: 'Completed', at: summary?.completed_at ?? null },
    { label: 'Failed', at: summary?.failed_at ?? null },
    { label: 'Last transition', at: summary?.last_transition_at ?? null },
  ].filter((t) => t.at)

  const hasFailureAlert = (summary?.status === 'failed') || failed > 0
  const canPause = status === 'active' || status === 'activating' || status === 'live_limited'
  const canResume = status === 'paused'
  const canArchive = ['completed', 'failed', 'paused', 'draft', 'previewed', 'scheduled'].includes(status)

  return (
    <div className="ccc-exec">
      {/* Header */}
      <div className="ccc-exec__head">
        <span className={cls('ccc-exec__pill', `is-${meta.tone}`)}>
          <span className="ccc-exec__pill-dot" />
          {meta.label}
          {isLive && summary?.hydration_active && <span className="ccc-exec__pill-live">hydrating</span>}
        </span>
        <div className="ccc-exec__head-meta">
          {degraded && <span className="ccc-exec__badge is-degraded" title="Progress migration not applied — showing fallback values">fallback</span>}
          <span className="ccc-exec__synced">{syncedAt ? `synced ${fmtAgo(new Date(syncedAt).toISOString())}` : loading ? 'loading…' : '—'}</span>
          <button className="ccc-exec__refresh" onClick={() => void load(true)} disabled={loading || inFlight.current} title="Recompute now">
            <Icon name="refresh-cw" size={12} />
          </button>
        </div>
      </div>

      {error && !summary && (
        <div className="ccc-exec__error">Progress unavailable: {error}</div>
      )}

      {proof && (
        <div className="ccc-exec__proof">
          <div className="ccc-exec__section-label">Execution — {modeLabel}</div>
          {proof.no_messages_will_transmit && (
            <div className="ccc-exec__proof-banner">TEST MODE — No messages will be transmitted.</div>
          )}
          <div className="ccc-exec__proof-grid">
            <div><span>State</span><strong>{stateLabel}</strong></div>
            <div><span>Queue rows created</span><strong>{fmtNum(proof.hydrated_rows)}</strong></div>
            <div><span>Live send rows</span><strong>{fmtNum(proof.live_send_rows)}</strong></div>
            <div><span>Test mode rows</span><strong>{fmtNum(proof.proof_no_send_rows)}</strong></div>
            <div><span>SMS eligible</span><strong>{fmtNum(proof.sms_eligible)}</strong></div>
            <div><span>Routable recipients</span><strong>{fmtNum(proof.routing_allowed)}</strong></div>
            <div><span>Next scheduled</span><strong>{fmtClock(proof.next_scheduled_proof_row)}</strong></div>
            <div><span>Sending</span><strong>{proof.transmission_enabled ? 'Enabled' : 'Disabled'}</strong></div>
          </div>
        </div>
      )}

      {/* Hydration / execution progress */}
      <div className="ccc-exec__progress">
        <div className="ccc-exec__progress-top">
          <span className="ccc-exec__progress-label">Queue hydration</span>
          <span className="ccc-exec__progress-pct">{hydrationPct.toFixed(0)}%</span>
        </div>
        <div className="ccc-exec__bar">
          <div className="ccc-exec__bar-fill" style={{ width: `${hydrationPct}%` }} />
        </div>
        <div className="ccc-exec__progress-sub">
          <span>{fmtNum(sent)} sent</span>
          <span>{fmtNum(queued)} queued</span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="ccc-exec__metrics">
        {metrics.map((m) => (
          <div key={m.key} className={cls('ccc-exec__metric', m.tone && `is-${m.tone}`)}>
            <div className="ccc-exec__metric-val">{fmtNum(m.value)}</div>
            <div className="ccc-exec__metric-label">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Funnel rates */}
      <div className="ccc-exec__rates">
        {rates.map((r) => (
          <div key={r.label} className="ccc-exec__rate">
            <div className="ccc-exec__rate-top">
              <span>{r.label}</span>
              <strong>{Number(r.value).toFixed(1)}%</strong>
            </div>
            <div className="ccc-exec__rate-bar">
              <div className={cls('ccc-exec__rate-fill', `is-${r.tone}`)} style={{ width: `${clampPct(Number(r.value))}%` }} />
            </div>
          </div>
        ))}
      </div>

      {/* Pacing + completion */}
      <div className="ccc-exec__pacing">
        <div className="ccc-exec__pace-cell">
          <span className="ccc-exec__pace-label">Interval</span>
          <span className="ccc-exec__pace-val">{intervalSec > 0 ? `${intervalSec}s` : '—'}</span>
        </div>
        <div className="ccc-exec__pace-cell">
          <span className="ccc-exec__pace-label">Target rate</span>
          <span className="ccc-exec__pace-val">{targetPerHour ? `${targetPerHour}/hr` : '—'}</span>
        </div>
        <div className="ccc-exec__pace-cell">
          <span className="ccc-exec__pace-label">Observed</span>
          <span className="ccc-exec__pace-val">{observedPerHour != null ? `${observedPerHour}/hr` : '—'}</span>
        </div>
        <div className="ccc-exec__pace-cell">
          <span className="ccc-exec__pace-label">Pace util</span>
          <span className="ccc-exec__pace-val">{paceUtilPct != null ? `${paceUtilPct.toFixed(0)}%` : '—'}</span>
        </div>
        <div className="ccc-exec__pace-cell">
          <span className="ccc-exec__pace-label">Est. completion</span>
          <span className="ccc-exec__pace-val">{remaining > 0 ? fmtDuration(etaSeconds) : '—'}</span>
        </div>
      </div>

      {/* Failure alert */}
      {hasFailureAlert && (
        <div className="ccc-exec__alert">
          <Icon name="alert-circle" size={13} />
          <div>
            <strong>{summary?.status === 'failed' ? 'Campaign failed' : `${fmtNum(failed)} failed sends`}</strong>
            {summary?.failure_reason && <span> — {summary.failure_reason}</span>}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="ccc-exec__controls">
        <button className="ccc-exec__btn is-warn" disabled={!canPause || busy != null} onClick={() => void runAction('pause', 'Paused')}>
          <Icon name="pause" size={11} /> Pause
        </button>
        <button className="ccc-exec__btn is-accent" disabled={!canResume || busy != null} onClick={() => void runAction('resume', 'Resumed')}>
          <Icon name="play" size={11} /> Resume
        </button>
        <button className="ccc-exec__btn" disabled={!canArchive || busy != null} onClick={() => void runAction('archive', 'Archived')}>
          <Icon name="archive" size={11} /> Archive
        </button>
      </div>

      {/* Execution timeline */}
      {timeline.length > 0 && (
        <div className="ccc-exec__timeline">
          <div className="ccc-exec__section-label">Execution timeline</div>
          {timeline.map((t) => (
            <div key={t.label} className="ccc-exec__tl-row">
              <span className="ccc-exec__tl-dot" />
              <span className="ccc-exec__tl-label">{t.label}</span>
              <span className="ccc-exec__tl-time">{fmtClock(t.at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Diagnostics (hidden by default) */}
      <button className="ccc-exec__diag-toggle" onClick={() => setShowDiag((v) => !v)}>
        <Icon name={showDiag ? 'chevron-down' : 'chevron-right'} size={10} /> Diagnostics
      </button>
      {showDiag && (
        <div className="ccc-exec__diag">
          <div><span>Attempts</span><span>{summary?.activation_attempt_count ?? 0}</span></div>
          <div><span>Heartbeat</span><span>{fmtAgo(summary?.execution_heartbeat_at)}</span></div>
          <div><span>Progress synced</span><span>{fmtAgo(summary?.progress_synced_at)}</span></div>
          <div><span>Hydration cursor</span><span>{summary?.hydration_cursor ? JSON.stringify(summary.hydration_cursor) : '—'}</span></div>
        </div>
      )}
    </div>
  )
}
