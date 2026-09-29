/**
 * SIMULATOR — run a workflow graph against fixture or captured facts with NO
 * production writes. Every action calls its capability's `simulate`, never
 * `invoke`. The result shows which nodes execute, which branch each decision
 * takes and why, what actions would be requested, what waits would be
 * created, and how the run ends.
 *
 * scenario = {
 *   trigger: { type, scope: {...} },
 *   facts:   { <conditionKey or nodeId>: { ...canonical facts } },  // per-condition inputs
 *   events:  [{ type, at_hours }],        // events that arrive during waits
 *   approvals: { <nodeId>: 'Approved' | 'Rejected' },
 *   loop_stop_after: { <nodeId>: n }       // stop condition becomes true after n attempts
 * }
 */
import { CAPABILITIES } from './capabilities.js'
import { CONDITIONS, TRIGGERS, evaluateCondition } from './catalog.js'
import { exitsOf, validateGraph } from './graph.js'

const MAX_STEPS = 200

export function simulateGraph(graph, scenario = {}, env = {}) {
  const validation = validateGraph(graph, env)
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]))
  const out = new Map()
  for (const e of graph.edges || []) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e)
  const next = (id, exit = 'Next') => (out.get(id) || []).find((e) => (e.exit || 'Next') === exit)?.to || null

  const path = []
  const actions = []
  const waits = []
  let clock = 0
  let cursor = next('trigger')
  let outcome = 'completed'
  path.push({ node: 'trigger', kind: 'trigger', label: TRIGGERS[graph.trigger?.type]?.label || graph.trigger?.type, at_hours: 0, why: 'Triggering event' })

  let steps = 0
  while (cursor && steps++ < MAX_STEPS) {
    const n = byId.get(cursor)
    if (!n) break
    const c = n.config || {}
    const ctx = { runId: 'simulation', nodeId: n.id, workflowKey: graph.key || 'draft', version: 'draft' }
    if (n.kind === 'action') {
      const cap = CAPABILITIES[c.capability]
      const r = cap ? cap.simulate(c.inputs || {}, ctx) : { status: 'PERMANENT_FAILURE', reason: 'unknown_capability' }
      actions.push({ node: n.id, capability: c.capability, label: cap?.label, preview: r.preview || null, status: r.status, at_hours: clock })
      path.push({ node: n.id, kind: 'action', label: n.label || cap?.label, exit: r.status === 'SUCCESS' ? 'Success' : 'Failed', at_hours: clock, why: r.preview || r.reason })
      cursor = exitsOf(n).includes('Success') ? next(n.id, r.status === 'SUCCESS' ? 'Success' : 'Failed') : next(n.id)
      if (r.status !== 'SUCCESS' && !exitsOf(n).includes('Failed')) { outcome = 'needs_operator'; break }
    } else if (n.kind === 'condition') {
      const facts = { now: Date.now(), ...(scenario.facts?.[n.id] || scenario.facts?.[c.condition] || {}) }
      const given = scenario.facts?.[n.id] || scenario.facts?.[c.condition]
      // pick:'first' (previews) walks each decision's first exit — the branch where the workflow acts.
      const exit = !CONDITIONS[c.condition] ? null : scenario.pick === 'first' && !given ? CONDITIONS[c.condition].exits[0] : evaluateCondition(c.condition, facts)
      path.push({ node: n.id, kind: 'condition', label: n.label || CONDITIONS[c.condition]?.label, exit, at_hours: clock, why: `${CONDITIONS[c.condition]?.reads || 'condition'} → ${exit}` })
      cursor = next(n.id, exit)
    } else if (n.kind === 'wait') {
      if (c.mode === 'event') {
        const ev = (scenario.events || []).filter((e) => e.type === c.event && e.at_hours >= clock).sort((a, b) => a.at_hours - b.at_hours)[0]
        const arrived = ev && ev.at_hours <= clock + Number(c.timeout_hours)
        waits.push({ node: n.id, kind: 'event', event: c.event, from_hours: clock, timeout_hours: Number(c.timeout_hours), resolved: arrived ? 'Event' : 'Timeout' })
        clock = arrived ? ev.at_hours : clock + Number(c.timeout_hours)
        path.push({ node: n.id, kind: 'wait', label: n.label, exit: arrived ? 'Event' : 'Timeout', at_hours: clock, why: arrived ? `${TRIGGERS[c.event]?.label || c.event} arrived` : `No ${TRIGGERS[c.event]?.label || c.event} within ${c.timeout_hours}h` })
        cursor = next(n.id, arrived ? 'Event' : 'Timeout')
      } else {
        const dur = c.mode === 'duration' ? Number(c.duration_hours) : 0
        waits.push({ node: n.id, kind: c.mode, from_hours: clock, duration_hours: dur })
        clock += dur
        path.push({ node: n.id, kind: 'wait', label: n.label, exit: 'Next', at_hours: clock, why: c.mode === 'contact_window' ? 'Deferred to the canonical contact window' : `Waited ${dur}h` })
        cursor = next(n.id)
      }
    } else if (n.kind === 'approval') {
      const decision = scenario.approvals?.[n.id] || 'Approved'
      waits.push({ node: n.id, kind: 'approval', from_hours: clock, title: c.title })
      path.push({ node: n.id, kind: 'approval', label: n.label || c.title, exit: decision, at_hours: clock, why: `Operator ${decision.toLowerCase()} (simulated)` })
      cursor = next(n.id, decision)
    } else if (n.kind === 'follow_up_loop') {
      const stopAfter = scenario.loop_stop_after?.[n.id]
      const cap = CAPABILITIES[c.action?.capability]
      let attempts = 0
      let stopped = false
      for (let i = 0; i < Number(c.max_attempts); i++) {
        if (stopAfter !== undefined && attempts >= stopAfter) { stopped = true; break }
        const r = cap ? cap.simulate(c.action?.inputs || {}, { ...ctx, nodeId: `${n.id}#${i + 1}` }) : { status: 'PERMANENT_FAILURE' }
        actions.push({ node: n.id, attempt: i + 1, capability: c.action?.capability, label: cap?.label, preview: r.preview || null, status: r.status, at_hours: clock })
        attempts++
        clock += Number(c.cadence_hours)
      }
      if (stopAfter !== undefined && attempts >= stopAfter) stopped = true
      path.push({ node: n.id, kind: 'follow_up_loop', label: n.label, exit: stopped ? 'Stopped' : 'Exhausted', at_hours: clock, why: stopped ? `Stop condition met after ${attempts} follow-up${attempts === 1 ? '' : 's'}` : `${attempts} follow-ups sent, no response — maximum reached` })
      cursor = next(n.id, stopped ? 'Stopped' : 'Exhausted')
    } else if (n.kind === 'transform') {
      path.push({ node: n.id, kind: 'transform', label: n.label, exit: 'Next', at_hours: clock, why: c.op })
      cursor = next(n.id)
    } else if (n.kind === 'terminate') {
      outcome = c.outcome || 'completed'
      path.push({ node: n.id, kind: 'terminate', label: n.label || 'End', at_hours: clock, why: outcome })
      cursor = null
    } else {
      cursor = next(n.id)
    }
  }
  if (steps >= MAX_STEPS) outcome = 'aborted_step_limit'
  return { ok: validation.ok, validation, path, actions, waits, outcome, duration_hours: clock, writes: 0 }
}
