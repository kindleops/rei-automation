/**
 * WORKFLOW GRAPH (lc.workflow/v1) — model, validator, description, outline, diff.
 *
 * A definition is data; a published version is immutable data. Node kinds are
 * deliberately few:
 *   action          invoke ONE capability (capabilities.js)
 *   condition       typed canonical condition (catalog.js) → labelled exits
 *   wait            duration | until | event (with timeout) | contact_window
 *   approval        operator decision → Approved / Rejected (/ Timeout)
 *   follow_up_loop  the ONLY way to repeat: action + cadence + max + stop → Stopped / Exhausted
 *   transform       safe typed transforms (no code)
 *   terminate       end with an outcome
 *   annotation      documentation only
 * Edges form a DAG. Variables are references ({ var: 'trigger.seller' } /
 * { var: 'nodes.<id>.<output>' }) resolved at run time, never template code.
 */
import { CAPABILITIES, POLICY } from './capabilities.js'
import { CONDITIONS, TRIGGERS } from './catalog.js'

export const SCHEMA = 'lc.workflow/v1'
export const NODE_KINDS = Object.freeze(['action', 'condition', 'wait', 'approval', 'follow_up_loop', 'transform', 'terminate', 'annotation'])
export const DEFAULT_LIMITS = Object.freeze({ max_actions: 25, max_duration_hours: 24 * 45, max_loop_attempts: 10 })
const TRANSFORMS = new Set(['format_money', 'format_date', 'duration_between', 'map_label', 'pick_first'])

const clean = (v) => String(v ?? '').trim()

export function exitsOf(node) {
  switch (node.kind) {
    case 'condition': return CONDITIONS[node.config?.condition]?.exits || []
    case 'wait': return node.config?.mode === 'event' ? ['Event', 'Timeout'] : ['Next']
    case 'approval': return node.config?.timeout_hours ? ['Approved', 'Rejected', 'Timeout'] : ['Approved', 'Rejected']
    case 'follow_up_loop': return ['Stopped', 'Exhausted']
    case 'action': return node.config?.on_failure === 'branch' ? ['Success', 'Failed'] : ['Next']
    case 'terminate': case 'annotation': return []
    default: return ['Next']
  }
}

function varsIn(value, out = []) {
  if (value && typeof value === 'object') {
    if (typeof value.var === 'string') out.push(value.var)
    else for (const v of Object.values(value)) varsIn(v, out)
  }
  return out
}

/** Every path from the trigger — used for reachability, approval coverage, loops. */
function walk(graph) {
  const out = new Map()
  for (const e of graph.edges || []) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e)
  return out
}

function hasCycle(graph) {
  const out = walk(graph)
  const state = new Map()
  const visit = (id) => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const e of out.get(id) || []) if (visit(e.to)) return true
    state.set(id, 2)
    return false
  }
  return visit('trigger')
}

/** Is `target` reachable from the trigger without passing an approval node? */
function reachableWithoutApproval(graph, target) {
  const out = walk(graph)
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]))
  const seen = new Set()
  const stack = ['trigger']
  while (stack.length) {
    const id = stack.pop()
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    for (const e of out.get(id) || []) {
      // The Approved exit is covered; Rejected / Timeout paths are still unapproved.
      if (node?.kind === 'approval' && e.exit === 'Approved') continue
      stack.push(e.to)
    }
  }
  return false
}

/**
 * Validate a graph for publish. Returns { ok, errors[], warnings[] } where
 * each issue = { code, node, message } — rendered on the canvas and in the
 * publish review. env.emailPlane etc. feed capability availability.
 */
