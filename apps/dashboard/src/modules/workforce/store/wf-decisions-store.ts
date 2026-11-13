/**
 * WORKFORCE — one decision state for the whole app (the "Needs you" rail and
 * the Work Queue show the same item, so they share it). A tiny external store
 * over the pure model in model/wf-decisions.ts; the transport is
 * resolveAssignment (CEO only; records the decision in Workforce only).
 */
import { useCallback, useSyncExternalStore } from 'react'
import { resolveAssignment } from '../api/wf-client'
import type { WfAssignment, WfDecision } from '../api/wf-types'
import { beginDecision, dismissDecision, settleDecision, type DecisionMap } from '../model/wf-decisions'

let state: DecisionMap = {}
const subs = new Set<() => void>()
const set = (next: DecisionMap) => { if (next !== state) { state = next; for (const f of subs) f() } }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const snapshot = () => state

/** Tests only. */
export function __resetWfDecisions() { state = {} }

export function useWfDecisions(onSettled?: () => void) {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot)
  const decide = useCallback(async (item: WfAssignment, decision: WfDecision) => {
    const begun = beginDecision(state, item, decision, Date.now())
    if (begun === state) return // already in flight or already recorded
    set(begun)
    const res = await resolveAssignment(item.assignment_id, decision)
    set(settleDecision(state, item.assignment_id, res, Date.now()))
    onSettled?.()
  }, [onSettled])
  const dismiss = useCallback((id: string) => set(dismissDecision(state, id)), [])
  return { map, decide, dismiss }
}
