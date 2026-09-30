import { describe, expect, it } from 'vitest'
import {
  deriveLaunchAction,
  deriveLaunchPlan,
  describeAutoReplyMode,
  describeHeldReason,
  describeNotSchedulable,
  describePace,
  describeQueueHold,
  friendlyTimezone,
  groupLaunchBlockers,
  zeroSchedulableTitle,
  type LaunchActionInput,
} from './campaign-launch-plan'

/** Exactly what the unnamed-draft LAUNCH screen rendered under "5 must clear". */
const REAL_FIVE = [
  'Campaign not persisted yet',
  'Campaign name required',
  'No eligible targets',
  'No valid sender route for selected market',
  'No contacts match the current targeting.',
]

const plan = (over: Partial<Parameters<typeof deriveLaunchPlan>[0]> = {}) => deriveLaunchPlan({
  ready: 1000, schedulable: 1000, schedulableLoading: false,
  firstScheduledAt: null, lastScheduledAt: null,
  effectiveSends: 1000, dailyVolume: 750, spacingSeconds: 45,
  scheduledAt: '', ...over,
})

const actionInput = (over: Partial<LaunchActionInput> = {}): LaunchActionInput => ({
  issues: [], plan: plan(), schedulable: 1000, schedulableLoading: false, savedCampaignId: 'c1',
  isLaunching: false, isPersisting: false, previewLoading: false, activationProgress: null,
  canActivate: true, canSchedule: true, scheduledAtLabel: 'Sep 25, 9:00 AM', ...over,
})

describe('groupLaunchBlockers', () => {
  it('H. five blocker strings for an unnamed, audience-less draft collapse to their two causes', () => {
    const issues = groupLaunchBlockers(REAL_FIVE, { hasName: false })
    expect(issues.map((i) => i.key)).toEqual(['name', 'audience', 'routing'])
    // name + persistence are one cause; eligible targets + contacts match are one cause.
    expect(issues.length).toBeLessThan(REAL_FIVE.length)
  })

  it('every grouped issue names the step that resolves it', () => {
    for (const issue of groupLaunchBlockers(REAL_FIVE, { hasName: false })) {
      expect(issue.step).toBe('build')
    }
  })

  it('"not persisted" with a name is a save problem, not a naming one', () => {
    const [issue] = groupLaunchBlockers(['Campaign not persisted yet'], { hasName: true })
    expect(issue.key).toBe('save')
  })

  it('an unrecognised blocker is passed through, never dropped', () => {
    const issues = groupLaunchBlockers(['Template governance hold on 3 variants'], { hasName: true })
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Template governance hold on 3 variants')
  })

  it('no issue title leaks developer vocabulary', () => {
    for (const issue of groupLaunchBlockers(REAL_FIVE, { hasName: false })) {
      expect(issue.title).not.toMatch(/persist|preview|eligible targets|route for selected/i)
    }
  })
})

describe('deriveLaunchAction', () => {
  it('G/H. a blocked launch never uses a blocker string as the button label', () => {
    const issues = groupLaunchBlockers(REAL_FIVE, { hasName: false })
    const a = deriveLaunchAction(actionInput({ issues, canActivate: false, canSchedule: false }))
    expect(a.kind).toBe('blocked')
    expect(a.label).not.toMatch(/persisted/i)
    expect(a.label).toBe('Name this campaign')
    expect(a).toMatchObject({ intent: 'resolve', step: 'build' })
  })

  it('G. "go" is only ever produced when the canonical gate allows it', () => {
    const refused = deriveLaunchAction(actionInput({ canActivate: false, canSchedule: false }))
    expect(refused.kind).not.toBe('go')
    const allowed = deriveLaunchAction(actionInput())
    expect(allowed).toMatchObject({ kind: 'go', intent: 'activate' })
  })

  it('a future start schedules rather than activates', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const a = deriveLaunchAction(actionInput({ plan: plan({ scheduledAt: future }) }))
    expect(a).toMatchObject({ kind: 'go', intent: 'schedule' })
  })

  it('busy states say what is happening and cannot be pressed through', () => {
    expect(deriveLaunchAction(actionInput({ isPersisting: true }))).toMatchObject({ kind: 'busy', label: 'Saving draft…', intent: 'none' })
    expect(deriveLaunchAction(actionInput({ schedulableLoading: true }))).toMatchObject({ kind: 'busy', intent: 'none' })
  })

  it('zero schedulable names its real cause: a message problem only when it is one', () => {
    const lint = deriveLaunchAction(actionInput({
      schedulable: 0, plan: plan({ schedulable: 0 }), skippedCounts: { TEMPLATE_RENDER_LINT_FAILURE: 12 },
    }))
    expect(lint).toMatchObject({ kind: 'blocked', label: 'Fix message personalization', intent: 'resolve', step: 'build' })

    // 75+ ACQ SCORE, 2026-09-30: 84 ready, 84 skipped sender_blocked_by_operator.
    const senders = deriveLaunchAction(actionInput({
      schedulable: 0, plan: plan({ schedulable: 0 }), skippedCounts: { sender_blocked_by_operator: 84 },
    }))
    expect(senders).toMatchObject({ kind: 'blocked', label: 'No sender number can reach these sellers', intent: 'none' })
    expect(senders.label).not.toMatch(/personaliz/i)
  })

  it('a build that held every seller says so instead of "couldn’t verify"', () => {
    const a = deriveLaunchAction(actionInput({
      schedulable: 0, plan: plan({ schedulable: 0 }), readyAfterBuild: 0, skippedCounts: {},
    }))
    expect(a).toMatchObject({ kind: 'blocked', label: 'No seller is ready to message', step: 'reach' })
  })

  it('a refused build names the filter problem; only a failed check is a retry', () => {
    const unknown = plan({ schedulable: null })
    const refused = deriveLaunchAction(actionInput({
      plan: unknown, schedulable: null,
      preflightError: 'Refusing to build targets: Units Count (No seller in the campaign audience has a value for this field yet).',
    }))
    expect(refused).toMatchObject({ kind: 'blocked', label: 'Remove filters that can’t narrow a campaign', step: 'build' })

    const failed = deriveLaunchAction(actionInput({ plan: unknown, schedulable: null, preflightError: 'Request timed out' }))
    expect(failed).toMatchObject({ kind: 'blocked', label: 'Couldn’t check messages — retry', step: 'reach' })
  })
})

