import { describe, expect, it } from 'vitest'
import { approvalDiff, proposalsFor, STAGE_OPTIONS } from './act-model'
import { chipsForContext, EMPTY_PAGE } from './context-model'
import { derivePresence } from './presence'

const CATALOG = [
  { id: 'pipeline.propose_stage_change', version: 1, domain: 'pipeline', title: '', side_effect: 'internal_write', tier: 'requires_explicit_approval', service: null, approval_class: 'pipeline', limits: null },
  { id: 'campaigns.prepare_launch_approval', version: 1, domain: 'campaigns', title: '', side_effect: 'outbound_prepare', tier: 'requires_explicit_approval', service: null, approval_class: 'campaign_launch', limits: null },
]

describe('Act proposals', () => {
  const page = { ...EMPTY_PAGE, app: 'pipeline', instanceId: 'p', deal: { opportunityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }
  it('a deal chip proposes a stage change with exactly the server input schema', () => {
    const [p] = proposalsFor(chipsForContext(page), CATALOG)
    expect(p.capability_id).toBe('pipeline.propose_stage_change')
    expect(p.available).toBe(true)
    expect(p.build({ to_stage: 'offer' }, 'no')).toBeNull() // reason < 3 chars
    expect(p.build({ to_stage: 'offer' }, 'Seller asked for a number')).toEqual({ opportunity_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', to_stage: 'offer', reason: 'Seller asked for a number' })
  })
  it('a capability missing from the server matrix is shown unavailable, never faked', () => {
    const [p] = proposalsFor(chipsForContext(page), [])
    expect(p.available).toBe(false)
    expect(p.why).toMatch(/capability matrix/)
  })
  it('closed is never proposable (closing authority only)', () => {
    expect(STAGE_OPTIONS as readonly string[]).not.toContain('closed')
  })
  it('a seller thread cannot prepare a reply from the page (no sealed ref)', () => {
    const t = proposalsFor(chipsForContext({ ...EMPTY_PAGE, app: 'inbox', instanceId: 'i', thread: { key: '+15550001111' } }), CATALOG)
    expect(t[0].capability_id).toBe('inbox.prepare_reply')
    expect(t[0].available).toBe(false)
  })
})

describe('the diff card shows the exact before → after', () => {
  it('stage change: from_stage → to_stage, reason as context', () => {
    const rows = approvalDiff({ capability_id: 'pipeline.propose_stage_change', target: {}, preview: null, intended_change: { action: 'stage_change', opportunity_id: 'o1', from_stage: 'asking_price', to_stage: 'offer', reason: 'Seller asked for a number' } })
    expect(rows[0]).toEqual({ field: 'stage', before: 'asking_price', after: 'offer', kind: 'change' })
    expect(rows.find((r) => r.field === 'reason')?.after).toBe('Seller asked for a number')
    expect(rows.some((r) => r.field === 'action')).toBe(false)
  })
  it('campaign launch: status draft → active / scheduled', () => {
    const now = approvalDiff({ capability_id: 'campaigns.prepare_launch_approval', target: {}, preview: null, intended_change: { action: 'launch', campaign_id: 'c', from_status: 'draft', start: { mode: 'now', at: null }, expected_eligible: null } })
    expect(now[0]).toEqual({ field: 'status', before: 'draft', after: 'active · starting now', kind: 'change' })
    const at = approvalDiff({ capability_id: 'campaigns.prepare_launch_approval', target: {}, preview: null, intended_change: { action: 'launch', campaign_id: 'c', from_status: 'draft', start: { mode: 'at', at: '2026-10-15T14:00:00Z' } } })
    expect(at[0].after).toBe('scheduled · 2026-10-15T14:00:00Z')
  })
  it('template reply: the exact rendered text from the display preview', () => {
    const rows = approvalDiff({ capability_id: 'inbox.prepare_reply', target: {}, preview: { message_text: 'Hi Dana — would you consider an offer?', recipient_mask: '••4471', sender_mask: '••0918' }, intended_change: { action: 'send_template_reply', template_id: 'S2', rendered_hash: 'x', rendered_chars: 38, sender_hash: 'y' } })
    expect(rows.find((r) => r.field === 'message')).toEqual({ field: 'message', before: null, after: 'Hi Dana — would you consider an offer?', kind: 'add' })
    expect(rows.find((r) => r.field === 'route')?.after).toBe('to ••4471 from ••0918')
    expect(JSON.stringify(rows)).not.toContain('rendered_hash')
  })
})

describe('presence', () => {
  const t = { metrics: {} as never, runtimes: [{ key: 'q', name: 'Queue processor', owner_href: null, status: 'on', heartbeat_at: new Date(1_000_000).toISOString(), heartbeat_state: 'fresh', cadence: '*/1', last_run_at: null, runs_24h: 1, needs_you: 0, in_flight: 0 }] }
  const now = 1_000_000 + 30_000
  it('idle / investigating / awaiting approval / problem, by priority', () => {
    expect(derivePresence({ now, telemetry: t, telemetryError: false, activeRuns: 0, pendingApprovals: 0, lastRunProblem: null }).state).toBe('idle')
    expect(derivePresence({ now, telemetry: t, telemetryError: false, activeRuns: 2, pendingApprovals: 0, lastRunProblem: null }).state).toBe('investigating')
    expect(derivePresence({ now, telemetry: t, telemetryError: false, activeRuns: 2, pendingApprovals: 1, lastRunProblem: null }).state).toBe('awaiting_approval')
    expect(derivePresence({ now, telemetry: t, telemetryError: false, activeRuns: 2, pendingApprovals: 1, lastRunProblem: 'Last run: Model provider error' }).state).toBe('problem')
  })
  it('a delayed runtime heartbeat is a problem; unreachable telemetry is a problem', () => {
    const late = derivePresence({ now, telemetry: { ...t, runtimes: [{ ...t.runtimes[0], heartbeat_state: 'stale' }] }, telemetryError: false, activeRuns: 0, pendingApprovals: 0, lastRunProblem: null })
    expect(late.state).toBe('problem')
    expect(late.detail).toMatch(/Queue processor heartbeat delayed/)
    expect(derivePresence({ now, telemetry: null, telemetryError: true, activeRuns: 0, pendingApprovals: 0, lastRunProblem: null }).state).toBe('problem')
  })
  it('an unreadable approvals plane is unknown, never "0 pending"', () => {
    const p = derivePresence({ now, telemetry: t, telemetryError: false, activeRuns: 0, pendingApprovals: null, lastRunProblem: null })
    expect(p.state).toBe('idle')
    expect(p.unknown).toEqual(['approvals'])
    expect(p.detail).toMatch(/approvals not readable/)
  })
})
