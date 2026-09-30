/**
 * LAUNCH PLAN — the pure half of the mobile LAUNCH step.
 *
 * Everything here was previously computed inline inside CampaignLaunchMobile,
 * which meant the only thing that could know "what will the button do" was the
 * component that drew the button. The builder now has ONE sticky footer across
 * Build / Reach / Launch, so the footer needs the same answer — and a derivation
 * that two surfaces read has to live in exactly one place, or they drift.
 *
 * THE ROLLING PLAN (2026-09-30). A campaign is not "one launch of 50". The
 * worker places rows in batches (queue_run_limit, batch_max) and the feeder
 * keeps refilling until every schedulable seller is messaged, at the pace the
 * campaign allows. This screen used to cap the answer at the worker's batch
 * size — "Sending to 50", "A system limit of 50 per run applies" — which is
 * not what happens. The plan now says: all N sellers, at X a day (the smallest
 * of the daily cap, what fits in the contact window, and what the available
 * sender numbers may carry), finishing in about D days, first send at T. The
 * pacing figures come from the server's full-cohort preflight when it has
 * answered (rolling_plan); until then from the launch settings.
 *
 * What IS new is how refusals are worded. The canonical gate still decides —
 * `canActivate` / `canSchedule` come from the modal untouched — but the reasons
 * are grouped by cause and by the step that resolves them.
 */

export type BuilderStep = 'build' | 'reach' | 'launch'

/** The server's rolling plan (queue-plan dry run, full cohort). */
export interface RollingPlanLike {
  schedulable: number
  sends_per_day: number
  binding?: string | null
  days_to_complete: number
  first_send_at: string | null
  daily_cap?: number | null
  spread_interval_seconds?: number
  sendable_senders?: number | null
}

export interface LaunchPlanInput {
  ready: number | null
  schedulable: number | null
  schedulableLoading: boolean
  firstScheduledAt: string | null
  lastScheduledAt: string | null
  /** The campaign's own limit applied to what's deliverable (max_targets). */
  effectiveSends: number
  /** min(daily cap, spaced messages that fit in the contact window). */
  dailyVolume: number
  spacingSeconds: number
  scheduledAt: string
  /** Server rolling plan, when the full-cohort preflight has answered. */
  rolling?: RollingPlanLike | null
  /** Queue-eligible sellers in the whole audience (Reach), before the limit. */
  eligibleInAudience?: number | null
  /** The campaign's send limit (max_targets). */
  maxTargets?: number | null
}

export type PaceBinding = 'daily_cap' | 'contact_window' | 'sender_capacity'

export interface LaunchPlan {
  now: boolean
  schedulableKnown: boolean
  /** Every seller this campaign will message — the whole cohort, not one batch. */
  willQueue: number
  /** The campaign's own send limit leaves eligible sellers out of the audience. */
  capBinds: boolean
  sendsPerDay: number
  paceBinding: PaceBinding | null
  days: number | null
  firstSendAt: string | null
  durationLabel: string
  durationKnown: boolean
}

/** "Now" means the scheduled instant has effectively already arrived. */
export function startsNow(value: string): boolean {
  if (!value || !value.trim()) return true
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return true
  return d.getTime() <= Date.now() + 120_000
}

function paceBinding(value: unknown): PaceBinding | null {
  return value === 'daily_cap' || value === 'contact_window' || value === 'sender_capacity' ? value : null
}

export function deriveLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const schedulableKnown = input.schedulable != null
  const willQueue = schedulableKnown
    ? Math.max(0, input.schedulable as number)
    : Math.max(0, input.ready != null ? Math.min(input.ready, input.effectiveSends) : input.effectiveSends)
  const capBinds = input.maxTargets != null && input.eligibleInAudience != null
    && input.eligibleInAudience > input.maxTargets

  const rolling = input.rolling && Number(input.rolling.sends_per_day) > 0 ? input.rolling : null
  const sendsPerDay = Math.max(1, rolling ? Number(rolling.sends_per_day) : input.dailyVolume)
  const spacing = Math.max(1, rolling?.spread_interval_seconds ?? input.spacingSeconds)
  const days = willQueue > 0 ? Math.max(1, Math.ceil(willQueue / sendsPerDay)) : null

  const durationLabel = (() => {
    if (willQueue <= 0 || days == null) return '—'
    if (days > 1) return `about ${days} days`
    const seconds = Math.max(0, willQueue - 1) * spacing
    if (seconds < 60) return 'under a minute'
    const mins = Math.round(seconds / 60)
    return mins < 90 ? `about ${mins} min` : `about ${(mins / 60).toFixed(1)} hr`
  })()

  return {
    now: startsNow(input.scheduledAt),
    schedulableKnown,
    willQueue,
    capBinds,
    sendsPerDay,
    paceBinding: rolling ? paceBinding(rolling.binding) : (input.dailyVolume > 0 ? 'daily_cap' : null),
    days,
    firstSendAt: rolling?.first_send_at ?? input.firstScheduledAt ?? null,
    durationLabel,
    durationKnown: willQueue > 0 && durationLabel !== '—',
  }
}

