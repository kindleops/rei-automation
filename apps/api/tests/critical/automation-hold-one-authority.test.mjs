// rc-8.5.21 integration — ONE automation-hold authority.
//
// The registry (lib/domain/holds/automation-hold.js, rc-8.5.20-holds = hotfix/automation-holds) is the
// only hold mechanism. 8.5.21-a's port (lib/domain/holds-port/automation-hold-port.js) is bound to its
// checkAutomationHold at load; 8.5.21-b's gate (lib/agent/operations/automation-hold-gate.js) delegates
// to that port and its composition roots pass checkAutomationHold explicitly. This suite proves:
//   1. statically: the port is pure and is bound by the registry module; the gate reaches the port; the
//      hold-everything placeholder and any second matcher are gone; the roots pass the registry checker;
//   2. behaviourally: for every scope × every capability any caller uses, the registry, the port (bound,
//      no injection), the gate (null checker) and the gate (registry checker injected) give the SAME
//      verdict — held / hold type / hold id — including fail-closed cases.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkAutomationHold, resolveAutomationHold, matchAutomationHolds, registryCapabilitiesFor,
  AUTOMATION_HOLD_PORT_CAPABILITY_MAP, ALL_HOLD_CAPABILITIES, HOLD_CAPABILITIES as REGISTRY_CAPS,
  staticExclusionFor, __setAutomationHoldResolverForTests,
} from '../../src/lib/domain/holds/automation-hold.js'
import { checkAutomationHoldPort, registerAutomationHoldChecker, __resetAutomationHoldChecker } from '../../src/lib/domain/holds-port/automation-hold-port.js'
import * as gate from '../../src/lib/agent/operations/automation-hold-gate.js'
import { importClosure } from '../helpers/import-graph.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const REGISTRY = path.join(SRC, 'lib/domain/holds/automation-hold.js')
const PORT = path.join(SRC, 'lib/domain/holds-port/automation-hold-port.js')
const GATE = path.join(SRC, 'lib/agent/operations/automation-hold-gate.js')
const KEY = Symbol.for('lc.automation_hold.checker')
const read = (f) => fs.readFileSync(f, 'utf8')
const code = (f) => read(f).replace(/\/\/.*$/gm, '')
const DEFAULT_SEAM = () => ({ held: false, fail_closed: false, holds: [], hold_ids: [], reason: null, source: 'test_default_no_holds' })

// ── 1. static ───────────────────────────────────────────────────────────────
test('static: the port is pure, the registry module binds it, the gate reaches the port — no second mechanism', () => {
  const port = importClosure([PORT])
  assert.ok(!port.files.has(REGISTRY), 'the port must not import the I/O registry (it is reachable from lib/domain/conversation-ai)')
  assert.ok(![...port.externals].some((e) => /supabase/.test(e)), 'the port imports no Supabase client')
  assert.match(code(REGISTRY), /registerAutomationHoldChecker\(checkAutomationHold\)/, 'the registry module binds checkAutomationHold into the port')
  const g = importClosure([GATE])
  assert.ok(g.files.has(PORT), 'the gate delegates to the port')
  assert.ok(!('failClosedHoldCheck' in gate), 'the hold-everything integration placeholder is removed')
  // no module other than the registry core matches holds / no module other than the port keeps a checker
  const all = (function list(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)) : /\.(m?js|ts)$/.test(e.name) ? [path.join(d, e.name)] : [])) })(SRC)
  for (const f of all) {
    const c = code(f)
    if (/function\s+matchAutomationHolds\s*\(/.test(c)) assert.equal(path.relative(SRC, f), 'lib/domain/holds/automation-hold-core.js')
    if (/Symbol\.for\(['"]lc\.automation_hold\.checker['"]\)/.test(c)) assert.equal(path.relative(SRC, f), 'lib/domain/holds-port/automation-hold-port.js')
  }
  // the 8.5.21-b composition roots pass the registry's checker
  for (const f of ['lib/ai/operations-runtime-wiring.js', 'lib/ai/mission-runtime-wiring.js']) {
    const c = code(path.join(SRC, f))
    assert.match(c, /import \{[^}]*\bcheckAutomationHold\b[^}]*\} from '@\/lib\/domain\/holds\/automation-hold\.js'/, `${f} imports the registry checker`)
    assert.match(c, /checkAutomationHold[,\s}]/, `${f} passes it`)
    assert.ok(!/failClosedHoldCheck/.test(c), `${f} no longer passes the placeholder`)
  }
})