export function validateGraph(graph = {}, env = {}) {
  const errors = []
  const warnings = []
  const err = (code, node, message) => errors.push({ code, node: node || null, message })
  const warn = (code, node, message) => warnings.push({ code, node: node || null, message })
  const nodes = graph.nodes || []
  const edges = graph.edges || []
  const byId = new Map()

  if (graph.schema && graph.schema !== SCHEMA) err('schema', null, `Unsupported schema ${graph.schema}`)
  const trigger = TRIGGERS[graph.trigger?.type]
  if (!trigger) err('trigger_unknown', 'trigger', graph.trigger?.type ? `Unknown trigger “${graph.trigger.type}”` : 'A workflow needs a trigger')

  for (const n of nodes) {
    if (!n.id || n.id === 'trigger') { err('node_id', n.id, 'Every node needs a unique id (not “trigger”)'); continue }
    if (byId.has(n.id)) err('node_duplicate', n.id, `Duplicate node id ${n.id}`)
    byId.set(n.id, n)
    if (!NODE_KINDS.includes(n.kind)) { err('node_kind', n.id, `Unknown node type “${n.kind}”`); continue }
    const c = n.config || {}
    if (n.kind === 'action' || n.kind === 'follow_up_loop') {
      const capKey = n.kind === 'action' ? c.capability : c.action?.capability
      const cap = CAPABILITIES[capKey]
      if (!cap) { err('capability_unknown', n.id, `Unknown action “${capKey || '—'}”`); continue }
      const avail = cap.availability(env)
      if (avail.state === 'UNAVAILABLE') err('capability_unavailable', n.id, `${cap.label} is not available: ${avail.reason}`)
      else if (avail.state === 'CONFIG_REQUIRED') err('capability_config', n.id, `${cap.label} needs configuration: ${avail.reason}`)
      if (cap.policy === POLICY.MANUAL) err('capability_manual_only', n.id, `${cap.label} is manual-only in its owning domain`)
      const inputs = n.kind === 'action' ? c.inputs || {} : c.action?.inputs || {}
      for (const [k, spec] of Object.entries(cap.inputs)) {
        if (spec.required && (inputs[k] === undefined || inputs[k] === null || inputs[k] === '')) err('input_missing', n.id, `${cap.label}: “${k.replace(/_/g, ' ')}” is required`)
        if (spec.type === 'enum' && inputs[k] && typeof inputs[k] === 'string' && !spec.values.includes(inputs[k])) err('input_invalid', n.id, `${cap.label}: “${inputs[k]}” is not a valid ${k.replace(/_/g, ' ')}`)
      }
    }
    if (n.kind === 'condition' && !CONDITIONS[c.condition]) err('condition_unknown', n.id, `Unknown condition “${c.condition || '—'}”`)
    if (n.kind === 'wait') {
      if (!['duration', 'until', 'event', 'contact_window'].includes(c.mode)) err('wait_mode', n.id, 'Wait needs a mode (duration, until, event, contact window)')
      if (c.mode === 'duration' && !(Number(c.duration_hours) > 0)) err('wait_duration', n.id, 'Wait duration must be positive')
      if (c.mode === 'event') {
        if (!TRIGGERS[c.event]) err('wait_event', n.id, `Unknown event “${c.event || '—'}”`)
        if (!(Number(c.timeout_hours) > 0)) err('wait_timeout_missing', n.id, 'Waiting for an event needs a timeout — nothing may wait forever')
      }
    }
    if (n.kind === 'follow_up_loop') {
      if (!(Number(c.max_attempts) >= 1)) err('loop_max', n.id, 'Follow-up loop needs a maximum number of attempts')
      if (Number(c.max_attempts) > (graph.limits?.max_loop_attempts ?? DEFAULT_LIMITS.max_loop_attempts)) err('loop_unbounded', n.id, `At most ${DEFAULT_LIMITS.max_loop_attempts} attempts`)
      if (!(Number(c.cadence_hours) > 0)) err('loop_cadence', n.id, 'Follow-up loop needs a cadence')
      if (!c.stop?.condition && !c.stop?.event) err('loop_stop', n.id, 'Follow-up loop needs a stop condition or stop event')
    }
    if (n.kind === 'approval' && !clean(c.title)) err('approval_title', n.id, 'Approval needs a title the operator will see')
    if (n.kind === 'transform' && !TRANSFORMS.has(c.op)) err('transform_op', n.id, `Unknown transform “${c.op || '—'}” (no custom code in workflows)`)
  }

  // edges + exits
  for (const e of edges) {
    if (e.from !== 'trigger' && !byId.has(e.from)) err('edge_from', e.from, `Edge from unknown node ${e.from}`)
    if (!byId.has(e.to)) err('edge_to', e.to, `Edge to unknown node ${e.to}`)
    const from = byId.get(e.from)
    if (from && !exitsOf(from).includes(e.exit || 'Next')) err('edge_exit', e.from, `“${from.label || from.id}” has no exit “${e.exit || 'Next'}”`)
  }
  if (!edges.some((e) => e.from === 'trigger')) err('trigger_unconnected', 'trigger', 'The trigger does not lead anywhere')
  if (hasCycle({ nodes, edges })) err('cycle', null, 'Workflows cannot loop back — use a Follow-up loop with a maximum and a stop condition')

  // reachability + dead ends
  const out = walk({ edges })
  const reach = new Set()
  const stack = ['trigger']
  while (stack.length) { const id = stack.pop(); if (reach.has(id)) continue; reach.add(id); for (const e of out.get(id) || []) stack.push(e.to) }
  for (const n of nodes) {
    if (n.kind === 'annotation') continue
    if (!reach.has(n.id)) err('unreachable', n.id, `“${n.label || n.id}” can never run`)
    const exits = exitsOf(n)
    const wired = new Set((out.get(n.id) || []).map((e) => e.exit || 'Next'))
    const missing = exits.filter((x) => !wired.has(x))
    if (n.kind === 'condition' || n.kind === 'approval' || (n.kind === 'wait' && n.config?.mode === 'event') || n.kind === 'follow_up_loop') {
      for (const m of missing) err('exit_unwired', n.id, `“${n.label || n.id}” has no path for “${m}”`)
    } else if (exits.length && missing.length === exits.length && n.kind !== 'terminate') {
      warn('implicit_end', n.id, `“${n.label || n.id}” ends the run (add a Terminate to make the outcome explicit)`)
    }
  }

  // approval coverage: APPROVAL-policy actions must sit behind an Approved exit on every path
  for (const n of nodes) {
    const capKey = n.kind === 'action' ? n.config?.capability : n.kind === 'follow_up_loop' ? n.config?.action?.capability : null
    const cap = CAPABILITIES[capKey]
    if (cap?.policy === POLICY.APPROVAL && reachableWithoutApproval({ nodes, edges }, n.id)) err('approval_required', n.id, `${cap.label} requires operator approval — route it through an Approval node`)
  }

  // variables
  const scope = new Set((trigger?.scope || []).map((s) => `trigger.${s}`))
  for (const s of ['seller', 'property', 'opportunity', 'closing', 'campaign', 'recipient']) scope.add(`trigger.${s}`)
  for (const n of nodes) {
    for (const v of varsIn(n.config || {})) {
      if (v.startsWith('trigger.')) { if (!scope.has(v) && !scope.has(v.split('.').slice(0, 2).join('.'))) err('var_unknown', n.id, `Unknown variable ${v}`) }
      else if (v.startsWith('nodes.')) { const [, id] = v.split('.'); if (!byId.has(id)) err('var_unknown', n.id, `Variable ${v} refers to a missing step`) }
      else if (!v.startsWith('system.')) err('var_unknown', n.id, `Unknown variable ${v}`)
    }
  }

  const actions = nodes.filter((n) => n.kind === 'action' || n.kind === 'follow_up_loop').length
  if (actions > (graph.limits?.max_actions ?? DEFAULT_LIMITS.max_actions)) err('limit_actions', null, `Too many actions (${actions})`)
  if (!nodes.some((n) => n.kind === 'terminate')) warn('no_terminate', null, 'No explicit Terminate — runs end silently at the last step')
  return { ok: errors.length === 0, errors, warnings }
}