/** "750 a day — the daily cap" · "1,040 a day — what fits in 8 AM–9 PM" · … */
export function describePace(plan: Pick<LaunchPlan, 'sendsPerDay' | 'paceBinding'>): string {
  const perDay = `${plan.sendsPerDay.toLocaleString()} a day`
  if (plan.paceBinding === 'sender_capacity') return `${perDay}, limited by available sender numbers`
  if (plan.paceBinding === 'contact_window') return `${perDay}, what fits in texting hours`
  if (plan.paceBinding === 'daily_cap') return `${perDay}, the daily cap`
  return perDay
}

// ── why sellers can't be scheduled ─────────────────────────────────────────

const SKIP_REASON_COPY: Record<string, string> = {
  sender_blocked_by_operator: 'Sender number blocked by an operator',
  local_senders_unavailable: 'Local sender numbers paused or cooling',
  no_local_sender_number: 'No sender number in their market',
  ROUTING_BLOCKED: 'No sender route for their market',
  NO_VALID_TEXTGRID_NUMBER: 'No active sender numbers',
  missing_selected_sender_number: 'No sender number',
  TEMPLATE_RENDER_LINT_FAILURE: 'No first name on file — the greeting can’t be personalized',
  NO_TEMPLATE: 'No approved message for their language',
  MISSING_FIRST_NAME: 'Seller first name missing',
  template_blocked_by_operator: 'Message blocked by an operator',
  OUTREACH_HISTORY_UNAVAILABLE: 'Message history couldn’t be read',
  active_queue_row_exists: 'Already queued',
  prior_contacted_suppression: 'Already contacted',
  graph_suppression_or_queue_block: 'Suppressed',
  duplicate_phone_in_launch_batch: 'Same phone as another seller',
  missing_prospect_id: 'No resolved seller',
  missing_to_phone_number: 'No phone number',
  schedule_window_full: 'No room left in today’s window',
  per_sender_cap_reached: 'Sender daily cap reached',
  per_market_cap_reached: 'Market cap reached',
}

