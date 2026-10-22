/**
 * WORKFORCE — the CEO queue decision model (pure; no React, no transport).
 *
 * An item parked for the CEO (an escalation, an offer-recommendation review,
 * an underwriting or operator review) is decided with POST
 * /assignments/[id]/resolve. The decision is RECORDED inside Workforce and
 * nothing else happens: no seller message, no offer, no stage change. The
 * copy here never implies otherwise; after a decision the UI shows the
 * server's own outcome text, never a client-made one.
 *
 * Optimistic but reconciled: a click marks the item `recording` at once; the
 * server's answer settles it (`recorded` with the server's assignment and
 * message, or `failed` with the classified failure, which puts the item back
 * with the reason and a retry). A recorded item stays hidden from the open
 * list while the server list may still be stale, then it is pruned and the
 * server list is the only truth again.
 */
import type { WfFailure, WfResult } from '../api/wf-client'
import type { WfAssignment, WfDecision, WfEmployee, WfResolveResult } from '../api/wf-types'

export interface DecisionOption { decision: WfDecision; label: string; primary: boolean }

/** Shown beside the buttons and in their titles: what a decision does, exactly. */
export const DECISION_SCOPE_NOTE = 'Records your decision in Workforce only. Nothing is sent, no offer is made and no stage changes.'
/** The same, for a narrow card (the button titles carry the full sentence). */
export const DECISION_SCOPE_TERSE = 'Recorded in Workforce only. Nothing is sent.'

const TASK_OF = (a: Pick<WfAssignment, 'input'>): string | null => (typeof a.input?.task === 'string' ? a.input.task : null)

/** Which decisions a queued item offers (null: it is not the CEO's to decide here). */
export function decisionOptions(a: Pick<WfAssignment, 'status' | 'assignee_employee_id' | 'input'>, employees?: ReadonlyMap<string, Pick<WfEmployee, 'kind'>>): DecisionOption[] | null {
  if (a.status !== 'waiting_approval' || !a.assignee_employee_id) return null
  const who = employees?.get(a.assignee_employee_id)
  // a person's queue only (the server re-checks: owner session, human assignee)
  const human = who ? who.kind === 'human' : a.assignee_employee_id === 'emp_ceo'
  if (!human) return null
  switch (TASK_OF(a)) {
    case 'escalation':
      return [{ decision: 'approve', label: 'Approve', primary: true }, { decision: 'decline', label: 'Decline', primary: false }]
    case 'review_offer_recommendation':
      return [{ decision: 'approve', label: 'Approve', primary: true }, { decision: 'decline', label: 'Decline', primary: false }, { decision: 'done', label: 'Done', primary: false }]
    default:
      return [{ decision: 'done', label: 'Mark done', primary: true }, { decision: 'decline', label: 'Decline', primary: false }]
  }
}

/** The button title: what this decision records (the server's message replaces it once recorded). */
export function decisionHint(decision: WfDecision, a: Pick<WfAssignment, 'input'>): string {
  const task = TASK_OF(a)
  const what = task === 'escalation' ? 'the executive review' : task === 'review_offer_recommendation' ? 'the offer recommendation review' : task === 'underwrite_review' ? 'the underwriting review' : task === 'operator_review' ? 'the operator review' : 'this item'
  const verb = decision === 'approve' ? 'Approve' : decision === 'decline' ? 'Decline' : 'Close'
  return `${verb} ${what}. ${DECISION_SCOPE_NOTE}`
}

/* ── optimistic state ─────────────────────────────────────────────────── */

export type DecisionPhase = 'recording' | 'recorded' | 'failed'
export interface DecisionState {
  phase: DecisionPhase
  decision: WfDecision
  at: number
  /** the item as last seen (kept so a recorded confirmation outlives the stale list row) */
  item: WfAssignment
  /** the server's outcome text (recorded) */
  message: string | null
  replayed: boolean
  failure: WfFailure | null
}
export type DecisionMap = Readonly<Record<string, DecisionState>>

/** How long a recorded confirmation stays in the panel before the server list is the only truth again. */
export const RECORDED_TTL_MS = 45_000

export function beginDecision(map: DecisionMap, item: WfAssignment, decision: WfDecision, now: number): DecisionMap {
  const cur = map[item.assignment_id]
  if (cur?.phase === 'recording' || cur?.phase === 'recorded') return map // one decision in flight per item; a recorded one is final
  return { ...map, [item.assignment_id]: { phase: 'recording', decision, at: now, item, message: null, replayed: false, failure: null } }
}

export function settleDecision(map: DecisionMap, id: string, res: WfResult<WfResolveResult>, now: number): DecisionMap {
  const cur = map[id]
  if (!cur) return map
  if (!res.ok) return { ...map, [id]: { ...cur, phase: 'failed', at: now, failure: res, message: null } }
  const item = res.data.assignment ?? { ...cur.item, status: 'completed' }
  // the server's text, verbatim; without one, say only what is certain
  const message = res.data.outcome.message ?? 'Recorded in Workforce. Nothing was sent, no offer was made and no stage changed.'
  return { ...map, [id]: { ...cur, phase: 'recorded', at: now, item, message, replayed: res.data.replayed, failure: null } }
}

export function dismissDecision(map: DecisionMap, id: string): DecisionMap {
  if (!(id in map)) return map
  const next = { ...map }
  delete next[id]
  return next
}

/** Drop recorded confirmations past their TTL (failed ones stay until retried or dismissed). */
export function pruneDecisions(map: DecisionMap, now: number): DecisionMap {
  const stale = Object.entries(map).filter(([, s]) => s.phase === 'recorded' && now - s.at > RECORDED_TTL_MS).map(([k]) => k)
  if (!stale.length) return map
  const next = { ...map }
  for (const k of stale) delete next[k]
  return next
}

export interface QueueRow { a: WfAssignment; state: DecisionState | null }

/**
 * The panel's rows: the server's open items with any local state beside them (recording / failed), and
 * the recorded confirmations separately. A recorded item is never shown as still open, even when a stale
 * list still carries it; a server row that the server reports as no longer waiting drops any local
 * failure (the server moved on: e.g. decided in another window).
 */
export function decisionView(serverRows: ReadonlyArray<WfAssignment>, map: DecisionMap, now: number): { open: QueueRow[]; recorded: DecisionState[] } {
  const live = pruneDecisions(map, now)
  const open: QueueRow[] = []
  for (const a of serverRows) {
    const s = live[a.assignment_id] ?? null
    if (s?.phase === 'recorded') continue
    if (s?.phase === 'failed' && a.status !== 'waiting_approval') continue
    open.push({ a, state: s })
  }
  const recorded = Object.values(live).filter((s) => s.phase === 'recorded').sort((x, y) => y.at - x.at)
  return { open, recorded }
}

/** A failure in the words the CEO needs (the classified failure already says the truth; a few get context). */
export function decisionFailureText(f: WfFailure): string {
  if (f.state === 'denied') return 'Only the CEO (the owner) can decide items in this queue.'
  if (f.code === 'CONFLICT') return 'This item was already decided differently. Reload to see the recorded decision.'
  if (f.code === 'ILLEGAL_TRANSITION') return 'This item is no longer waiting for you.'
  if (f.state === 'not_enabled') return 'Workforce is not enabled on this server.'
  return f.message
}
