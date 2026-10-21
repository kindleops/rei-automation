// PACKAGE A (hotfix/research-runtime) — the non-contacting AI research runtime, STATIC guarantees.
//
//   1. research / operations kinds have NO import path to the send stack (BFS over the real import graph)
//   2. the runtime registers, and the owner arming SQL arms, ONLY the Package A kinds
//   3. the excluded capabilities are ABSENT from the tree (not merely unwired)
//   4. the valuation refresh has no write path; its write flag is never forwarded to the container
//   5. owner exclusions (Maxwell, Hartford) never enter a job
//   6. the schedule seed / enable script / verify script agree with the code
// The behavioural half (arming with seeded paused / held queue rows and paused campaigns ⇒ zero changes)
// is tests/critical/research-package-a-arming-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RESEARCH_PACKAGE_KINDS, buildResearchPackageHandlers, researchRuntimeHandlers, excludingCandidates, excludingResearchSource } from '../../src/lib/ai/research-runtime-wiring.js'
import { researchExclusionFor, isExcludedRow, EXCLUDED_PROPERTY_IDS, HARTFORD_EXCLUSION } from '../../src/lib/agent/missions/research-exclusions.js'
import { consultHold, HOLD_CAPABILITIES } from '../../src/lib/agent/operations/automation-hold-gate.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { createMissionMemoryReads } from '../../src/lib/agent/missions/index.js'
import { createOperationsMemorySource, createOperationsMemoryStore, OPERATIONS_SCHEDULE_DEFINITIONS } from '../../src/lib/agent/operations/index.js'
import { PROPERTY_RESEARCH_SWEEP } from '../../src/lib/agent/missions/property-research-triggers.js'
import { SCHEDULE_DEFINITIONS } from '../../src/lib/agent/missions/mission-kinds.js'
import { PID, memorySource } from '../helpers/property-research-fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const API = path.resolve(here, '../..')
const REPO = path.resolve(API, '../..')
const SRC = path.join(API, 'src')
const OPS_DIR = path.join(API, 'scripts/ops/research-package-a')
const SEED = path.join(REPO, 'supabase/migrations/PROPOSED_20261020120100_research_package_schedules.sql')