export function describeSkipReason(reason: string): string {
  return SKIP_REASON_COPY[reason]
    ?? reason.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

const SENDER_STATE_COPY: Record<string, string> = {
  blocked_by_operator: 'blocked by an operator',
  status_paused: 'paused',
  health_cooling: 'cooling',
  cooling_until: 'cooling',
  daily_limit_reached: 'at today’s limit',
}

const SENDER_REASONS = new Set([
  'sender_blocked_by_operator', 'local_senders_unavailable', 'no_local_sender_number',
  'ROUTING_BLOCKED', 'NO_VALID_TEXTGRID_NUMBER', 'missing_selected_sender_number',
])

export interface NotSchedulableLine {
  reason: string
  label: string
  count: number
  /** "Miami, FL — +13058975670 blocked by an operator; +17866052999 cooling" */
  details: string[]
}

type RoutingBlocks = Record<string, { targets: number; reason: string; senders: Array<{ phone_number: string | null; state: string }> }>

/** Skipped sellers by reason, with the markets and numbers behind sender reasons. */
export function describeNotSchedulable(
  skipped: Record<string, number> | null | undefined,
  routingBlocks?: RoutingBlocks | null,
): NotSchedulableLine[] {
  return Object.entries(skipped ?? {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([reason, n]) => ({
      reason,
      label: describeSkipReason(reason),
      count: Number(n),
      details: SENDER_REASONS.has(reason)
        ? Object.entries(routingBlocks ?? {})
            .filter(([, block]) => block.reason === reason)
            .sort((a, b) => b[1].targets - a[1].targets)
            .slice(0, 4)
            .map(([market, block]) => {
              const senders = (block.senders ?? [])
                .map((sender) => `${sender.phone_number ?? 'number'} ${SENDER_STATE_COPY[sender.state] ?? sender.state.replace(/_/g, ' ')}`)
                .join('; ')
              return `${market} (${block.targets.toLocaleString()}) — ${senders || 'no sender number in this market'}`
            })
        : [],
    }))
}

const HELD_REASON_COPY: Record<string, string> = {
  entity_contact_requires_review: 'Entity owner — contact needs review',
  missing_identity_linkage: 'No resolved person and phone',
  ambiguous_phone_ownership: 'Phone shared by several owners',
  missing_timezone: 'No timezone',
  graph_not_queue_eligible: 'Not eligible in the audience data',
  RENTER_NOT_OWNER: 'Likely a renter, not the owner',
  IDENTITY_MISMATCH: 'Owner identity doesn’t match',
  OWNERSHIP_NOT_CONFIRMED: 'Ownership not confirmed',
}

/** Why the build held a seller back (target block_reason), in words. */
export function describeHeldReason(reason: string): string {
  return HELD_REASON_COPY[reason] ?? describeSkipReason(reason)
}

/** What the plan's 0 means, in one line. */
export function zeroSchedulableTitle(skipped: Record<string, number> | null | undefined): string {
  const top = Object.entries(skipped ?? {}).filter(([, n]) => Number(n) > 0).sort((a, b) => Number(b[1]) - Number(a[1]))[0]
  if (!top) return 'No seller can be messaged yet'
  if (SENDER_REASONS.has(top[0])) return 'No sender number can reach these sellers'
  if (top[0] === 'TEMPLATE_RENDER_LINT_FAILURE' || top[0] === 'NO_TEMPLATE' || top[0] === 'MISSING_FIRST_NAME') return 'Fix message personalization'
  return describeSkipReason(top[0])
}

// ── blockers ────────────────────────────────────────────────────────────────

export type LaunchIssue = {
  key: string
  /** What to do, as an instruction. */
  title: string
  /** Why, when there is something to add. */
  detail?: string
  /** The step where this gets fixed. Null when it resolves on its own. */
  step: BuilderStep | null
}

/**
 * Group raw blocker strings by root cause.
 *
 * The modal produces one string per failed check, and several checks fail for
 * the same reason. An unnamed draft with no audience produced FIVE lines —
 * "Campaign not persisted yet", "Campaign name required", "No eligible
 * targets", "No valid sender route for selected market", "No contacts match
 * the current targeting" — under a heading reading "5 must clear". There are
 * two things to do: name it, and give it an audience.
 *
 * Matching is on the canonical strings the modal emits. Anything unrecognised
 * is passed through as its own item rather than dropped: an unmapped blocker
 * is still a blocker, and hiding it would make the screen claim readiness the
 * gate will refuse.
 */
export function groupLaunchBlockers(blockers: string[], opts: { hasName: boolean }): LaunchIssue[] {
  const out: LaunchIssue[] = []
  const seen = new Set<string>()
  const push = (issue: LaunchIssue) => {
    if (seen.has(issue.key)) return
    seen.add(issue.key)
    out.push(issue)
  }

  for (const raw of blockers) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const t = text.toLowerCase()

    if (t.includes('name required') || (t.includes('not persisted') && !opts.hasName)) {
      push({ key: 'name', title: 'Name this campaign', detail: 'A name is needed before the draft can be saved.', step: 'build' })
      continue
    }
    if (t.includes('not persisted')) {
      push({ key: 'save', title: 'Save the draft', detail: 'The draft hasn’t saved yet. It saves automatically on this step — try again if it doesn’t.', step: null })
      continue
    }
    if (
      t.includes('no eligible targets') || t.includes('no contacts match') ||
      t.includes('run preview') || t.includes('no ready') || t.includes('no eligible target')
    ) {
      push({ key: 'audience', title: 'Choose an audience', detail: 'No sellers in the current audience can be messaged yet.', step: 'build' })
      continue
    }
    if (t.includes('sender route') || t.includes('no valid sender') || t.includes('sender coverage')) {
      push({ key: 'routing', title: 'Add a market with sender coverage', detail: 'No sender number covers the sellers in this audience.', step: 'build' })
      continue
    }
    if (t.includes('degraded') || t.includes('unavailable') || t.includes('timed out')) {
      push({ key: 'degraded', title: 'Counts are temporarily unavailable', detail: text, step: 'reach' })
      continue
    }
    push({ key: `other:${t.slice(0, 48)}`, title: text, step: null })
  }

  return out
}

// ── the primary action ──────────────────────────────────────────────────────

export type LaunchActionKind = 'go' | 'blocked' | 'busy' | 'draft'

export type LaunchAction = {
  kind: LaunchActionKind
  label: string
  /** Which handler the footer should run. */
  intent: 'activate' | 'schedule' | 'save' | 'resolve' | 'none'
  /** The step to jump to when intent is 'resolve'. */
  step?: BuilderStep
}

export interface LaunchActionInput {
  issues: LaunchIssue[]
  plan: LaunchPlan
  schedulable: number | null
  schedulableLoading: boolean
  /** Why the preflight has no answer (the build or plan call failed), when it failed. */
  preflightError?: string | null
  /** The preflight plan's skips by reason — what "0 schedulable" is made of. */
  skippedCounts?: Record<string, number> | null
  /** Ready targets the preflight build produced (0 = everyone held at build). */
  readyAfterBuild?: number | null
  savedCampaignId: string | null
  isLaunching: boolean
  isPersisting: boolean
  previewLoading: boolean
  activationProgress: string | null
  canActivate: boolean
  canSchedule: boolean
  scheduledAtLabel: string
}

const nf = (n: number) => n.toLocaleString()

/**
 * What the one primary button does, and says.
 *
 * The previous version, when blocked, used the FIRST BLOCKER STRING as the
 * button's label — so the primary action of the whole builder read "Campaign
 * not persisted yet", an error message dressed as a control. When blocked, the
 * button now names the fix and takes you to where it is made.
 *
 * The gate is untouched: `go` is only ever produced when the modal's own
 * `canActivate` / `canSchedule` say so.
 */
export function deriveLaunchAction(input: LaunchActionInput): LaunchAction {
  const first = input.issues[0]
  if (first) {
    return first.step
      ? { kind: 'blocked', label: first.title, intent: 'resolve', step: first.step }
      : { kind: 'blocked', label: first.title, intent: 'none' }
  }

  if (input.isLaunching || input.isPersisting || input.previewLoading || input.schedulableLoading) {
    const label = input.isLaunching
      ? (input.activationProgress ?? 'Launching…')
      : input.isPersisting
        ? 'Saving draft…'
        : input.schedulableLoading
          ? 'Checking messages…'
          : 'Counting audience…'
    return { kind: 'busy', label, intent: 'none' }
  }

  /*
   * "Couldn't verify messages — retry" was the answer to three different
   * things: the check timing out (a dry-run plan made ~2,000 round trips and
   * outlived the two-minute request), the build refusing the audience (a
   * filter it can't apply), and a build that held every seller. Only the
   * first is a retry.
   */
  if (!input.plan.schedulableKnown && input.savedCampaignId) {
    const error = String(input.preflightError ?? '')
    if (/refusing to build targets/i.test(error)) {
      return { kind: 'blocked', label: 'Remove filters that can’t narrow a campaign', intent: 'resolve', step: 'build' }
    }
    if (input.readyAfterBuild === 0) {
      return { kind: 'blocked', label: 'No seller is ready to message', intent: 'resolve', step: 'reach' }
    }
    return { kind: 'blocked', label: 'Couldn’t check messages — retry', intent: 'resolve', step: 'reach' }
  }
  if (input.plan.schedulableKnown && input.schedulable === 0) {
    if (input.readyAfterBuild === 0) {
      return { kind: 'blocked', label: 'No seller is ready to message', intent: 'resolve', step: 'reach' }
    }
    const title = zeroSchedulableTitle(input.skippedCounts)
    return title === 'Fix message personalization'
      ? { kind: 'blocked', label: title, intent: 'resolve', step: 'build' }
      : { kind: 'blocked', label: title, intent: 'none' }
  }

  if (input.plan.now) {
    return input.canActivate
      ? { kind: 'go', label: `Launch · ${nf(input.plan.willQueue)} sellers`, intent: 'activate' }
      : { kind: 'draft', label: 'Save draft', intent: 'save' }
  }
  return input.canSchedule
    ? { kind: 'go', label: `Schedule · ${input.scheduledAtLabel}`, intent: 'schedule' }
    : { kind: 'draft', label: 'Save draft', intent: 'save' }
}

// ── operator vocabulary for system posture ──────────────────────────────────

/** `live_limited` → "Limited". Raw enums were printed verbatim ("live limited"). */
export function describeAutoReplyMode(mode: string | null | undefined): string | null {
  const m = String(mode ?? '').trim().toLowerCase()
  if (!m) return null
  if (m === 'disabled' || m === 'off') return 'Off'
  if (m === 'live_limited') return 'On, limited'
  if (m === 'live' || m === 'enabled' || m === 'full_live') return 'On'
  if (m === 'internal_only') return 'Internal only'
  if (m === 'dry_run' || m === 'shadow') return 'Preview only'
  return m.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** Queue execution mode, only when it would hold this launch. */
export function describeQueueHold(mode: string | null | undefined): string | null {
  const m = String(mode ?? '').trim().toLowerCase()
  if (!m || m === 'normal') return null
  if (m === 'scoped_canary_only') return 'Sending is limited to test traffic right now'
  if (m === 'stopped' || m === 'paused') return 'Sending is stopped system-wide right now'
  return 'Sending is restricted right now'
}

/** "America/Chicago" → "Central". An IANA id is our config, not their clock. */
export function friendlyTimezone(tz: string | null | undefined): string {
  const map: Record<string, string> = {
    'America/New_York': 'Eastern',
    'America/Chicago': 'Central',
    'America/Denver': 'Mountain',
    'America/Phoenix': 'Arizona',
    'America/Los_Angeles': 'Pacific',
    'America/Anchorage': 'Alaska',
    'Pacific/Honolulu': 'Hawaii',
  }
  const key = String(tz ?? '').trim()
  return map[key] ?? (key.split('/').pop()?.replace(/_/g, ' ') || 'local')
}

export function formatLaunchWhen(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
