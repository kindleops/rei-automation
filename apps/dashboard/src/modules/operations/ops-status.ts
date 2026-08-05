/**
 * Operations Center — the single queue/sending status resolver.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this resolver the dashboard derived queue status six different ways,
 * none of which agreed:
 *
 *   1. NexusTopBar badge          <- health.status
 *   2. QueueCommandCenter popover <- its own getInferredStatus()
 *   3. MobileCommandDock pip      <- health.status
 *   4. usePinnedAppDockBadges     <- its own 60s poll of health.status
 *   5. /queue market badges       <- failure-rate buckets
 *   6. SendQueueDashboard         <- a fourth colour scale
 *   (7. localStorage['nx.queue.mode'], which won on first paint.)
 *
 * `health.status` has no concept of execution mode, and `getQueueProcessorHealth`
 * defaults a missing status to 'healthy'. With `queue_execution_mode = 'paused'`
 * in production the top bar rendered a green "Healthy" dot over a popover that
 * said PAUSED.
 *
 * This resolver is the only place that decides. It consumes:
 *   - queue_execution_mode  (the authoritative operator posture; fail-closed)
 *   - queue processor health (throughput + infrastructure signals)
 *   - campaign control diagnostics (hard blockers, campaign posture)
 *
 * It mirrors the backend's fail-closed semantics in
 * `apps/api/src/lib/domain/queue/queue-execution-mode.js`, including the legacy
 * 'paused' alias that production was frozen with on 2026-07-29.
 */

// ── Execution mode (mirrors the backend contract) ─────────────────────────

export type QueueExecutionMode = 'stopped' | 'normal' | 'scoped_canary_only'

export type ExecutionModeSource = 'canonical' | 'legacy_alias' | 'unknown_fail_closed' | 'absent'

export interface ExecutionModeDescription {
  /** Normalised, fail-closed mode. */
  mode: QueueExecutionMode
  /** The raw stored value, for the disclosure line. Never a headline. */
  raw: string
  source: ExecutionModeSource
  /** True when this posture prevents sending. */
  failClosed: boolean
}

const CANONICAL_MODES = new Set<QueueExecutionMode>(['stopped', 'normal', 'scoped_canary_only'])

/**
 * Legacy stored values with a known, safe meaning. Production was frozen with
 * the literal 'paused', which is not canonical but is unambiguously a stop.
 */
const LEGACY_MODE_ALIASES: Record<string, QueueExecutionMode> = {
  paused: 'stopped',
  pause: 'stopped',
  off: 'stopped',
}

/**
 * Classify a raw `queue_execution_mode` value. Unknown values fail closed and
 * are reported as unknown so the operator can see the posture was not
 * understood, rather than it looking like a deliberate stop.
 */
export function describeExecutionMode(value: unknown): ExecutionModeDescription {
  const raw = String(value ?? '').trim().toLowerCase()

  if (!raw) {
    return { mode: 'stopped', raw: '', source: 'absent', failClosed: true }
  }
  if (CANONICAL_MODES.has(raw as QueueExecutionMode)) {
    const mode = raw as QueueExecutionMode
    return { mode, raw, source: 'canonical', failClosed: mode !== 'normal' }
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_MODE_ALIASES, raw)) {
    return { mode: LEGACY_MODE_ALIASES[raw], raw, source: 'legacy_alias', failClosed: true }
  }
  return { mode: 'stopped', raw, source: 'unknown_fail_closed', failClosed: true }
}

// ── Resolved status ───────────────────────────────────────────────────────

export type SendingState = 'stopped' | 'canary' | 'blocked' | 'degraded' | 'unknown' | 'live'

export type StatusTone = 'positive' | 'caution' | 'critical' | 'neutral'

export interface OpsReason {
  /** Stable identity — also the dedup key. */
  key: string
  /** Operator-facing label. Never a raw enum. */
  label: string
  /** What it means for the operator. */
  detail: string
  count: number | null
  tone: StatusTone
  severity: 'blocker' | 'degrade' | 'watch'
}

