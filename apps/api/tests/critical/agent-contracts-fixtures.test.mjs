// Agent S1 — shared contracts + fixture event logs (S2 UI input).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as contracts from '../../src/lib/agent/contracts/index.js'
import {
  FIXTURE_SCENARIO_IDS,
  generateFixtureScenario,
  generateAllFixtureScenarios,
} from '../../src/lib/agent/contracts/fixtures/scenarios.js'
import { FIXTURE_SOURCES } from '../../src/lib/agent/contracts/fixtures/fixture-sources.js'
import { sanitizeEventPayload } from '../../src/lib/agent/runtime/sanitize.js'

const { EVENT_PAYLOAD_FIELDS, LABELLED_EVENT_TYPES, OPERATION_LABEL_TEMPLATES, findingViolations, reduceEvents, applyEvent, emptyRunView } = contracts
const CONTRACTS_DIR = fileURLToPath(new URL('../../src/lib/agent/contracts/', import.meta.url))

test('contracts are pure ESM: no imports outside the contracts directory, no Node-only APIs', () => {
  const files = []
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name))
      else if (f.name.endsWith('.js')) files.push(join(d, f.name))
    }
  }
  walk(CONTRACTS_DIR)
  assert.ok(files.length >= 9)
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), `${file} imports ${m[1]}`)
      assert.ok(!m[1].includes('runtime') && !m[1].includes('node:'), `${file} must not import ${m[1]}`)
    }
    assert.ok(!/\bprocess\.|require\(|node:/.test(src), `${file} uses a Node-only API`)
  }
})

test('there are exactly the 8 design-review scenarios', () => {
  assert.deepEqual(FIXTURE_SCENARIO_IDS, ['single-deep', 'batch-25', 'discoveries', 'blocked-conflict', 'campaign-handoff', 'resume-reload', 'ultrawide', 'reduced-motion'])
})

test('every fixture event is fixture:true, whitelisted, globally ordered and per-run gapless', () => {
  for (const s of generateAllFixtureScenarios()) {
    assert.equal(s.fixture, true)
    assert.equal(s.test_data, true)
    assert.ok(s.events.length > 0, s.scenario_id)
    const seq = {}
    let last = 0
    for (const e of s.events) {
      assert.equal(e.fixture, true, `${s.scenario_id} #${e.event_id} missing fixture:true`)
      assert.ok(EVENT_PAYLOAD_FIELDS[e.type], `${s.scenario_id}: unregistered type ${e.type}`)
      for (const k of Object.keys(e.payload)) assert.ok(EVENT_PAYLOAD_FIELDS[e.type].includes(k), `${e.type}.${k} not whitelisted`)
      assert.ok(e.event_id > last, 'event_id monotonic')
      last = e.event_id
      seq[e.run_id] = (seq[e.run_id] || 0) + 1
      assert.equal(e.seq, seq[e.run_id], `${s.scenario_id} seq gap in ${e.run_id}`)
      // passing through the production sanitizer drops nothing
      assert.deepEqual(sanitizeEventPayload(e.type, e.payload).dropped, [])
    }
  }
})

