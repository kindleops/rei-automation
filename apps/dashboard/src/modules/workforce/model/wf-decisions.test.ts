import { describe, expect, it } from 'vitest'
import { classifyWf, type WfResult } from '../api/wf-client'
import { normalizeAssignment, normalizeResolve } from '../api/wf-normalize'
import type { WfAssignment, WfEmployee, WfResolveResult } from '../api/wf-types'
import {
  DECISION_SCOPE_NOTE, RECORDED_TTL_MS, beginDecision, decisionFailureText, decisionHint, decisionOptions, decisionView, dismissDecision, pruneDecisions, settleDecision,
  type DecisionMap,
} from './wf-decisions'

const A = (o: Record<string, unknown>): WfAssignment => normalizeAssignment({ mission_id: 'wfm_1', capability_key: 'work.assign', status: 'waiting_approval', assignee_employee_id: 'emp_ceo', ...o })!
const emps = new Map<string, Pick<WfEmployee, 'kind'>>([['emp_ceo', { kind: 'human' }], ['emp_coo', { kind: 'ai' }], ['emp_staff', { kind: 'human' }]])
const esc = A({ assignment_id: 'wfa_esc', input: { follow_on: true, task: 'escalation', property_ref: 'pid_nggggggghh' } })
const review = A({ assignment_id: 'wfa_rev', input: { follow_on: true, task: 'review_offer_recommendation' } })
const opReview = A({ assignment_id: 'wfa_op', input: { follow_on: true, task: 'operator_review' } })

const SERVER_OK = (o: Record<string, unknown> = {}): WfResult<WfResolveResult> => ({
  ok: true,
  fixture: false,
  data: normalizeResolve({
    assignment: { ...esc, status: 'completed', outcome_class: 'verified', output: { decision: 'approve' } },
    decision: 'approve',
    outcome: { headline: 'Recorded: you approved the executive review of property 7000000011.', next_step: 'x', message: 'Recorded: you approved the executive review of property 7000000011. It is cleared past the executive threshold inside Workforce only. Nothing was sent, no offer was made and no stage changed.', effects: { recorded_in_workforce: true, seller_contacted: false, offer_made: false, stage_changed: false, runtime_job_started: false, work_created: false } },
    messages: [{ message_id: 'm1', author: 'coo', content: 'Noted', created_at: '2026-10-21T15:00:00.000Z' }],
    replayed: false,
    ...o,
  }),
})

