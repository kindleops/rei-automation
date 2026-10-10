/**
 * RUN STATUS (S3 directive P1) — the one vocabulary the dock, spine, rail and
 * shell indicator use for "where is this task": running · waiting on you ·
 * approval needed · blocked · complete (+ failed / cancelled / starting /
 * lost). Pure; derived only from received events and the transport state.
 */
import { isWaiting, type RunSnapshot } from '../runtime/agent-store'
import { isTerminal, progressOf } from './research-model'
import { RUN_STATE_LABEL, runIsTerminal } from './run-model'

export type TaskStatus = 'starting' | 'running' | 'waiting' | 'approval' | 'blocked' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'lost'

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  starting: 'Starting', running: 'Running', waiting: 'Waiting on you', approval: 'Approval needed', blocked: 'Blocked',
  complete: 'Complete', partial: 'Complete · partial', failed: 'Failed', cancelled: 'Cancelled', lost: 'Unavailable',
}

export interface TaskStatusInfo { status: TaskStatus; detail: string | null }

export function taskStatus(s: RunSnapshot): TaskStatusInfo {
  const lv = s.live
  if (lv) {
    if (lv.status === 'starting') return { status: 'starting', detail: 'Creating the run on the server' }
    if (lv.status === 'failed_to_start') return { status: 'failed', detail: lv.error }
    if (lv.status === 'lost' || lv.status === 'refused') return { status: 'lost', detail: lv.error }
  }
  const r = s.research
  if (r) {
    if (r.state === 'cancelled') return { status: 'cancelled', detail: r.summary }
    if (r.state === 'failed') return { status: 'failed', detail: r.error_code ?? r.summary }
    if (r.state === 'completed_partial' || r.state === 'budget_exhausted') return { status: 'partial', detail: r.summary }
    if (isTerminal(r)) return { status: 'complete', detail: r.summary }
    if (r.state === 'draft') return { status: 'waiting', detail: 'Confirm the scope to start' }
    if (r.tasks.some((t) => t.state === 'needs_input')) return { status: 'waiting', detail: r.tasks.find((t) => t.state === 'needs_input')?.question ?? 'A question is waiting' }
    if (lv?.status === 'reconnecting') return { status: 'blocked', detail: `Stream reconnecting — ${lv.error ?? 'the API did not respond'}` }
    const p = progressOf(r)
    if (r.running_count === 0 && p.blocked > 0 && r.phase !== 'synthesizing') return { status: 'blocked', detail: `${p.blocked} source${p.blocked === 1 ? '' : 's'} blocked — continuing via alternatives` }
    if (lv && (lv.status === 'connecting') && !r.event_count) return { status: 'starting', detail: 'Connecting to the run stream' }
    return { status: 'running', detail: r.current?.label ?? null }
  }
  const run = s.run
  if (run) {
    if (run.items.some((i) => (i.kind === 'approval' && i.state === 'requested') || (i.kind === 'plan' && i.state === 'proposed'))) return { status: 'approval', detail: run.state === 'awaiting_plan_approval' ? 'A plan is waiting for your approval' : 'An action is waiting for your approval' }
    if (isWaiting(s)) return { status: 'waiting', detail: RUN_STATE_LABEL[run.state] }
    if (run.state === 'cancelled') return { status: 'cancelled', detail: null }
    if (run.state === 'failed' || run.state === 'expired') return { status: 'failed', detail: RUN_STATE_LABEL[run.state] }
    if (run.state === 'completed_partial' || run.state === 'budget_exhausted') return { status: 'partial', detail: RUN_STATE_LABEL[run.state] }
    if (runIsTerminal(run)) return { status: 'complete', detail: null }
    return { status: 'running', detail: run.current }
  }
  return { status: 'starting', detail: null }
}

/** Needs the operator (sorts first everywhere). */
export const needsOperator = (st: TaskStatus) => st === 'waiting' || st === 'approval'
export const isActiveStatus = (st: TaskStatus) => st === 'starting' || st === 'running' || st === 'blocked' || needsOperator(st)

/** The run the dock should feature: needs-you → running → most recent. */
export function featuredRun(snaps: RunSnapshot[]): RunSnapshot | null {
  let best: { s: RunSnapshot; rank: number } | null = null
  for (const s of snaps) {
    const st = taskStatus(s).status
    const rank = needsOperator(st) ? 3 : isActiveStatus(st) ? 2 : Date.now() - s.record.createdAt < 30 * 60_000 ? 1 : 0
    if (!best || rank > best.rank || (rank === best.rank && s.record.createdAt > best.s.record.createdAt)) best = { s, rank }
  }
  return best && best.rank > 0 ? best.s : null
}