test('every fixture label re-renders from a registered operation template (labels map 1:1)', () => {
  for (const s of generateAllFixtureScenarios()) {
    for (const e of s.events) {
      if (!LABELLED_EVENT_TYPES.includes(e.type)) continue
      assert.ok(OPERATION_LABEL_TEMPLATES[e.payload.operation], `${e.type} operation ${e.payload.operation}`)
      const template = OPERATION_LABEL_TEMPLATES[e.payload.operation]
      const re = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{\w+\\?\}/g, '.+')}$`)
      assert.match(e.payload.label, re)
    }
  }
})

test('every fixture source is test data on an unfetchable .invalid host', () => {
  for (const src of FIXTURE_SOURCES) {
    assert.equal(src.test_data, true)
    assert.match(src.host, /\.invalid$/)
    assert.match(src.name, /\[test data\]/)
  }
  for (const s of generateAllFixtureScenarios()) {
    for (const e of s.events) {
      const text = JSON.stringify(e.payload)
      assert.ok(!/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text), 'no phone-like strings in fixtures')
      assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(text), 'no emails in fixtures')
      assert.ok(!/thinking|chain_of_thought/i.test(Object.keys(e.payload).join(',')))
    }
  }
})

test('fixture findings honor evidence invariants: blocked/unavailable carry no value and are never absence', () => {
  let blocked = 0
  for (const s of generateAllFixtureScenarios()) {
    for (const e of s.events) {
      if (e.type !== 'finding.upserted') continue
      const f = e.payload.finding
      const src = FIXTURE_SOURCES.find((x) => x.source_id === f.source_id)
      assert.deepEqual(findingViolations(f, { supports_negative: src.supports_negative, query_succeeded: true }), [], `${s.scenario_id} ${f.finding_id}`)
      if (f.evidence_status === 'blocked') {
        blocked += 1
        assert.equal(f.value, null)
        assert.equal(f.is_negative_claim, false)
      }
    }
  }
  assert.ok(blocked > 0, 'some scenario exercises a blocked source')
})

test('scenario-specific content: discoveries, blocked card + conflict, handoff, ultrawide, perf', () => {
  const disc = reduceEvents(generateFixtureScenario('discoveries').events)['fx-run-discoveries']
  assert.ok(disc.counters.discoveries >= 2)
  assert.equal(disc.brief_completed.opportunity_class, 'priority')

  const bc = generateFixtureScenario('blocked-conflict')
  const blockedEv = bc.events.find((e) => e.type === 'source.blocked')
  assert.match(blockedEv.payload.message, /Not evidence of absence/)
  assert.ok(blockedEv.payload.alternatives.length >= 2)
  const v = reduceEvents(bc.events)['fx-run-duval']
  assert.equal(Object.values(v.conflicts)[0].resolution_state, 'resolved_by_rule')
  assert.ok(Object.values(v.findings).some((f) => f.contradicted_by), 'a vendor assumption is downgraded')

  const ho = generateFixtureScenario('campaign-handoff')
  const intent = ho.events.find((e) => e.type === 'ui.intent')
  assert.equal(intent.payload.draft_only, true)
  assert.equal(intent.payload.destination, 'entity-graph.campaign-sheet')
  const apr = ho.events.find((e) => e.type === 'approval.requested').payload.approval
  assert.equal(apr.identity_available, false)
  assert.equal(apr.tier, 'T3')
  assert.match(apr.payload_hash, /^[0-9a-f]{64}$/)

  const uw = generateFixtureScenario('ultrawide')
  assert.deepEqual(uw.presentation.viewport, { width: 5120, height: 1440 })
  assert.equal(uw.runs.length, 2)
  const runsInOrder = uw.events.slice(0, 40).map((e) => e.run_id)
  assert.ok(new Set(runsInOrder).size === 2, 'event ids interleave across runs')

  const perf = generateFixtureScenario('reduced-motion')
  assert.ok(perf.events.length >= 2000, `perf scenario has ${perf.events.length} events`)
  assert.equal(perf.presentation.reduced_motion, true)
})

test('generator is deterministic', () => {
  for (const id of FIXTURE_SCENARIO_IDS) {
    assert.deepEqual(generateFixtureScenario(id).events, generateFixtureScenario(id).events)
  }
})

test('reducer: replay after reload with redelivered events never duplicates rows', () => {
  const s = generateFixtureScenario('resume-reload')
  const { reload_after_event_id, redelivered_event_ids } = s.resume
  const full = reduceEvents(s.events)['fx-run-resume']
  const view = emptyRunView('fx-run-resume')
  for (const e of s.events.filter((x) => x.event_id <= reload_after_event_id)) applyEvent(view, e)
  assert.equal(view.last_event_id, reload_after_event_id)
  assert.equal(s.resume.snapshot.last_event_id, reload_after_event_id)
  // transport redelivers some already-seen events, then the tail
  for (const id of redelivered_event_ids) applyEvent(view, s.events.find((e) => e.event_id === id))
  for (const e of s.events.filter((x) => x.event_id > reload_after_event_id)) applyEvent(view, e)
  assert.equal(view.timeline.length, full.timeline.length)
  assert.deepEqual(view.counters, full.counters)
  assert.equal(view.gap_detected, false)
})

test('reducer: a seq gap is detected (client must refetch)', () => {
  const s = generateFixtureScenario('single-deep')
  const view = emptyRunView('fx-run-single')
  s.events.forEach((e, i) => { if (i !== 5) applyEvent(view, e) })
  assert.equal(view.gap_detected, true)
})

test('reducer: status line is the latest running operation label, null when idle', () => {
  const s = generateFixtureScenario('single-deep')
  const view = emptyRunView('fx-run-single')
  let sawRunning = false
  for (const e of s.events) {
    applyEvent(view, e)
    if (e.type === 'task.started') {
      assert.equal(view.status_line, e.payload.label)
      sawRunning = true
    }
  }
  assert.ok(sawRunning)
  assert.equal(view.status_line, null)
  assert.equal(view.terminal, true)
})

test('cost contract: owner default caps are exact', () => {
  const c = contracts.DEFAULT_CAPS_USD
  assert.deepEqual(c.research.per_property, { quick: 0, deep: 0.75, diligence: 2.0 })
  assert.equal(c.research.per_batch, 25)
  assert.equal(c.research.concurrency, 2)
  assert.deepEqual({ ...c.non_research }, { per_response: 0.05, per_conversation_task: 0.5, per_background_task: 1.0, per_day: 15, per_month: 60 })
  assert.deepEqual({ ...c.org }, { per_day: 50, per_month: 200 })
  assert.equal(c.opus_enabled, false)
  assert.equal(c.per_operator_day, null)
})

test('tiers: T4 is not representable in the contracts', () => {
  assert.deepEqual(contracts.TIERS, ['T0', 'T1', 'T2', 'T3'])
  assert.ok(!Object.values(contracts.SIDE_EFFECT_TIER).includes('T4'))
})
