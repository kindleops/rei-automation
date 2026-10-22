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
  assert.equal(files.length, 12)
  for (const f of files) {
    const specs = [...stripComments(fs.readFileSync(f, 'utf8')).matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const s of specs) assert.ok(/_shared\.js$/.test(s) || s === '@/lib/workforce/routes.js' || s === '@/lib/ai/workforce-runtime-wiring.js', `${rel(f)} imports ${s}`)
  }
})

test('self-check: the closure walker does see a forbidden module when one is imported', () => {
  const { files } = importClosure([path.join(SRC, 'lib/domain/opportunity/pipeline-command-service.js')])
  assert.ok([...files].map(rel).some((f) => FORBIDDEN_MODULES.some((re) => re.test(f))), 'the guard is not vacuous')
})

// ── Workforce × Agntei (docs/WORKFORCE-AGNTEI.md §2): the gateway's Workforce actions are T1 INTERNAL ONLY ──
const GW_WF = path.join(SRC, 'lib/domain/action-gateway/actions/workforce')
const AGNTEI_SQL = path.resolve(SRC, '../../../supabase/migrations/PROPOSED_20261022110000_workforce_agntei.sql')

test('the gateway Workforce actions (actions/workforce/**) — their import closure reaches no send / offer / stage / campaign / contact module', () => {
  const entries = listFiles(GW_WF)
  assert.ok(entries.length >= 1)
  const { files, externals, missing, parents } = importClosure(entries)
  const reached = [...files].map(rel)
  // the gateway's own modules this family may use: its constants / errors, the pure T2 text helpers, and itself
  const allowedGateway = (f) => /^lib\/domain\/action-gateway\/(constants|errors)\.js$/.test(f) || f === 'lib/domain/action-gateway/actions/t2/shared.js' || f.startsWith('lib/domain/action-gateway/actions/workforce/')
  const bad = reached.filter((f) => !allowedGateway(f) && FORBIDDEN_MODULES.some((re) => re.test(f)))
  assert.deepEqual(bad.map((f) => chainTo(path.join(SRC, f), parents).join(' → ')), [], 'a forbidden module is reachable from the gateway Workforce actions')
  assert.ok(!reached.some((f) => /^lib\/domain\/action-gateway\/(gateway|actions|catalog)\.js$/.test(f)), 'the family never reaches the gateway core (no path to the other tool families)')
  assert.deepEqual([...externals].sort(), ['node:crypto'])
  assert.deepEqual([...missing], [])
  for (const f of entries) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    for (const id of FORBIDDEN_IDENTIFIERS) assert.equal(new RegExp(`\\b${id}\\b`).test(src), false, `${rel(f)} names ${id}`)
    assert.doesNotMatch(src, /createClient\(|new pg\.|fetch\(|from\(\s*['"]/, `${rel(f)} builds a client or touches a table`)
  }
})

test('the gateway Workforce actions are T1, internal, never seller-facing; every write is the ONE Workforce writer, whose SQL writes no seller-facing table', async () => {
  const { WF_ACTIONS, WF_READS } = await import('../../src/lib/domain/action-gateway/actions/workforce/index.js')
  const { WORKFORCE_GATEWAY_TOOLS } = await import('../../src/lib/workforce/agntei/tools.js')
  assert.deepEqual([...WF_ACTIONS, ...WF_READS].map((s) => s.name).sort(), WORKFORCE_GATEWAY_TOOLS.map((t) => t.tool).sort())
  for (const s of [...WF_ACTIONS, ...WF_READS]) {
    assert.equal(s.tier, 1, s.name)
    assert.match(s.capability, /^workforce\.[a-z_]+$/, s.name)
    assert.doesNotMatch(s.name, /(send|sms|text|offer|stage|campaign|contact|dispatch|queue)/, s.name)
  }
  for (const s of WF_ACTIONS) {
    assert.deepEqual(s.executor, { kind: 'domain_write', fn: 'action_gateway_dw_workforce' }, s.name)
    for (const t of s.touches) assert.ok(['workforce', 'agent_runtime_job'].includes(t), `${s.name} touches ${t}`)
  }
  const sql = fs.readFileSync(AGNTEI_SQL, 'utf8').replace(/--[^\n]*/g, '')
  const body = (name) => { const i = sql.indexOf(`function ${name}(`); assert.ok(i > 0, name); return sql.slice(i, sql.indexOf('\n$fn$;', i) > 0 && sql.indexOf('\n$fn$;', i) < sql.indexOf('\n$$;', i) ? sql.indexOf('\n$fn$;', i) : sql.indexOf('\n$$;', i)) }
  for (const fn of ['public.action_gateway_dw_workforce', 'public.action_gateway_workforce_read', 'workforce.assignment_claim_external', 'workforce.assignment_handoff', 'workforce.employee_link_external', 'workforce.employee_bind_principal', 'workforce.employee_unbind']) {
    const b = body(fn)
    assert.doesNotMatch(b, /\b(send_queue|seller_offers|negotiation_\w+|followup_intent_plan|campaign_transition_status|sms_suppression_list|automation_holds|acquisition_opportunities)\b/i, `${fn} names a seller-facing table / writer`)
    assert.doesNotMatch(b, /(insert\s+into|update|delete\s+from)\s+public\./i, `${fn} writes public.*`)
    for (const m of b.matchAll(/runtime_enqueue\(\s*'([a-z_.]+)'/g)) assert.ok(['workforce.coo_plan', 'property.research'].includes(m[1]), `${fn} enqueues ${m[1]}`)
  }
})