export interface SendingStatus {
  state: SendingState
  /** Short badge text: 'Stopped' | 'Canary only' | 'Blocked' | 'Degraded' | 'Unknown' | 'Live'. */
  label: string
  tone: StatusTone
  icon: 'check' | 'alert' | 'alert-circle' | 'pause' | 'activity' | 'shield'
  /** One operator sentence: what this is, is it good, what happens next. */
  headline: string
  /** Deduplicated, humanised, ordered by severity. */
  reasons: OpsReason[]
  /** True only when the system will actually dispatch messages. */
  canSend: boolean
  /** True when health could not be read at all — never report this as healthy. */
  healthUnavailable: boolean
  executionMode: ExecutionModeDescription
  checkedAt: string | null
  /** Raw health status string as reported by the API, for the disclosure line. */
  rawHealthStatus: string
}

// ── Inputs (structurally typed so callers need no shared import) ──────────

export interface HealthInput {
  status?: string | null
  checkedAt?: string | null
  processorHealthy?: boolean
  webhookHealthy?: boolean
  queuedCount?: number
  sentTodayCount?: number
  failedTodayCount?: number
  failedRate?: number | null
  blockedCount?: number
  pausedInvalidCount?: number
  routingBlockedCount?: number
  blankBodyBlockedCount?: number
  activeBlankRowCount?: number
  queuedOlderThanLagWindow?: number
  summary?: string
  /** Present only when the health read itself failed. See ops-status handoff note. */
  liveAutopilotAllowed?: boolean
}

export interface ControlInput {
  queue_execution_mode?: unknown
  queue_processor_mode?: unknown
  campaign_mode?: unknown
  auto_reply_mode?: unknown
  queue_emergency_stop_at?: unknown
  exact_blockers?: string[]
  blocked_reason_counts?: Record<string, number>
  stats?: Record<string, number | undefined>
  [key: string]: unknown
}

// ── Humanised blocker + degraded-reason vocabulary ────────────────────────

/**
 * Internal blocker codes are never rendered raw. Anything not in this map gets
 * sentence-cased and marked so we can see the gap, but it still never reaches
 * the operator as `snake_case`.
 */
const BLOCKER_LABELS: Record<string, { label: string; detail: string }> = {
  global_queue_emergency_stop_active: {
    label: 'Emergency stop active',
    detail: 'An operator halted all sending. Nothing will dispatch until it is cleared.',
  },
  global_emergency_stop_active: {
    label: 'Emergency stop active',
    detail: 'An operator halted all sending. Nothing will dispatch until it is cleared.',
  },
  global_auto_send_must_remain_disabled: {
    label: 'Auto-send held off',
    detail: 'Automatic dispatch is deliberately disabled at the system level.',
  },
  auto_enqueue_disabled: {
    label: 'Auto-queue disabled',
    detail: 'New targets are not being queued, so the queue will drain and stay empty.',
  },
  campaign_automation_paused: {
    label: 'Campaign automation paused',
    detail: 'The campaign will not queue or send until automation is resumed.',
  },
  no_ready_or_live_limited_campaign: {
    label: 'No sendable campaign',
    detail: 'No campaign is in a ready or limited-live state, so there is nothing to send.',
  },
  queue_execution_mode_stopped: {
    label: 'Execution stopped',
    detail: 'The queue execution mode is set to stopped.',
  },
  queue_execution_mode_scoped_canary_only: {
    label: 'Canary-only execution',
    detail: 'Only the scoped canary run may send. Normal traffic is held.',
  },
}

/** Blocker codes that are a deliberate operator posture, not a fault. */
const POSTURE_BLOCKERS = new Set([
  'global_auto_send_must_remain_disabled',
  'no_ready_or_live_limited_campaign',
  'auto_enqueue_disabled',
  'campaign_automation_paused',
])