test('static: every capability a port / gate caller uses is mapped onto the registry vocabulary (an unmapped one would hold everything)', () => {
  const callers = ['lib/ai/conversation-ai-r3-executor.js', 'lib/ai/conversation-turn-wiring.js', 'lib/domain/followups/followup-execution.js', 'lib/domain/queue/ai-conversation-row-gate.js', 'lib/domain/queue/send-time-contact-guard.js']
  const used = new Set(Object.values(gate.HOLD_CAPABILITIES))
  for (const f of callers) for (const m of code(path.join(SRC, f)).matchAll(/checkAutomationHoldPort\(\{[^}]*capability:\s*['"]([^'"]+)['"]/g)) used.add(m[1])
  // P0 2026-10-17: the follow-up lifecycle retired the enqueue-time hold call (followup_enqueue): an intent is
  // checked at materialization and again at dispatch (followup_dispatch), with the registry
  assert.ok(used.size >= 9, [...used].join(','))
  assert.ok(used.has('followup_dispatch'), 'the follow-up lifecycle consults the port')
  for (const c of used) {
    const caps = registryCapabilitiesFor(c)
    assert.ok(caps.length >= 1, `capability ${c} is mapped`)
    for (const x of caps) assert.ok(ALL_HOLD_CAPABILITIES.includes(x), `${c} → ${x} is a registry capability`)
  }
  for (const c of ALL_HOLD_CAPABILITIES) assert.deepEqual(registryCapabilitiesFor(c), [c], 'registry names map to themselves')
  // the send / dispatch paths include the registry's outbound_send (what the send_queue trigger enforces)
  for (const c of ['send_time_dispatch', 'ai_reply_dispatch', 'followup_dispatch']) assert.ok(registryCapabilitiesFor(c).includes(REGISTRY_CAPS.OUTBOUND_SEND), c)
  assert.equal(Object.isFrozen(AUTOMATION_HOLD_PORT_CAPABILITY_MAP), true)
})

// ── 2. behaviour: the four entry points agree with the registry ─────────────
// In-memory registry: the SAME predicate as public.automation_hold_for (matchAutomationHolds, which also
// applies the static permanent exclusions), installed through the hotfix's resolver seam.
const HOLDS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', hold_key: 'owner_hold:t1', hold_type: 'operator_hold', reason: 'owner review', thread_key: '+15555550101', blocked_capabilities: [...ALL_HOLD_CAPABILITIES] },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', hold_key: 'campaign_only:p2', hold_type: 'operator_hold', reason: 'campaign pause', property_id: 'P2', blocked_capabilities: ['campaign'] },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', hold_key: 'followups:o3', hold_type: 'operator_hold', reason: 'no follow-ups', opportunity_id: 'bbbbbbbb-0000-4000-8000-000000000003', blocked_capabilities: ['follow_up'] },
  { id: 'aaaaaaaa-0000-4000-8000-000000000004', hold_key: 'released:m4', hold_type: 'operator_hold', master_owner_id: 'M4', released_at: '2026-10-16T00:00:00Z' },
]
const registrySeam = (s, { capability }) => {
  if (s.property_id === 'P_DOWN') throw new Error('registry down')
  const m = matchAutomationHolds(HOLDS, s, capability)
  return m.length ? { held: true, fail_closed: false, holds: m, hold_ids: m.map((h) => h.id).filter(Boolean), reason: 'automation_hold' } : { held: false, fail_closed: false, holds: [], hold_ids: [], reason: null }
}
const SCOPES = [
  { threadKey: '+15555550101' },
  { threadKey: '+15555550199', propertyId: 'P2' },
  { threadKey: '+15555550199', opportunityId: 'bbbbbbbb-0000-4000-8000-000000000003' },
  { threadKey: '+15555550199', masterOwnerId: 'M4' },
  { propertyId: '251027062' }, // the static permanent exclusion (Maxwell), no registry row
  { threadKey: '+15555550199', propertyId: 'P_DOWN' }, // lookup failure
  { threadKey: '+15555550177', propertyId: 'P9' }, // free
]

async function registryVerdict(scope, capability) {
  const caps = registryCapabilitiesFor(capability)
  if (!caps.length) return { held: true, hold_type: 'lookup_error', hold_id: null }
  for (const c of caps) {
    const r = await resolveAutomationHold({ thread_key: scope.threadKey, property_id: scope.propertyId, opportunity_id: scope.opportunityId, master_owner_id: scope.masterOwnerId }, { capability: c })
    if (r.held) return { held: true, hold_type: r.fail_closed ? 'lookup_error' : r.holds[0]?.hold_type, hold_id: r.hold_ids[0] || r.holds[0]?.hold_key || null }
  }
  return { held: false, hold_type: null, hold_id: null }
}
const pick = (r) => ({ held: r.held, hold_type: r.hold_type ?? null, hold_id: r.hold_id ?? null })