// ── the import graph ────────────────────────────────────────────────────────
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm
function resolveSpec(from, spec) {
  let p
  if (spec.startsWith('@/')) p = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) p = path.resolve(path.dirname(from), spec)
  else return null
  for (const c of [p, `${p}.js`, `${p}.mjs`, path.join(p, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  throw new Error(`unresolved import ${spec} in ${path.relative(API, from)}`)
}
/** BFS: the shortest import chain from `entry` to a file matching `forbidden`, or null; plus the closure size. */
function chainTo(entry, forbidden) {
  const start = path.join(API, entry)
  const prev = new Map([[start, null]])
  const q = [start]
  while (q.length) {
    const f = q.shift()
    const src = fs.readFileSync(f, 'utf8')
    IMPORT_RE.lastIndex = 0
    let m
    while ((m = IMPORT_RE.exec(src))) {
      const d = resolveSpec(f, m[1] || m[2] || m[3])
      if (!d || prev.has(d)) continue
      prev.set(d, f)
      if (forbidden.test(path.relative(SRC, d))) {
        const chain = []
        for (let x = d; x; x = prev.get(x)) chain.unshift(path.relative(SRC, x))
        return { chain, size: prev.size }
      }
      q.push(d)
    }
  }
  return { chain: null, size: prev.size }
}

// THE SEND STACK: every module that can transmit, queue, schedule or release a message, or change a campaign,
// an auto-reply / follow-up mode, a disposition, a stage or an offer — plus the capability plane (whose
// services include Send Now) and every messaging runtime that Package A does not ship.
const SEND_STACK = new RegExp('^lib/(' + [
  'providers/(textgrid|brevo|twilio|email)',
  'domain/queue/(process-send-queue|run-send-queue|canonical-queue-writer|queue-writer|enqueue-|release-|cancel-supabase-pending-outbound|block-send-at-compliance|resolve-deferred-queue-message)',
  'domain/communications/(dispatch-seller-queue-row|seller-communication-store)',
  'domain/inbox/(send-now-service|new-replies-cleanup-apply)',
  'automation/queueAutoReply',
  'domain/seller-flow/(process-seller-inbound-message|apply-inbound-automation-decision|persist-seller-transition|finalize-seller-acceptance|seller-followup-scheduler|no-response-followup|delivery-triggered-followup|execute-referral-automation|recover-)',
  'domain/campaigns/(campaign-automation-service|campaign-launch|campaign-execution)',
  'domain/outbound/supabase-candidate-feeder',
  'domain/followups/',
  'domain/email/',
  'domain/closings/',
  'domain/lead-state/bulk-lead-state-service',
  'agent/capabilities/(index|services)',
  'agent/missions/(mission-capability-hook|research-mission-handler|supervisor-handler|discovery-|research-trigger-hook|missions-routes|missions-service)',
  'agent/operations/(pipeline-reconciler|auto-recovery|dead-deal-correction|ops-intel-capability)',
  'ai/(conversation-|followup-runtime-wiring|mission-runtime-wiring)',
  'supabase/sms-engine',
  'system-control',
].join('|') + ')')

const ENTRIES = [
  'src/lib/ai/research-runtime-wiring.js',
  'src/lib/ai/operations-runtime-wiring.js',
  'src/lib/agent/missions/index.js',
  'src/lib/agent/missions/property-research-handler.js',
  'src/lib/agent/missions/property-research-triggers.js',
  'src/lib/agent/missions/valuation-refresh-handler.js',
  'src/lib/agent/missions/review-digest-handler.js',
  'src/lib/agent/operations/index.js',
  'src/lib/agent/operations/operations-handlers.js',
  'src/lib/agent/operations/operations-routes.js',
  'src/lib/agent/runtime/runtime-service.js',
  'src/lib/domain/property-research/research-pipeline.js',
  'src/lib/domain/valuation-refresh/dry-run.js',
  'src/lib/domain/opportunity-economics/economics-service.js',
  'src/app/api/cockpit/agent/operations/action-center/route.js',
  'src/app/api/cockpit/agent/operations/brief/route.js',
  'src/app/api/cockpit/agent/operations/supervisor/route.js',
  'src/app/api/cockpit/agent/operations/work-items/route.js',
  'src/app/api/cockpit/agent/operations/work-items/[id]/decide/route.js',
]

test('NO-SEND (static): no Package A entry has an import path to the send stack, the capability plane or a messaging runtime', () => {
  for (const e of ENTRIES) {
    const { chain, size } = chainTo(e, SEND_STACK)
    assert.equal(chain, null, `${e} reaches the send stack: ${chain?.join(' -> ')}`)
    assert.ok(size >= 1, e)
  }
})

test('NO-SEND (static): the BFS really finds a send path when one exists (the detector is not vacuous)', () => {
  // the PRODUCTION tick route also loads conversation.decide (shadow); the Intelligence Command capability plane reaches Send Now
  const cap = chainTo('src/lib/agent/capabilities/index.js', /^lib\/(domain\/inbox\/send-now-service|providers\/textgrid)/)
  assert.ok(cap.chain && cap.chain.length >= 2, 'capabilities/index.js → send-now-service is detected')
  const queue = chainTo('src/lib/domain/queue/run-send-queue.js', /^lib\/domain\/queue\/process-send-queue/)
  assert.ok(queue.chain, 'run-send-queue → process-send-queue is detected')
})

test('NO-SEND (static): no Package A module writes a public table through a client (.from(x).insert/update/upsert/delete) or touches system_control / send_queue / campaigns for writing', () => {
  const files = [
    ...fs.readdirSync(path.join(SRC, 'lib/agent/missions')).map((f) => `lib/agent/missions/${f}`),
    ...fs.readdirSync(path.join(SRC, 'lib/agent/operations')).map((f) => `lib/agent/operations/${f}`),
    ...fs.readdirSync(path.join(SRC, 'lib/domain/property-research')).map((f) => `lib/domain/property-research/${f}`),
    ...fs.readdirSync(path.join(SRC, 'lib/domain/valuation-refresh')).map((f) => `lib/domain/valuation-refresh/${f}`),
    ...fs.readdirSync(path.join(SRC, 'lib/domain/opportunity-economics')).map((f) => `lib/domain/opportunity-economics/${f}`),
    'lib/ai/research-runtime-wiring.js', 'lib/ai/operations-runtime-wiring.js',
  ].filter((f) => f.endsWith('.js'))
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8')
    assert.doesNotMatch(src, /\.from\(\s*['"][a-z_]+['"]\s*\)[\s\S]{0,200}?\.(insert|upsert|update|delete)\(/, `${f} writes a table through a client`)
    assert.doesNotMatch(src, /\b(insert\s+into|update|delete\s+from)\s+(public\.)?(send_queue|campaigns|campaign_targets|system_control|inbox_thread_state|acquisition_opportunities|seller_offers|property_acquisition_scores|message_events)\b/i, `${f} writes a messaging / pipeline table in SQL`)
    assert.doesNotMatch(src, /setSystemValue|upsertSystemControl|from ['"]@\/lib\/system-control/, `${f} writes system_control`)
  }
})

test('EXCLUDED CAPABILITIES are absent from the tree, not merely unwired', () => {
  for (const f of [
    'lib/agent/missions/mission-capability-hook.js', 'lib/agent/missions/research-mission-handler.js', 'lib/agent/missions/supervisor-handler.js',
    'lib/agent/missions/discovery-handler.js', 'lib/agent/missions/discovery-source.js', 'lib/agent/missions/research-trigger-hook.js', 'lib/agent/missions/missions-routes.js',
    'lib/agent/operations/pipeline-reconciler.js', 'lib/agent/operations/auto-recovery.js', 'lib/agent/operations/dead-deal-correction.js',
    'lib/ai/mission-runtime-wiring.js', 'lib/ai/followup-runtime-wiring.js', 'lib/ai/conversation-turn-handler.js', 'lib/ai/conversation-turn-wiring.js',
    'lib/domain/followups/followup-execution.js', 'lib/domain/negotiation/negotiation-composer.js', 'lib/domain/negotiation/send-authorization.js',
  ]) assert.equal(fs.existsSync(path.join(SRC, f)), false, `${f} must not exist in Package A`)
  const handlers = fs.readFileSync(path.join(SRC, 'lib/agent/operations/operations-handlers.js'), 'utf8')
  assert.doesNotMatch(handlers, /capability_id:\s*'/, 'no operations handler invokes a capability')
  assert.doesNotMatch(handlers, /enqueueFollowupIntent\(|autoRecoverySource\?\.run|createPipelineReconcileHandler/, 'follow-up linkage, auto-recovery and pipeline.reconcile are removed')
})

// ── the kind allowlist ──────────────────────────────────────────────────────
const ALL_FLAGS = {
  AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1', PROPERTY_RESEARCH_ENABLED: '1', VALUATION_REFRESH_ENABLED: '1', AGENT_OPERATIONS_ENABLED: '1',
  // flags of rc-8.5.21 runtimes NOT in Package A: setting them must change nothing
  AGENT_MISSIONS_ENABLED: '1', LC_FOLLOWUP_EXECUTION: '1', AI_CONVERSATION_SHADOW_ENABLED: 'true', OPS_SUPERVISOR_AUTO_RECOVERY: 'true', VALUATION_REFRESH_WRITE_ENABLED: '1',
}

test('KIND ALLOWLIST: Package A registers ONLY its research / operations kinds, whatever else is switched on', () => {
  assert.deepEqual([...RESEARCH_PACKAGE_KINDS].sort(), ['conversation.review_digest', 'inbox.action_center', 'ops.health_check', 'ops.supervisor', 'property.research', 'property.research_sweep', 'recovery.sweep', 'valuation.refresh'])
  const runtimeStore = createRuntimeMemoryStore({})
  const handlers = buildResearchPackageHandlers({
    env: ALL_FLAGS, runtimeStore, reads: createMissionMemoryReads(runtimeStore),
    operations: { source: createOperationsMemorySource({}), store: createOperationsMemoryStore() },
    sources: { research: memorySource(), sweep: { candidates: async () => [] }, valuation: { candidates: async () => [] }, valuationClient: { from: () => ({}) } },
  })
  // ops.health_check is production's own DEFAULT_RUNTIME_HANDLERS entry (registered by the tick route as before)
  assert.deepEqual(Object.keys(handlers).sort(), RESEARCH_PACKAGE_KINDS.filter((k) => k !== 'ops.health_check').sort())
  for (const k of Object.keys(handlers)) assert.ok(!/^(conversation\.(decide|turn)|followup\.|mission\.|acquisition\.|pipeline\.)/.test(k), k)
  // every flag off ⇒ nothing; the runtime gate off ⇒ nothing
  assert.deepEqual(buildResearchPackageHandlers({ env: {}, runtimeStore, reads: createMissionMemoryReads(runtimeStore), operations: null, sources: { research: memorySource(), sweep: { candidates: async () => [] } } }), {})
  assert.deepEqual(researchRuntimeHandlers({ PROPERTY_RESEARCH_ENABLED: '1', AGENT_OPERATIONS_ENABLED: '1' }), {}, 'AGENT_ENABLED / AGENT_RUNTIME_ENABLED off ⇒ {}')
  assert.deepEqual(researchRuntimeHandlers({ AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1' }), {}, 'no package flag ⇒ {}')
})

test('KIND ALLOWLIST: the tick route adds only researchRuntimeHandlers() to production\'s handler map', () => {
  const route = fs.readFileSync(path.join(SRC, 'app/api/internal/agent/runtime/tick/route.js'), 'utf8')
  assert.match(route, /handlers: \{ \.\.\.DEFAULT_RUNTIME_HANDLERS, \.\.\.conversationRuntimeHandlers\(\), \.\.\.researchRuntimeHandlers\(\) \}/)
  assert.doesNotMatch(route, /missionRuntimeHandlers|operationsRuntimeHandlers|followupRuntimeHandlers/)
})

test('KIND ALLOWLIST: the owner arming SQL arms exactly RESEARCH_PACKAGE_KINDS (one kind with an event budget, ≤ 0.30)', () => {
  const sql = fs.readFileSync(path.join(OPS_DIR, 'activate.sql'), 'utf8')
  const arr = /v_kinds constant text\[\] := array\[([^\]]+)\]/.exec(sql)
  assert.ok(arr, 'kind array present')
  assert.deepEqual([...arr[1].matchAll(/'([a-z._]+)'/g)].map((m) => m[1]).sort(), [...RESEARCH_PACKAGE_KINDS].sort())
  assert.match(sql, /when k = 'property\.research' then jsonb_build_object\('event_budget_cap_usd', 0\.30\)/)
  assert.match(sql, /event_budget_ceilings = '\{"property\.research": 0\.30\}'::jsonb/)
  // it writes ONE table, row id 1, and nothing in public
  assert.deepEqual([...sql.matchAll(/^\s*update\s+([a-z_.]+)/gim)].map((m) => m[1]), ['agent.runtime_limits'])
  assert.doesNotMatch(sql, /\b(insert\s+into|update|delete\s+from)\s+public\./i)
  const verify = fs.readFileSync(path.join(OPS_DIR, 'verify.sql'), 'utf8')
  const vk = /<@ array\[([^\]]+)\]::text\[\] as ok/.exec(verify)
  assert.deepEqual([...vk[1].matchAll(/'([a-z._]+)'/g)].map((m) => m[1]).sort(), [...RESEARCH_PACKAGE_KINDS].sort())
  for (const f of ['preflight.sql', 'verify.sql', 'monitor.sql']) {
    const src = fs.readFileSync(path.join(OPS_DIR, f), 'utf8')
    assert.match(src, /^begin read only;$/m, `${f} is read only`)
    assert.match(src.trim(), /rollback;$/, `${f} ends in rollback`)
    assert.doesNotMatch(src, /\b(insert\s+into|update\s+[a-z_.]+\s+set|delete\s+from|alter\s|drop\s|create\s|grant\s|truncate)\b/i, `${f} writes nothing`)
  }
  const disarm = fs.readFileSync(path.join(OPS_DIR, 'disarm.sql'), 'utf8')
  assert.deepEqual([...new Set([...disarm.matchAll(/^\s*update\s+([a-z_.]+)/gim)].map((m) => m[1]))].sort(), ['agent.runtime_limits', 'agent.runtime_schedule'])
})

test('SCHEDULES: the Package A seed mirrors the code definitions, every schedule born disabled, and the enable script accepts only these names', () => {
  const sql = fs.readFileSync(SEED, 'utf8')
  const calls = [...sql.matchAll(/runtime_upsert_schedule\('([a-z-]+)', '([a-z._]+)', (\d+), :'owner_id',\s*'([^']+)'::jsonb, (false|true), (null|[^;]+?), ([0-9.]+)\);/g)]
  const got = calls.map((m) => ({ name: m[1], kind: m[2], interval_seconds: Number(m[3]), input: JSON.parse(m[4]), enabled: m[5] === 'true', budget: Number(m[7]) }))
  assert.equal(got.length, 7)
  for (const s of got) { assert.equal(s.enabled, false, s.name); assert.equal(s.budget, 0, s.name); assert.ok(RESEARCH_PACKAGE_KINDS.includes(s.kind), s.kind) }
  const byName = Object.fromEntries(got.map((s) => [s.name, s]))
  // operations: the rc-8.5.21 definitions minus pipeline-reconcile, byte-for-byte inputs
  for (const d of OPERATIONS_SCHEDULE_DEFINITIONS.filter((x) => x.kind !== 'pipeline.reconcile')) {
    assert.deepEqual([byName[d.name]?.kind, byName[d.name]?.interval_seconds, byName[d.name]?.input], [d.kind, d.interval_seconds, JSON.parse(JSON.stringify(d.input))], d.name)
  }
  assert.equal(byName['pipeline-reconcile'], undefined)
  assert.equal(byName['acquisition-discovery'], undefined)
  for (const d of SCHEDULE_DEFINITIONS.filter((x) => x.kind !== 'acquisition.discovery')) assert.deepEqual([byName[d.name]?.kind, byName[d.name]?.interval_seconds], [d.kind, d.interval_seconds], d.name)
  // the research sweep: PROPERTY_RESEARCH_SWEEP, with the first-weeks limit 10 (budget plan) instead of 25
  assert.deepEqual([byName[PROPERTY_RESEARCH_SWEEP.name].kind, byName[PROPERTY_RESEARCH_SWEEP.name].interval_seconds, byName[PROPERTY_RESEARCH_SWEEP.name].input], [PROPERTY_RESEARCH_SWEEP.kind, PROPERTY_RESEARCH_SWEEP.interval_seconds, { limit: 10 }])
  assert.deepEqual(byName['recovery-sweep'].input.approved_programs, [], 'no re-engagement program is approved by default')
  const enable = fs.readFileSync(path.join(OPS_DIR, 'enable-schedules.sql'), 'utf8')
  const allowed = /v_allowed constant text\[\] := array\[([^\]]+)\]/.exec(enable)
  assert.deepEqual([...allowed[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort(), Object.keys(byName).sort())
  const kindOf = JSON.parse(/v_kind_of jsonb := '([^']+)'::jsonb/.exec(enable)[1])
  for (const s of got) assert.equal(kindOf[s.name], s.kind, s.name)
  // the posttest runs the same statements
  const post = fs.readFileSync(SEED.replace('.sql', '_posttest.sql'), 'utf8')
  for (const s of got) assert.match(post, new RegExp(`runtime_upsert_schedule\\('${s.name}', '${s.kind.replace('.', '\\.')}', ${s.interval_seconds}, v_owner,`))
})

test('VALUATION: dry run only — write is hard-coded false, no write client exists in the wiring, and the write flag is never forwarded', () => {
  const w = fs.readFileSync(path.join(SRC, 'lib/ai/research-runtime-wiring.js'), 'utf8')
  assert.match(w, /runValuationRefresh\(\{ property_id, client: valuationClient, now: at, write: false, env \}\)/)
  assert.doesNotMatch(w, /writeAuthority|VALUATION_REFRESH_WRITE_ENABLED\s*[:=]|getDefaultSupabaseClient|supabase\/client\.js/)
  const worker = fs.readFileSync(path.join(REPO, 'infra/cloudflare/worker/index.ts'), 'utf8')
  const list = /const AGENT_FORWARDED_VARS = \[([\s\S]*?)\] as const;/.exec(worker)[1]
  const names = [...list.matchAll(/^\s*"([A-Z0-9_]+)",/gm)].map((m) => m[1])
  for (const n of ['PROPERTY_RESEARCH_ENABLED', 'VALUATION_REFRESH_ENABLED', 'AGENT_OPERATIONS_ENABLED', 'AGENT_WEB_RESEARCH_ENABLED', 'RESEARCH_PAID_CALLS_APPROVED', 'RESEARCH_PAID_APPROVAL_REF', 'RESEARCH_PAID_CEILING_USD']) assert.ok(names.includes(n), n)
  for (const n of ['VALUATION_REFRESH_WRITE_ENABLED', 'AGENT_MISSIONS_ENABLED', 'AI_CONVERSATION_SHADOW_ENABLED', 'LC_FOLLOWUP_EXECUTION', 'OPS_SUPERVISOR_AUTO_RECOVERY', 'AGENT_RUNTIME_TICK_CONCURRENT']) assert.ok(!names.includes(n), `${n} is never forwarded`)
})

test('EXCLUSIONS: Maxwell (static hold core) and Hartford (closed lost) never enter a job; everything else passes', async () => {
  assert.ok(EXCLUDED_PROPERTY_IDS.includes('251027062') && EXCLUDED_PROPERTY_IDS.includes(HARTFORD_EXCLUSION.property_id))
  assert.equal(researchExclusionFor({ property_id: '251027062' })?.hold_type, 'permanent_exclusion')
  assert.equal(researchExclusionFor({ thread_id: HARTFORD_EXCLUSION.thread_id })?.hold_type, 'owner_closed_lost')
  assert.equal(researchExclusionFor({ opportunity_id: HARTFORD_EXCLUSION.opportunity_id })?.hold_type, 'owner_closed_lost')
  assert.equal(researchExclusionFor({ property_id: PID }), null)
  assert.equal(isExcludedRow({ conversation_id: HARTFORD_EXCLUSION.thread_id }), true)
  assert.equal(isExcludedRow({ primary_property_id: '251027062' }), true)
  const cands = excludingCandidates({ candidates: async () => [{ property_id: '251027062' }, { property_id: HARTFORD_EXCLUSION.property_id }, { property_id: PID }] })
  assert.deepEqual((await cands.candidates({})).map((c) => c.property_id), [PID])
  const src = excludingResearchSource(memorySource())
  await assert.rejects(() => src.property('251027062'), (e) => e.code === 'PROPERTY_EXCLUDED_BY_OWNER' && e.permanent === true)
  assert.ok(await src.property(PID))
  // the hold gate: exclusions first, an injected checker fails closed, no checker ⇒ not held
  assert.equal((await consultHold(null, { propertyId: '251027062', capability: HOLD_CAPABILITIES.recovery_research })).held, true)
  assert.equal((await consultHold(null, { propertyId: PID, capability: HOLD_CAPABILITIES.recovery_research })).held, false)
  assert.equal((await consultHold(async () => { throw new Error('down') }, { propertyId: PID, capability: HOLD_CAPABILITIES.valuation_refresh })).held, true)
  assert.equal((await consultHold(async () => ({}), { propertyId: PID, capability: HOLD_CAPABILITIES.valuation_refresh })).held, true)
  assert.equal((await consultHold(null, { propertyId: PID })).held, true, 'a missing capability is a hold')
})

// ── the repository guards, applied to every file Package A adds ───────────────
// (The whole-repo forms of these scans need the rc-8.5.21 credential / fixture remediation of files Package A
// does not touch; Package A must not wait for it. Its OWN files are held to the rc-8.5.21 standard here, and the
// whole-repo delta against production 6ecbae6b is reported in PACKAGE-A.md: zero new findings.)
const PACKAGE_A_FILES = () => {
  const out = []
  const mig = path.join(REPO, 'supabase/migrations')
  for (const f of fs.readdirSync(mig)) if (/^PROPOSED_(20261013120000_agent_capabilities|20261014121000_runtime_kind_limits_event_budget|20261014150000_ops_health_snapshot_delivery_ref|20261014120000_persistent_missions|20261016140000_operations_action_center|20261019120000_payload_clean_opaque_ids|20261020120000_research_event_budget_ceilings|20261020120100_research_package_schedules)/.test(f)) out.push(`supabase/migrations/${f}`)
  for (const f of fs.readdirSync(path.join(REPO, 'supabase/tests'))) if (f.startsWith('research_package_')) out.push(`supabase/tests/${f}`)
  for (const f of fs.readdirSync(OPS_DIR)) out.push(`apps/api/scripts/ops/research-package-a/${f}`)
  for (const f of ['scripts/db/fixtures/fix_a_runtime_state.sql', 'scripts/db/fixtures/operations_public_baseline.sql', 'scripts/db/migration-tests.manifest.mjs',
    'apps/api/tests/critical/research-package-a.test.mjs', 'apps/api/tests/critical/research-package-a-arming-pg.test.mjs']) out.push(f)
  return out
}

test('SCANS: every Package A SQL fixture passes the fixture linter; no Package A file names a production target or derives a credential', async () => {
  const { lintFixtureSource } = await import('../../../../scripts/db/lint-migration-fixtures.mjs')
  const prodTargets = await import('../../../../scripts/db/scan-test-prod-targets.mjs')
  const cred = await import('../../../../scripts/db/scan-credential-derivation.mjs')
  const files = PACKAGE_A_FILES()
  assert.ok(files.length >= 40, `${files.length} files`)
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    if (rel.endsWith('.sql')) {
      const r = lintFixtureSource(rel, src)
      assert.deepEqual(r.violations || [], [], `${rel}: ${JSON.stringify(r.violations)}`)
    }
    assert.deepEqual(prodTargets.scanSource(rel, src, 'test').map((f) => `${f.line} ${f.rule}`), [], `${rel} names a production target`)
    assert.deepEqual(cred.scanSource(rel, src, 'script').map((f) => `${f.line} ${f.rule}`), [], `${rel} derives a credential`)
  }
})
