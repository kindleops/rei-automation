// The Action Gateway catalog: every agent-facing action, its capability, tier, resource, closed input
// schema (validated by agent/tools/schema.js) and executor. Phase 1 implements the T1 tools end to end
// plus set_thread_hold (T2, SET only) and run_authorized_reconciliation (report-only). Every other
// requested tool is REGISTERED BUT UNAVAILABLE: it answers not_implemented / capability_not_implemented
// and never silently succeeds.
//
// Tier, capability, resource kind and executor are properties of the SPEC (code review). Nothing a caller
// sends can change them: inputs are closed schemas and identity / authority keys are refused upstream.
import { schemaBoundednessErrors } from '../../agent/tools/schema.js'
import { classifyProhibited } from '../../agent/tools/prohibited.js'
import { UUID, str, int, num, bool, enumOf, list, obj } from '../../agent/capabilities/defs/_schema.js'
import { TIERS, DOMAIN_WRITES } from './constants.js'
import { T2_SPECS, T2_NAMES } from './actions/t2/index.js'
import { T34_ACTIONS, T34_READS, T34_NAMES } from './actions/t34/index.js'

const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })
const PROPERTY_ID = str(64, { minLength: 1, pattern: '^[A-Za-z0-9_-]{1,64}$' })
const ISO_TIME = str(40, { minLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$' })
// free text: printable, no control characters (masked + digit-neutralized before it is stored)
const TEXT = (max, min = 1) => str(max, { minLength: min, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const client = { client_request_id: CLIENT_KEY }

/** Hold reasons an agent may record (codes only; free text goes in the note). */
export const HOLD_REASON_CODES = Object.freeze(['seller_requested_pause', 'ownership_unclear', 'compliance_concern', 'operator_review', 'conflicting_instructions', 'data_quality', 'other'])
export const RECONCILIATION_KINDS = Object.freeze(['pipeline'])

// ── implemented (phase 1) ────────────────────────────────────────────────────
const IMPLEMENTED = [
  {
    name: 'create_research_job',
    title: 'Create a research job',
    description: 'Enqueue a background research mission (mission.research on the R2 runtime: read-only research ask, findings only, no outbound). Budget up to the autonomous ceiling runs on the agent grant; above it (≤ $2.50) a human approval is requested first.',
    capability: 'research.create_job', tier: TIERS.T1, resource: 'property_or_system',
    input: obj({ ...client, question: TEXT(2000), property_ids: list(PROPERTY_ID, 10), campaign_id: UUID, budget_usd: num(0.01, 2.5), max_model_calls: int(1, 4) }, ['client_request_id', 'question']),
    executor: { kind: 'domain_write', fn: DOMAIN_WRITES.runtime_enqueue },
    recovery: 'reexecute',
    limits: { per_min: 6 },
    wraps: { service: 'agent.runtime_enqueue via missions.create semantics (capabilities/defs/platform.js#researchMissionInput)', module: 'apps/api/src/lib/agent/runtime/job-runtime.js' },
    touches: ['agent_runtime_job'],
  },
  {
    name: 'request_property_valuation',
    title: 'Request a property valuation',
    description: 'Ask for a fresh, READ-ONLY valuation work-up of one property: a property.research job (internal dossier, comps, economics, MAO / opening plan as findings). Never writes property_acquisition_scores, an offer or a stage.',
    capability: 'valuation.request', tier: TIERS.T1, resource: 'property',
    input: obj({ ...client, property_id: PROPERTY_ID }, ['client_request_id', 'property_id']),
    executor: { kind: 'domain_write', fn: DOMAIN_WRITES.runtime_enqueue },
    recovery: 'reexecute',
    limits: { per_min: 12 },
    wraps: { service: 'agent.runtime_enqueue(property.research) (missions/property-research-triggers.js#enqueuePropertyResearch shape)', module: 'apps/api/src/lib/agent/missions/property-research-triggers.js' },
    touches: ['agent_runtime_job'],
  },
  {
    name: 'create_operator_task',
    title: 'Create an operator task',
    description: 'Create one operator work item (agent.ops_work_item, scope "agent") in the Inbound Action Center, optionally about a thread or an opportunity. A human acknowledges, resolves or dismisses it there.',
    capability: 'tasks.create_operator_task', tier: TIERS.T1, resource: 'subject_or_system',
    input: obj({ ...client, title: TEXT(160, 3), note: TEXT(600), priority: int(0, 1000), due_at: ISO_TIME, severity: enumOf(['info', 'warning']),
      subject: obj({ type: enumOf(['thread', 'opportunity']), id: UUID }, ['type', 'id']) }, ['client_request_id', 'title']),
    executor: { kind: 'domain_write', fn: DOMAIN_WRITES.operator_task },
    recovery: 'reexecute',
    limits: { per_min: 20 },
    wraps: { service: 'agent.ops_work_item (operations action center), lease-bound writer', module: 'apps/api/src/lib/agent/operations/operations-store.js' },
    touches: ['ops_work_item'],
  },
  {
    name: 'update_operator_task',
    title: 'Update an operator task',
    description: 'Update an AGENT-created operator task: add a note, change priority / due date, or mark it resolved. Work items raised by other subsystems are never touched; acknowledging and dismissing stay human.',
    capability: 'tasks.update_operator_task', tier: TIERS.T1, resource: 'work_item',
    input: obj({ ...client, work_item_id: UUID, note: TEXT(600), priority: int(0, 1000), due_at: ISO_TIME, resolve: bool() }, ['client_request_id', 'work_item_id']),
    executor: { kind: 'domain_write', fn: DOMAIN_WRITES.operator_task },
    recovery: 'reexecute',
    limits: { per_min: 30 },
    wraps: { service: 'agent.ops_work_item (scope agent only)', module: 'apps/api/src/lib/agent/operations/operations-store.js' },
    touches: ['ops_work_item'],
  },
  {
    name: 'draft_seller_reply',
    title: 'Draft a seller reply (never sent)',
    description: 'What the canonical conversation runtime would decide and write for the latest inbound of a thread: decideAndCompose in shadow through the review-draft service. NEVER queued, reserved or sent. Refused when the thread is held, opted out, or a STOP arrives while the draft is prepared.',
    capability: 'conversation.draft_reply', tier: TIERS.T1, resource: 'thread',
    input: obj({ ...client, thread_id: UUID }, ['client_request_id', 'thread_id']),
    executor: { kind: 'js', fn: 'draftSellerReply' },
    recovery: 'reexecute',
    limits: { per_min: 6 },
    wraps: { service: 'ai/conversation-ai-draft-service#draftReplyForInbound → conversation-ai/runtime/canonical#decideAndCompose', module: 'apps/api/src/lib/ai/conversation-ai-draft-service.js' },
    touches: [],
  },
  {
    name: 'set_thread_hold',
    title: 'Set an automation hold on a thread',
    description: 'Record an internal automation hold for one thread in the ONE hold registry (public.automation_holds): every automated path and the send_queue trigger refuse automation on the thread until a HUMAN releases it. SET only; manual operator sends stay possible. Not an offer withdrawal; nothing is sent.',
    capability: 'holds.set_thread_hold', tier: TIERS.T2, resource: 'thread', reversible: true,
    input: obj({ ...client, thread_id: UUID, reason_code: enumOf(HOLD_REASON_CODES), note: TEXT(300) }, ['client_request_id', 'thread_id', 'reason_code']),
    executor: { kind: 'domain_write', fn: DOMAIN_WRITES.thread_hold },
    recovery: 'reexecute',
    limits: { per_min: 20 },
    wraps: { service: 'public.automation_holds (holds/automation-hold.js authority; registry triggers)', module: 'apps/api/src/lib/domain/holds/automation-hold.js' },
    touches: ['automation_hold'],
  },
  {
    name: 'run_authorized_reconciliation',
    title: 'Run a reconciliation (report only)',
    description: 'Run the pipeline reconciler over live opportunities in REPORT-ONLY mode: projection-consistency, missing next action / due date / valuation, stagnation and blocked-contact issues, with the stage the events support. Writes nothing (no stage, no work item, no approval).',
    capability: 'ops.reconciliation_report', tier: TIERS.T1, resource: 'system',
    input: obj({ ...client, kind: enumOf(RECONCILIATION_KINDS), limit: int(1, 500), after_id: UUID }, ['client_request_id', 'kind']),
    executor: { kind: 'js', fn: 'reconciliationReport' },
    recovery: 'reexecute',
    limits: { per_min: 4 },
    wraps: { service: 'agent.ops_pipeline_facts + operations/pipeline-reconciler#reconcileOpportunity (report only)', module: 'apps/api/src/lib/agent/operations/pipeline-reconciler.js' },
    touches: [],
  },
]

// ── registered but unavailable (later phases; the audit names the service each will wrap) ──────────
const stub = (name, capability, tier, title, plan) => ({
  name, title, capability, tier, implemented: false, resource: 'none',
  description: `${title}. NOT AVAILABLE in this phase: every call answers capability_not_implemented. Planned: ${plan}`,
  input: obj({ ...client }, ['client_request_id']),
  executor: { kind: 'none' }, recovery: 'report_unknown', limits: { per_min: 30 }, wraps: { service: plan }, touches: [],
})
const STUBS = [
  stub('update_lead_disposition', 'leads.update_disposition', TIERS.T2, 'Update a lead disposition', 'WRAP lead-state/patch-universal-lead-state#patchUniversalLeadState (dry run first; supported disposition codes only; hold check added)'),
  stub('update_lead_stage', 'leads.update_stage', TIERS.T2, 'Propose a lead stage change', 'REUSE capabilities pipeline.propose_stage_change → transitionOpportunityStage on human approval (stage is a projection)'),
  stub('create_deal_action', 'deals.create_action', TIERS.T2, 'Create a deal next action', 'MISSING: narrow next_action / next_action_due wrapper over opportunity-service#updateOpportunity'),
  stub('request_thread_hold_release', 'holds.request_release', TIERS.T2, 'Request a hold release', 'an operator approval / work item; agents never release holds'),
  stub('schedule_followup', 'followups.schedule', TIERS.T2, 'Schedule a follow-up', 'WRAP followups/followup-lifecycle#planFollowUpIntent (eligible intents only; hold + send-time guard at plan)'),
  stub('cancel_followup', 'followups.cancel', TIERS.T2, 'Cancel a follow-up', 'WRAP followups/followup-lifecycle#closeFollowUpIntentsForThread (reason required)'),
  stub('queue_authorized_reply', 'conversation.queue_reply', TIERS.T3, 'Queue an authorized seller reply', 'WRAP the R3 executor (ai/conversation-ai-r3-executor) only when ai_conversation_send_enabled + the send policy are active and every dispatch guard passes'),
  stub('prepare_acquisition_offer', 'offers.prepare', TIERS.T4, 'Prepare an acquisition offer position', 'REUSE negotiation/negotiation-service#preparePosition (composer view only)'),
  stub('submit_offer_for_approval', 'offers.submit_for_approval', TIERS.T4, 'Submit an offer for approval', 'WRAP an approval capability modelled on negotiation/envelope-approval (MAO cap, envelope validation, drift snapshot)'),
  stub('execute_authorized_offer', 'offers.execute_authorized', TIERS.T4, 'Communicate an authorized offer', 'MISSING: composeNegotiationReply + persistActiveOffer inside a live envelope + send authorization (durable sends-used, amount ≤ ceiling)'),
  stub('record_seller_counteroffer', 'offers.record_counter', TIERS.T2, 'Record a seller counteroffer', 'WRAP negotiation ledger seller_counter bound to an inbound message id (seller-flow/seller-offer-authority#recordSellerCounter)'),
  stub('pause_campaign', 'campaigns.pause', TIERS.T2, 'Pause a campaign', 'WRAP campaigns/campaign-automation-service#applyCampaignLifecycleAction with action fixed to pause'),
  stub('request_campaign_resume', 'campaigns.request_resume', TIERS.T3, 'Request a campaign resume', 'WRAP an approval capability; resume readiness re-checked on approval'),
  stub('adjust_campaign_plan', 'campaigns.adjust_plan', TIERS.T3, 'Adjust a campaign plan', 'MISSING: allowlisted campaign-automation-service#updateCampaign behind approval'),
]

/** Separately scoped reads (no intent; audited; their own scope + grant). */
export const READS = Object.freeze([
  ...T34_READS.map((r) => Object.freeze({ ...r })),
  Object.freeze({
    name: 'read_conversation_context',
    title: 'Read conversation context',
    description: 'For authorized conversation agents: the thread\'s recent messages (bodies, phones and emails masked), conversation facts and stage, the established sender persona (no number), permission state (opt-out / suppression / hold codes) and property evidence. No raw phone number is ever returned; routing is resolved inside LeadCommand.',
    capability: 'conversation.read_context', tier: TIERS.T1, scope: 'conversation_context.read', resource: 'thread',
    input: obj({ thread_id: UUID, message_limit: int(1, 40) }, ['thread_id']),
    limits: { per_min: 20 },
    wraps: { service: 'ai/conversation-canonical-inputs#loadCanonicalInputs (projection) + persona-continuity + eligibility-bridge#dryRunEligibility' },
  }),
])

/** Actions the gateway will NEVER expose (asserted by tests): contracts, withdrawals of communicated offers, legal. */
export const NEVER_EXPOSED = Object.freeze(['sign_contract', 'create_contract', 'withdraw_offer', 'retract_offer', 'accept_offer', 'finalize_closing', 'send_legal_notice', 'release_thread_hold', 'unsuppress', 'set_system_control'])

function freezeSpec(spec) {
  const errs = schemaBoundednessErrors(spec.input)
  if (errs.length) throw new Error(`${spec.name}: input schema not bounded: ${errs.join('; ')}`)
  if (!Object.values(TIERS).includes(spec.tier)) throw new Error(`${spec.name}: tier`)
  if (spec.implemented !== false) {
    const p = classifyProhibited({ name: spec.capability, touches: spec.touches || [], wraps: spec.wraps || {}, input_schema: spec.input })
    if (p.prohibited) throw new Error(`${spec.name}: prohibited (${p.reason})`)
  }
  return Object.freeze({ version: 1, implemented: true, ...spec })
}

export const ACTIONS = Object.freeze([...IMPLEMENTED, ...T2_SPECS, ...T34_ACTIONS, ...STUBS.filter((x) => !T2_NAMES.has(x.name) && !T34_NAMES.includes(x.name))].map(freezeSpec))
export const ACTION_NAMES = Object.freeze(ACTIONS.map((a) => a.name))
export const REQUESTED_TOOLS = Object.freeze(['create_research_job', 'request_property_valuation', 'create_operator_task', 'update_operator_task', 'run_authorized_reconciliation',
  'update_lead_disposition', 'update_lead_stage', 'create_deal_action', 'set_thread_hold', 'request_thread_hold_release',
  'draft_seller_reply', 'schedule_followup', 'cancel_followup', 'queue_authorized_reply',
  'prepare_acquisition_offer', 'submit_offer_for_approval', 'execute_authorized_offer', 'record_seller_counteroffer',
  'pause_campaign', 'request_campaign_resume', 'adjust_campaign_plan'])

export function createActionCatalog(actions = ACTIONS, reads = READS) {
  const byName = new Map([...actions, ...reads].map((a) => [a.name, a]))
  for (const n of NEVER_EXPOSED) if (byName.has(n)) throw new Error(`catalog exposes a never-exposed action: ${n}`)
  return Object.freeze({
    get: (name) => byName.get(String(name || '')) || null,
    actions: () => [...actions],
    reads: () => [...reads],
    isRead: (name) => reads.some((r) => r.name === name),
  })
}