const sentenceCase = (code: string): string => {
  const spaced = code.replace(/[_-]+/g, ' ').trim()
  if (!spaced) return 'Unrecognised condition'
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** Humanise a raw blocker/blocked-reason code without ever leaking snake_case. */
export function humanizeBlockerCode(code: string): { label: string; detail: string } {
  const key = String(code ?? '').trim().toLowerCase()
  if (BLOCKER_LABELS[key]) return BLOCKER_LABELS[key]
  return {
    label: sentenceCase(key),
    detail: 'Reported by the queue control plane.',
  }
}

// ── Degradation thresholds ────────────────────────────────────────────────

/**
 * A single failed send out of thousands is not a degraded system. The previous
 * QueueCommandCenter flipped to DEGRADED on `failedTodayCount > 0`.
 */
export const DEGRADE_THRESHOLDS = {
  /** Percent of today's sends that failed. */
  failureRatePct: 5,
  /** Absolute failures that matter even at low volume. */
  failureCount: 10,
  /** Rows stuck past the lag window. */
  staleQueued: 25,
  routingBlocked: 5,
} as const

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Normalise the many health status spellings the API has used
 * ('degraded', 'warning', 'critical', 'error', 'ok', 'healthy', '').
 * Crucially: an absent status is NOT healthy — it is unknown.
 */
export function normalizeHealthStatus(raw: unknown): 'healthy' | 'warning' | 'critical' | 'unknown' {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return 'unknown'
  if (value === 'healthy' || value === 'ok' || value === 'green') return 'healthy'
  if (value === 'warning' || value === 'warn' || value === 'degraded' || value === 'amber') return 'warning'
  if (value === 'critical' || value === 'error' || value === 'red' || value === 'failed') return 'critical'
  return 'unknown'
}

const STATE_META: Record<SendingState, { label: string; tone: StatusTone; icon: SendingStatus['icon'] }> = {
  stopped: { label: 'Stopped', tone: 'caution', icon: 'pause' },
  canary: { label: 'Canary only', tone: 'caution', icon: 'shield' },
  blocked: { label: 'Blocked', tone: 'critical', icon: 'alert-circle' },
  degraded: { label: 'Degraded', tone: 'caution', icon: 'alert' },
  unknown: { label: 'Unknown', tone: 'neutral', icon: 'activity' },
  live: { label: 'Live', tone: 'positive', icon: 'check' },
}

export interface ResolveSendingStatusInput {
  health?: HealthInput | null
  control?: ControlInput | null
  /** True while the first health/control read is still in flight. */
  loading?: boolean
}

/**
 * THE resolver. Every queue/sending surface reads this and only this.
 *
 * Precedence is fail-closed and mirrors the backend gate order:
 *   1. execution mode says stopped  -> Stopped   (nothing can send, full stop)
 *   2. execution mode says canary   -> Canary only
 *   3. a hard blocker is present    -> Blocked
 *   4. health could not be read     -> Unknown   (never 'healthy')
 *   5. degradation thresholds hit   -> Degraded
 *   6. otherwise                    -> Live
 */
export function resolveSendingStatus({ health, control, loading }: ResolveSendingStatusInput): SendingStatus {
  const executionMode = describeExecutionMode(control?.queue_execution_mode)
  const rawHealthStatus = String(health?.status ?? '')
  const healthStatus = normalizeHealthStatus(health?.status)
  const checkedAt = health?.checkedAt ?? null

  // A health object we never received, or one whose read failed, is unknown.
  // `getQueueProcessorHealth` returns status:'warning' with
  // liveAutopilotAllowed:true on exception — see the backend handoff note in
  // artifacts/lane-f. We treat "no health at all" as unavailable here.
  const healthUnavailable = !health || (!loading && healthStatus === 'unknown' && !health.checkedAt)

  const reasons: OpsReason[] = []
  const seen = new Set<string>()
  const push = (reason: OpsReason) => {
    if (seen.has(reason.key)) return
    if (reason.count != null && reason.count <= 0) return
    seen.add(reason.key)
    reasons.push(reason)
  }

  // ── Execution posture ───────────────────────────────────────────────────
  if (executionMode.mode === 'stopped') {
    push({
      key: 'execution_mode_stopped',
      label: executionMode.source === 'unknown_fail_closed'
        ? 'Execution posture not understood'
        : 'Sending is stopped',
      detail: executionMode.source === 'unknown_fail_closed'
        ? 'The stored execution mode was not recognised, so the system fails closed and sends nothing.'
        : 'The queue execution mode is set to stop. No message will dispatch, regardless of campaign state.',
      count: null,
      tone: 'caution',
      severity: 'blocker',
    })
  } else if (executionMode.mode === 'scoped_canary_only') {
    push({
      key: 'execution_mode_canary',
      label: 'Canary sends only',
      detail: 'Only the scoped canary run may dispatch. All other traffic is held.',
      count: null,
      tone: 'caution',
      severity: 'blocker',
    })
  }

  // ── Hard blockers from the control plane ────────────────────────────────
  const emergencyStopAt = String(control?.queue_emergency_stop_at ?? '').trim()
  if (emergencyStopAt) {
    push({
      key: 'emergency_stop',
      label: 'Emergency stop active',
      detail: 'An operator halted all sending. Nothing dispatches until it is cleared.',
      count: null,
      tone: 'critical',
      severity: 'blocker',
    })
  }

  const rawBlockers = Array.isArray(control?.exact_blockers) ? control.exact_blockers : []
  let hasFaultBlocker = Boolean(emergencyStopAt)
  for (const blocker of rawBlockers) {
    const code = String(blocker ?? '').trim().toLowerCase()
    if (!code) continue
    const isPosture = POSTURE_BLOCKERS.has(code)
    if (!isPosture) hasFaultBlocker = true
    const { label, detail } = humanizeBlockerCode(code)
    push({
      key: `blocker:${code}`,
      label,
      detail,
      count: null,
      tone: isPosture ? 'caution' : 'critical',
      severity: 'blocker',
    })
  }

  // ── Infrastructure + throughput degradation ─────────────────────────────
  if (health) {
    if (health.processorHealthy === false && healthStatus !== 'unknown') {
      push({
        key: 'processor_unhealthy',
        label: 'Queue processor unhealthy',
        detail: 'The processor is not reporting healthy, so queued rows may not be picked up.',
        count: null,
        tone: 'critical',
        severity: 'degrade',
      })
    }
    if (health.webhookHealthy === false) {
      push({
        key: 'webhook_stale',
        label: 'Delivery receipts stale',
        detail: 'No recent delivery webhook. Sent counts are trustworthy; delivered counts are not.',
        count: null,
        tone: 'caution',
        severity: 'degrade',
      })
    }

    const failed = num(health.failedTodayCount)
    const sent = num(health.sentTodayCount)
    const failureRate = health.failedRate != null && Number.isFinite(Number(health.failedRate))
      ? Number(health.failedRate)
      : (sent > 0 ? (failed / sent) * 100 : 0)

    // One failure in thousands is not degradation. Rate OR absolute volume.
    if (failed >= DEGRADE_THRESHOLDS.failureCount || failureRate >= DEGRADE_THRESHOLDS.failureRatePct) {
      push({
        key: 'failed_today',
        label: 'Delivery failures today',
        detail: sent > 0
          ? `${failed} of ${sent} sends failed today (${failureRate.toFixed(1)}%).`
          : `${failed} sends failed today.`,
        count: failed,
        tone: failureRate >= DEGRADE_THRESHOLDS.failureRatePct * 2 ? 'critical' : 'caution',
        severity: 'degrade',
      })
    } else if (failed > 0) {
      // Visible, but explicitly below the degradation threshold.
      push({
        key: 'failed_today_low',
        label: 'Isolated delivery failures',
        detail: `${failed} failure${failed === 1 ? '' : 's'} today — below the ${DEGRADE_THRESHOLDS.failureRatePct}% degradation threshold.`,
        count: failed,
        tone: 'neutral',
        severity: 'watch',
      })
    }

    push({
      key: 'routing_blocked',
      label: 'Routing blocked',
      detail: 'No usable local sender number could be resolved for these rows.',
      count: num(health.routingBlockedCount),
      tone: num(health.routingBlockedCount) >= DEGRADE_THRESHOLDS.routingBlocked ? 'caution' : 'neutral',
      severity: num(health.routingBlockedCount) >= DEGRADE_THRESHOLDS.routingBlocked ? 'degrade' : 'watch',
    })
    push({
      key: 'paused_invalid',
      label: 'Stale or invalid rows',
      detail: 'Rows the processor paused because they no longer validate. They can be reprocessed.',
      count: num(health.pausedInvalidCount),
      tone: 'neutral',
      severity: 'watch',
    })
    push({
      key: 'blank_body',
      label: 'Empty message body',
      detail: 'A template rendered nothing, so these rows will never send as-is.',
      count: num(health.blankBodyBlockedCount) || num(health.activeBlankRowCount),
      tone: 'caution',
      severity: 'watch',
    })
    push({
      key: 'stale_queued',
      label: 'Queued past the lag window',
      detail: 'These rows have waited longer than the expected pickup window.',
      count: num(health.queuedOlderThanLagWindow),
      tone: num(health.queuedOlderThanLagWindow) >= DEGRADE_THRESHOLDS.staleQueued ? 'caution' : 'neutral',
      severity: num(health.queuedOlderThanLagWindow) >= DEGRADE_THRESHOLDS.staleQueued ? 'degrade' : 'watch',
    })
  }

  // Blocked-reason counts from the control plane, humanised.
  for (const [code, count] of Object.entries(control?.blocked_reason_counts ?? {})) {
    if (num(count) <= 0) continue
    const { label, detail } = humanizeBlockerCode(code)
    push({
      key: `blocked_reason:${code}`,
      label,
      detail,
      count: num(count),
      tone: 'caution',
      severity: 'watch',
    })
  }

  if (healthUnavailable) {
    push({
      key: 'health_unavailable',
      label: 'Queue health could not be read',
      detail: 'Status is unknown, not healthy. Treat sending capability as unverified until this clears.',
      count: null,
      tone: 'neutral',
      severity: 'blocker',
    })
  }

  // ── Precedence ──────────────────────────────────────────────────────────
  let state: SendingState
  if (executionMode.mode === 'stopped') {
    state = 'stopped'
  } else if (executionMode.mode === 'scoped_canary_only') {
    state = 'canary'
  } else if (hasFaultBlocker) {
    state = 'blocked'
  } else if (healthUnavailable) {
    state = 'unknown'
  } else if (
    healthStatus === 'critical'
    || healthStatus === 'warning'
    || reasons.some((r) => r.severity === 'degrade')
  ) {
    state = 'degraded'
  } else if (rawBlockers.length > 0) {
    // Posture-only blockers: nothing is broken, but nothing will send either.
    state = 'blocked'
  } else {
    state = 'live'
  }

  const meta = STATE_META[state]
  const orderedReasons = [...reasons].sort((a, b) => {
    const rank = { blocker: 0, degrade: 1, watch: 2 } as const
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity]
    return (b.count ?? 0) - (a.count ?? 0)
  })

  return {
    state,
    label: meta.label,
    tone: meta.tone,
    icon: meta.icon,
    headline: buildHeadline(state, executionMode, orderedReasons, health),
    reasons: orderedReasons,
    canSend: state === 'live',
    healthUnavailable,
    executionMode,
    checkedAt,
    rawHealthStatus,
  }
}

