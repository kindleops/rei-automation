// Workforce Phase A — STATIC PROOF that lib/workforce/** has no path to send a seller message, write a
// stage, create / send / accept an offer, launch a campaign, contact anyone, or run the Decision Engine
// writer: its whole transitive import closure (static + literal dynamic imports) contains none of those
// modules, and no source file names their writers. The composition root (lib/ai/workforce-runtime-
// wiring.js) is pinned to an exact import allowlist and binds every domain service to the guarded
// READ-ONLY data client. The thin routes import only the Workforce route module, the wiring and _shared.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { importClosure, chainTo, listFiles, SRC } from '../helpers/import-graph.mjs'

const WF = path.join(SRC, 'lib/workforce')
const WIRING = path.join(SRC, 'lib/ai/workforce-runtime-wiring.js')
const ROUTES = path.join(SRC, 'app/api/cockpit/workforce')
const rel = (f) => path.relative(SRC, f)

/** Modules that send, queue, dispatch, write offers / stages / campaigns / suppression, or may write the engine row. */
const FORBIDDEN_MODULES = [
  /^lib\/supabase\/sms-engine\.js$/,
  /send-queue|send_queue/,
  /^lib\/domain\/queue\//, // queue writers, runners, canonical send authority, canonical-queue-writer
  /^lib\/domain\/conversation-ai\/runtime\/canonical(?:-shadow)?\.js$/, // decideAndCompose
  /^lib\/ai\/conversation-turn-dispatch\.js$/,
  /^lib\/ai\/action-gateway-execution\.js$/, // the canonical send paths of the Action Gateway
  /^lib\/domain\/action-gateway\/actions\/(?!t2\/shared\.js$)/, // every gateway action (only the pure T2 constants are allowed)
  /textgrid/i,
  /^lib\/domain\/seller-flow\/seller-offer-authority\.js$/, // persistActiveOffer, acceptActiveOffer
  /^lib\/domain\/negotiation\/negotiation-send\.js$/, // sendAuthorizedOffer
  /^lib\/domain\/seller-flow\/finalize-seller-acceptance\.js$/,
  /^lib\/domain\/seller-flow\/resolve-seller-stage-transition\.js$/,
  /^lib\/domain\/opportunity\/opportunity-service\.js$/, // transitionOpportunityStage
  /^lib\/domain\/lead-state\/patch-universal-lead-state\.js$/,
  /^lib\/domain\/campaigns\//, // launch / transition / feeder / live execution
  /^lib\/acquisition\/decisionAuthority\.js$/, // ensurePropertyAcquisitionDecision (may write)
  /^lib\/domain\/followups\//, // follow-up execution writes send_queue rows
  /^lib\/domain\/compliance\/record-phone-suppression\.js$/,
  /^lib\/domain\/seller-flow\/apply-inbound-automation-decision\.js$/,
  /^lib\/domain\/email\//,
  /^lib\/discord\//,
]
const FORBIDDEN_IDENTIFIERS = [
  'decideAndCompose', 'persistActiveOffer', 'sendAuthorizedOffer', 'acceptActiveOffer', 'finalizeSellerAcceptance',
  'resolveSellerStageTransition', 'transitionOpportunityStage', 'patchUniversalLeadState', 'ensurePropertyAcquisitionDecision',
  'insertSendQueue', 'enqueueSendQueue', 'queueOutbound', 'sendSms', 'sendTextgrid', 'runSendQueue', 'processSendQueue',
  'launchCampaign', 'transitionCampaign', 'recordPhoneSuppression', 'releaseAutomationHoldByOperator',
]
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