describe('describeNotSchedulable', () => {
  it('names the markets and numbers behind a sender reason', () => {
    const lines = describeNotSchedulable(
      { sender_blocked_by_operator: 84, TEMPLATE_RENDER_LINT_FAILURE: 3 },
      {
        'Miami, FL': {
          targets: 84,
          reason: 'sender_blocked_by_operator',
          senders: [
            { phone_number: '+13058975670', state: 'blocked_by_operator' },
            { phone_number: '+17866052999', state: 'health_cooling' },
            { phone_number: '+13057604780', state: 'status_paused' },
          ],
        },
      },
    )
    expect(lines[0]).toMatchObject({ reason: 'sender_blocked_by_operator', count: 84, label: 'Sender number blocked by an operator' })
    expect(lines[0].details[0]).toBe('Miami, FL (84) — +13058975670 blocked by an operator; +17866052999 cooling; +13057604780 paused')
    expect(lines[1]).toMatchObject({ reason: 'TEMPLATE_RENDER_LINT_FAILURE', details: [] })
  })

  it('a market with no number at all says so', () => {
    const [line] = describeNotSchedulable({ no_local_sender_number: 229 }, {
      'Chicago, IL': { targets: 229, reason: 'no_local_sender_number', senders: [] },
    })
    expect(line.label).toBe('No sender number in their market')
    expect(line.details).toEqual(['Chicago, IL (229) — no sender number in this market'])
  })

  it('zeroSchedulableTitle reads the dominant reason', () => {
    expect(zeroSchedulableTitle({ no_local_sender_number: 5, TEMPLATE_RENDER_LINT_FAILURE: 1 })).toBe('No sender number can reach these sellers')
    expect(zeroSchedulableTitle({})).toBe('No seller can be messaged yet')
  })

  it('held-at-build reasons are words, not codes', () => {
    expect(describeHeldReason('entity_contact_requires_review')).toBe('Entity owner — contact needs review')
    expect(describeHeldReason('some_new_reason')).toBe('Some new reason')
  })
})

describe('deriveLaunchPlan', () => {
  it('the whole cohort is the launch — a worker batch size never caps it', () => {
    // "Yes": 539 ready. The old screen said "Sending to 50" because
    // queue_run_limit is 50; the feeder refills until everyone is messaged.
    const p = plan({ ready: 539, schedulable: 539, effectiveSends: 1000 })
    expect(p.willQueue).toBe(539)
    expect(p).not.toHaveProperty('systemBound')
  })

  it('pace, days and first send come from the server rolling plan when it has answered', () => {
    const p = plan({
      ready: 1000, schedulable: 1000,
      rolling: { schedulable: 1000, sends_per_day: 300, binding: 'sender_capacity', days_to_complete: 4, first_send_at: '2026-10-01T13:00:00.000Z', spread_interval_seconds: 45 },
    })
    expect(p.sendsPerDay).toBe(300)
    expect(p.paceBinding).toBe('sender_capacity')
    expect(p.days).toBe(4)
    expect(p.durationLabel).toBe('about 4 days')
    expect(p.firstSendAt).toBe('2026-10-01T13:00:00.000Z')
    expect(describePace(p)).toBe('300 a day, limited by available sender numbers')
  })

  it('a one-day plan is timed by its spacing', () => {
    // 50 messages 45s apart is ~37 minutes.
    const p = plan({ ready: 50, schedulable: 50, dailyVolume: 750, spacingSeconds: 45 })
    expect(p.days).toBe(1)
    expect(p.durationLabel).toBe('about 37 min')
  })

  it('the campaign’s own send limit binds only when the audience is larger than it', () => {
    expect(plan({ eligibleInAudience: 27_257, maxTargets: 1000 }).capBinds).toBe(true)
    expect(plan({ eligibleInAudience: 800, maxTargets: 1000 }).capBinds).toBe(false)
    expect(plan({}).capBinds).toBe(false)
  })

  it('READY is never substituted for an unknown schedulable count', () => {
    const p = plan({ schedulable: null, ready: 5 })
    expect(p.schedulableKnown).toBe(false)
  })
})

describe('system posture vocabulary', () => {
  it('raw enums become words', () => {
    expect(describeAutoReplyMode('live_limited')).toBe('On, limited')
    expect(describeAutoReplyMode('disabled')).toBe('Off')
    expect(describeAutoReplyMode(null)).toBeNull()
    expect(describeQueueHold('normal')).toBeNull()
    expect(describeQueueHold('scoped_canary_only')).toMatch(/test traffic/)
  })

  it('an IANA timezone becomes the name people use', () => {
    expect(friendlyTimezone('America/Chicago')).toBe('Central')
    expect(friendlyTimezone('America/New_York')).toBe('Eastern')
    expect(friendlyTimezone('Europe/Lisbon')).toBe('Lisbon')
  })
})
