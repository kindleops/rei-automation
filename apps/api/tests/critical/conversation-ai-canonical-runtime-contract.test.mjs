// rc-8.5.21 part A, Phase 11 — PERMANENT CONTRACT: every caller of the conversation writer calls
// the SAME exported function (runtime/canonical.js#decideAndCompose) and records the same version.
//   static   who imports the pipeline / composer / canonical entry, and nothing else does
//   runtime  function-reference identity + every caller's record carries CANONICAL_VERSIONS and its
//            caller tag (live shadow, durable turn, R3 re-validation input, review API, capability,
//            evaluation)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { importClosure, importsFile, listFiles, SRC } from '../helpers/import-graph.mjs'
import * as canonical from '../../src/lib/domain/conversation-ai/runtime/canonical.js'
import * as evaluation from '../../src/lib/domain/conversation-ai/runtime/evaluation-entry.js'
import { runCanonicalShadow } from '../../src/lib/domain/conversation-ai/runtime/canonical-shadow.js'
import { createCanonicalTurnDecider } from '../../src/lib/ai/conversation-turn-wiring.js'
import { draftReplyForInbound } from '../../src/lib/ai/conversation-ai-draft-service.js'
import { inboxCapabilities } from '../../src/lib/agent/capabilities/defs/inbox.js'
import { createDefaultCapabilityRegistry } from '../../src/lib/agent/capabilities/index.js'
import { validateOutbound } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { checkComposedText } from '../../src/lib/domain/conversation-ai/pipeline/compose.js'
import { createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { fakeSupabase, fakeProvider, threadTables, SID, routineDecision } from '../helpers/conversation-ai-runtime-fakes.mjs'

const rel = (f) => path.relative(SRC, f)
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const ALL = listFiles(SRC).filter((f) => /\.(m?js|ts|tsx)$/.test(f))
const importersOf = (re) => ALL.filter((f) => re.test(read(f))).map(rel).sort()
const R1_ENGINE = path.join(SRC, 'lib/domain/conversation-ai/engine.js')

test('static: the R1-engine import check resolves specifiers (it still catches every way of importing it, and only it)', () => {
  assert.ok(fs.existsSync(R1_ENGINE), 'the retired R1 engine file is where the check expects it')
  const beside = path.join(SRC, 'lib/domain/conversation-ai/some-caller.js')
  const below = path.join(SRC, 'lib/domain/conversation-ai/runtime/some-caller.js')
  const elsewhere = path.join(SRC, 'lib/workforce/authority/some-caller.js')
  for (const [src, from] of [
    ["import { x } from './engine.js'", beside], ["import { x } from './engine'", beside], ["export { x } from './engine.js'", beside],
    ["const m = await import('../engine.js')", below], ["import '../engine.js'", below],
    ["import { x } from '@/lib/domain/conversation-ai/engine.js'", elsewhere], ["import { x } from '../../domain/conversation-ai/engine.js'", elsewhere],
  ]) assert.equal(importsFile(src, from, R1_ENGINE), true, `${src} (from ${rel(from)}) is an R1 import`)
  for (const [src, from] of [
    ["import { authorize } from './engine.js'", elsewhere], // workforce/authority's own engine.js
    ["// import { x } from './engine.js'", beside], ["import { x } from './engine-v2.js'", beside], ["import { x } from './runtime/engine.js'", beside],
  ]) assert.equal(importsFile(src, from, R1_ENGINE), false, `${src} (from ${rel(from)}) is not an R1 import`)
})

test('static: decideAndCompose is the ONLY entry to the pipeline; the pipeline is the only composer caller; the R1 engine has no importer', () => {
  assert.deepEqual(importersOf(/pipeline\/run\.js['"]/), ['lib/domain/conversation-ai/runtime/canonical.js'])
  assert.deepEqual(importersOf(/\bcomposeReply\b/).filter((f) => f !== 'lib/domain/conversation-ai/pipeline/compose.js'), ['lib/domain/conversation-ai/pipeline/run.js'])
  // the retired R1 engine, by RESOLVED import (relative, "@/" alias, dynamic) plus any literal path naming it.
  // A name match on "./engine.js" also hit lib/workforce/authority's own, unrelated engine.js.
  assert.deepEqual(ALL.filter((f) => f !== R1_ENGINE && (importsFile(fs.readFileSync(f, 'utf8'), f, R1_ENGINE) || /conversation-ai\/engine(?:\.js)?['"]/.test(read(f)))).map(rel).sort(), [],
    'nothing imports the retired R1 engine')
  assert.deepEqual(importersOf(/\brunConversationPipeline\b/).filter((f) => f !== 'lib/domain/conversation-ai/pipeline/run.js'), ['lib/domain/conversation-ai/runtime/canonical.js'])
})

test('static: every caller imports decideAndCompose from runtime/canonical.js and calls it (shadow, turn, review drafts, capability via the draft service, evaluations)', () => {
  const callers = [
    'lib/domain/conversation-ai/runtime/canonical-shadow.js',
    'lib/ai/conversation-turn-wiring.js',
    'lib/ai/conversation-ai-draft-service.js',
    'lib/domain/conversation-ai/runtime/evaluation-entry.js',
  ]
  for (const c of callers) {
    const src = read(path.join(SRC, c))
    assert.match(src, /import\s*\{[^}]*\bdecideAndCompose\b[^}]*\}\s*from\s*['"][^'"]*runtime\/canonical\.js['"]|import\s*\{[^}]*\bdecideAndCompose\b[^}]*\}\s*from\s*['"]\.\/canonical\.js['"]/, `${c} imports decideAndCompose from the canonical module`)
    assert.match(src, /decideAndCompose\(/, `${c} calls it`)
  }
  // the live shadow wiring reaches the canonical shadow; the turn handler reaches the canonical decider
  assert.ok(importClosure([path.join(SRC, 'lib/ai/conversation-ai-shadow-wiring.js')]).files.has(path.join(SRC, 'lib/domain/conversation-ai/runtime/canonical.js')))
  assert.ok(importClosure([path.join(SRC, 'lib/ai/conversation-turn-handler.js')]).files.has(path.join(SRC, 'lib/domain/conversation-ai/runtime/canonical.js')))
  // the capability wraps the draft service; the review route calls it
  const cap = inboxCapabilities.find((c) => c.id === 'inbox.draft_ai_reply')
  assert.ok(cap && /draftReplyForInbound.*decideAndCompose/.test(cap.wraps.service))
  assert.match(read(path.join(SRC, 'lib/agent/capabilities/services.js')), /conversation-ai-draft-service\.js'\), 'draftReplyForInbound'/)
  assert.match(read(path.join(SRC, 'app/api/cockpit/agent/conversation-ai/draft/route.js')), /draftReplyForInbound\(/)
  // the repo eval replay script uses the evaluation entry
  assert.match(fs.readFileSync(path.join(SRC, '../scripts/conversation-ai/eval-replay.mjs'), 'utf8'), /replayTurnForEvaluation/)
})

test('static: ONE validator — the composer, the canonical decision and R3 all import validateOutbound from outbound-validator.js', () => {
  for (const f of ['lib/domain/conversation-ai/pipeline/compose.js', 'lib/domain/conversation-ai/runtime/canonical.js', 'lib/ai/conversation-ai-r3-executor.js']) {
    assert.match(read(path.join(SRC, f)), /\bvalidateOutbound\b[^\n]*from\s*['"][^'"]*outbound-validator\.js['"]|import\s*\{[^}]*validateOutbound[^}]*\}\s*from\s*['"][^'"]*outbound-validator\.js['"]/, f)
  }
  // checkComposedText IS the shared validator's content verdict
  const text = "I'm not with a company. Would you consider selling?"
  assert.deepEqual(checkComposedText(text, { ledger: null, objective: 'interest', category: 'next_missing_fact' }), validateOutbound(text, { ledger: null, objective: 'interest', category: 'next_missing_fact' }).content_reasons)
})

test('runtime: function-reference identity — the evaluation entry exports the canonical function itself; versions are one frozen object', () => {
  assert.equal(evaluation.decideAndCompose, canonical.decideAndCompose)
  assert.ok(Object.isFrozen(canonical.CANONICAL_VERSIONS))
  assert.equal(canonical.CANONICAL_VERSIONS.writer, canonical.WRITER_VERSION)
  assert.deepEqual([...canonical.CANONICAL_CALLERS], ['turn', 'shadow', 'r3_revalidation', 'review_api', 'capability', 'evaluation'])
})

// one fixture thread, read through the REAL loaders by every production caller
function fixture() {
  const t = threadTables({ body: 'Yes I would consider selling it' })
  for (const e of t.message_events) if (e.id === 'in-1') e.detected_intent = 'seller_interested'
  return t
}
const provider = () => fakeProvider((p) => (p.tools[0].input_schema?.properties?.message ? { message: 'Good to hear. What price did you have in mind for it?' } : routineDecision({ intent: 'interested', next_objective: 'get_asking_price' })))
const ENV = { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_DRAFT_MODEL_ENABLED: 'true' }

test('runtime: every caller produces a record of the SAME writer — shadow, turn, review API, capability, evaluation', async () => {
  const seen = []
  // live shadow
  const t1 = fixture()
  const s = await runCanonicalShadow({
    input: (await import('../../src/lib/domain/conversation-ai/context-loader.js')).loadShadowContext ? (await (await import('../../src/lib/domain/conversation-ai/context-loader.js')).loadShadowContext({ supabase: fakeSupabase(t1), providerMessageSid: SID })).input : null,
    policy: { shadow_enabled: true, kill_switch_engaged: false }, env: ENV,
  })
  seen.push(['shadow', s.decision])
  // durable turn
  const t2 = fixture()
  const decide = createCanonicalTurnDecider({ supabase: fakeSupabase(t2, { shadowStoreRows: new Map() }), env: ENV, tracker: createSpendTracker({ capUsd: 0.05 }), provider: provider(), readSwitch: async () => null })
  const d = await decide({ latest_inbound_id: 'in-1' })
  seen.push(['turn', d.canonical])
  // review API (via the draft service, the function the route calls)
  const r = await draftReplyForInbound({ inboundMessageId: '00000000-0000-4000-8000-0000000000aa', caller: 'review_api', env: ENV, supabase: fakeSupabase(withUuid(fixture())), provider: provider(), tracker: createSpendTracker({ capUsd: 0.05 }) })
  assert.equal(r.ok, true, JSON.stringify(r))
  seen.push(['review_api', { versions: r.draft.versions, caller: r.draft.caller }])
  // capability (the spec's execute with the service bound to the same draft service)
  const cap = createDefaultCapabilityRegistry().get('inbox.draft_ai_reply')
  assert.ok(cap, 'registered in the sealed registry')
  const ctx = {
    org_id: 'org', services: {
      refs: { open: () => '+15555550123', seal: () => 'thr_x' },
      conversation: {
        latestInboundId: async () => '00000000-0000-4000-8000-0000000000aa',
        draft: (a) => draftReplyForInbound({ ...a, env: ENV, supabase: fakeSupabase(withUuid(fixture())), provider: provider(), tracker: createSpendTracker({ capUsd: 0.05 }) }),
      },
    },
  }
  const c = await cap.execute({ thread_ref: 'thr_aaaaaaaaaaaa' }, ctx)
  assert.equal(c.ok, true, JSON.stringify(c))
  seen.push(['capability', { versions: c.draft.versions, caller: c.draft.caller }])
  // evaluation
  const e = await evaluation.replayTurnForEvaluation({ input: d.canonical ? (await (await import('../../src/lib/domain/conversation-ai/context-loader.js')).loadShadowContext({ supabase: fakeSupabase(fixture()), providerMessageSid: SID })).input : null })
  seen.push(['evaluation', e])
  for (const [caller, rec] of seen) {
    assert.equal(rec.versions, canonical.CANONICAL_VERSIONS, `${caller}: the same frozen version object`)
    assert.equal(rec.caller, caller)
  }
  // and the turn decision produced the canonical text (playbook v3 composer), never R1's
  assert.equal(d.canonical.reply.text, 'Good to hear. What price did you have in mind for it?')
  assert.equal(d.writer_version, canonical.WRITER_VERSION)
})

function withUuid(t) {
  // the review / capability path addresses an inbound by its message_events uuid
  for (const e of t.message_events) if (e.id === 'in-1') e.id = '00000000-0000-4000-8000-0000000000aa'
  return t
}

test('runtime: the review draft never sends — no queue / record / reservation writes, gated by the shadow switches, model only behind its own flag', async () => {
  const t = withUuid(fixture())
  const sb = fakeSupabase(t)
  const off = await draftReplyForInbound({ inboundMessageId: '00000000-0000-4000-8000-0000000000aa', caller: 'review_api', env: {}, supabase: sb })
  assert.equal(off.code, 'SHADOW_ENV_OFF')
  const noModel = await draftReplyForInbound({ inboundMessageId: '00000000-0000-4000-8000-0000000000aa', caller: 'review_api', env: { AI_CONVERSATION_SHADOW_ENABLED: 'true' }, supabase: sb })
  assert.deepEqual([noModel.ok, noModel.model_used, noModel.draft.send_status], [true, false, 'never_sent_draft'])
  assert.deepEqual(sb.log.writes, [], 'nothing written')
  assert.equal((await draftReplyForInbound({ inboundMessageId: 'not-a-uuid', caller: 'review_api', env: ENV, supabase: sb })).code, 'INBOUND_ID_INVALID')
  assert.equal((await draftReplyForInbound({ inboundMessageId: '00000000-0000-4000-8000-0000000000aa', caller: 'somewhere', env: ENV, supabase: sb })).code, 'CALLER_INVALID')
})