function buildHeadline(
  state: SendingState,
  executionMode: ExecutionModeDescription,
  reasons: OpsReason[],
  health: HealthInput | null | undefined,
): string {
  const queued = num(health?.queuedCount)
  const queuedPhrase = queued > 0
    ? `${queued.toLocaleString()} row${queued === 1 ? '' : 's'} waiting`
    : 'nothing waiting'

  switch (state) {
    case 'stopped':
      return executionMode.source === 'unknown_fail_closed'
        ? `Execution posture "${executionMode.raw}" was not recognised, so sending fails closed — ${queuedPhrase}.`
        : `Sending is stopped by execution mode — ${queuedPhrase}. No message will dispatch.`
    case 'canary':
      return `Only the scoped canary may send — ${queuedPhrase} is held.`
    case 'blocked': {
      const first = reasons.find((r) => r.severity === 'blocker')
      return first
        ? `${first.label} — ${queuedPhrase} and nothing will dispatch.`
        : `Sending is blocked — ${queuedPhrase}.`
    }
    case 'unknown':
      return 'Queue health could not be read. Sending capability is unverified — do not assume it is running.'
    case 'degraded': {
      const first = reasons.find((r) => r.severity === 'degrade')
      return first
        ? `Sending continues but is degraded: ${first.label.toLowerCase()}.`
        : 'Sending continues but the queue is degraded.'
    }
    default:
      return `Sending is live — ${queuedPhrase}.`
  }
}

/**
 * Legacy 4-value badge vocabulary, for surfaces that still take
 * 'healthy' | 'warning' | 'critical' | 'unknown' (mobile dock pip, dock badges).
 * Derived from the resolver so it can never disagree with it.
 */
export function toLegacyBadgeStatus(status: SendingStatus): 'healthy' | 'warning' | 'critical' | 'unknown' {
  switch (status.state) {
    case 'live': return 'healthy'
    case 'blocked': return 'critical'
    case 'degraded': return status.tone === 'critical' ? 'critical' : 'warning'
    case 'stopped':
    case 'canary': return 'warning'
    default: return 'unknown'
  }
}
