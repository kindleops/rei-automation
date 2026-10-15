/**
 * DEV-ONLY FETCH DOUBLE for Intelligence Command visual QA.
 *
 * Loaded ONLY by a dev server started with VITE_LC_IC_FIXTURES=1 (the import
 * sites are guarded by `import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1'`,
 * which a production build folds to false — ic-flags.test.ts and
 * scripts/proof/desktop/ic-fixture-bundle-check.mjs prove the module never
 * reaches a bundle). It answers the agent routes with SYNTHETIC data shaped
 * exactly like the real servers (research-routes.js, actions/routes.js,
 * shadow route, shell telemetry), so the real transports, SSE parser and
 * reducers run unchanged. Every name and address here is synthetic.
 *
 *   window.__icDev.limit = n      hold the SSE stream after n events (Infinity = run)
 *   window.__icDev.planes = 'off' answer the actions / runtime / shadow planes as not enabled
 *   window.__icDev.select({...})  publish a property locator (property · thread · deal)
 *   window.__icDev.campaign({...}) publish Campaign Command's open campaign
 */
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { CAMPAIGN_SUBJECT_EVENT } from '../../../views/campaign-command/desktop/war-room-links'

export const IC_DEV_FIXTURE_MARKER = 'lc-ic-dev-fixture-v1'

type Json = Record<string, unknown>
interface ScriptRun { id: string; question: string; plan: boolean; events: Json[]; emitted: number; cancelled: boolean; createdAt: number; listeners: Set<() => void> }

const dev = { limit: Infinity as number, planes: 'on' as 'on' | 'off', speed: 1 }
const runs = new Map<string, ScriptRun>()
const T0 = Date.now()
const iso = (ms = 0) => new Date(T0 + ms).toISOString()
const PIDS = ['9100001', '9100002', '9100003']
const ADDR: Record<string, string> = { 9100001: '1418 Larkspur Ct · synthetic', 9100002: '77 Quarry Row · synthetic', 9100003: '9 Fennel Way · synthetic' }

