/**
 * LAUNCH PLAN — the pure half of the mobile LAUNCH step.
 *
 * Everything here was previously computed inline inside CampaignLaunchMobile,
 * which meant the only thing that could know "what will the button do" was the
 * component that drew the button. The builder now has ONE sticky footer across
 * Build / Reach / Launch, so the footer needs the same answer — and a derivation
 * that two surfaces read has to live in exactly one place, or they drift.
 *
 * The quantitative rules are unchanged from the component they came out of:
 * the binding cap is the smallest of the campaign cap, the system per-run cap
 * and what can actually render; duration is computed from what will actually be
 * queued, not from the discarded campaign cap; READY is never presented as the
 * schedulable answer.
 *
 * What IS new is how refusals are worded. The canonical gate still decides —
 * `canActivate` / `canSchedule` come from the modal untouched — but the reasons
 * are grouped by cause and by the step that resolves them.
 */

export type BuilderStep = 'build' | 'reach' | 'launch'

export interface LaunchPlanInput {
  ready: number | null
  schedulable: number | null
  schedulableLoading: boolean
  firstScheduledAt: string | null
  lastScheduledAt: string | null
  effectiveSends: number
  dailyVolume: number
  spacingSeconds: number
  runLimit: number | null
  scheduledAt: string
}

export interface LaunchPlan {
  now: boolean
  schedulableKnown: boolean
  willQueue: number
  capBinds: boolean
  systemBound: boolean
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

export function deriveLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const schedulableKnown = input.schedulable != null
  const systemBound = input.runLimit != null && input.runLimit < input.effectiveSends
  const capBound = systemBound ? (input.runLimit as number) : input.effectiveSends
  const willQueue = schedulableKnown ? Math.min(capBound, input.schedulable as number) : capBound
  const capBinds = input.ready != null && input.ready > 0 && willQueue < input.ready

  const windowMinutes = input.firstScheduledAt && input.lastScheduledAt
    ? Math.max(0, (new Date(input.lastScheduledAt).getTime() - new Date(input.firstScheduledAt).getTime()) / 60000)
    : null

  const durationLabel = (() => {
    if (willQueue <= 0) return '—'
    if (windowMinutes != null && Number.isFinite(windowMinutes)) {
      if (windowMinutes < 1) return 'under a minute'
      if (windowMinutes < 90) return `about ${Math.round(windowMinutes)} min`
      const hours = windowMinutes / 60
      if (hours < 24) return `about ${hours.toFixed(hours < 10 ? 1 : 0)} hr`
      return `about ${Math.ceil(hours / 24)} days`
    }
    const perDay = Math.max(1, input.dailyVolume)
    const days = Math.ceil(willQueue / perDay)
    if (days > 1) return `about ${days} days`
    const seconds = Math.max(0, willQueue - 1) * Math.max(1, input.spacingSeconds)
    if (seconds < 60) return 'under a minute'
    const mins = Math.round(seconds / 60)
    return mins < 90 ? `about ${mins} min` : `about ${(mins / 60).toFixed(1)} hr`
  })()

  return {
    now: startsNow(input.scheduledAt),
    schedulableKnown,
    willQueue,
    capBinds,
    systemBound,
    durationLabel,
    durationKnown: willQueue > 0 && durationLabel !== '—',
  }
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

  if (!input.plan.schedulableKnown && input.savedCampaignId) {
    return { kind: 'blocked', label: 'Couldn’t verify messages — retry', intent: 'resolve', step: 'reach' }
  }
  if (input.plan.schedulableKnown && input.schedulable === 0) {
    return { kind: 'blocked', label: 'Fix message personalization', intent: 'resolve', step: 'build' }
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
