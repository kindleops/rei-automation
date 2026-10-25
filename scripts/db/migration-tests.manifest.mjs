// Migration tests the runner (run-migration-test.mjs) knows how to execute on a
// disposable PostgreSQL. Each entry:
//   setup            files (or { name, sql }) applied first — shims and already-applied
//                    prerequisite migrations; never fixtures that end in COMMIT
//   pretest          read-only prerequisite fixture; must leave no trace
//   apply            the migration file(s) under test, in order
//   verify           read-only "check | ok | detail" selects; any ok = f fails
//   posttest         BEGIN … assertions … ROLLBACK fixtures run after apply
//   rollback         rollback file(s) (applied in reverse order)
//   rollbackEnv      env for the rollback psql (e.g. PGOPTIONS session settings)
//   rollbackPosttest fixtures run after the rollback
//   requires         set ⇒ not part of --all (needs inputs CI does not have)
// Paths are repo-relative. Every fixture is linted before anything runs.

const M = (f) => `supabase/migrations/${f}`
const R = (f) => `supabase/rollbacks/${f}`
const T = (f) => `supabase/tests/${f}`
/**
 * Setup marker: restore a production-shaped SCHEMA-ONLY snapshot first (local input given with
 * --prod-shape / LC_PROD_SHAPE_SETUP, never committed). Entries that need it are not part of
 * --all unless a snapshot is given. CI has no snapshot.
 */
export const PROD_SHAPE = 'prod-shape-schema-snapshot'
const SHIM = 'apps/api/tests/pg/supabase-shim.sql'
const DURABILITY = 'apps/api/supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql'
const S3 = M('PROPOSED_20261010120000_agent_s3_persistence.sql')
const RESEARCH = M('PROPOSED_20261010130000_agent_research_ro.sql')
const RUNTIME = M('PROPOSED_20261012140000_intel_runtime.sql')
// ops_health_snapshot reads these two (same fixture as tests/critical/agent-runtime-pg.test.mjs)
const RUNTIME_PUBLIC_FIXTURE = {
  name: 'public.system_control + public.send_queue (runtime fixture)',
  sql: `create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
        create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
        create index if not exists idx_send_queue_status_sched on public.send_queue (queue_status, scheduled_for);
        revoke all on public.system_control, public.send_queue from agent_api;`,
}
const SEND_QUEUE_BASELINE = 'scripts/db/fixtures/send_queue_live_baseline.sql'
// 8.5.20 part C: the public tables the operations read functions read (prod-shaped subset)
const OPS_PUBLIC_BASELINE = 'scripts/db/fixtures/operations_public_baseline.sql'
// the UNRELATED legacy production public.conversation_turns (phase-3, 10 columns): the 8.5.20
// part A turn engine is public.conversation_reply_turns and must never touch it
const LEGACY_CONVERSATION_TURNS = 'scripts/db/fixtures/legacy_conversation_turns_baseline.sql'
const KIND_LIMITS_FIX = M('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql')
const CONV_DECIDE_BUDGET = M('PROPOSED_20261013161000_conversation_decide_event_budget.sql')
const CAPS = M('PROPOSED_20261013120000_agent_capabilities.sql')
const CONV_AI_SHADOW = M('PROPOSED_20261013160000_conversation_ai_shadow.sql')
const OPS_HEALTH_DELIVERY_REF = M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql')
const MISSIONS = M('PROPOSED_20261014120000_persistent_missions.sql')
const MESSAGE_ORIGIN = M('PROPOSED_20261015130000_message_origin_ai_generated_messages.sql')
const NEGOTIATION = M('PROPOSED_20261015190000_negotiation_authority.sql')
const FEEDBACK = M('PROPOSED_20261015191000_ai_operator_feedback.sql')
const ASKING_PRICE_MIRROR = M('PROPOSED_20261015110000_block_repeat_asking_price_mirror.sql')
const ASKING_PRICE_QUESTION_KIND = M('PROPOSED_20261015120000_repeat_asking_price_question_kind.sql')
// rc-8.5.20 parts A / C, needed as setup by the 8.5.21-b entries
const REPLY_TURNS = M('PROPOSED_20261016120000_conversation_reply_turns.sql')
const OPS_ACTION_CENTER = M('PROPOSED_20261016140000_operations_action_center.sql')
// P0 automation-hold registry (rc-8.5.20-holds = hotfix/automation-holds). ALREADY APPLIED TO PRODUCTION
// VIA THE HOTFIX before rc-8.5.21 deploys; it stays the FIRST link of the disposable release chain so
// every later migration (and its rollback) is proven against a database that carries the hold triggers.
const HOLDS_REGISTRY = M('PROPOSED_20261016200000_automation_holds_registry.sql')
const HOLDS_PUBLIC_BASELINE = 'scripts/db/fixtures/automation_holds_public_baseline.sql'
// rc-8.5.21 part A
const COMPANY_IDENTITY = M('PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql')
const GRAPH_PRIOR_REPLY_NOT_OWNER = M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner.sql')
const GRAPH_LIVE_FUNCTIONS_BASELINE = 'scripts/db/fixtures/campaign_target_graph_live_functions_baseline.sql'
// OWNER DECISION 2026-10-17: the declined-unverified role (property × contact hold)
const CPR_DECLINED = M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql')
const FOLLOWUP_LIFECYCLE = M('PROPOSED_20261017120000_followup_intent_lifecycle.sql')
const CPR_LIVE_CONSTRAINTS = 'scripts/db/fixtures/contact_property_resolution_live_constraints.sql'
// OWNER DIRECTIVE 2026-10-17: no duplicate response to the same inbound turn (dispatch lease + send_queue backstop)
const DISPATCH_LEASE = M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql')
// blind-eval D3: an R3 hold raises one operator work item per turn (scope 'conversation')
const TURN_OPERATOR_ITEMS = M('PROPOSED_20261017122000_conversation_turn_operator_items.sql')
// #25 rc-8.5.21: agent.payload_is_clean never rejects a random UUID / opaque hex id token (finding_doc_check defect)
const PAYLOAD_OPAQUE_IDS = M('PROPOSED_20261019120000_payload_clean_opaque_ids.sql')
// OPTIONAL link #26 (separately approved; #25 on rc-8.5.21-mcp, renumbered at the final integration): LeadCommand MCP 1.0 live-mode credential lc_mcp_reader. The chain
// baseline adds ONLY the MCP read-inventory relations the chain fixtures lack; the chain posttest calls the five
// operations read functions AS the role against the REAL chain objects (they are plpgsql: they bind when called).
const LC_MCP_READER = M('PROPOSED_20261019150000_lc_mcp_reader.sql')
const LC_MCP_CHAIN_BASELINE = 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_baseline.sql'
// Roles are CLUSTER-global: a test database is dropped at the end of its run, but the lc_mcp_reader role it left
// (cycle 2 re-applies) survives into the next test on the same cluster (--all). Drop that leftover before the
// setup so each entry starts from "the role does not exist" (DROP ROLE also drops its authenticator membership;
// the databases that held its grants are already gone).
const LC_MCP_ROLE_RESET = { name: 'drop a leftover lc_mcp_reader role (cluster-global; disposable cluster only)', sql: 'drop role if exists lc_mcp_reader;' }
// OPTIONAL link #26 (separately approved; after #25): the Action Gateway durable schema + the scoped execution
// role lc_action_gateway (docs/ACTION-MCP.md). Standalone setup = the REAL prerequisite migrations + a baseline of
// the read-inventory relations; the chain entry applies it LAST.
const ACTION_GATEWAY = M('PROPOSED_20261019160000_action_gateway.sql')
const ACTION_GATEWAY_BASELINE = 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_baseline.sql'
// Roles are CLUSTER-global (see LC_MCP_ROLE_RESET): drop a leftover lc_action_gateway before each entry's setup.
const ACTION_ROLE_RESET = { name: 'drop a leftover lc_action_gateway role (cluster-global; disposable cluster only)', sql: 'drop role if exists lc_action_gateway;' }
// OPTIONAL link #27 (separately approved; after #26): the Action Gateway Tier-2 domain writers + the composable
// extension registry (docs/ACTION-MCP.md §8). Its baseline carries the live campaign lifecycle writer
// (campaign_transition_status + its edge seed, verbatim) and the columns the T2 snapshots read.
const ACTION_GATEWAY_T2 = M('PROPOSED_20261020100000_action_gateway_t2.sql')
const ACTION_GATEWAY_T2_BASELINE = 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t2_baseline.sql'
// OPTIONAL link #28 (separately approved; after #27): the Action Gateway T3 (seller-facing) / T4 (financial) family +
// R4 (persistence-layer ceiling) + R5 (durable send budget). It ADDS ROWS to #27's extension registry (self-check,
// complete) and never re-edits those bodies.
const ACTION_GATEWAY_T34 = M('PROPOSED_20261020110000_action_gateway_t34.sql')
const ACTION_GATEWAY_T34_BASELINE = 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t34_baseline.sql'
// rc-8.5.21 part B
const EVENT_BUDGET_CEILINGS = M('PROPOSED_20261016160000_runtime_event_budget_ceilings.sql')
const SEND_AUTHORIZATION = M('PROPOSED_20261016161000_negotiation_send_authorization.sql')
const OPS_RESEARCH_VALUATION = M('PROPOSED_20261016162000_ops_research_valuation_snapshot.sql')
// the production column the 8.5.21-b supervisor read adds to the operations fixture (decision_tier)
const RESEARCH_VALUATION_BASELINE = 'scripts/db/fixtures/research_valuation_public_baseline.sql'
// ops_health_snapshot_delivery_ref reads max(public.send_queue.delivered_at)
const SEND_QUEUE_DELIVERED_AT = {
  name: 'public.send_queue.delivered_at (ops health fixture)',
  sql: `alter table public.send_queue add column if not exists delivered_at timestamptz;`,
}