test('lib/workforce/** — the transitive import closure reaches no send / offer / stage / campaign / engine-writer module', () => {
  const entries = listFiles(WF)
  assert.ok(entries.length >= 20, `${entries.length} workforce files`)
  const { files, externals, missing, parents } = importClosure(entries)
  const reached = [...files].map(rel)
  const bad = reached.filter((f) => FORBIDDEN_MODULES.some((re) => re.test(f)))
  assert.deepEqual(bad.map((f) => chainTo(path.join(SRC, f), parents).join(' → ')), [], 'a forbidden module is reachable from lib/workforce')
  // the closure outside lib/workforce is small, pure and pinned: a NEW dependency is a reviewed change
  const outside = reached.filter((f) => !f.startsWith('lib/workforce/')).sort()
  assert.deepEqual(outside, [
    'lib/acquisition/offer-sanity.js',
    'lib/acquisition/offerReadiness.js',
    'lib/agent/config/agent-config.js',
    'lib/agent/contracts/states.js',
    'lib/agent/missions/mission-codec.js',
    'lib/agent/missions/mission-kinds.js',
    'lib/agent/operations/action-center.js',
    'lib/agent/operations/conversation-facts.js',
    'lib/agent/research/pii.js',
    'lib/agent/runtime/job-runtime.js',
    'lib/agent/runtime/runtime-tick.js',
    'lib/agent/runtime/store.js',
    'lib/agent/security/agent-auth.js',
    'lib/agent/security/rate-limit.js',
    'lib/domain/action-gateway/actions/t2/shared.js',
    'lib/domain/action-gateway/errors.js',
    'lib/domain/holds/automation-hold-core.js',
    'lib/domain/inbox/inbox-bucket-predicates.js',
    'lib/domain/inbox/reply-actionability.js',
    'lib/domain/inbox/resolve-waiting-cold-state.js',
    'lib/domain/seller-flow/valuation-offer-authority.js',
    'lib/security/supabase-session-verifier.js',
  ])
  assert.deepEqual([...externals].sort(), ['node:crypto'], 'no SDK, no network client, no provider')
  assert.deepEqual([...missing], [])
  // no supabase client, no pg, no provider is constructed anywhere inside lib/workforce
  for (const f of entries) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    assert.doesNotMatch(src, /createClient\(|new pg\.|anthropic|fetch\(/i, rel(f))
  }
})

test('lib/workforce/** — no source file names a writer, a sender or the engine-row writer', () => {
  for (const f of [...listFiles(WF), WIRING, ...listFiles(ROUTES)]) {
    const raw = fs.readFileSync(f, 'utf8')
    // the scanner strips comments: a block-comment opener inside a line comment would hide the imports after it
    assert.equal(raw.split('\n').some((l) => /\/\/.*(\/\*|\*\/)/.test(l)), false, `${rel(f)}: a /* or */ inside a line comment`)
    const src = stripComments(raw)
    for (const id of FORBIDDEN_IDENTIFIERS) assert.equal(new RegExp(`\\b${id}\\b`).test(src), false, `${rel(f)} names ${id}`)
    assert.doesNotMatch(src, /from\(\s*['"](send_queue|sms_suppression_list|seller_offers|acquisition_opportunities|campaigns?)['"]\s*\)/, `${rel(f)} touches a business table directly`)
  }
})

test('the composition root: an exact import allowlist; every domain service is bound to the guarded read-only client', () => {
  const src = fs.readFileSync(WIRING, 'utf8')
  const code = stripComments(src)
  const specs = [...code.matchAll(/(?:from\s*|import\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]).sort()
  assert.deepEqual([...new Set(specs)], [
    './anthropic-provider.js', // only when WORKFORCE_MODEL_INTERPRET=1: a job-owned, reserve/settle, intent-choice call
    './operations-runtime-wiring.js', // the daily brief read
    '@/lib/agent/live/live-agent.js',
    '@/lib/agent/missions/index.js',
    '@/lib/agent/missions/mission-model.js',
    '@/lib/agent/missions/property-research-triggers.js',
    '@/lib/agent/quick-scan/read-client.js',
    '@/lib/agent/research/models.js',
    '@/lib/agent/runtime/runtime-service.js',
    '@/lib/domain/compliance/query-active-suppression.js',
    '@/lib/domain/deal-context/deal-context-service.js',
    '@/lib/domain/deal-intelligence/deal-decision-service.js',
    '@/lib/domain/holds/automation-hold.js',
    '@/lib/domain/inbox/thread-context-service.js',
    '@/lib/domain/opportunity/pipeline-command-service.js',
    '@/lib/utils/phones.js',
    '@/lib/workforce/config.js',
    '@/lib/workforce/engine/handlers.js',
    '@/lib/workforce/store/index.js',
  ].sort())
  for (const id of FORBIDDEN_IDENTIFIERS) assert.equal(new RegExp(`\\b${id}\\b`).test(code), false, `the wiring names ${id}`)
  // every bound domain call passes the guarded read client (GET/HEAD + allowlisted STABLE RPCs; writes refused at transport)
  assert.match(code, /const read = db \|\| createQuickScanReadClient\(\{ env \}\)\.client/)
  for (const call of ['listDealContexts', 'getDealContextByProperty', 'getPipelineCommandOverview', 'getDealDecision', 'loadActiveAutomationHolds']) {
    assert.match(code, new RegExp(`${call}\\([^)]*\\{ supabase: read \\}\\)`), `${call} is bound to the read client`)
  }
  assert.match(code, /loadThreadContext\(\{ thread_key, supabase: read \}\)/)
  assert.match(code, /checkAutomationHold\(\{ \.\.\.scope, capability: 'ai_action' \}, \{ supabase: read \}\)/)
  assert.match(code, /queryActiveSuppression\(read, to\)/)
  assert.doesNotMatch(code, /\.(insert|update|upsert|delete|rpc)\(/, 'the wiring writes nothing and calls no RPC itself')
})

test('the thin routes import only the Workforce route module, the wiring and _shared', () => {
  const files = listFiles(ROUTES)
  assert.equal(files.length, 13)
  for (const f of files) {
    const specs = [...stripComments(fs.readFileSync(f, 'utf8')).matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const s of specs) assert.ok(/_shared\.js$/.test(s) || s === '@/lib/workforce/routes.js' || s === '@/lib/ai/workforce-runtime-wiring.js', `${rel(f)} imports ${s}`)
  }
})

test('self-check: the closure walker does see a forbidden module when one is imported', () => {
  const { files } = importClosure([path.join(SRC, 'lib/domain/opportunity/pipeline-command-service.js')])
  assert.ok([...files].map(rel).some((f) => FORBIDDEN_MODULES.some((re) => re.test(f))), 'the guard is not vacuous')
})