describe('decision options', () => {
  it('an escalation offers Approve / Decline; an offer-recommendation review adds Done; other reviews are Mark done / Decline', () => {
    expect(decisionOptions(esc, emps)?.map((o) => o.decision)).toEqual(['approve', 'decline'])
    expect(decisionOptions(review, emps)?.map((o) => o.decision)).toEqual(['approve', 'decline', 'done'])
    expect(decisionOptions(opReview, emps)?.map((o) => o.label)).toEqual(['Mark done', 'Decline'])
    expect(decisionOptions(esc, emps)?.filter((o) => o.primary).length).toBe(1)
  })
  it('only a waiting item in a PERSON\'s queue is decidable here', () => {
    expect(decisionOptions({ ...esc, status: 'completed' }, emps)).toBeNull()
    expect(decisionOptions({ ...esc, status: 'blocked' }, emps)).toBeNull()
    expect(decisionOptions({ ...esc, assignee_employee_id: 'emp_coo' }, emps)).toBeNull()
    expect(decisionOptions({ ...esc, assignee_employee_id: null }, emps)).toBeNull()
    expect(decisionOptions({ ...esc, assignee_employee_id: 'emp_staff' }, emps)).not.toBeNull()
    // without the org loaded, only the CEO row is assumed human
    expect(decisionOptions(esc)).not.toBeNull()
    expect(decisionOptions({ ...esc, assignee_employee_id: 'emp_x' })).toBeNull()
  })
  it('every hint says the decision is recorded in Workforce only and nothing is sent', () => {
    for (const a of [esc, review, opReview]) for (const o of decisionOptions(a, emps)!) {
      const h = decisionHint(o.decision, a)
      expect(h.endsWith(DECISION_SCOPE_NOTE)).toBe(true)
      expect(h).not.toMatch(/\b(will|we'll) (send|text|offer|contact|launch)\b/i)
    }
    expect(DECISION_SCOPE_NOTE).toBe('Records your decision in Workforce only. Nothing is sent, no offer is made and no stage changes.')
  })
})

describe('optimistic, reconciled decision state', () => {
  it('begin → recording at once; a second click while in flight changes nothing', () => {
    const m1 = beginDecision({}, esc, 'approve', 1000)
    expect(m1.wfa_esc.phase).toBe('recording')
    expect(beginDecision(m1, esc, 'decline', 1001)).toBe(m1)
    const v = decisionView([esc, review], m1, 1002)
    expect(v.open.map((r) => [r.a.assignment_id, r.state?.phase ?? null])).toEqual([['wfa_esc', 'recording'], ['wfa_rev', null]])
    expect(v.recorded).toEqual([])
  })
  it('a server success records the SERVER\'s row and message verbatim; the item leaves the open list even while the list is stale', () => {
    const m = settleDecision(beginDecision({}, esc, 'approve', 1000), 'wfa_esc', SERVER_OK(), 1100)
    expect(m.wfa_esc.phase).toBe('recorded')
    expect(m.wfa_esc.item.status).toBe('completed')
    expect(m.wfa_esc.message).toMatch(/Nothing was sent, no offer was made and no stage changed\.$/)
    const stale = decisionView([esc, review], m, 2000) // the list still says waiting_approval
    expect(stale.open.map((r) => r.a.assignment_id)).toEqual(['wfa_rev'])
    expect(stale.recorded.map((s) => s.item.assignment_id)).toEqual(['wfa_esc'])
    expect(beginDecision(m, esc, 'decline', 2001)).toBe(m) // recorded is final
  })
  it('a replay answer is recorded and marked as already recorded', () => {
    const m = settleDecision(beginDecision({}, esc, 'approve', 1), 'wfa_esc', SERVER_OK({ replayed: true, messages: [] }), 2)
    expect(m.wfa_esc.replayed).toBe(true)
  })
  it('a server failure puts the item back with the classified reason; a retry is allowed', () => {
    const f = classifyWf(403, 'CEO_ONLY', 'Only the CEO decides items in the CEO queue.')
    const m = settleDecision(beginDecision({}, esc, 'approve', 1), 'wfa_esc', f, 2)
    expect(m.wfa_esc.phase).toBe('failed')
    const v = decisionView([esc], m, 3)
    expect(v.open[0].state?.phase).toBe('failed')
    expect(decisionFailureText(m.wfa_esc.failure!)).toBe('Only the CEO (the owner) can decide items in this queue.')
    expect(beginDecision(m, esc, 'approve', 4).wfa_esc.phase).toBe('recording')
    expect(decisionFailureText(classifyWf(409, 'CONFLICT', 'x'))).toMatch(/already decided differently/)
    expect(decisionFailureText(classifyWf(409, 'ILLEGAL_TRANSITION', 'x'))).toBe('This item is no longer waiting for you.')
    expect(decisionFailureText(classifyWf(503, 'WORKFORCE_DB_UNAVAILABLE', 'The workforce store is unavailable.'))).toBe('The workforce store is unavailable.')
  })
  it('the server is the truth: a failed item the server no longer lists as waiting drops out; recorded lines expire; dismiss removes', () => {
    const failed = settleDecision(beginDecision({}, esc, 'approve', 1), 'wfa_esc', classifyWf(503, null, 'down'), 2)
    expect(decisionView([{ ...esc, status: 'completed' }], failed, 3).open).toEqual([])
    const rec = settleDecision(beginDecision({}, esc, 'approve', 1000), 'wfa_esc', SERVER_OK(), 1000)
    expect(pruneDecisions(rec, 1000 + RECORDED_TTL_MS - 1)).toBe(rec)
    const pruned = pruneDecisions(rec, 1000 + RECORDED_TTL_MS + 1)
    expect(pruned).toEqual({})
    // after expiry the server list alone decides what is open (a still-waiting row reappears: never hidden forever)
    expect(decisionView([esc], rec, 1000 + RECORDED_TTL_MS + 1).open.map((r) => r.a.assignment_id)).toEqual(['wfa_esc'])
    expect(dismissDecision(rec, 'wfa_esc')).toEqual({})
    expect(dismissDecision(rec, 'nope')).toBe(rec)
  })
  it('a settle for an unknown id changes nothing; without a server message only the certain sentence is shown', () => {
    const m: DecisionMap = {}
    expect(settleDecision(m, 'x', SERVER_OK(), 1)).toBe(m)
    const r = SERVER_OK()
    if (r.ok) r.data.outcome.message = null
    const s = settleDecision(beginDecision({}, esc, 'approve', 1), 'wfa_esc', r, 2)
    expect(s.wfa_esc.message).toBe('Recorded in Workforce. Nothing was sent, no offer was made and no stage changed.')
  })
})

describe('normalizeResolve', () => {
  it('effects are all-or-nothing (an effect the server did not state is unknown, never assumed false)', () => {
    expect(normalizeResolve({ outcome: { effects: { recorded_in_workforce: true } } }).outcome.effects).toBeNull()
    const r = SERVER_OK()
    expect(r.ok && r.data.outcome.effects?.offer_made).toBe(false)
    expect(r.ok && r.data.decision).toBe('approve')
    expect(normalizeResolve({ decision: 'send' }).decision).toBeNull()
    expect(normalizeResolve({}).replayed).toBe(false)
  })
})
