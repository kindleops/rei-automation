import test from 'node:test'
import assert from 'node:assert/strict'

import { validateGraph, describeGraph, outlineGraph, diffGraphs } from '@/lib/domain/workflow-studio/orchestrator/graph.js'
import { simulateGraph } from '@/lib/domain/workflow-studio/orchestrator/simulator.js'
import { CAPABILITIES, capabilityCatalog } from '@/lib/domain/workflow-studio/orchestrator/capabilities.js'
import { evaluateCondition } from '@/lib/domain/workflow-studio/orchestrator/catalog.js'

// The first bounded workflow (spec §145): a seller conversation that needs review
// and is still open 4h later → notify the operator. Send-incapable by construction.
const escalation = () => ({
  schema: 'lc.workflow/v1',
  key: 'review_escalation',
  trigger: { type: 'seller_needs_review' },
  nodes: [
    { id: 'wait', kind: 'wait', label: 'Give the team 4 hours', config: { mode: 'duration', duration_hours: 4 } },
    { id: 'open', kind: 'condition', label: 'Still needs a human?', config: { condition: 'seller.conversation_open' } },
    { id: 'notify', kind: 'action', label: 'Escalate', config: { capability: 'notify.operator', inputs: { event_type: 'inbox_needs_call', title: 'Seller waiting on review', entity: { var: 'trigger.thread_key' } } } },
    { id: 'end_escalated', kind: 'terminate', config: { outcome: 'escalated' } },
    { id: 'end_handled', kind: 'terminate', config: { outcome: 'handled' } },
  ],
  edges: [
    { from: 'trigger', to: 'wait' },
    { from: 'wait', to: 'open' },
    { from: 'open', exit: 'Open', to: 'notify' },
    { from: 'open', exit: 'Handled', to: 'end_handled' },
    { from: 'notify', to: 'end_escalated' },
  ],
})

const codes = (r) => r.errors.map((e) => e.code)

test('the bounded escalation workflow validates clean', () => {
  const r = validateGraph(escalation())
  assert.deepEqual(r.errors, [])
  assert.equal(r.ok, true)
})

test('validator: unknown trigger, capability, condition and variables are errors', () => {
  const g = escalation()
  g.trigger.type = 'nope'
  g.nodes[1].config.condition = 'seller.vibes'
  g.nodes[2].config.capability = 'db.raw_sql'
  const r = validateGraph(g)
  assert.ok(codes(r).includes('trigger_unknown'))
  assert.ok(codes(r).includes('condition_unknown'))
  assert.ok(codes(r).includes('capability_unknown'))

  const v = escalation()
  v.nodes[2].config.inputs.description = { var: 'nodes.ghost.output' }
  v.nodes[2].config.inputs.entity = { var: 'secrets.api_key' }
  assert.equal(codes(validateGraph(v)).filter((c) => c === 'var_unknown').length, 2)
})

test('validator: missing required input and invalid enum', () => {
  const g = escalation()
  delete g.nodes[2].config.inputs.title
  g.nodes[2].config.inputs.event_type = 'made_up_event'
  const r = validateGraph(g)
  assert.ok(codes(r).includes('input_missing'))
  assert.ok(codes(r).includes('input_invalid'))
})

test('validator: unwired decision exit, unreachable node, dead trigger', () => {
  const g = escalation()
  g.edges = g.edges.filter((e) => e.exit !== 'Handled')
  g.nodes.push({ id: 'orphan', kind: 'action', config: { capability: 'notify.operator', inputs: { event_type: 'inbox_needs_call', title: 'x' } } })
  const r = validateGraph(g)
  assert.ok(codes(r).includes('exit_unwired'))
  assert.ok(r.errors.some((e) => e.code === 'unreachable' && e.node === 'orphan'))

  const dead = escalation()
  dead.edges = dead.edges.filter((e) => e.from !== 'trigger')
  assert.ok(codes(validateGraph(dead)).includes('trigger_unconnected'))
})

test('validator: cycles are rejected — repetition only through a bounded follow-up loop', () => {
  const g = escalation()
  g.edges.push({ from: 'end_handled', to: 'wait' })
  g.nodes.find((n) => n.id === 'end_handled').kind = 'transform'
  g.nodes.find((n) => n.id === 'end_handled').config = { op: 'pick_first' }
  assert.ok(codes(validateGraph(g)).includes('cycle'))
})