const BASE_TESTS = [
  {
    id: 'agent_s3_persistence',
    setup: [SHIM, DURABILITY],
    pretest: M('PROPOSED_20261010120000_agent_s3_persistence_pretest.sql'),
    apply: [S3],
    rollback: [M('PROPOSED_20261010120000_agent_s3_persistence_rollback.sql')],
  },
  {
    id: 'agent_research_ro',
    setup: [SHIM, DURABILITY, S3],
    pretest: M('PROPOSED_20261010130000_agent_research_ro_pretest.sql'),
    apply: [RESEARCH],
    verify: [M('PROPOSED_20261010130000_agent_research_ro_verify.sql')],
    rollback: [M('PROPOSED_20261010130000_agent_research_ro_rollback.sql')],
  },
  {
    id: 'intel_runtime',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE],
    pretest: M('PROPOSED_20261012140000_intel_runtime_pretest.sql'),
    apply: [RUNTIME],
    verify: [M('PROPOSED_20261012140000_intel_runtime_verify.sql')],
    posttest: [M('PROPOSED_20261012140000_intel_runtime_posttest.sql')],
    rollback: [M('PROPOSED_20261012140000_intel_runtime_rollback.sql')],
  },
  {
    id: 'agent_capabilities',
    setup: [SHIM, DURABILITY, S3],
    pretest: M('PROPOSED_20261013120000_agent_capabilities_pretest.sql'),
    apply: [M('PROPOSED_20261013120000_agent_capabilities.sql')],
    posttest: [M('PROPOSED_20261013120000_agent_capabilities_posttest.sql')],
    rollback: [M('PROPOSED_20261013120000_agent_capabilities_rollback.sql')],
  },
  {
    id: 'conversation_ai_shadow',
    setup: [SHIM],
    pretest: M('PROPOSED_20261013160000_conversation_ai_shadow_pretest.sql'),
    apply: [M('PROPOSED_20261013160000_conversation_ai_shadow.sql')],
    posttest: [M('PROPOSED_20261013160000_conversation_ai_shadow_posttest.sql')],
    rollback: [M('PROPOSED_20261013160000_conversation_ai_shadow_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261013160000_conversation_ai_shadow_rollback_posttest.sql')],
  },
  {
    id: 'runtime_kind_limits_event_budget',
    // 8.5.15: agent.runtime_kind_limits_valid accepts event_budget_cap_usd (needed by
    // conversation_decide_event_budget, which is applied after this fix)
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, RUNTIME],
    pretest: M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_pretest.sql'),
    apply: [KIND_LIMITS_FIX],
    posttest: [M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_posttest.sql')],
    rollback: [M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback_posttest.sql')],
  },
  {
    id: 'conversation_decide_event_budget',
    // The posttest arms event_budget_cap_usd, which agent.runtime_kind_limits_valid
    // (intel_runtime) refuses until PROPOSED_20261014121000_runtime_kind_limits_event_budget
    // is applied — rc-8.5.20 carries that fix (8.5.15), so it is part of the setup.
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, RUNTIME, KIND_LIMITS_FIX],
    pretest: M('PROPOSED_20261013161000_conversation_decide_event_budget_pretest.sql'),
    apply: [CONV_DECIDE_BUDGET],
    posttest: [M('PROPOSED_20261013161000_conversation_decide_event_budget_posttest.sql')],
    rollback: [M('PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261013161000_conversation_decide_event_budget_rollback_posttest.sql')],
  },
  {
    id: 'ops_health_snapshot_delivery_ref',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, SEND_QUEUE_DELIVERED_AT, RUNTIME],
    pretest: M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_pretest.sql'),
    apply: [M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql')],
    posttest: [M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_posttest.sql')],
    rollback: [M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_rollback.sql')],
  },
  {
    id: 'persistent_missions',
    // 8.5.18. Re-creates agent.runtime_kind_limits_valid, so it is applied AFTER the 8.5.15
    // kind-limits fix (its body carries the event_budget_cap_usd rule; the pretest refuses
    // otherwise) despite its 20261014120000 file stamp. The schedule seed
    // (PROPOSED_20261014120100_persistent_missions_schedules.sql: psql -v owner_id, own
    // BEGIN/COMMIT) is exercised statement-for-statement by its posttest.
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, SEND_QUEUE_DELIVERED_AT, RUNTIME, CAPS, CONV_AI_SHADOW, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, OPS_HEALTH_DELIVERY_REF],
    pretest: M('PROPOSED_20261014120000_persistent_missions_pretest.sql'),
    apply: [MISSIONS],
    posttest: [M('PROPOSED_20261014120000_persistent_missions_posttest.sql'), M('PROPOSED_20261014120100_persistent_missions_schedules_posttest.sql')],
    rollback: [M('PROPOSED_20261014120000_persistent_missions_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261014120000_persistent_missions_rollback_posttest.sql')],
  },
  // ── 8.5.16 native AI conversation engine ──
  {
    id: 'message_origin_ai_generated_messages',
    setup: [SHIM, SEND_QUEUE_BASELINE],
    pretest: M('PROPOSED_20261015130000_message_origin_ai_generated_messages_pretest.sql'),
    apply: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages.sql')],
    posttest: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages_posttest.sql')],
    rollback: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback_posttest.sql')],
  },
  // ── 8.5.19 negotiation authority + operator feedback ──
  {
    id: 'negotiation_authority',
    setup: [SHIM],
    pretest: M('PROPOSED_20261015190000_negotiation_authority_pretest.sql'),
    apply: [M('PROPOSED_20261015190000_negotiation_authority.sql')],
    posttest: [M('PROPOSED_20261015190000_negotiation_authority_posttest.sql')],
    rollback: [M('PROPOSED_20261015190000_negotiation_authority_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261015190000_negotiation_authority_rollback_posttest.sql')],
  },
  {
    id: 'ai_operator_feedback',
    setup: [SHIM],
    pretest: M('PROPOSED_20261015191000_ai_operator_feedback_pretest.sql'),
    apply: [M('PROPOSED_20261015191000_ai_operator_feedback.sql')],
    posttest: [M('PROPOSED_20261015191000_ai_operator_feedback_posttest.sql')],
    rollback: [M('PROPOSED_20261015191000_ai_operator_feedback_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261015191000_ai_operator_feedback_rollback_posttest.sql')],
  },
  // ── 8.5.20-b ZIP acquisition intelligence + learning loop (independent of the agent chain) ──
  {
    id: 'zip_acquisition_intelligence',
    setup: [SHIM],
    pretest: M('PROPOSED_20261016100000_zip_acquisition_intelligence_pretest.sql'),
    apply: [M('PROPOSED_20261016100000_zip_acquisition_intelligence.sql')],
    posttest: [M('PROPOSED_20261016100000_zip_acquisition_intelligence_posttest.sql')],
    rollback: [M('PROPOSED_20261016100000_zip_acquisition_intelligence_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016100000_zip_acquisition_intelligence_rollback_posttest.sql')],
  },
  // ── asking-price guard: the 8.5.16 mirror of the live body, then the 8.5.15.1 replacement ──
  {
    id: 'block_repeat_asking_price_mirror',
    // the baseline already carries the live trigger: the mirror must re-create it identically
    setup: [SHIM, SEND_QUEUE_BASELINE],
    pretest: M('PROPOSED_20261015110000_block_repeat_asking_price_mirror_pretest.sql'),
    apply: [M('PROPOSED_20261015110000_block_repeat_asking_price_mirror.sql')],
    posttest: [M('PROPOSED_20261015110000_block_repeat_asking_price_mirror_posttest.sql')],
  },
  {
    id: 'repeat_asking_price_question_kind',
    setup: [SHIM, SEND_QUEUE_BASELINE],
    pretest: M('PROPOSED_20261015120000_repeat_asking_price_question_kind_pretest.sql'),
    apply: [M('PROPOSED_20261015120000_repeat_asking_price_question_kind.sql')],
    posttest: [M('PROPOSED_20261015120000_repeat_asking_price_question_kind_posttest.sql')],
    rollback: [M('PROPOSED_20261015120000_repeat_asking_price_question_kind_rollback.sql')],
  },
  {
    id: 'unlock_stale_jobs_status_predicate',
    // the rollback file IS the live production body: it doubles as the baseline
    setup: [SHIM, SEND_QUEUE_BASELINE, M('PROPOSED_20261008110000_unlock_stale_jobs_status_predicate_rollback.sql')],
    pretest: M('PROPOSED_20261008110000_unlock_stale_jobs_status_predicate_pretest.sql'),
    apply: [M('PROPOSED_20261008110000_unlock_stale_jobs_status_predicate.sql')],
    posttest: [M('PROPOSED_20261008110000_unlock_stale_jobs_status_predicate_posttest.sql')],
    rollback: [M('PROPOSED_20261008110000_unlock_stale_jobs_status_predicate_rollback.sql')],
  },
  // ── rc-8.5.20 part A: durable consolidated reply turns + the delayed runtime enqueue ──
  {
    id: 'conversation_reply_turns',
    // the legacy public.conversation_turns is modelled first: pretest / posttest / rollback posttest
    // assert it is untouched, and the rollback must restore the pre-apply fingerprint around it
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, LEGACY_CONVERSATION_TURNS, RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET],
    pretest: M('PROPOSED_20261016120000_conversation_reply_turns_pretest.sql'),
    apply: [M('PROPOSED_20261016120000_conversation_reply_turns.sql')],
    // the turn-sweep schedule seed (PROPOSED_20261016120100: psql -v owner_id, own BEGIN/COMMIT)
    // is exercised statement-for-statement by its posttest
    // rc-8.5.21: the follow-up execution schedules (PROPOSED_20261016161000, same seed pattern) need agent.runtime_enqueue_event_at
    posttest: [M('PROPOSED_20261016120000_conversation_reply_turns_posttest.sql'), M('PROPOSED_20261016120100_conversation_reply_turns_schedules_posttest.sql'), M('PROPOSED_20261016163000_followup_execution_schedules_posttest.sql')],
    rollback: [M('PROPOSED_20261016120000_conversation_reply_turns_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016120000_conversation_reply_turns_rollback_posttest.sql')],
  },
  // ── 8.5.20 part C: operations read model (recovery, action center, pipeline, supervisor) ──
  {
    id: 'operations_action_center',
    setup: [SHIM, DURABILITY, S3, RESEARCH, OPS_PUBLIC_BASELINE, RUNTIME, CAPS, CONV_AI_SHADOW, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, OPS_HEALTH_DELIVERY_REF, MISSIONS],
    pretest: M('PROPOSED_20261016140000_operations_action_center_pretest.sql'),
    apply: [M('PROPOSED_20261016140000_operations_action_center.sql')],
    posttest: [M('PROPOSED_20261016140000_operations_action_center_posttest.sql'), M('PROPOSED_20261016140100_operations_schedules_posttest.sql')],
    rollback: [M('PROPOSED_20261016140000_operations_action_center_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016140000_operations_action_center_rollback_posttest.sql')],
  },
  // ── rc-8.5.21 part B: per-kind event budget ceilings (property.research up to 0.30; default unchanged) ──
  {
    id: 'runtime_event_budget_ceilings',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, LEGACY_CONVERSATION_TURNS, RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, REPLY_TURNS],
    pretest: M('PROPOSED_20261016160000_runtime_event_budget_ceilings_pretest.sql'),
    apply: [EVENT_BUDGET_CEILINGS],
    posttest: [M('PROPOSED_20261016160000_runtime_event_budget_ceilings_posttest.sql')],
    rollback: [M('PROPOSED_20261016160000_runtime_event_budget_ceilings_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016160000_runtime_event_budget_ceilings_rollback_posttest.sql')],
  },
  // ── rc-8.5.21 part B: the distinct live-negotiation SEND authorization ──
  {
    id: 'negotiation_send_authorization',
    setup: [SHIM, NEGOTIATION],
    pretest: M('PROPOSED_20261016161000_negotiation_send_authorization_pretest.sql'),
    apply: [SEND_AUTHORIZATION],
    posttest: [M('PROPOSED_20261016161000_negotiation_send_authorization_posttest.sql')],
    rollback: [M('PROPOSED_20261016161000_negotiation_send_authorization_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016161000_negotiation_send_authorization_rollback_posttest.sql')],
  },
  // ── rc-8.5.21 part B: supervisor read of valuation coverage / overdue offers / negotiation progress ──
  {
    id: 'ops_research_valuation_snapshot',
    setup: [SHIM, DURABILITY, S3, RESEARCH, OPS_PUBLIC_BASELINE, RESEARCH_VALUATION_BASELINE, RUNTIME, CAPS, CONV_AI_SHADOW, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, OPS_HEALTH_DELIVERY_REF, MISSIONS, OPS_ACTION_CENTER],
    pretest: M('PROPOSED_20261016162000_ops_research_valuation_snapshot_pretest.sql'),
    apply: [OPS_RESEARCH_VALUATION],
    posttest: [M('PROPOSED_20261016162000_ops_research_valuation_snapshot_posttest.sql')],
    rollback: [M('PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback_posttest.sql')],
  },
  // ── owner directive 2026-10-17: the turn dispatch lease + one ai_generated send_queue row per turn ──
  {
    id: 'conversation_reply_turn_dispatch_lease',
    setup: [SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, LEGACY_CONVERSATION_TURNS, RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, REPLY_TURNS],
    pretest: M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_pretest.sql'),
    apply: [DISPATCH_LEASE],
    posttest: [M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_posttest.sql')],
    rollback: [M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_rollback_posttest.sql')],
  },
  {
    id: 'conversation_turn_operator_items',
    setup: [SHIM, DURABILITY, S3, RESEARCH, OPS_PUBLIC_BASELINE, RUNTIME, CAPS, CONV_AI_SHADOW, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, OPS_HEALTH_DELIVERY_REF, MISSIONS, OPS_ACTION_CENTER],
    pretest: M('PROPOSED_20261017122000_conversation_turn_operator_items_pretest.sql'),
    apply: [TURN_OPERATOR_ITEMS],
    posttest: [M('PROPOSED_20261017122000_conversation_turn_operator_items_posttest.sql')],
    rollback: [M('PROPOSED_20261017122000_conversation_turn_operator_items_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261017122000_conversation_turn_operator_items_rollback_posttest.sql')],
  },
  // ── rc-8.5.21: agent.payload_is_clean never rejects a random UUID / opaque hex id token ──
  {
    id: 'payload_clean_opaque_ids',
    setup: [SHIM, DURABILITY, S3],
    pretest: M('PROPOSED_20261019120000_payload_clean_opaque_ids_pretest.sql'),
    apply: [PAYLOAD_OPAQUE_IDS],
    posttest: [M('PROPOSED_20261019120000_payload_clean_opaque_ids_posttest.sql')],
    rollback: [M('PROPOSED_20261019120000_payload_clean_opaque_ids_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261019120000_payload_clean_opaque_ids_rollback_posttest.sql')],
  },
  // ── B1 (2026-10-25): typed Agntei identities (external_agent_id / external_install_id) are never phones ──
  {
    id: 'payload_clean_typed_external_ids',
    setup: [SHIM, DURABILITY, S3, PAYLOAD_OPAQUE_IDS],
    pretest: M('PROPOSED_20261025100000_payload_clean_typed_external_ids_pretest.sql'),
    apply: [M('PROPOSED_20261025100000_payload_clean_typed_external_ids.sql')],
    posttest: [M('PROPOSED_20261025100000_payload_clean_typed_external_ids_posttest.sql')],
    rollback: [M('PROPOSED_20261025100000_payload_clean_typed_external_ids_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261025100000_payload_clean_typed_external_ids_rollback_posttest.sql')],
  },
  // ── owner 2026-10-17: contact_property_resolution role ownership_declined_unverified ──
  {
    id: 'contact_property_resolution_declined_unverified',
    setup: [SHIM, GRAPH_LIVE_FUNCTIONS_BASELINE, CPR_LIVE_CONSTRAINTS],
    pretest: M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_pretest.sql'),
    apply: [CPR_DECLINED],
    posttest: [M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_posttest.sql')],
    rollback: [M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_rollback_posttest.sql')],
  },
  // ── owner 2026-10-17: legacy disposition backfill not_interested → declined_unverified (DISPOSITION ONLY) ──
  {
    id: 'inbox_disposition_declined_unverified_backfill',
    setup: [SHIM, DURABILITY, S3, OPS_PUBLIC_BASELINE, GRAPH_LIVE_FUNCTIONS_BASELINE, CPR_LIVE_CONSTRAINTS, CPR_DECLINED, 'scripts/db/fixtures/disposition_backfill_seed.sql'],
    pretest: M('PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill_pretest.sql'),
    // the dry run (selects only) runs right before the apply, exactly as an operator would
    apply: [{ fixture: M('PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill_dryrun.sql') }, M('PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill.sql')],
    posttest: [M('PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill_posttest.sql')],
    rollback: [M('PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill_rollback_posttest.sql')],
  },
  // ── rc-8.5.21 v4: FORWARD view migration — production's 10-10 inbox bucket views (20261010120000 applied
  //    out of band 2026-10-12) brought up to the 10-17 declined_unverified mapping; never a re-apply ──
  {
    id: 'inbox_bucket_views_declined_unverified',
    // the production state: the inbox tables the views read + the 10-10 view body (= this migration's rollback)
    setup: ['scripts/db/fixtures/inbox_bucket_views_public_baseline.sql', M('PROPOSED_20261020120000_inbox_bucket_views_declined_unverified_rollback.sql'), 'scripts/db/fixtures/inbox_zero_counts_dependant.sql'],
    pretest: M('PROPOSED_20261020120000_inbox_bucket_views_declined_unverified_pretest.sql'),
    apply: [M('PROPOSED_20261020120000_inbox_bucket_views_declined_unverified.sql')],
    posttest: [M('PROPOSED_20261020120000_inbox_bucket_views_declined_unverified_posttest.sql')],
    rollback: [M('PROPOSED_20261020120000_inbox_bucket_views_declined_unverified_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261020120000_inbox_bucket_views_declined_unverified_rollback_posttest.sql')],
  },
  // ── P0 automation-hold registry (rc-8.5.20-holds; production gets it via hotfix/automation-holds) ──
  {
    id: 'automation_holds_registry',
    // the live send_queue surface (its guard triggers fire after the hold guard) + the registry baseline
    // (the protected tables' columns, the lock-target index, is_ops_operator()); the release chain proves
    // the same registry composed with every other public fixture
    setup: [SHIM, SEND_QUEUE_BASELINE, HOLDS_PUBLIC_BASELINE],
    pretest: M('PROPOSED_20261016200000_automation_holds_registry_pretest.sql'),
    apply: [HOLDS_REGISTRY],
    posttest: [M('PROPOSED_20261016200000_automation_holds_registry_posttest.sql')],
    rollback: [M('PROPOSED_20261016200000_automation_holds_registry_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016200000_automation_holds_registry_rollback_posttest.sql')],
  },
  // ── rc-8.5.21: the WHOLE release chain (8.5.15 … 8.5.21 + the P0 holds registry) on ONE database ──
  // Production apply order. The holds registry is FIRST: production receives it via the hotfix before
  // rc-8.5.21 (it is "already applied via hotfix" when 8.5.21 deploys; its version stamp 20261016200000 is
  // later than the 8.5.21 files on purpose — it is the hotfix's file, byte-identical).
  // Each migration's own pretest runs immediately before it (interleaved fixtures); the
  // posttests run on the final state; the rollbacks run in reverse order and must restore
  // the pre-chain fingerprint; then the chain is re-applied. The mirror of the live
  // trg_block_repeat_asking_price body is applied BEFORE repeat_asking_price_question_kind:
  // applied after it, the mirror would re-create the old body (and its pretest refuses a
  // body that is not the live one).
  {
    id: 'rc_8_5_21_release_chain',
    setup: [LC_MCP_ROLE_RESET, ACTION_ROLE_RESET, SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, RESEARCH_VALUATION_BASELINE, LEGACY_CONVERSATION_TURNS, HOLDS_PUBLIC_BASELINE, GRAPH_LIVE_FUNCTIONS_BASELINE, CPR_LIVE_CONSTRAINTS, LC_MCP_CHAIN_BASELINE, ACTION_GATEWAY_BASELINE, ACTION_GATEWAY_T2_BASELINE, ACTION_GATEWAY_T34_BASELINE],
    apply: [
      // 0. the P0 holds registry (already applied via hotfix/automation-holds in production)
      { fixture: M('PROPOSED_20261016200000_automation_holds_registry_pretest.sql') }, HOLDS_REGISTRY,
      { fixture: M('PROPOSED_20261012140000_intel_runtime_pretest.sql') }, RUNTIME,
      { fixture: M('PROPOSED_20261013120000_agent_capabilities_pretest.sql') }, CAPS,
      { fixture: M('PROPOSED_20261013160000_conversation_ai_shadow_pretest.sql') }, CONV_AI_SHADOW,
      { fixture: M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_pretest.sql') }, KIND_LIMITS_FIX,
      { fixture: M('PROPOSED_20261013161000_conversation_decide_event_budget_pretest.sql') }, CONV_DECIDE_BUDGET,
      { fixture: M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_pretest.sql') }, OPS_HEALTH_DELIVERY_REF,
      { fixture: M('PROPOSED_20261014120000_persistent_missions_pretest.sql') }, MISSIONS,
      { fixture: M('PROPOSED_20261015130000_message_origin_ai_generated_messages_pretest.sql') }, MESSAGE_ORIGIN,
      { fixture: M('PROPOSED_20261015190000_negotiation_authority_pretest.sql') }, NEGOTIATION,
      { fixture: M('PROPOSED_20261015191000_ai_operator_feedback_pretest.sql') }, FEEDBACK,
      { fixture: M('PROPOSED_20261015110000_block_repeat_asking_price_mirror_pretest.sql') }, ASKING_PRICE_MIRROR,
      { fixture: M('PROPOSED_20261015120000_repeat_asking_price_question_kind_pretest.sql') }, ASKING_PRICE_QUESTION_KIND,
      // rc-8.5.20 parts A / B / C. zip_acquisition_intelligence is independent; conversation_reply_turns
      // needs the runtime + both event-budget fixes; operations_action_center needs the runtime,
      // the capability plane and persistent_missions. The schedule seeds (PROPOSED_20261016100100
      // property research, PROPOSED_20261016120100 turn sweep, PROPOSED_20261016140100 operations:
      // psql -v owner_id, own BEGIN/COMMIT) are exercised by their posttests.
      { fixture: M('PROPOSED_20261016100000_zip_acquisition_intelligence_pretest.sql') }, M('PROPOSED_20261016100000_zip_acquisition_intelligence.sql'),
      { fixture: M('PROPOSED_20261016120000_conversation_reply_turns_pretest.sql') }, M('PROPOSED_20261016120000_conversation_reply_turns.sql'),
      { fixture: M('PROPOSED_20261016140000_operations_action_center_pretest.sql') }, M('PROPOSED_20261016140000_operations_action_center.sql'),
      // rc-8.5.21 part A: the born-empty company identity setting; the graph recontact guard (the five
      // queue_eligible writers read contact_property_resolution). The follow-up execution schedule seed
      // (PROPOSED_20261016163000: psql -v owner_id, own BEGIN/COMMIT, born disabled) is exercised by its posttest.
      { fixture: M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_pretest.sql') }, COMPANY_IDENTITY,
      { fixture: M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_pretest.sql') }, GRAPH_PRIOR_REPLY_NOT_OWNER,
      // rc-8.5.21 part B: event budget ceilings (after the reply-turns runtime_enqueue_event_at), the send
      // authorization (after negotiation_authority), the supervisor read (after operations_action_center)
      { fixture: M('PROPOSED_20261016160000_runtime_event_budget_ceilings_pretest.sql') }, EVENT_BUDGET_CEILINGS,
      { fixture: M('PROPOSED_20261016161000_negotiation_send_authorization_pretest.sql') }, SEND_AUTHORIZATION,
      { fixture: M('PROPOSED_20261016162000_ops_research_valuation_snapshot_pretest.sql') }, OPS_RESEARCH_VALUATION,
      // owner 2026-10-17: the declined-unverified role (before the historical ownership correction)
      { fixture: M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_pretest.sql') }, CPR_DECLINED,
      // owner P0 2026-10-17: the ONE follow-up execution lifecycle (needs the holds registry, send_queue, inbox_thread_state)
      { fixture: M('PROPOSED_20261017120000_followup_intent_lifecycle_pretest.sql') }, FOLLOWUP_LIFECYCLE,
      // owner directive 2026-10-17: the turn dispatch lease (after reply_turns, message_origin and the runtime)
      { fixture: M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_pretest.sql') }, DISPATCH_LEASE,
      { fixture: M('PROPOSED_20261017122000_conversation_turn_operator_items_pretest.sql') }, TURN_OPERATOR_ITEMS,
      // #25 rc-8.5.21: the payload CHECK no longer rejects random ids (needs only S3, applied in production)
      { fixture: M('PROPOSED_20261019120000_payload_clean_opaque_ids_pretest.sql') }, PAYLOAD_OPAQUE_IDS,
      // #26 OPTIONAL, the LAST link (separately approved; production: after pg_net is resolved): the MCP read-only credential
      { fixture: M('PROPOSED_20261019150000_lc_mcp_reader_pretest.sql') }, LC_MCP_READER,
      // #26 OPTIONAL (separately approved; production: after pg_net is resolved, like #25): the Action Gateway
      { fixture: M('PROPOSED_20261019160000_action_gateway_pretest.sql') }, ACTION_GATEWAY,
      // #27 OPTIONAL (separately approved; after #26): the Action Gateway Tier-2 domain writers
      { fixture: M('PROPOSED_20261020100000_action_gateway_t2_pretest.sql') }, ACTION_GATEWAY_T2,
      // #28 OPTIONAL (separately approved; after #27): the T3 / T4 family + R4 + R5
      { fixture: M('PROPOSED_20261020110000_action_gateway_t34_pretest.sql') }, ACTION_GATEWAY_T34,
    ],
    verify: [T('rc_8_5_21_release_chain_verify.sql')],
    posttest: [
      M('PROPOSED_20261016200000_automation_holds_registry_posttest.sql'),
      M('PROPOSED_20261013120000_agent_capabilities_posttest.sql'),
      M('PROPOSED_20261013160000_conversation_ai_shadow_posttest.sql'),
      M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_posttest.sql'),
      M('PROPOSED_20261013161000_conversation_decide_event_budget_posttest.sql'),
      M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_posttest.sql'),
      M('PROPOSED_20261014120000_persistent_missions_posttest.sql'),
      M('PROPOSED_20261014120100_persistent_missions_schedules_posttest.sql'),
      M('PROPOSED_20261015130000_message_origin_ai_generated_messages_posttest.sql'),
      M('PROPOSED_20261015190000_negotiation_authority_posttest.sql'),
      M('PROPOSED_20261015191000_ai_operator_feedback_posttest.sql'),
      M('PROPOSED_20261015120000_repeat_asking_price_question_kind_posttest.sql'),
      M('PROPOSED_20261016100000_zip_acquisition_intelligence_posttest.sql'),
      M('PROPOSED_20261016100100_property_research_schedules_posttest.sql'),
      M('PROPOSED_20261016120000_conversation_reply_turns_posttest.sql'),
      M('PROPOSED_20261016120100_conversation_reply_turns_schedules_posttest.sql'),
      M('PROPOSED_20261016140000_operations_action_center_posttest.sql'),
      M('PROPOSED_20261016140100_operations_schedules_posttest.sql'),
      M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_posttest.sql'),
      M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_posttest.sql'),
      // after 8.5.21-b re-created runtime_enqueue_event_at: the follow-up kinds are still refused unarmed
      M('PROPOSED_20261016163000_followup_execution_schedules_posttest.sql'),
      M('PROPOSED_20261016160000_runtime_event_budget_ceilings_posttest.sql'),
      M('PROPOSED_20261016161000_negotiation_send_authorization_posttest.sql'),
      M('PROPOSED_20261016162000_ops_research_valuation_snapshot_posttest.sql'),
      M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_posttest.sql'),
      M('PROPOSED_20261017120000_followup_intent_lifecycle_posttest.sql'),
      M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_posttest.sql'),
      M('PROPOSED_20261017122000_conversation_turn_operator_items_posttest.sql'),
      M('PROPOSED_20261019120000_payload_clean_opaque_ids_posttest.sql'),
      'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_posttest.sql',
      M('PROPOSED_20261019160000_action_gateway_posttest.sql'),
      M('PROPOSED_20261020100000_action_gateway_t2_posttest.sql'),
      M('PROPOSED_20261020110000_action_gateway_t34_posttest.sql'),
    ],
    // applied in reverse order by the runner (the mirror has no rollback: it is the live body); the
    // holds registry is rolled back LAST (it was applied first)
    rollback: [
      M('PROPOSED_20261016200000_automation_holds_registry_rollback.sql'),
      M('PROPOSED_20261012140000_intel_runtime_rollback.sql'),
      M('PROPOSED_20261013120000_agent_capabilities_rollback.sql'),
      M('PROPOSED_20261013160000_conversation_ai_shadow_rollback.sql'),
      M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql'),
      M('PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql'),
      M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_rollback.sql'),
      M('PROPOSED_20261014120000_persistent_missions_rollback.sql'),
      M('PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback.sql'),
      M('PROPOSED_20261015190000_negotiation_authority_rollback.sql'),
      M('PROPOSED_20261015191000_ai_operator_feedback_rollback.sql'),
      M('PROPOSED_20261015120000_repeat_asking_price_question_kind_rollback.sql'),
      M('PROPOSED_20261016100000_zip_acquisition_intelligence_rollback.sql'),
      M('PROPOSED_20261016120000_conversation_reply_turns_rollback.sql'),
      M('PROPOSED_20261016140000_operations_action_center_rollback.sql'),
      M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_rollback.sql'),
      M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_rollback.sql'),
      M('PROPOSED_20261016160000_runtime_event_budget_ceilings_rollback.sql'),
      M('PROPOSED_20261016161000_negotiation_send_authorization_rollback.sql'),
      M('PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback.sql'),
      M('PROPOSED_20261017100000_contact_property_resolution_declined_unverified_rollback.sql'),
      M('PROPOSED_20261017120000_followup_intent_lifecycle_rollback.sql'),
      M('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_rollback.sql'),
      M('PROPOSED_20261017122000_conversation_turn_operator_items_rollback.sql'),
      M('PROPOSED_20261019120000_payload_clean_opaque_ids_rollback.sql'),
      M('PROPOSED_20261019150000_lc_mcp_reader_rollback.sql'),
      M('PROPOSED_20261019160000_action_gateway_rollback.sql'),
      M('PROPOSED_20261020100000_action_gateway_t2_rollback.sql'),
      M('PROPOSED_20261020110000_action_gateway_t34_rollback.sql'),
    ],
  },
  // ── production-shaped (schema-only snapshot) — formerly run with psql against production ──
  {
    id: 'operator_read_policies',
    requires: PROD_SHAPE,
    // the snapshot is post-lockdown and post-read-policies: roll both back to reach the pre-state
    setup: [PROD_SHAPE, R('20261003130000_operator_lockdown.rollback.sql'), R('20261003120000_operator_read_policies.rollback.sql')],
    pretest: T('operator_read_policies_pretest.sql'),
    apply: ['supabase/migrations/20261003120000_operator_read_policies.sql'],
    posttest: [T('operator_read_policies_test.sql')],
    rollback: [R('20261003120000_operator_read_policies.rollback.sql')],
  },
  {
    id: 'operator_lockdown',
    requires: PROD_SHAPE,
    setup: [PROD_SHAPE, R('20261003130000_operator_lockdown.rollback.sql')],
    pretest: T('operator_lockdown_pretest.sql'),
    apply: ['supabase/migrations/20261003130000_operator_lockdown.sql'],
    posttest: [T('operator_lockdown_test.sql')],
    rollback: [R('20261003130000_operator_lockdown.rollback.sql')],
    rollbackPosttest: [T('operator_lockdown_rollback_test.sql')],
  },
  {
    id: 'campaign_audience_completeness',
    requires: PROD_SHAPE,
    setup: [PROD_SHAPE, R('20261003220000_campaign_audience_completeness.rollback.sql')],
    pretest: T('campaign_audience_completeness_pretest.sql'),
    apply: ['supabase/migrations/20261003220000_campaign_audience_completeness.sql'],
    posttest: [T('campaign_audience_completeness_test.sql')],
    rollback: [R('20261003220000_campaign_audience_completeness.rollback.sql')],
    rollbackPosttest: [T('campaign_audience_completeness_rollback_test.sql')],
  },
  {
    id: 'graph_sender_coverage_routing_v2',
    requires: PROD_SHAPE,
    setup: [PROD_SHAPE],
    pretest: M('PROPOSED_20261007170000_graph_sender_coverage_routing_v2_pretest.sql'),
    apply: [
      M('20261002130000_sender_routing_v2.sql'),
      M('20261002130100_sender_routing_v2_seed_proposed_graph.sql'),
      { fixture: M('PROPOSED_20261007170000_graph_sender_coverage_routing_v2_fleet_snapshot.sql') },
      M('PROPOSED_20261007171000_sender_routing_v2_evidence_backfill.sql'),
      M('PROPOSED_20261007170000_graph_sender_coverage_routing_v2.sql'),
    ],
    posttest: [M('PROPOSED_20261007170000_graph_sender_coverage_routing_v2_posttest.sql')],
    rollback: [
      R('20261002130000_sender_routing_v2_ROLLBACK.sql'),
      M('PROPOSED_20261007171000_sender_routing_v2_evidence_backfill_rollback.sql'),
      M('PROPOSED_20261007170000_graph_sender_coverage_routing_v2_rollback.sql'),
    ],
  },
  // ── 8.5.21 part A: the configured company identity setting (born empty) ──
  {
    id: 'ai_conversation_company_identity_setting',
    setup: [SHIM, { name: 'public.system_control (fixture)', sql: `create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());` }],
    pretest: M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_pretest.sql'),
    apply: [M('PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql')],
    posttest: [M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_posttest.sql')],
    rollback: [M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016150000_ai_conversation_company_identity_setting_rollback_posttest.sql')],
  },
  // rc-8.5.21: recontact guard, graph side — every queue_eligible writer reads contact_property_resolution
  {
    id: 'campaign_graph_prior_reply_not_owner',
    setup: [SHIM, 'scripts/db/fixtures/campaign_target_graph_live_functions_baseline.sql'],
    pretest: M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_pretest.sql'),
    apply: [M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner.sql')],
    posttest: [M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_posttest.sql')],
    rollback: [M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_rollback_posttest.sql')],
  },
  // ── P0 2026-10-17: the ONE follow-up execution lifecycle (intent record, materialize-before-claimable,
  // send_queue ⇄ intent sync, follow_up_at projection). Composes on the live send_queue surface, the
  // operations + holds public baselines and the P0 holds registry (applied first in production). S3
  // provides the agent_api role the operations baseline revokes from. Also the LAST link of the
  // rc_8_5_21_release_chain entry.
  {
    id: 'followup_intent_lifecycle',
    setup: [SHIM, DURABILITY, S3, SEND_QUEUE_BASELINE, OPS_PUBLIC_BASELINE, HOLDS_PUBLIC_BASELINE, HOLDS_REGISTRY],
    pretest: M('PROPOSED_20261017120000_followup_intent_lifecycle_pretest.sql'),
    apply: [FOLLOWUP_LIFECYCLE],
    posttest: [M('PROPOSED_20261017120000_followup_intent_lifecycle_posttest.sql')],
    rollback: [M('PROPOSED_20261017120000_followup_intent_lifecycle_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261017120000_followup_intent_lifecycle_rollback_posttest.sql')],
  },
  // ── LeadCommand MCP 1.0 live mode: the database-role-enforced read-only credential lc_mcp_reader ──
  // OPTIONAL, separately approved (docs/LEADCOMMAND-MCP-1.0.md §4.2). Renumbered from 20261016120000
  // (collided with conversation_reply_turns); bodies unchanged except their own self-references.
  // Setup = the shim + an emulation of the production objects it touches (disposable only).
  {
    id: 'lc_mcp_reader',
    setup: [LC_MCP_ROLE_RESET, SHIM, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_supabase_emulation.sql'],
    pretest: M('PROPOSED_20261019150000_lc_mcp_reader_pretest.sql'),
    apply: [M('PROPOSED_20261019150000_lc_mcp_reader.sql')],
    posttest: [M('PROPOSED_20261019150000_lc_mcp_reader_posttest.sql')],
    rollback: [M('PROPOSED_20261019150000_lc_mcp_reader_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261019150000_lc_mcp_reader_rollback_posttest.sql')],
  },
  // ── Action Gateway phase 1 (OPTIONAL link #26, separately approved): the durable action schema and the scoped
  // execution role lc_action_gateway. Setup = the REAL prerequisite migrations (runtime, capabilities, missions,
  // operations + #24, the P0 hold registry) + the read-inventory baseline.
  {
    id: 'action_gateway',
    setup: [ACTION_ROLE_RESET, SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, HOLDS_PUBLIC_BASELINE,
      RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, CAPS, CONV_AI_SHADOW, MISSIONS, OPS_ACTION_CENTER, TURN_OPERATOR_ITEMS, HOLDS_REGISTRY, ACTION_GATEWAY_BASELINE],
    pretest: M('PROPOSED_20261019160000_action_gateway_pretest.sql'),
    apply: [ACTION_GATEWAY],
    posttest: [M('PROPOSED_20261019160000_action_gateway_posttest.sql')],
    rollback: [M('PROPOSED_20261019160000_action_gateway_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261019160000_action_gateway_rollback_posttest.sql')],
  },
  // ── Action Gateway Tier-2 (OPTIONAL link #27, separately approved): the T2 domain writers over the follow-up
  // lifecycle, the campaign lifecycle writer, the ops work items and the approval ledger, + the extension registry.
  // Setup = #26's setup + #26 itself + the follow-up lifecycle + the T2 baseline (the live campaign writer).
  {
    id: 'action_gateway_t2',
    setup: [ACTION_ROLE_RESET, SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, HOLDS_PUBLIC_BASELINE,
      RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, CAPS, CONV_AI_SHADOW, MISSIONS, OPS_ACTION_CENTER, TURN_OPERATOR_ITEMS, HOLDS_REGISTRY, FOLLOWUP_LIFECYCLE,
      ACTION_GATEWAY_BASELINE, ACTION_GATEWAY_T2_BASELINE, ACTION_GATEWAY],
    pretest: M('PROPOSED_20261020100000_action_gateway_t2_pretest.sql'),
    apply: [ACTION_GATEWAY_T2],
    posttest: [M('PROPOSED_20261020100000_action_gateway_t2_posttest.sql')],
    rollback: [M('PROPOSED_20261020100000_action_gateway_t2_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261020100000_action_gateway_t2_rollback_posttest.sql')],
  },
  // ── Action Gateway T3 / T4 (OPTIONAL link #28, separately approved): setup = #27's setup + #26 + #27 + the negotiation
  // authority + send authorization tables + the T3 / T4 baseline (seller_offers / scores / templates columns).
  {
    id: 'action_gateway_t34',
    setup: [ACTION_ROLE_RESET, SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, HOLDS_PUBLIC_BASELINE,
      RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, CAPS, CONV_AI_SHADOW, MISSIONS, OPS_ACTION_CENTER, TURN_OPERATOR_ITEMS, HOLDS_REGISTRY, FOLLOWUP_LIFECYCLE,
      ACTION_GATEWAY_BASELINE, ACTION_GATEWAY_T2_BASELINE, NEGOTIATION, SEND_AUTHORIZATION, ACTION_GATEWAY_T34_BASELINE, ACTION_GATEWAY, ACTION_GATEWAY_T2],
    pretest: M('PROPOSED_20261020110000_action_gateway_t34_pretest.sql'),
    apply: [ACTION_GATEWAY_T34],
    posttest: [M('PROPOSED_20261020110000_action_gateway_t34_posttest.sql')],
    rollback: [M('PROPOSED_20261020110000_action_gateway_t34_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261020110000_action_gateway_t34_rollback_posttest.sql')],
  },
  // ── LeadCommand Workforce Phase A (docs/WORKFORCE.md §2): STANDALONE, not a release-chain link. A new schema
  // `workforce` over the S3 + R2 agent schema (+ the rc-8.5.21 opaque-id payload fix it is proposed after). The seed
  // (PROPOSED_20261022100100_workforce_seed.sql: psql -v owner_id, own BEGIN/COMMIT) is exercised
  // statement-for-statement by its posttest.
  {
    id: 'workforce_foundation',
    setup: [SHIM, DURABILITY, S3, PAYLOAD_OPAQUE_IDS, RESEARCH, RUNTIME_PUBLIC_FIXTURE, RUNTIME],
    pretest: M('PROPOSED_20261022100000_workforce_foundation_pretest.sql'),
    apply: [M('PROPOSED_20261022100000_workforce_foundation.sql')],
    posttest: [M('PROPOSED_20261022100000_workforce_foundation_posttest.sql'), M('PROPOSED_20261022100100_workforce_seed_posttest.sql')],
    rollback: [M('PROPOSED_20261022100000_workforce_foundation_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261022100000_workforce_foundation_rollback_posttest.sql')],
  },
  // ── LeadCommand Workforce × Agntei (docs/WORKFORCE-AGNTEI.md §1–§5): STANDALONE, after BOTH the Workforce foundation and
  // the Action Gateway chain (#26 + #27's extension registry). One employee identity (employment type, origin, the linked
  // Agntei agent), execution modes, budgets and the gateway-side Workforce writer / reader (registered in #27's registry).
  {
    id: 'workforce_agntei',
    setup: [ACTION_ROLE_RESET, SHIM, DURABILITY, S3, PAYLOAD_OPAQUE_IDS, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, HOLDS_PUBLIC_BASELINE,
      RUNTIME, KIND_LIMITS_FIX, CONV_DECIDE_BUDGET, CAPS, CONV_AI_SHADOW, MISSIONS, OPS_ACTION_CENTER, TURN_OPERATOR_ITEMS, HOLDS_REGISTRY, FOLLOWUP_LIFECYCLE,
      ACTION_GATEWAY_BASELINE, ACTION_GATEWAY_T2_BASELINE, ACTION_GATEWAY, ACTION_GATEWAY_T2, M('PROPOSED_20261022100000_workforce_foundation.sql')],
    pretest: M('PROPOSED_20261022110000_workforce_agntei_pretest.sql'),
    apply: [M('PROPOSED_20261022110000_workforce_agntei.sql')],
    posttest: [M('PROPOSED_20261022110000_workforce_agntei_posttest.sql')],
    rollback: [M('PROPOSED_20261022110000_workforce_agntei_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261022110000_workforce_agntei_rollback_posttest.sql')],
  },
]

// ── rc-8.5.21: the SAME release chain, started from the PRODUCTION agent-runtime state ──
// Production already carries intel_runtime with the Fix A state (incident 2026-10-14, executed
// 2026-10-16): runtime_enabled = false, emergency_stop = true (reason 'pretest'), kind_limits = '{}'.
// This entry applies intel_runtime + that state as SETUP, then every later chain migration; its verify
// proves no migration, rollback or re-apply touches runtime_enabled / emergency_stop / kind_limits.
const FIX_A_STATE = 'scripts/db/fixtures/fix_a_runtime_state.sql'
const CHAIN = BASE_TESTS.find((t) => t.id === 'rc_8_5_21_release_chain')
const withoutRuntime = (list) => {
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (typeof a === 'object' && a.fixture === M('PROPOSED_20261012140000_intel_runtime_pretest.sql')) { i += 1; continue }
    out.push(a)
  }
  return out
}
const FROM_PRODUCTION_STATE = {
  id: 'rc_8_5_21_release_chain_from_production_state',
  setup: [...CHAIN.setup, RUNTIME, FIX_A_STATE],
  apply: withoutRuntime(CHAIN.apply),
  verify: [...CHAIN.verify.filter((v) => v !== T('rc_8_5_21_release_chain_verify.sql')), T('rc_8_5_21_release_chain_verify.sql'), T('rc_8_5_21_fix_a_state_verify.sql')],
  // the behavioural posttests arm / claim jobs, which the engaged emergency stop (correctly) refuses;
  // they run in rc_8_5_21_release_chain. This entry proves the STATE: apply → rollback → re-apply
  // never changes runtime_enabled / emergency_stop / kind_limits.
  posttest: [],
  rollback: CHAIN.rollback.filter((r) => r !== M('PROPOSED_20261012140000_intel_runtime_rollback.sql')),
}

// ── G1: the MINIMUM chain for Phase A0 (the Action Gateway's T1 task tools), applied onto the FROM_PRODUCTION_STATE
// baseline (S3 + research_ro + intel_runtime with the Fix A state, as rc_8_5_21_release_chain_from_production_state)
// with lc_mcp_reader applied FIRST (its documented order) + the public-table fixtures.
// Then ONLY: #0 holds registry → #2 capabilities → #3 conversation-AI shadow → #7 persistent missions → #15 operations
// action center → #24 turn operator items → #25 opaque ids → #26 action_gateway. Nothing seller-sending, no T2/T3/T4,
// no follow-up lifecycle, no reply turns, no negotiation. Proves: ordering, each pretest, idempotent re-apply (the
// whole cycle twice), the posttests (role shape, privileges, tenant isolation, the gateway self-check), that the
// Reader's own self-check is STILL ok after #26 replaces the shared egress functions, that the Fix A runtime state is
// never touched, and that the rollbacks restore the exact pre-chain fingerprint.
const P = (f, k) => M(`${f}_${k}.sql`)
const A0 = [
  ['PROPOSED_20261016200000_automation_holds_registry', HOLDS_REGISTRY],
  ['PROPOSED_20261013120000_agent_capabilities', CAPS],
  ['PROPOSED_20261013160000_conversation_ai_shadow', CONV_AI_SHADOW],
  ['PROPOSED_20261014121000_runtime_kind_limits_event_budget', KIND_LIMITS_FIX], // #4: required by #7 (its pretest)
  ['PROPOSED_20261014120000_persistent_missions', MISSIONS], // #7: required by #15 (its pretest)
  ['PROPOSED_20261016140000_operations_action_center', OPS_ACTION_CENTER],
  ['PROPOSED_20261017122000_conversation_turn_operator_items', TURN_OPERATOR_ITEMS],
  ['PROPOSED_20261019120000_payload_clean_opaque_ids', PAYLOAD_OPAQUE_IDS],
  ['PROPOSED_20261019160000_action_gateway', ACTION_GATEWAY],
]
const RUNTIME_BEHAVIOURAL = new Set(['PROPOSED_20261014121000_runtime_kind_limits_event_budget', 'PROPOSED_20261014120000_persistent_missions',
  'PROPOSED_20261016140000_operations_action_center', 'PROPOSED_20261017122000_conversation_turn_operator_items'])
const PHASE_A0_FROM_PRODUCTION_STATE = {
  id: 'phase_a0_gateway_from_production_state',
  setup: [LC_MCP_ROLE_RESET, ACTION_ROLE_RESET, SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, HOLDS_PUBLIC_BASELINE,
    GRAPH_LIVE_FUNCTIONS_BASELINE, CPR_LIVE_CONSTRAINTS, LC_MCP_CHAIN_BASELINE, ACTION_GATEWAY_BASELINE, RUNTIME, FIX_A_STATE, LC_MCP_READER],
  apply: A0.flatMap(([f, file]) => [{ fixture: P(f, 'pretest') }, file]),
  verify: [T('rc_8_5_21_fix_a_state_verify.sql'), T('phase_a0_reader_selfcheck_verify.sql')],
  // The behavioural posttests of #4, #7, #15 and #24 arm / claim R2 runtime jobs (inside BEGIN … ROLLBACK). The
  // emergency stop of the Fix A state (kept engaged in this baseline on purpose) refuses that, correctly
  // ({"blocked":"emergency_stop"} / runtime_limits_stop_stamped). They run in rc_8_5_21_release_chain, whose runtime
  // is armed. Every structural posttest runs here: holds, capabilities, shadow, opaque ids, the gateway, the Reader.
  posttest: [...A0.filter(([f]) => !RUNTIME_BEHAVIOURAL.has(f)).map(([f]) => P(f, 'posttest'))], // the Reader: phase_a0_reader_selfcheck_verify (its standalone posttest needs census_geo_metrics, absent from this fixture)
  rollback: A0.map(([f]) => P(f, 'rollback')), // listed in apply order; the runner runs them in REVERSE
}

export const MIGRATION_TESTS = Object.freeze([...BASE_TESTS, FROM_PRODUCTION_STATE, PHASE_A0_FROM_PRODUCTION_STATE])

// RECORDED PRODUCTION HISTORY (applied_in_production: true). These migrations were applied out of band and are
// kept only so the repository matches production's migration history. They are NOT test entries, NOT chain links and
// NOT part of any deploy plan; run-migration-test refuses any entry or file that names one.
export { APPLIED_IN_PRODUCTION } from './applied-in-production.mjs'
