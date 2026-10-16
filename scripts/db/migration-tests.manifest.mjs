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
const ASKING_PRICE_MIRROR = M('PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql')
const ASKING_PRICE_QUESTION_KIND = M('PROPOSED_20261015120000_repeat_asking_price_question_kind.sql')
// rc-8.5.20 parts A / C, needed as setup by the 8.5.21-b entries
const REPLY_TURNS = M('PROPOSED_20261016120000_conversation_reply_turns.sql')
const OPS_ACTION_CENTER = M('PROPOSED_20261016140000_operations_action_center.sql')
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

export const MIGRATION_TESTS = Object.freeze([
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
    pretest: M('PROPOSED_20261014120000_block_repeat_asking_price_mirror_pretest.sql'),
    apply: [M('PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql')],
    posttest: [M('PROPOSED_20261014120000_block_repeat_asking_price_mirror_posttest.sql')],
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
    posttest: [M('PROPOSED_20261016120000_conversation_reply_turns_posttest.sql'), M('PROPOSED_20261016120100_conversation_reply_turns_schedules_posttest.sql')],
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
  // ── rc-8.5.20: the WHOLE release chain on ONE database, in production apply order ──
  // Each migration's own pretest runs immediately before it (interleaved fixtures); the
  // posttests run on the final state; the rollbacks run in reverse order and must restore
  // the pre-chain fingerprint; then the chain is re-applied. The mirror of the live
  // trg_block_repeat_asking_price body is applied BEFORE repeat_asking_price_question_kind:
  // applied after it, the mirror would re-create the old body (and its pretest refuses a
  // body that is not the live one).
  {
    id: 'rc_8_5_20_release_chain',
    setup: [SHIM, DURABILITY, S3, RESEARCH, SEND_QUEUE_BASELINE, RUNTIME_PUBLIC_FIXTURE, OPS_PUBLIC_BASELINE, RESEARCH_VALUATION_BASELINE, LEGACY_CONVERSATION_TURNS],
    apply: [
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
      { fixture: M('PROPOSED_20261014120000_block_repeat_asking_price_mirror_pretest.sql') }, ASKING_PRICE_MIRROR,
      { fixture: M('PROPOSED_20261015120000_repeat_asking_price_question_kind_pretest.sql') }, ASKING_PRICE_QUESTION_KIND,
      // rc-8.5.20 parts A / B / C. zip_acquisition_intelligence is independent; conversation_reply_turns
      // needs the runtime + both event-budget fixes; operations_action_center needs the runtime,
      // the capability plane and persistent_missions. The schedule seeds (PROPOSED_20261016100100
      // property research, PROPOSED_20261016120100 turn sweep, PROPOSED_20261016140100 operations:
      // psql -v owner_id, own BEGIN/COMMIT) are exercised by their posttests.
      { fixture: M('PROPOSED_20261016100000_zip_acquisition_intelligence_pretest.sql') }, M('PROPOSED_20261016100000_zip_acquisition_intelligence.sql'),
      { fixture: M('PROPOSED_20261016120000_conversation_reply_turns_pretest.sql') }, M('PROPOSED_20261016120000_conversation_reply_turns.sql'),
      { fixture: M('PROPOSED_20261016140000_operations_action_center_pretest.sql') }, M('PROPOSED_20261016140000_operations_action_center.sql'),
      // rc-8.5.21 part B: event budget ceilings (after the reply-turns runtime_enqueue_event_at), the send
      // authorization (after negotiation_authority), the supervisor read (after operations_action_center)
      { fixture: M('PROPOSED_20261016160000_runtime_event_budget_ceilings_pretest.sql') }, EVENT_BUDGET_CEILINGS,
      { fixture: M('PROPOSED_20261016161000_negotiation_send_authorization_pretest.sql') }, SEND_AUTHORIZATION,
      { fixture: M('PROPOSED_20261016162000_ops_research_valuation_snapshot_pretest.sql') }, OPS_RESEARCH_VALUATION,
    ],
    posttest: [
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
      M('PROPOSED_20261016160000_runtime_event_budget_ceilings_posttest.sql'),
      M('PROPOSED_20261016161000_negotiation_send_authorization_posttest.sql'),
      M('PROPOSED_20261016162000_ops_research_valuation_snapshot_posttest.sql'),
    ],
    // applied in reverse order by the runner (the mirror has no rollback: it is the live body)
    rollback: [
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
      M('PROPOSED_20261016160000_runtime_event_budget_ceilings_rollback.sql'),
      M('PROPOSED_20261016161000_negotiation_send_authorization_rollback.sql'),
      M('PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback.sql'),
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
])