test('validator: waiting on an event requires a timeout; loops require max, cadence and stop', () => {
  const g = escalation()
  g.nodes[0].config = { mode: 'event', event: 'seller_reply_received' }
  assert.ok(codes(validateGraph(g)).includes('wait_timeout_missing'))

  const loop = {
    trigger: { type: 'offer_sent' },
    nodes: [
      { id: 'loop', kind: 'follow_up_loop', config: { action: { capability: 'seller.schedule_follow_up', inputs: { seller: { var: 'trigger.thread_key' }, intent: 'offer_follow_up' } }, max_attempts: 50 } },
      { id: 'a', kind: 'terminate', config: {} },
      { id: 'b', kind: 'terminate', config: {} },
    ],
    edges: [{ from: 'trigger', to: 'loop' }, { from: 'loop', exit: 'Stopped', to: 'a' }, { from: 'loop', exit: 'Exhausted', to: 'b' }],
  }
  const c = codes(validateGraph(loop))
  assert.ok(c.includes('loop_unbounded'))
  assert.ok(c.includes('loop_cadence'))
  assert.ok(c.includes('loop_stop'))
})

test('validator: APPROVAL-policy actions must sit behind an Approved exit on every path', () => {
  const sms = { id: 'sms', kind: 'action', config: { capability: 'outbound.send_sms', inputs: { seller: { var: 'trigger.thread_key' }, template_id: 't1', message_body: 'Hi' } } }
  const direct = { trigger: { type: 'seller_reply_received' }, nodes: [sms, { id: 'end', kind: 'terminate' }], edges: [{ from: 'trigger', to: 'sms' }, { from: 'sms', to: 'end' }] }
  assert.ok(codes(validateGraph(direct)).includes('approval_required'))

  const gated = {
    trigger: { type: 'seller_reply_received' },
    nodes: [{ id: 'ok', kind: 'approval', config: { title: 'Send this SMS?' } }, sms, { id: 'end', kind: 'terminate' }, { id: 'no', kind: 'terminate' }],
    edges: [{ from: 'trigger', to: 'ok' }, { from: 'ok', exit: 'Approved', to: 'sms' }, { from: 'ok', exit: 'Rejected', to: 'no' }, { from: 'sms', to: 'end' }],
  }
  assert.deepEqual(validateGraph(gated).errors, [])

  // Rejected leading to the send is still an unapproved path.
  const leaky = structuredClone(gated)
  leaky.edges = leaky.edges.map((e) => (e.exit === 'Rejected' ? { ...e, to: 'sms' } : e))
  assert.ok(codes(validateGraph(leaky)).includes('approval_required'))
})

test('validator: unavailable and config-required capabilities cannot publish', () => {
  const g = escalation()
  g.nodes[2].config = { capability: 'seller.pause_automation', inputs: {} }
  assert.ok(codes(validateGraph(g)).includes('capability_unavailable'))

  const email = escalation()
  email.nodes[2].config = { capability: 'email.send', inputs: {} }
  assert.ok(codes(validateGraph(email)).includes('capability_config'))
})

test('description, outline and diff are deterministic and business-readable', () => {
  const g = escalation()
  const d = describeGraph(g)
  assert.equal(d, describeGraph(escalation()))
  assert.match(d, /^When a seller conversation needs review, this workflow will wait 4 hours, check “Still needs a human\?”/)
  const outline = outlineGraph(g)
  assert.equal(outline[0].id, 'trigger')
  assert.ok(outline.find((l) => l.id === 'open').exits.some((x) => x.exit === 'Open' && x.to === 'notify'))

  const b = escalation()
  b.nodes[0].config.duration_hours = 48
  b.nodes[2].config.inputs.title = 'Seller still waiting'
  b.nodes.push({ id: 'note', kind: 'annotation', label: 'Ops note' })
  const diff = diffGraphs(g, b).map((c) => c.text)
  assert.ok(diff.includes('Give the team 4 hours: duration hours 4 hours → 2 days'))
  assert.ok(diff.some((t) => t.startsWith('Escalate: title')))
  assert.ok(diff.includes('Added: Ops note'))
  assert.deepEqual(diffGraphs(g, escalation()), [])
})

