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
//
// PACKAGE A (hotfix/research-runtime, on production 6ecbae6b): the runner and its guards are the
// rc-8.5.21 (71479867) files; this manifest carries ONLY the migrations this branch ships plus the
// production prerequisites they compose on (S3, research_ro, intel_runtime — all applied in production).

const M = (f) => `supabase/migrations/${f}`
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
// 8.5.20 part C: the public tables the operations read functions read (prod-shaped subset)
const OPS_PUBLIC_BASELINE = 'scripts/db/fixtures/operations_public_baseline.sql'
// ops_health_snapshot_delivery_ref reads max(public.send_queue.delivered_at)
const SEND_QUEUE_DELIVERED_AT = {
  name: 'public.send_queue.delivered_at (ops health fixture)',
  sql: `alter table public.send_queue add column if not exists delivered_at timestamptz;`,
}
const KIND_LIMITS_FIX = M('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql')
const CAPS = M('PROPOSED_20261013120000_agent_capabilities.sql')
const OPS_HEALTH_DELIVERY_REF = M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql')
const MISSIONS = M('PROPOSED_20261014120000_persistent_missions.sql')
const OPS_ACTION_CENTER = M('PROPOSED_20261016140000_operations_action_center.sql')
const PAYLOAD_OPAQUE_IDS = M('PROPOSED_20261019120000_payload_clean_opaque_ids.sql')
// Package A's own link: per-kind event-budget ceilings WITHOUT runtime_enqueue_event_at (reply turns are not in the package)
const RESEARCH_CEILINGS = M('PROPOSED_20261020120000_research_event_budget_ceilings.sql')
// the production agent-runtime state after Fix A (2026-10-16): runtime off, emergency stop ON ('pretest'), kind_limits {}
const FIX_A_STATE = 'scripts/db/fixtures/fix_a_runtime_state.sql'

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
    apply: [CAPS],
    posttest: [M('PROPOSED_20261013120000_agent_capabilities_posttest.sql')],
    rollback: [M('PROPOSED_20261013120000_agent_capabilities_rollback.sql')],
  },
  {
    id: 'runtime_kind_limits_event_budget',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, RUNTIME],
    pretest: M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_pretest.sql'),
    apply: [KIND_LIMITS_FIX],
    posttest: [M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_posttest.sql')],
    rollback: [M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback_posttest.sql')],
  },
  {
    id: 'ops_health_snapshot_delivery_ref',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, SEND_QUEUE_DELIVERED_AT, RUNTIME],
    pretest: M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_pretest.sql'),
    apply: [OPS_HEALTH_DELIVERY_REF],
    posttest: [M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_posttest.sql')],
    rollback: [M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_rollback.sql')],
  },
  {
    // Package A: WITHOUT conversation_ai_shadow / conversation_decide_event_budget in the setup (not shipped)
    id: 'persistent_missions',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, SEND_QUEUE_DELIVERED_AT, RUNTIME, CAPS, KIND_LIMITS_FIX, OPS_HEALTH_DELIVERY_REF],
    pretest: M('PROPOSED_20261014120000_persistent_missions_pretest.sql'),
    apply: [MISSIONS],
    posttest: [M('PROPOSED_20261014120000_persistent_missions_posttest.sql')],
    rollback: [M('PROPOSED_20261014120000_persistent_missions_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261014120000_persistent_missions_rollback_posttest.sql')],
  },
  {
    id: 'operations_action_center',
    setup: [SHIM, DURABILITY, S3, RESEARCH, OPS_PUBLIC_BASELINE, RUNTIME, CAPS, KIND_LIMITS_FIX, OPS_HEALTH_DELIVERY_REF, MISSIONS],
    pretest: M('PROPOSED_20261016140000_operations_action_center_pretest.sql'),
    apply: [OPS_ACTION_CENTER],
    posttest: [M('PROPOSED_20261016140000_operations_action_center_posttest.sql')],
    rollback: [M('PROPOSED_20261016140000_operations_action_center_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261016140000_operations_action_center_rollback_posttest.sql')],
  },
  {
    id: 'payload_clean_opaque_ids',
    setup: [SHIM, DURABILITY, S3],
    pretest: M('PROPOSED_20261019120000_payload_clean_opaque_ids_pretest.sql'),
    apply: [PAYLOAD_OPAQUE_IDS],
    posttest: [M('PROPOSED_20261019120000_payload_clean_opaque_ids_posttest.sql')],
    rollback: [M('PROPOSED_20261019120000_payload_clean_opaque_ids_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261019120000_payload_clean_opaque_ids_rollback_posttest.sql')],
  },
  {
    id: 'research_event_budget_ceilings',
    setup: [SHIM, DURABILITY, S3, RESEARCH, RUNTIME_PUBLIC_FIXTURE, RUNTIME, KIND_LIMITS_FIX],
    pretest: M('PROPOSED_20261020120000_research_event_budget_ceilings_pretest.sql'),
    apply: [RESEARCH_CEILINGS],
    posttest: [M('PROPOSED_20261020120000_research_event_budget_ceilings_posttest.sql'), M('PROPOSED_20261020120100_research_package_schedules_posttest.sql')],
    rollback: [M('PROPOSED_20261020120000_research_event_budget_ceilings_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261020120000_research_event_budget_ceilings_rollback_posttest.sql')],
  },
]