const hours = (h) => (h % 24 === 0 && h >= 24 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`)

function nodeSentence(n) {
  const c = n.config || {}
  switch (n.kind) {
    case 'action': return (CAPABILITIES[c.capability]?.label || c.capability || 'act').replace(/^./, (x) => x.toLowerCase())
    case 'condition': return `check “${CONDITIONS[c.condition]?.label || c.condition}”`
    case 'wait': return c.mode === 'event' ? `wait up to ${hours(Number(c.timeout_hours))} for “${TRIGGERS[c.event]?.label || c.event}”` : c.mode === 'duration' ? `wait ${hours(Number(c.duration_hours))}` : c.mode === 'contact_window' ? 'wait for the contact window' : `wait until ${c.until}`
    case 'approval': return `ask for operator approval (“${c.title}”)`
    case 'follow_up_loop': return `${(CAPABILITIES[c.action?.capability]?.label || 'follow up').toLowerCase()} every ${hours(Number(c.cadence_hours))}, up to ${c.max_attempts} time${Number(c.max_attempts) === 1 ? '' : 's'}, stopping when ${c.stop?.label || CONDITIONS[c.stop?.condition]?.label || TRIGGERS[c.stop?.event]?.label || 'its stop condition is met'}`
    case 'transform': return `${String(c.op).replace(/_/g, ' ')}`
    case 'terminate': return `end (${c.outcome || 'completed'})`
    default: return ''
  }
}

/** Plain-English description generated from topology — deterministic, no AI prose. */
export function describeGraph(graph = {}) {
  const trig = TRIGGERS[graph.trigger?.type]?.label || graph.trigger?.type || 'triggered'
  const order = topoOrder(graph).map((id) => graph.nodes.find((n) => n.id === id)).filter((n) => n && n.kind !== 'annotation' && n.kind !== 'terminate')
  const parts = order.map(nodeSentence).filter(Boolean)
  if (!parts.length) return `When ${trig.toLowerCase()}, this workflow does nothing yet.`
  const last = parts.length > 1 ? `, and ${parts.pop()}` : ''
  return `When ${trig.toLowerCase()}, this workflow will ${parts.join(', ')}${last}.`
}

export function topoOrder(graph = {}) {
  const out = walk(graph)
  const order = []
  const seen = new Set()
  const queue = ['trigger']
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    if (id !== 'trigger') order.push(id)
    for (const e of out.get(id) || []) queue.push(e.to)
  }
  return order
}

/** Numbered outline for mobile / accessibility. */
export function outlineGraph(graph = {}) {
  const out = walk(graph)
  const lines = [{ n: 1, id: 'trigger', text: `When ${(TRIGGERS[graph.trigger?.type]?.label || graph.trigger?.type || '—').toLowerCase()}` }]
  topoOrder(graph).forEach((id, i) => {
    const node = graph.nodes.find((x) => x.id === id)
    if (!node || node.kind === 'annotation') return
    const exits = (out.get(id) || []).filter((e) => (e.exit || 'Next') !== 'Next')
    lines.push({ n: i + 2, id, text: nodeSentence(node).replace(/^./, (x) => x.toUpperCase()), exits: exits.map((e) => ({ exit: e.exit, to: e.to })) })
  })
  return lines
}

/** Business-readable diff between two versions (spec §87). */
export function diffGraphs(a = {}, b = {}) {
  const changes = []
  if (a.trigger?.type !== b.trigger?.type) changes.push({ kind: 'trigger', text: `Trigger: ${TRIGGERS[a.trigger?.type]?.label || a.trigger?.type || '—'} → ${TRIGGERS[b.trigger?.type]?.label || b.trigger?.type}` })
  const A = new Map((a.nodes || []).map((n) => [n.id, n]))
  const B = new Map((b.nodes || []).map((n) => [n.id, n]))
  for (const [id, n] of B) if (!A.has(id)) changes.push({ kind: 'added', node: id, text: `Added: ${n.label || nodeSentence(n)}` })
  for (const [id, n] of A) if (!B.has(id)) changes.push({ kind: 'removed', node: id, text: `Removed: ${n.label || nodeSentence(n)}` })
  for (const [id, nb] of B) {
    const na = A.get(id)
    if (!na) continue
    const ca = na.config || {}
    const cb = nb.config || {}
    const label = nb.label || id
    const cmp = (k, fmt = (x) => x) => { if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) changes.push({ kind: 'changed', node: id, text: `${label}: ${k.replace(/_/g, ' ')} ${fmt(ca[k]) ?? '—'} → ${fmt(cb[k]) ?? '—'}` }) }
    for (const k of ['duration_hours', 'timeout_hours', 'cadence_hours']) cmp(k, (x) => (x ? hours(Number(x)) : x))
    for (const k of ['max_attempts', 'capability', 'condition', 'event', 'mode', 'title', 'outcome']) cmp(k)
    const ia = JSON.stringify(ca.inputs || ca.action?.inputs || {})
    const ib = JSON.stringify(cb.inputs || cb.action?.inputs || {})
    if (ia !== ib) {
      const pa = ca.inputs || ca.action?.inputs || {}
      const pb = cb.inputs || cb.action?.inputs || {}
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) changes.push({ kind: 'changed', node: id, text: `${label}: ${k.replace(/_/g, ' ')} ${fmtVal(pa[k])} → ${fmtVal(pb[k])}` })
      }
    }
  }
  const ea = new Set((a.edges || []).map((e) => `${e.from}>${e.exit || 'Next'}>${e.to}`))
  const eb = new Set((b.edges || []).map((e) => `${e.from}>${e.exit || 'Next'}>${e.to}`))
  const rewired = [...eb].filter((x) => !ea.has(x)).length + [...ea].filter((x) => !eb.has(x)).length
  if (rewired) changes.push({ kind: 'routing', text: `Routing changed (${rewired} connection${rewired === 1 ? '' : 's'})` })
  return changes
}
const fmtVal = (v) => (v === undefined ? '—' : v && typeof v === 'object' && v.var ? `{${v.var}}` : JSON.stringify(v))