test('simulator: open conversation escalates, handled one ends quietly, zero writes', () => {
  const invoked = []
  for (const cap of Object.values(CAPABILITIES)) {
    const orig = cap.invoke
    if (orig) cap.invoke = undefined // any invoke during simulation would be a write
    invoked.push([cap, orig])
  }
  try {
    const open = simulateGraph(escalation(), { facts: { open: { in_needs_review: true } } })
    assert.equal(open.ok, true)
    assert.equal(open.outcome, 'escalated')
    assert.deepEqual(open.path.map((p) => p.node), ['trigger', 'wait', 'open', 'notify', 'end_escalated'])
    assert.equal(open.path.find((p) => p.node === 'open').exit, 'Open')
    assert.equal(open.actions.length, 1)
    assert.equal(open.actions[0].preview, 'Notification: Seller waiting on review')
    assert.equal(open.duration_hours, 4)
    assert.equal(open.writes, 0)

    const handled = simulateGraph(escalation(), { facts: { open: { in_needs_review: false, in_new_replies: false } } })
    assert.equal(handled.outcome, 'handled')
    assert.equal(handled.actions.length, 0)
  } finally {
    for (const [cap, orig] of invoked) if (orig) cap.invoke = orig
  }
})

test('simulator: event waits resolve on the event or the timeout; loops stop or exhaust', () => {
  const g = {
    trigger: { type: 'offer_sent' },
    nodes: [
      { id: 'w', kind: 'wait', config: { mode: 'event', event: 'seller_reply_received', timeout_hours: 48 } },
      { id: 'loop', kind: 'follow_up_loop', label: 'Chase', config: { action: { capability: 'seller.schedule_follow_up', inputs: { seller: { var: 'trigger.thread_key' }, intent: 'offer_follow_up' } }, max_attempts: 3, cadence_hours: 72, stop: { event: 'seller_reply_received' } } },
      { id: 'replied', kind: 'terminate', config: { outcome: 'replied' } },
      { id: 'stopped', kind: 'terminate', config: { outcome: 'replied_during_follow_up' } },
      { id: 'cold', kind: 'terminate', config: { outcome: 'no_response' } },
    ],
    edges: [
      { from: 'trigger', to: 'w' },
      { from: 'w', exit: 'Event', to: 'replied' },
      { from: 'w', exit: 'Timeout', to: 'loop' },
      { from: 'loop', exit: 'Stopped', to: 'stopped' },
      { from: 'loop', exit: 'Exhausted', to: 'cold' },
    ],
  }
  assert.deepEqual(validateGraph(g).errors, [])
  assert.equal(simulateGraph(g, { events: [{ type: 'seller_reply_received', at_hours: 10 }] }).outcome, 'replied')
  const stopped = simulateGraph(g, { loop_stop_after: { loop: 1 } })
  assert.equal(stopped.outcome, 'replied_during_follow_up')
  assert.equal(stopped.actions.length, 1)
  const cold = simulateGraph(g, {})
  assert.equal(cold.outcome, 'no_response')
  assert.equal(cold.actions.length, 3)
  assert.equal(cold.duration_hours, 48 + 3 * 72)
})

test('catalog: conditions are typed and total; capability catalog is honest about availability', () => {
  assert.equal(evaluateCondition('seller.conversation_open', { in_new_replies: true }), 'Open')
  assert.equal(evaluateCondition('email.address_healthy', { status: 'hard_bounced' }), 'Bounced / suppressed')
  assert.throws(() => evaluateCondition('nope', {}))
  const cat = capabilityCatalog({})
  assert.equal(cat.find((c) => c.key === 'seller.pause_automation').availability.state, 'UNAVAILABLE')
  assert.equal(cat.find((c) => c.key === 'email.send').availability.state, 'CONFIG_REQUIRED')
  assert.equal(capabilityCatalog({ emailPlane: true }).find((c) => c.key === 'email.send').availability.state, 'AVAILABLE')
})
