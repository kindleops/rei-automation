import { describe, expect, it } from 'vitest'
import {
  deriveLaunchAction,
  deriveLaunchPlan,
  describeAutoReplyMode,
  describeQueueHold,
  friendlyTimezone,
  groupLaunchBlockers,
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
  effectiveSends: 1000, dailyVolume: 750, spacingSeconds: 45, runLimit: null,
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

  it('zero schedulable is a message problem, and says so', () => {
    const a = deriveLaunchAction(actionInput({ schedulable: 0, plan: plan({ schedulable: 0 }) }))
    expect(a).toMatchObject({ kind: 'blocked', label: 'Fix message personalization' })
  })
})

describe('deriveLaunchPlan', () => {
  it('the smallest cap binds, and the plan says which', () => {
    const p = plan({ ready: 14_147, effectiveSends: 1000, runLimit: 50, schedulable: 900 })
    expect(p.willQueue).toBe(50)
    expect(p.systemBound).toBe(true)
    expect(p.capBinds).toBe(true)
  })

  it('duration comes from what will actually queue, not the discarded cap', () => {
    // 50 messages 45s apart is ~37 minutes, not "~2 days" from a 1,000 cap.
    const p = plan({ effectiveSends: 1000, runLimit: 50, schedulable: 900, dailyVolume: 750, spacingSeconds: 45 })
    expect(p.durationLabel).toBe('about 37 min')
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