const STATUS = {
  ok: true, live: true, read_only: true, enabled: true, mode_ok: true,
  models: { ok: true, default: { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }, escalation: { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' } },
  caps: { day_usd: 10, user_day_usd: 10, cycle_usd: 150, run_usd: 2.5 },
  spend: { day_usd: 1.84, cycle_usd: 12.4, day_remaining_usd: 8.16, cycle_remaining_usd: 137.6 },
  runs_today: 6, daily_run_cap: 40, limits: { question_max_chars: 2000, max_model_calls: 10, max_tool_calls: 24 },
  tools: [
    { name: 'eg.distress_signals', label: 'Reading distress signals', tier: 'autonomous_internal', side_effect: 'read' },
    { name: 'eg.contact_map', label: 'Reading the contact map', tier: 'autonomous_internal', side_effect: 'read' },
    { name: 'eg.facts', label: 'Reading Entity Graph facts', tier: 'autonomous_internal', side_effect: 'read' },
    { name: 'eg.recorded_sales', label: 'Reading recorded sales', tier: 'autonomous_internal', side_effect: 'read' },
    { name: 'campaign.overview', label: 'Reading campaign overview', tier: 'autonomous_internal', side_effect: 'read' },
  ],
}

const ANSWER = [
  '**9100001** carries the strongest distress evidence: a recorded tax delinquency (recorded_parcel) and a verified probate status (probate_status). The public web shows no active listing.',
  '',
  '**Evidence**',
  '- 9100001 — tax delinquent 2 years (recorded_parcel); probate verified (probate_status); 3 reachable contact handles, best via SMS (eg.contact_map).',
  '- 9100002 — preforeclosure flag from the target graph; not confirmed by preforeclosure_status_v2 (unavailable is not "no").',
  '- 9100003 — no distress flags in any source read; high estimated equity (vendor-reported).',
  '',
  '**Gaps**',
  '- eg_property_facts timed out for 9100003; its facts were not applied.',
].join('\n')

const PLAN = [
  '**Mission plan — probate follow-through for 1418 Larkspur Ct**',
  '',
  '1. Confirm the probate record and the personal representative — eg.facts, probate_status. Changes the plan if the estate is closed.',
  '2. Map reachable heirs — eg.contact_map (handles only). Any outreach is an approval (inbox.prepare_reply).',
  '3. Check listing status on the public web — web_search (provider-executed). An active listing ends the mission.',
  '4. Pull the nearest LLC investor sales — eg.recorded_sales — for the as-is anchor (SFR lane, no repairs).',
  '5. Propose the next stage on the deal — pipeline.propose_stage_change → **needs your approval**.',
  '',
  '**Open questions**',
  '- Should heirs outside the state be contacted at all?',
].join('\n')

const RESULT = {
  schema: 'lc.ask.result', version: 1,
  blocks: [
    { kind: 'answer', markdown: ANSWER },
    { kind: 'property_research', title: 'Probate + tax delinquency', property_id: PIDS[0], address_label: ADDR[PIDS[0]], summary: 'Two independent distress signals; no active listing found on the public web.', facts: [
      { label: 'Tax status', value: 'Delinquent · 2 years', evidence: 'internal', source: 'recorded_parcel' },
      { label: 'Probate', value: 'Verified · estate open', evidence: 'internal', source: 'probate_status' },
      { label: 'Reachable contacts', value: '3 handles · best SMS', evidence: 'internal', source: 'eg.contact_map' },
      { label: 'Listing', value: 'No active listing found', evidence: 'public_web', source: 'https://example.com/listing-search' },
    ], listing_status: { status: 'Not listed', source_url: 'https://example.com/listing-search', as_of: '2026-10-14' }, gaps: ['eg_property_facts timed out for 9100003'] },
    { kind: 'web_citations', citations: [
      { url: 'https://example.com/county-probate-docket', title: 'County probate docket (synthetic)', retrieved_at: iso() },
      { url: 'https://example.com/listing-search', title: 'Listing search (synthetic)', retrieved_at: iso(), page_age: '2 days' },
    ] },
  ],
  evidence: { internal: { tools: ['eg.distress_signals', 'eg.contact_map'], property_ids: PIDS }, public_web: [
    { url: 'https://example.com/county-probate-docket', title: 'County probate docket (synthetic)', retrieved_at: iso() },
    { url: 'https://example.com/listing-search', title: 'Listing search (synthetic)', retrieved_at: iso() },
  ] },
}

function scriptFor(plan: boolean): Json[] {
  const text = plan ? PLAN : ANSWER
  const chunks = text.match(/[\s\S]{1,28}/g) ?? [text]
  const ev: Json[] = [
    { type: 'run_start', mode: 'research', context: { campaign: false, properties: 3 } },
    { type: 'model_call_start', call: 1, route: 'default', model: 'claude-haiku-5-5', web_offered: true },
    { type: 'model_call_end', call: 1, route: 'default', model: 'claude-haiku-5-5', ok: true, stop: 'tool_use', latency_ms: 840, cost_usd: 0.0021, input_tokens: 3120, output_tokens: 184 },
    { type: 'tool_start', tool: 'eg.distress_signals', label: 'Reading distress signals' },
    { type: 'tool_end', tool: 'eg.distress_signals', rows: 6, outcome: 'ok', latency_ms: 212 },
    { type: 'tool_start', tool: 'eg.contact_map', label: 'Reading the contact map' },
    { type: 'tool_end', tool: 'eg.contact_map', rows: 3, outcome: 'ok', latency_ms: 96 },
    { type: 'model_call_start', call: 2, route: 'default', model: 'claude-haiku-5-5', web_offered: true },
    { type: 'tool_start', call: 2, tool: 'web_search', provider_executed: true },
    { type: 'tool_end', call: 2, tool: 'web_search', provider_executed: true, rows: 5, outcome: 'ok' },
    { type: 'web_search', call: 2, searches: 2, fetches: 0, results: 9, citations: 2 },
    { type: 'model_call_end', call: 2, route: 'default', model: 'claude-haiku-5-5', ok: true, stop: 'tool_use', latency_ms: 2210, cost_usd: 0.0262, input_tokens: 7410, output_tokens: 96 },
    { type: 'tool_start', tool: 'eg.facts', label: 'Reading Entity Graph facts' },
    { type: 'tool_end', tool: 'eg.facts', rows: 0, outcome: 'TOOL_TIMEOUT', latency_ms: 30000 },
    { type: 'model_call_start', call: 3, route: 'escalation', model: 'claude-sonnet-5-5', web_offered: false },
    ...chunks.map((t) => ({ type: 'text_delta', call: 3, text: t })),
    { type: 'model_call_end', call: 3, route: 'escalation', model: 'claude-sonnet-5-5', ok: true, stop: 'end_turn', latency_ms: 6480, cost_usd: 0.0412, input_tokens: 9820, output_tokens: 712 },
    { type: 'result', kind: plan ? 'answer' : 'property_research' },
  ]
  return ev
}

function terminal(r: ScriptRun): Json {
  const plan = r.plan
  return r.cancelled
    ? { type: 'cancelled', state: 'cancelled', outcome: 'CANCELLED', cost_usd: 0.0283, latency_ms: 5200, model_calls: 2, tool_calls: 2, web_searches: 2, answer_md: null, result: null, refusal_class: 'cancelled' }
    : { type: 'completed', state: 'completed', outcome: 'completed', cost_usd: 0.0695, latency_ms: 14300, model_calls: 3, tool_calls: 2, web_searches: 2, answer_md: plan ? PLAN : ANSWER, result: plan ? { schema: 'lc.ask.result', version: 1, blocks: [{ kind: 'answer', markdown: PLAN }], evidence: { internal: { tools: ['eg.facts', 'eg.contact_map'], property_ids: [PIDS[0]] }, public_web: [] } } : RESULT }
}

function runBody(r: ScriptRun): Json {
  const done = r.emitted >= r.events.length || r.cancelled
  const t = terminal(r)
  const audit = [
    { at: iso(0), kind: 'run_start', name: 'research.ask' },
    { at: iso(900), kind: 'model_call', name: 'claude-haiku-5-5', latency_ms: 840, cost_usd: 0.0021, outcome: 'tool_use' },
    { at: iso(1200), kind: 'tool_call', name: 'eg.distress_signals', rows_returned: 6, latency_ms: 212, outcome: 'ok', params_sha256: 'a41f09c2d1e8' },
    { at: iso(1400), kind: 'tool_call', name: 'eg.contact_map', rows_returned: 3, latency_ms: 96, outcome: 'ok', params_sha256: '7c02e5b19f30' },
    { at: iso(3600), kind: 'web_search', name: 'web_search', rows_returned: 5, cost_usd: 0.02, outcome: 'ok' },
    { at: iso(3800), kind: 'model_call', name: 'claude-haiku-5-5', latency_ms: 2210, cost_usd: 0.0262, outcome: 'tool_use' },
    { at: iso(4000), kind: 'tool_call', name: 'eg.facts', rows_returned: 0, latency_ms: 30000, outcome: 'TOOL_TIMEOUT' },
    { at: iso(5000), kind: 'escalation', name: 'claude-sonnet-5-5', outcome: 'multi_property_synthesis' },
    { at: iso(11500), kind: 'model_call', name: 'claude-sonnet-5-5', latency_ms: 6480, cost_usd: 0.0412, outcome: 'end_turn' },
    { at: iso(14300), kind: 'run_end', outcome: 'completed' },
  ]
  return {
    ok: true, live: true, read_only: true, run_id: r.id, state: done ? t.state : 'running', outcome: done ? t.outcome : null, created_at: new Date(r.createdAt).toISOString(), ended_at: done ? new Date(r.createdAt + 14300).toISOString() : null,
    latency_ms: done ? t.latency_ms : null, cost_usd: done ? t.cost_usd : 0.0283, mode: 'research', refusal_class: done && r.cancelled ? 'cancelled' : null,
    models: { default: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' }, counters: { model_calls: done ? 3 : 2, escalated_calls: done ? 1 : 0, escalated_usd: done ? 0.0412 : 0, tool_calls: 2, web_searches: 2 },
    answer: done && t.answer_md ? { answer_md: t.answer_md, property_ids: PIDS, persisted: true } : null,
    calls: [
      { model: 'claude-haiku-5-5', route: 'default', input_tokens: 3120, output_tokens: 184, cost_usd: 0.0021, latency_ms: 840, stop: 'tool_use' },
      { model: 'claude-haiku-5-5', route: 'default', input_tokens: 7410, output_tokens: 96, cost_usd: 0.0262, latency_ms: 2210, stop: 'tool_use' },
      ...(done && !r.cancelled ? [{ model: 'claude-sonnet-5-5', route: 'escalation', input_tokens: 9820, output_tokens: 712, cost_usd: 0.0412, latency_ms: 6480, stop: 'end_turn' }] : []),
    ],
    audit: done ? audit : audit.slice(0, 4), result: done ? t.result : null, refusal: null,
  }
}

/* ── actions plane ────────────────────────────────────────────────────── */

const CAPS = [
  { id: 'platform.health', version: 1, domain: 'platform_ops', title: 'Platform health', side_effect: 'read', tier: 'autonomous_internal', service: 'system-control', approval_class: null, limits: { per_min: 12 } },
  { id: 'missions.create', version: 1, domain: 'missions', title: 'Create a runtime mission', side_effect: 'internal_write', tier: 'autonomous_internal', service: 'agent.runtime_enqueue', approval_class: null, limits: { per_min: 3 } },
  { id: 'pipeline.inspect_stage_evidence', version: 1, domain: 'pipeline', title: 'Inspect stage evidence', side_effect: 'read', tier: 'autonomous_internal', service: 'pipeline-command-service', approval_class: null, limits: {} },
  { id: 'pipeline.propose_stage_change', version: 1, domain: 'pipeline', title: 'Propose a stage change for approval', side_effect: 'internal_write', tier: 'requires_explicit_approval', service: 'opportunity-service#transitionOpportunityStage', approval_class: 'pipeline', limits: { per_min: 6 } },
  { id: 'campaigns.prepare_launch_approval', version: 1, domain: 'campaigns', title: 'Prepare a campaign launch for approval', side_effect: 'outbound_prepare', tier: 'requires_explicit_approval', service: 'campaign-composer#launchComposedCampaign', approval_class: 'campaign_launch', limits: { per_min: 2 } },
  { id: 'inbox.prepare_reply', version: 1, domain: 'inbox', title: 'Prepare a template reply for approval', side_effect: 'outbound_prepare', tier: 'requires_explicit_approval', service: 'send-now-service', approval_class: 'sms', limits: { per_min: 4 } },
]
const approvals = new Map<string, Json>()
let aprSeq = 1
function mkApproval(capability_id: string, intended_change: Json, target: Json, summary: string[], preview: Json | null = null): Json {
  const id = `apr_dev${String(aprSeq++).padStart(4, '0')}synthetic`
  const a = { approval_id: id, capability_id, capability_version: 1, tier: 'requires_explicit_approval', state: 'pending', provenance: 'operator', target, intended_change, summary, payload_hash: `9f3c${id.replace(/\W/g, '').padEnd(60, '0').slice(0, 60)}`, snapshot_hash_prefix: '4be2a7c1d09e', expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), created_at: new Date().toISOString(), decided_at: null, execution_result: null, preview }
  approvals.set(id, a)
  return a
}
mkApproval('inbox.prepare_reply', { action: 'send_template_reply', template_id: 'S2_interest_followup_en', template_row_id: 'tpl_syn_0042', use_case: 'interest_followup', rendered_hash: 'h1', rendered_chars: 118, sender_hash: 'h2' }, { thread_ref: 'thr_abcdefghijklmnop', recipient_mask: '••4471' }, ['Send 1 SMS reply to ••4471 from ••0918 using sms_templates "S2_interest_followup_en" (interest_followup)', 'Rendered 118 characters from the template with server-side merge values', 'Dry run: suppression clear · contact guard ok · sender routed · contact window open'], { message_text: 'Hi Dana, following up on 1418 Larkspur Ct — would you consider an offer on the property as it is today? (synthetic)', recipient_mask: '••4471', sender_mask: '••0918', matches_approved: true })

/* ── telemetry / shadow / runtime ─────────────────────────────────────── */

function telemetry(): Json {
  const now = Date.now()
  const beat = (s: number) => new Date(now - s * 1000).toISOString()
  return {
    ok: true, generated_at: new Date(now).toISOString(), cursor: String(now), replay_suppressed: false, degraded: [],
    metrics: { inbox: { awaiting: 4, needs_review: 1 }, email: null, queue: { today_remaining: 212, approval: 0, processing: 3, sent_today: 1840, delivered_today: 1792, failed_today: 6, status: 'healthy', latest_sent_at: beat(20) }, campaigns: { active: 3, paused: 1, scheduled: 0, attention: 0 }, pipeline: { live: 41, need_you: 2, system: 7, moved_today: 5, blocked: 0 }, workflow: { live_runs: 2, human_holds: 0, events_today: 64 }, closing: { active: 0, needs_you: 0, blocked: 0 } },
    runtimes: [
      { key: 'queue_processor', name: 'Queue processor', owner_href: '/queue', status: 'on', heartbeat_at: beat(40), heartbeat_state: 'fresh', cadence: '*/1', last_run_at: beat(40), runs_24h: 1438, needs_you: 0, in_flight: 3 },
      { key: 'campaign_feeder', name: 'Campaign feeder', owner_href: '/campaign-command', status: 'on', heartbeat_at: beat(170), heartbeat_state: 'fresh', cadence: '*/5', last_run_at: beat(170), runs_24h: 288, needs_you: 0, in_flight: 0 },
      { key: 'workflow_orchestrator', name: 'Workflow orchestrator', owner_href: '/workflow-studio', status: 'on', heartbeat_at: beat(95), heartbeat_state: 'fresh', cadence: '*/5', last_run_at: beat(95), runs_24h: 287, needs_you: 0, in_flight: 2 },
      { key: 'inbound_autoreply', name: 'Inbound auto-reply', owner_href: '/inbox', status: 'off', heartbeat_at: null, heartbeat_state: 'event_driven', cadence: null, last_run_at: null, runs_24h: null, needs_you: 0, in_flight: 0 },
    ],
    events: [],
  }
}

const SHADOW = {
  ok: true, available: true, records: [
    { inbound_message_id: 'msg_syn_0001', created_at: new Date(Date.now() - 14 * 60_000).toISOString(), thread_ref: 'thr_abcdefghijk', property_ids: [PIDS[0]], seller_message_masked: 'Depends on the number. What are you thinking?', understood: { intent: 'price_inquiry', seller_interest: 'conditional', confidence: 0.86 }, stage_evidence: { stage: 'S3_asking_price' }, decision: { outcome: 'REPLY_CANDIDATE', next_objective: 'ask_asking_price' }, draft: { text: 'Happy to share — what number would make it worth it for you? (synthetic)' }, validation: { status: 'passed' }, model: { path: 'haiku', models: ['claude-haiku-5-5'] }, cost: { total_usd: 0.0018 }, latency_ms: 1240 },
    { inbound_message_id: 'msg_syn_0002', created_at: new Date(Date.now() - 52 * 60_000).toISOString(), thread_ref: 'thr_bcdefghijkl', property_ids: [PIDS[1]], seller_message_masked: 'Not interested right now.', understood: { intent: 'not_interested', seller_interest: 'not_interested', confidence: 0.93 }, stage_evidence: { stage: 'nurture' }, decision: { outcome: 'UPDATE_ONLY', next_objective: 'nurture_30d' }, draft: null, validation: { status: 'not_applicable' }, model: { path: 'haiku', models: ['claude-haiku-5-5'] }, cost: { total_usd: 0.0011 }, latency_ms: 880 },
  ],
}

const MISSIONS = [
  { job_id: 'mjob_0000dev1-0000-4000-8000-000000000001', kind: 'ops.health_check', state: 'completed', requested_by: 'operator:dev', trigger_kind: 'manual', attempt: 1, max_attempts: 3, priority: 100, budget_cap_usd: 0, progress: { step: 'record', steps_done: 3, steps_total: 3 }, result: { problems: 0, heartbeats: { queue_processor_last_run_at: 'fresh' } }, last_error: null, created_at: iso(-3600_000), updated_at: iso(-3590_000), ended_at: iso(-3590_000), heartbeat_at: iso(-3591_000) },
  { job_id: 'mjob_0000dev1-0000-4000-8000-000000000002', kind: 'ops.health_check', state: 'running', requested_by: 'operator:dev', trigger_kind: 'schedule', attempt: 1, max_attempts: 3, priority: 100, budget_cap_usd: 0, progress: { step: 'evaluate', steps_done: 1, steps_total: 3 }, result: null, last_error: null, created_at: iso(-40_000), updated_at: iso(-5_000), ended_at: null, heartbeat_at: iso(-5_000) },
]

/* ── the double ───────────────────────────────────────────────────────── */

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const off = () => new Response(null, { status: 404 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sse(r: ScriptRun, after: number): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(': lc-ask events (dev fixture)\n\n'))
      let i = after
      while (i < r.events.length && !r.cancelled) {
        while (i >= dev.limit && !r.cancelled) await sleep(120)
        if (r.cancelled) break
        const e: Json = { seq: i + 1, at: new Date().toISOString(), ...r.events[i] }
        c.enqueue(enc.encode(`id: ${e.seq}\nevent: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`))
        i += 1
        r.emitted = Math.max(r.emitted, i)
        await sleep((e.type === 'text_delta' ? 45 : e.type === 'tool_end' && e.outcome !== 'ok' ? 900 : 420) / dev.speed)
      }
      const t: Json = { seq: r.events.length + 1, at: new Date().toISOString(), ...terminal(r) }
      r.emitted = r.events.length
      c.enqueue(enc.encode(`id: ${t.seq}\nevent: ${String(t.type)}\ndata: ${JSON.stringify(t)}\n\n`))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

async function route(url: URL, init: RequestInit | undefined): Promise<Response | null> {
  const p = url.pathname
  const method = (init?.method || 'GET').toUpperCase()
  const body = (() => { try { return JSON.parse(String(init?.body ?? '{}')) as Json } catch { return {} } })()
  if (p === '/api/cockpit/agent/live/ask') {
    if (method === 'GET') return json(STATUS)
    const q = String(body.question ?? '')
    const id = `ask_dev${Date.now().toString(36)}${runs.size}`
    const plan = /^PLAN A MISSION/.test(q)
    runs.set(id, { id, question: q, plan, events: scriptFor(plan), emitted: 0, cancelled: false, createdAt: Date.now(), listeners: new Set() })
    return json({ ok: true, live: true, run_id: id, state: 'running' }, 202)
  }
  let m = /^\/api\/cockpit\/agent\/live\/ask\/([^/]+)(\/events|\/cancel)?$/.exec(p)
  if (m) {
    const r = runs.get(m[1])
    if (!r) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404)
    if (m[2] === '/events') return sse(r, Number(url.searchParams.get('after') || 0))
    if (m[2] === '/cancel') { if (r.emitted >= r.events.length) return json({ ok: false, error: 'RUN_NOT_ACTIVE' }, 409); r.cancelled = true; return json({ ok: true, run_id: r.id, state: 'cancelling' }, 202) }
    return json(runBody(r))
  }
  if (p === '/api/cockpit/agent/live/runs') return json({ ok: true, live: true, runs: [{ run_id: 'qs_dev0001', title: 'Quick Scan · 1418 Larkspur Ct · synthetic', state: 'completed', property_count: 1, created_at: iso(-7200_000), ended_at: iso(-7190_000) }] })
  if (p.startsWith('/api/cockpit/agent/actions') || p.startsWith('/api/cockpit/agent/runtime')) {
    if (dev.planes === 'off') return off()
  }
  if (p === '/api/cockpit/agent/actions') return json({ ok: true, capabilities: CAPS })
  if (p === '/api/cockpit/agent/actions/invoke') {
    const cap = String(body.capability_id ?? '')
    const input = (body.input ?? {}) as Json
    if (cap === 'platform.health') return json({ ok: true, status: 'read', capability_id: cap, result: { at: new Date().toISOString(), heartbeats: [{ key: 'queue_processor_last_run_at', status: 'fresh', age_seconds: 41, threshold_seconds: 300, observed_at: iso() }, { key: 'campaign_feeder_last_batch_at', status: 'fresh', age_seconds: 172, threshold_seconds: 900, observed_at: iso() }, { key: 'workflow_runtime_last_tick_at', status: 'stale', age_seconds: 1260, threshold_seconds: 900, observed_at: iso() }], modes: {}, queue: { sends_due_waiting: 0, failed_1h: 1 }, watchdog: { findings: [{ code: 'WORKFLOW_TICK_STALE', severity: 'warning', summary: 'Workflow runtime tick older than its threshold (synthetic)' }], unknown: [] } } })
    if (cap === 'missions.create') return json({ ok: true, status: 'executed', capability_id: cap, result: { job_id: 'mjob_0000dev1-0000-4000-8000-000000000003', state: 'queued', deduped: false } })
    if (cap === 'pipeline.propose_stage_change') {
      const a = mkApproval(cap, { action: 'stage_change', opportunity_id: input.opportunity_id, from_stage: 'asking_price', to_stage: input.to_stage, reason: input.reason }, { opportunity_id: input.opportunity_id }, [`Move opportunity from asking_price → ${String(input.to_stage)}`, `Reason: ${String(input.reason)}`, 'On approval the pipeline transition re-validates; offer / contract stages need recorded events.'])
      return json({ ok: true, status: 'approval_pending', capability_id: cap, approval_id: a.approval_id, expires_at: a.expires_at, deduped: false })
    }
    if (cap === 'campaigns.prepare_launch_approval') {
      const a = mkApproval(cap, { action: 'launch', campaign_id: input.campaign_id, from_status: 'draft', start: { mode: input.start, at: input.start_at ?? null }, expected_eligible: null }, { campaign_id: input.campaign_id }, ['Launch campaign "Spring probate · synthetic" (draft → active, starting now)', 'Strategy ownership_check (S1) · size 250', 'Readiness now: ready'])
      return json({ ok: true, status: 'approval_pending', capability_id: cap, approval_id: a.approval_id, expires_at: a.expires_at, deduped: false })
    }
    return json({ ok: false, status: 'refused', code: 'CAPABILITY_NOT_REGISTERED' }, 404)
  }
  if (p === '/api/cockpit/agent/actions/approvals') {
    const st = url.searchParams.get('state') || 'pending'
    return json({ ok: true, approvals: [...approvals.values()].filter((a) => st === 'all' || a.state === st).reverse() })
  }
  m = /^\/api\/cockpit\/agent\/actions\/approvals\/([^/]+)(\/decide)?$/.exec(p)
  if (m) {
    const a = approvals.get(m[1])
    if (!a) return json({ ok: false, code: 'APPROVAL_NOT_FOUND' }, 404)
    if (!m[2]) return json({ ok: true, approval: a })
    if (body.payload_hash !== a.payload_hash) return json({ ok: false, code: 'HASH_MISMATCH' }, 409)
    const ch = a.intended_change as Json
    if (body.decision === 'deny') Object.assign(a, { state: 'denied', decided_at: new Date().toISOString() })
    else Object.assign(a, { state: 'executed', decided_at: new Date().toISOString(), execution_result: ch.action === 'stage_change' ? { ok: true, code: null, from_stage: ch.from_stage, to_stage: ch.to_stage, readback: { stage: ch.to_stage, status: 'active' } } : { ok: true, code: null, readback: { status: 'sent' } } })
    return json({ ok: true, state: a.state, code: null, replayed: false, execution_result: a.execution_result })
  }
  if (p === '/api/cockpit/agent/conversation-ai/shadow') return dev.planes === 'off' ? json({ ok: true, available: false, records: [], code: 'SHADOW_TABLE_NOT_APPLIED' }) : json(SHADOW)
  if (p === '/api/cockpit/agent/runtime/status') return json({ ok: true, status: { at: iso(), limits: { runtime_enabled: true, emergency_stop: false, max_concurrency_global: 2, kind_limits: { 'ops.health_check': { enabled: true } } }, open: { running: 1 }, ended_24h: { completed: 1 }, heartbeats: [{ worker_id: 'agent-runtime-tick', last_tick_at: iso(-30_000), ticks: 1440, age_s: 30 }], schedules: [] } })
  if (p === '/api/cockpit/agent/runtime/missions') return json({ ok: true, missions: MISSIONS })
  m = /^\/api\/cockpit\/agent\/runtime\/missions\/([^/]+)\/events$/.exec(p)
  if (m) return json({ ok: true, events: [{ id: 1, job_id: m[1], at: iso(-40_000), type: 'job.enqueued', state: 'queued', attempt: 0, actor: 'operator:dev', payload: {} }, { id: 2, job_id: m[1], at: iso(-35_000), type: 'job.started', state: 'running', attempt: 1, actor: 'agent-runtime-tick', payload: {} }, { id: 3, job_id: m[1], at: iso(-5_000), type: 'job.progress', state: 'running', attempt: 1, actor: 'agent-runtime-tick', payload: { step: 'evaluate' } }] })
  if (p === '/api/cockpit/shell/telemetry') return json(telemetry())
  if (p === '/api/cockpit/entity-graph/search') {
    const tab = url.searchParams.get('tab')
    if (tab === 'properties') return json({ results: PIDS.map((id) => ({ entityId: id, title: ADDR[id], subtitle: 'Dallas · synthetic' })) })
    if (tab === 'markets') return json({ results: [{ entityId: 'mkt_dal', title: 'Dallas, TX', subtitle: 'market' }] })
    return json({ results: [] })
  }
  if (p === '/api/cockpit/campaigns') return json({ campaigns: [{ id: '11111111-2222-3333-4444-555555555555', campaign_name: 'Spring probate · synthetic', status: 'draft' }] })
  return null
}

let installed = false
export function installIcDevFixtures() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const real = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let url: URL
    try { url = new URL(raw, window.location.origin) } catch { return real(input, init) }
    if (url.pathname.startsWith('/api/cockpit/')) {
      const r = await route(url, init ?? (input instanceof Request ? { method: input.method } : undefined))
      if (r) return r
    }
    return real(input, init)
  }) as typeof window.fetch
  ;(window as unknown as { __icDev?: unknown }).__icDev = {
    marker: IC_DEV_FIXTURE_MARKER,
    get limit() { return dev.limit }, set limit(n: number) { dev.limit = n },
    get planes() { return dev.planes }, set planes(v: 'on' | 'off') { dev.planes = v },
    set speed(v: number) { dev.speed = v },
    select: (l: { propertyId?: string; address?: string; threadKey?: string; opportunityId?: string }) => setPropertyLocator(l, { explicit: true }),
    campaign: (c: { campaignId: string; name: string }) => { window.sessionStorage.setItem('nexus:campaign-subject:v1', JSON.stringify(c)); window.dispatchEvent(new CustomEvent(CAMPAIGN_SUBJECT_EVENT, { detail: c })) },
  }
}