test('agreement: registry = port (bound) = gate (no checker) = gate (registry checker) for every scope × capability', async () => {
  __setAutomationHoldResolverForTests(registrySeam)
  try {
    assert.equal(globalThis[KEY], checkAutomationHold, 'the port is bound to the registry checker')
    const capabilities = [...new Set([...Object.keys(AUTOMATION_HOLD_PORT_CAPABILITY_MAP), 'not_a_capability'])]
    let held = 0; let checked = 0
    for (const scope of SCOPES) {
      for (const capability of capabilities) {
        const want = await registryVerdict(scope, capability)
        const viaPort = pick(await checkAutomationHoldPort({ ...scope, capability }))
        const viaGate = pick(await gate.consultHold(null, { ...scope, capability }))
        const viaGateInjected = pick(await gate.consultHold(checkAutomationHold, { ...scope, capability }))
        const direct = pick(await checkAutomationHold({ ...scope, capability }))
        const label = `${JSON.stringify(scope)} × ${capability}`
        assert.deepEqual(direct, want, `checkAutomationHold ${label}`)
        assert.deepEqual(viaPort, want, `port ${label}`)
        assert.deepEqual(viaGate, want, `gate ${label}`)
        assert.deepEqual(viaGateInjected, want, `gate(injected) ${label}`)
        checked += 1; if (want.held) held += 1
      }
    }
    assert.ok(checked >= 7 * 20 && held > 0 && held < checked, `${held}/${checked}`)
    // spot checks of the intended semantics
    const v = async (scope, capability) => pick(await checkAutomationHoldPort({ ...scope, capability }))
    assert.deepEqual(await v(SCOPES[0], 'send_time_dispatch'), { held: true, hold_type: 'operator_hold', hold_id: HOLDS[0].id })
    assert.equal((await v(SCOPES[1], 'send_time_dispatch')).held, false, 'a campaign-only hold does not block a reply dispatch')
    assert.equal((await v(SCOPES[1], 'campaign')).held, true)
    assert.equal((await v(SCOPES[2], 'followup_dispatch')).held, true, 'a follow_up hold blocks the follow-up pipeline')
    assert.equal((await v(SCOPES[2], 'recovery.nurture_intent')).held, true, 'and the recovery nurture intent (union: recovery + follow_up)')
    assert.equal((await v(SCOPES[2], 'valuation.refresh')).held, false)
    assert.equal((await v(SCOPES[3], 'ai_reply_dispatch')).held, false, 'a released hold holds nothing')
    assert.deepEqual(await v(SCOPES[4], 'negotiation.compose'), { held: true, hold_type: 'permanent_exclusion', hold_id: 'owner_handled_20261014:maxwell' })
    assert.deepEqual(await v(SCOPES[5], 'followup_enqueue'), { held: true, hold_type: 'lookup_error', hold_id: null }, 'a lookup failure is HELD')
    assert.deepEqual(await v(SCOPES[6], 'not_a_capability'), { held: true, hold_type: 'lookup_error', hold_id: null }, 'an unmapped capability is HELD')
    assert.equal((await v(SCOPES[6], 'ai_reply_dispatch')).held, false)
  } finally {
    __setAutomationHoldResolverForTests(DEFAULT_SEAM)
  }
})

test('fail closed survives integration: an unbound port, a throwing registry and a malformed verdict are holds on both paths', async () => {
  __resetAutomationHoldChecker()
  try {
    assert.deepEqual(pick(await checkAutomationHoldPort({ threadKey: '+15555550177', capability: 'send_time_dispatch' })), { held: true, hold_type: 'lookup_error', hold_id: null })
    assert.equal((await gate.consultHold(null, { threadKey: '+15555550177', capability: 'valuation.refresh' })).held, true)
  } finally { registerAutomationHoldChecker(checkAutomationHold) }
  __setAutomationHoldResolverForTests(() => { throw new Error('rpc down') })
  try {
    for (const capability of ['send_time_dispatch', 'followup_dispatch', 'recovery.research_enqueue', 'negotiation.compose']) {
      assert.equal((await checkAutomationHoldPort({ threadKey: '+15555550177', capability })).held, true, capability)
      assert.equal((await gate.consultHold(null, { threadKey: '+15555550177', capability })).held, true, capability)
    }
  } finally { __setAutomationHoldResolverForTests(DEFAULT_SEAM) }
  __setAutomationHoldResolverForTests(() => ({ held: 'no' }))
  try {
    assert.equal((await checkAutomationHold({ threadKey: '+15555550177', capability: 'send_time_dispatch' })).held, true, 'a verdict without held:false is held')
  } finally { __setAutomationHoldResolverForTests(DEFAULT_SEAM) }
  // the port's owner-handled address check reads the SAME static list as the registry
  assert.ok(staticExclusionFor({ property_address: '3746 Baltimore Ave' }))
  assert.equal((await checkAutomationHoldPort({ threadKey: '+15555550177', propertyAddress: '3746 Baltimore Ave', capability: 'send_time_dispatch' })).hold_type, 'owner_handled')
})
