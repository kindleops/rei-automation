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
    id: 'conversation_decide_event_budget',
    // The posttest arms event_budget_cap_usd, which agent.runtime_kind_limits_valid
    // (intel_runtime) refuses until PROPOSED_20261014121000_runtime_kind_limits_event_budget
    // is applied — that fix is not on this release's base (6ecbae6b). Pre-existing: the
    // original single-file pretest failed the same way here.
    requires: 'PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql (setup)',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, RUNTIME],
    pretest: M('PROPOSED_20261013161000_conversation_decide_event_budget_pretest.sql'),
    apply: [M('PROPOSED_20261013161000_conversation_decide_event_budget.sql')],
    posttest: [M('PROPOSED_20261013161000_conversation_decide_event_budget_posttest.sql')],
    rollback: [M('PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261013161000_conversation_decide_event_budget_rollback_posttest.sql')],
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
  // ── 8.5.16 native AI conversation engine ──
  {
    id: 'block_repeat_asking_price_mirror',
    // the baseline already carries the live trigger: the mirror must re-create it identically
    setup: [SHIM, SEND_QUEUE_BASELINE],
    pretest: M('PROPOSED_20261014120000_block_repeat_asking_price_mirror_pretest.sql'),
    apply: [M('PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql')],
    posttest: [M('PROPOSED_20261014120000_block_repeat_asking_price_mirror_posttest.sql')],
  },
  {
    id: 'message_origin_ai_generated_messages',
    setup: [SHIM, SEND_QUEUE_BASELINE],
    pretest: M('PROPOSED_20261015130000_message_origin_ai_generated_messages_pretest.sql'),
    apply: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages.sql')],
    posttest: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages_posttest.sql')],
    rollback: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback_posttest.sql')],
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