// ── PACKAGE A: the whole chain, in the PRODUCTION apply order ──
// From a clean database (intel_runtime as the first link) and — the entry that matters for the deploy —
// from the PRODUCTION state: S3 + research_ro + intel_runtime applied and the Fix A runtime state
// (runtime off, emergency stop engaged, kind_limits {}). Each link's own pretest runs right before it;
// the verify runs after apply AND after the re-apply; the rollbacks run in reverse order and must restore
// the exact pre-chain schema fingerprint.
const CHAIN_LINKS = [
  { fixture: M('PROPOSED_20261013120000_agent_capabilities_pretest.sql') }, CAPS,
  { fixture: M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_pretest.sql') }, KIND_LIMITS_FIX,
  { fixture: M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_pretest.sql') }, OPS_HEALTH_DELIVERY_REF,
  { fixture: M('PROPOSED_20261014120000_persistent_missions_pretest.sql') }, MISSIONS,
  { fixture: M('PROPOSED_20261016140000_operations_action_center_pretest.sql') }, OPS_ACTION_CENTER,
  { fixture: M('PROPOSED_20261019120000_payload_clean_opaque_ids_pretest.sql') }, PAYLOAD_OPAQUE_IDS,
  { fixture: M('PROPOSED_20261020120000_research_event_budget_ceilings_pretest.sql') }, RESEARCH_CEILINGS,
]
const CHAIN_ROLLBACKS = [
  M('PROPOSED_20261013120000_agent_capabilities_rollback.sql'),
  M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql'),
  M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_rollback.sql'),
  M('PROPOSED_20261014120000_persistent_missions_rollback.sql'),
  M('PROPOSED_20261016140000_operations_action_center_rollback.sql'),
  M('PROPOSED_20261019120000_payload_clean_opaque_ids_rollback.sql'),
  M('PROPOSED_20261020120000_research_event_budget_ceilings_rollback.sql'),
]
const CHAIN_POSTTESTS = [
  M('PROPOSED_20261013120000_agent_capabilities_posttest.sql'),
  M('PROPOSED_20261014121000_runtime_kind_limits_event_budget_posttest.sql'),
  M('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_posttest.sql'),
  M('PROPOSED_20261014120000_persistent_missions_posttest.sql'),
  M('PROPOSED_20261016140000_operations_action_center_posttest.sql'),
  M('PROPOSED_20261019120000_payload_clean_opaque_ids_posttest.sql'),
  M('PROPOSED_20261020120000_research_event_budget_ceilings_posttest.sql'),
  M('PROPOSED_20261020120100_research_package_schedules_posttest.sql'),
]
const CHAIN_SETUP = [SHIM, DURABILITY, S3, RESEARCH, OPS_PUBLIC_BASELINE]

const RESEARCH_PACKAGE_CHAIN = {
  id: 'research_package_chain',
  setup: CHAIN_SETUP,
  apply: [{ fixture: M('PROPOSED_20261012140000_intel_runtime_pretest.sql') }, RUNTIME, ...CHAIN_LINKS],
  verify: [T('research_package_chain_verify.sql')],
  posttest: CHAIN_POSTTESTS,
  rollback: [M('PROPOSED_20261012140000_intel_runtime_rollback.sql'), ...CHAIN_ROLLBACKS],
}

const RESEARCH_PACKAGE_FROM_PRODUCTION_STATE = {
  id: 'research_package_chain_from_production_state',
  setup: [...CHAIN_SETUP, RUNTIME, FIX_A_STATE],
  apply: CHAIN_LINKS,
  verify: [T('research_package_chain_verify.sql'), T('research_package_fix_a_state_verify.sql')],
  // the behavioural posttests arm / claim jobs, which the engaged emergency stop (correctly) refuses; they run
  // in research_package_chain. This entry proves the STATE: apply → rollback → re-apply never changes
  // runtime_enabled / emergency_stop / kind_limits.
  posttest: [],
  rollback: CHAIN_ROLLBACKS,
}

export const MIGRATION_TESTS = Object.freeze([...BASE_TESTS, RESEARCH_PACKAGE_CHAIN, RESEARCH_PACKAGE_FROM_PRODUCTION_STATE])
