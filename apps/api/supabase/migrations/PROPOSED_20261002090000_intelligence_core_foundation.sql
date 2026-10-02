-- INTELLIGENCE CORE 8.0 -- FOUNDATION SCHEMA. PROPOSED, NOT APPLIED.
--
-- STATUS: PROPOSED 2026-10-02. Requires owner approval before anyone applies
-- it (Supabase MCP apply_migration or an execute_sql DO-block, per the
-- migration-channel rule). The PROPOSED_ prefix keeps it outside
-- `supabase db push`. Do NOT rename it. Never applied by an agent.
--
-- PURPOSE
--   The separable learning domain for IC8 (architecture §2): registries,
--   the decision journal, outcomes, operator corrections, dataset and model
--   lineage, experiments, monitoring and the control audit. No ML column is
--   added to any existing table (prospects, properties, send_queue are
--   untouched). The code registries in apps/api/src/lib/domain/intelligence
--   are the source of truth; these tables mirror and record.
--
-- TABLES (schema intelligence; all new)
--    1 feature_definitions   code-registry mirror, PK (feature_key, version); a definition cannot change in place;
--                            carries feature_group (per-model contracts) and declared quality_fields (IC 8.1)
--    2 feature_sets          PK feature_set_id ("name@v"), members + hash
--    3 feature_snapshots     decision-time feature values; CHECK max_input_time < as_of; tri-state
--                            missingness and quality companions per feature (IC 8.1)
--    4 outcome_definitions   taxonomy mirror, PK (outcome_key, version)
--      outcomes              labels, UNIQUE (outcome_key, outcome_version, subject_type, subject_id);
--                            the ONE mutable label table (pending -> mature/censored)
--    5 decision_journal      APPEND-ONLY; decision_id = uuid v5(type:key); idempotency_key UNIQUE
--    6 corrections           APPEND-ONLY operator corrections (original kept)
--    7 dataset_snapshots     immutable once sealed
--    8 models / model_versions / model_status_events (APPEND-ONLY)
--    9 training_runs
--   10 experiments / experiment_assignments
--   11 policy_versions
--   12 monitor_metrics
--   13 control_audit         APPEND-ONLY flag-toggle audit
--   14 autonomy_envelopes    schema only (nothing reads it before Phase 12)
--
-- FAIRNESS (owner decision 2026-10-01, counsel approved)
--   fairness_class in (permitted, conversation_only, personal_attribute,
--   prohibited). The code registry never defines a prohibited feature; the
--   value exists so a mirror row can never claim a class outside the policy.
--
-- INDEXES
--   feature_snapshots (entity_type, entity_id, as_of desc); decision_journal
--   (decision_type, decided_at desc) + GIN(context); one champion per family
--   (partial UNIQUE); one live/successful training run per (family, dataset
--   sha) (partial UNIQUE); one active envelope per domain (partial UNIQUE);
--   BRIN on the time columns of the large append-only tables; lookups for
--   outcomes by decision and subject, corrections by subject, status events
--   by family.
--
-- RLS / GRANTS
--   RLS enabled on every table with ZERO policies. Schema usage and all table
--   privileges revoked from public, anon, authenticated; granted to
--   service_role only. Append-only tables grant service_role SELECT/INSERT
--   only, and a trigger rejects UPDATE/DELETE/TRUNCATE for every role.
--   Deployment prerequisite for the store (supabase-js .schema('intelligence')):
--   add `intelligence` to the API's exposed schemas. That is safe: anon and
--   authenticated hold no privilege on it.
--
-- EXPECTED VOLUME (first 6 months)
--   decision_journal < 25k rows/month; outcomes ~4x sends; feature_snapshots
--   ~1 per journaled decision; everything else is small (registries, runs,
--   audits). No partitioning yet.
--
-- BACKFILL
--   None in this migration. Later, separately approved, batched, checkpointed
--   and rate-limited jobs: outcome labels (labeler), corrections from
--   acquisition_opportunity_history / universal_lead_state_events (pure
--   mappers in corrections/corrections.js), registry mirrors (code -> table).
--
-- ROLLBACK
--   drop schema intelligence cascade;
--   (Everything here is new, so this is a complete rollback. Nothing outside
--   the schema references it.)
--
-- LOCK RISK
--   None: only new objects are created. No existing table is altered, no
--   existing lock is taken beyond catalog locks for the new schema.

create schema if not exists intelligence;
revoke all on schema intelligence from public, anon, authenticated;
grant usage on schema intelligence to service_role;

-- ── shared trigger functions ──────────────────────────────────────────────

create or replace function intelligence.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'intelligence.% is append-only: % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

create or replace function intelligence.feature_definition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'feature definitions are never deleted; deprecate them' using errcode = 'restrict_violation';
  end if;
  if (new.feature_key, new.version, new.definition_hash, new.scope, new.domain, new.value_type, new.pit_class,
      new.fairness_class, new.source_lineage)
     is distinct from
     (old.feature_key, old.version, old.definition_hash, old.scope, old.domain, old.value_type, old.pit_class,
      old.fairness_class, old.source_lineage) then
    raise exception 'feature % @ % cannot be redefined in place; define a new version', old.feature_key, old.version
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create or replace function intelligence.outcomes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.labeler_version is null or btrim(new.labeler_version) = '' then
    raise exception 'outcomes rows carry the labeler_version that wrote them' using errcode = 'check_violation';
  end if;
  if old.status in ('mature', 'censored') and new.status = 'pending' and new.labeler_version = old.labeler_version then
    raise exception 'an outcome cannot return to pending under the same labeler version' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function intelligence.dataset_snapshot_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.sealed then
    raise exception 'dataset snapshot % is sealed and immutable', old.dataset_id using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function intelligence.reject_mutation() from public, anon, authenticated;
revoke all on function intelligence.feature_definition_guard() from public, anon, authenticated;
revoke all on function intelligence.outcomes_touch() from public, anon, authenticated;
revoke all on function intelligence.dataset_snapshot_guard() from public, anon, authenticated;

-- ── 1. feature_definitions ────────────────────────────────────────────────
create table if not exists intelligence.feature_definitions (
  feature_key     text not null check (feature_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  version         integer not null check (version > 0),
  scope           text not null check (scope in ('seller','property','conversation','message','market','campaign','sender','template','buyer','comp','deal','time')),
  domain          text not null check (domain in ('property','ownership_prospect','financial_title','company_relationship','operational')),
  value_type      text not null check (value_type in ('integer','number','boolean','categorical')),
  mode            text not null check (mode in ('online','offline','both')),
  pit_class       text not null check (pit_class in ('event_time','history_reconstructed','static_fact','decision_snapshot_only')),
  fairness_class  text not null check (fairness_class in ('permitted','conversation_only','personal_attribute','prohibited')),
  feature_group   text not null default 'campaign' check (feature_group in ('prospect','property','market','contact','campaign','investor','transaction','comp','public_record','seller_provided','buyer','company','purchase','property_relationship','conversation')),
  quality_fields  text[] not null default '{}',
  stated_fact     boolean not null default false,
  source_lineage  jsonb not null,
  owner           text not null,
  freshness_sla   interval,
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  status          text not null default 'active' check (status in ('active','deprecated')),
  created_at      timestamptz not null default now(),
  primary key (feature_key, version)
);
drop trigger if exists trg_feature_definitions_guard on intelligence.feature_definitions;
create trigger trg_feature_definitions_guard
  before update or delete on intelligence.feature_definitions
  for each row execute function intelligence.feature_definition_guard();

-- ── 2. feature_sets ───────────────────────────────────────────────────────
create table if not exists intelligence.feature_sets (
  feature_set_id  text primary key check (feature_set_id ~ '^[a-z][a-z0-9_]*@[1-9][0-9]*$'),
  members         jsonb not null check (jsonb_typeof(members) = 'array'),
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  purpose         text not null default 'historical_training' check (purpose in ('historical_training','online')),
  status          text not null default 'active' check (status in ('active','deprecated')),
  created_at      timestamptz not null default now()
);

-- ── 3. feature_snapshots ──────────────────────────────────────────────────
create table if not exists intelligence.feature_snapshots (
  snapshot_id    uuid primary key default gen_random_uuid(),
  feature_set_id text not null references intelligence.feature_sets (feature_set_id),
  entity_type    text not null,
  entity_id      text not null,
  as_of          timestamptz not null,
  max_input_time timestamptz,
  "values"       jsonb not null default '{}'::jsonb check (jsonb_typeof("values") = 'object'),
  missing        text[] not null default '{}',
  missingness    jsonb not null default '{}'::jsonb,   -- key -> missing | unknown | not_applicable (never zero-filled)
  quality        jsonb not null default '{}'::jsonb,   -- key -> declared quality companions (source, vintage, confidence, ...)
  origin         text not null check (origin in ('online','offline_materialization','dataset_builder')),
  created_at     timestamptz not null default now(),
  constraint feature_snapshots_point_in_time check (max_input_time is null or max_input_time < as_of)
);
create index if not exists feature_snapshots_entity_idx on intelligence.feature_snapshots (entity_type, entity_id, as_of desc);
create index if not exists feature_snapshots_as_of_brin on intelligence.feature_snapshots using brin (as_of);

-- ── 4. outcome_definitions + outcomes ─────────────────────────────────────
create table if not exists intelligence.outcome_definitions (
  outcome_key     text not null,
  version         integer not null check (version > 0),
  subject_type    text not null check (subject_type in ('send','thread','decision','opportunity','campaign_day','comp_subject')),
  horizon         interval not null,
  value_type      text not null,
  label_source    text not null check (label_source in ('behavior','deterministic_rule','operator','transaction','system_event')),
  definition      jsonb not null,
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  primary key (outcome_key, version)
);

create table if not exists intelligence.outcomes (
  outcome_id      uuid primary key default gen_random_uuid(),
  outcome_key     text not null,
  outcome_version integer not null,
  subject_type    text not null check (subject_type in ('send','thread','decision','opportunity','campaign_day','comp_subject')),
  subject_id      text not null,
  decision_id     uuid,                    -- soft link: the journal is written asynchronously
  anchor_at       timestamptz,
  horizon_ends_at timestamptz,
  status          text not null check (status in ('pending','mature','censored')),
  value           jsonb,
  observed_at     timestamptz,
  censor_reason   text,
  evidence        jsonb not null default '{}'::jsonb,   -- ids and counts only, never message text
  labeler_version text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint outcomes_subject_unique unique (outcome_key, outcome_version, subject_type, subject_id),
  constraint outcomes_definition_fk foreign key (outcome_key, outcome_version)
    references intelligence.outcome_definitions (outcome_key, version),
  constraint outcomes_censor_reason check (status <> 'censored' or censor_reason is not null),
  constraint outcomes_anchor check ((anchor_at is not null and horizon_ends_at is not null and horizon_ends_at >= anchor_at) or status = 'censored')
);
create index if not exists outcomes_decision_idx on intelligence.outcomes (decision_id) where decision_id is not null;
create index if not exists outcomes_pending_idx on intelligence.outcomes (horizon_ends_at) where status = 'pending';
create index if not exists outcomes_anchor_brin on intelligence.outcomes using brin (anchor_at);
drop trigger if exists trg_outcomes_touch on intelligence.outcomes;
create trigger trg_outcomes_touch
  before update on intelligence.outcomes
  for each row execute function intelligence.outcomes_touch();

-- ── 5. decision_journal (append-only) ─────────────────────────────────────
create table if not exists intelligence.decision_journal (
  decision_id          uuid primary key,
  idempotency_key      text not null unique,   -- "<decision_type>:<key>"
  decided_at           timestamptz not null,
  decision_type        text not null check (decision_type in (
                         'seller_turn','message_strategy','follow_up_timing','fact_acceptance',
                         'campaign_feed','campaign_selection','campaign_scale','campaign_pause',
                         'comp_selection','valuation','human_handoff','buyer_match','market_selection')),
  mode                 text not null check (mode in ('observe','shadow','assist','act')),
  context              jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  feature_snapshot_id  uuid,
  feature_set_id       text,
  model_version_id     uuid,
  policy_version       text,
  versions             jsonb not null default '{}'::jsonb,
  candidates           jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  chosen_action        text,
  confidence           numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  guardrails           jsonb not null default '{}'::jsonb,
  reason_codes         text[] not null default '{}',
  experiment           jsonb,
  action_ref           jsonb,
  champion_decision_id uuid,
  created_at           timestamptz not null default now(),
  constraint decision_journal_idempotency_shape check (idempotency_key like decision_type || ':%')
);
create index if not exists decision_journal_type_decided_idx on intelligence.decision_journal (decision_type, decided_at desc);
create index if not exists decision_journal_context_gin on intelligence.decision_journal using gin (context);
create index if not exists decision_journal_champion_idx on intelligence.decision_journal (champion_decision_id) where champion_decision_id is not null;
create index if not exists decision_journal_decided_brin on intelligence.decision_journal using brin (decided_at);
drop trigger if exists trg_decision_journal_append_only on intelligence.decision_journal;
create trigger trg_decision_journal_append_only
  before update or delete on intelligence.decision_journal
  for each row execute function intelligence.reject_mutation();
drop trigger if exists trg_decision_journal_no_truncate on intelligence.decision_journal;
create trigger trg_decision_journal_no_truncate
  before truncate on intelligence.decision_journal
  for each statement execute function intelligence.reject_mutation();

-- ── 6. corrections (append-only) ──────────────────────────────────────────
create table if not exists intelligence.corrections (
  correction_id   uuid primary key default gen_random_uuid(),
  idempotency_key text unique,
  subject_type    text not null,
  subject_id      text not null,
  field           text not null,
  original_value  jsonb,
  original_source jsonb not null default '{}'::jsonb,   -- {producer, version, decision_id}
  corrected_value jsonb,
  operator_id     text,                                  -- x-ops-user-id; null = unknown (weak label)
  reason          text,
  corrected_at    timestamptz not null,
  source          text not null check (source ~ '^(route|repair|backfill|operator|script):'),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists corrections_subject_idx on intelligence.corrections (subject_type, subject_id, corrected_at desc);
create index if not exists corrections_corrected_brin on intelligence.corrections using brin (corrected_at);
drop trigger if exists trg_corrections_append_only on intelligence.corrections;
create trigger trg_corrections_append_only
  before update or delete on intelligence.corrections
  for each row execute function intelligence.reject_mutation();
drop trigger if exists trg_corrections_no_truncate on intelligence.corrections;
create trigger trg_corrections_no_truncate
  before truncate on intelligence.corrections
  for each statement execute function intelligence.reject_mutation();

-- ── 7. dataset_snapshots ──────────────────────────────────────────────────
create table if not exists intelligence.dataset_snapshots (
  dataset_id     uuid primary key,
  name           text not null,
  spec           jsonb not null,
  row_count      bigint not null default 0 check (row_count >= 0),
  positive_count bigint check (positive_count is null or positive_count >= 0),
  sha256         text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  uri            text,
  code_commit    text,
  built_at       timestamptz,
  build_stats    jsonb not null default '{}'::jsonb,
  sealed         boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint dataset_snapshots_sealed_complete check (not sealed or (sha256 is not null and uri is not null and built_at is not null and code_commit is not null))
);
drop trigger if exists trg_dataset_snapshots_sealed on intelligence.dataset_snapshots;
create trigger trg_dataset_snapshots_sealed
  before update or delete on intelligence.dataset_snapshots
  for each row execute function intelligence.dataset_snapshot_guard();

-- ── 8. models, model_versions, model_status_events ────────────────────────
create table if not exists intelligence.models (
  model_family    text primary key check (model_family ~ '^[a-z][a-z0-9_]*$'),
  purpose         text not null,
  target          text not null,
  prohibited_uses text[] not null default '{}',
  owner           text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists intelligence.model_versions (
  model_version_id    uuid primary key default gen_random_uuid(),
  model_family        text not null references intelligence.models (model_family),
  version             text not null,
  status              text not null default 'development'
                        check (status in ('development','backtest','shadow','challenger','champion','retired')),
  dataset_snapshot_id uuid references intelligence.dataset_snapshots (dataset_id),
  feature_set_id      text references intelligence.feature_sets (feature_set_id),
  training_window     tstzrange,
  code_commit         text,
  params              jsonb not null default '{}'::jsonb,
  metrics             jsonb not null default '{}'::jsonb,
  baseline_metrics    jsonb not null default '{}'::jsonb,
  artifact            jsonb check (artifact is null or octet_length(artifact::text) <= 102400),
  artifact_uri        text,
  artifact_sha256     text check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'),
  model_card          jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  promoted_at         timestamptz,
  retired_at          timestamptz,
  constraint model_versions_family_version unique (model_family, version),
  constraint model_versions_artifact_present check (artifact is not null or artifact_uri is not null)
);
create unique index if not exists model_versions_one_champion_per_family
  on intelligence.model_versions (model_family) where status = 'champion';

create table if not exists intelligence.model_status_events (
  event_id         uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references intelligence.model_versions (model_version_id),
  model_family     text not null references intelligence.models (model_family),
  from_status      text,
  to_status        text not null check (to_status in ('development','backtest','shadow','challenger','champion','retired')),
  actor            text not null check (btrim(actor) <> ''),
  reason           text not null check (btrim(reason) <> ''),
  gate_report      jsonb,
  metadata         jsonb not null default '{}'::jsonb,
  at               timestamptz not null default now(),
  constraint model_status_events_gated check (to_status not in ('challenger','champion') or gate_report is not null)
);
create index if not exists model_status_events_family_idx on intelligence.model_status_events (model_family, at desc);
drop trigger if exists trg_model_status_events_append_only on intelligence.model_status_events;
create trigger trg_model_status_events_append_only
  before update or delete on intelligence.model_status_events
  for each row execute function intelligence.reject_mutation();
drop trigger if exists trg_model_status_events_no_truncate on intelligence.model_status_events;
create trigger trg_model_status_events_no_truncate
  before truncate on intelligence.model_status_events
  for each statement execute function intelligence.reject_mutation();

-- ── 9. training_runs ──────────────────────────────────────────────────────
create table if not exists intelligence.training_runs (
  run_id              uuid primary key default gen_random_uuid(),
  model_family        text not null references intelligence.models (model_family),
  trigger             text not null check (trigger in ('manual','schedule')),
  dataset_snapshot_id uuid references intelligence.dataset_snapshots (dataset_id),
  status              text not null check (status in ('running','succeeded','failed','skipped_duplicate')),
  metrics             jsonb not null default '{}'::jsonb,
  error               text,
  model_version_id    uuid references intelligence.model_versions (model_version_id),
  idempotency_key     text not null,   -- "<family>:<dataset sha256>"
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists training_runs_live_idempotency
  on intelligence.training_runs (idempotency_key) where status in ('running','succeeded');
create index if not exists training_runs_family_idx on intelligence.training_runs (model_family, started_at desc);

-- ── 10. experiments + experiment_assignments ──────────────────────────────
create table if not exists intelligence.experiments (
  experiment_id text primary key check (experiment_id ~ '^[a-z][a-z0-9_]{2,80}$'),
  hypothesis    text not null,
  target        text not null check (target !~ '(^|_)(dnc|suppression|opt_?out|stop|unsubscribe|legal|compliance|tcpa|consent|security|auth|disclosures?|caps?)(_|$)'
                                  and target !~ '(wrong_number|wrong_person|contact_window|quiet_hours|sender_health|provider_eligibility|send_authority|daily_cap|stage_authority|offer_authority|offer_authorization|closing_authority)'),
  family        text,
  population    jsonb not null default '{}'::jsonb,
  unit_type     text not null,
  arms          jsonb not null check (jsonb_typeof(arms) = 'array' and jsonb_array_length(arms) >= 2),
  allocation    jsonb not null default '{}'::jsonb,
  strata        text[] not null default '{}',
  guardrails    jsonb not null default '{}'::jsonb,
  metrics       jsonb not null default '{}'::jsonb,
  status        text not null default 'draft' check (status in ('draft','running','stopped','completed')),
  salt          text not null check (length(salt) >= 8),
  started_at    timestamptz,
  ended_at      timestamptz,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists intelligence.experiment_assignments (
  experiment_id text not null references intelligence.experiments (experiment_id),
  unit_type     text not null,
  unit_id       text not null,
  arm           text not null,
  propensity    numeric not null check (propensity > 0 and propensity <= 1),
  assigned_at   timestamptz not null default now(),
  primary key (experiment_id, unit_type, unit_id)
);

-- ── 11. policy_versions ───────────────────────────────────────────────────
create table if not exists intelligence.policy_versions (
  policy_key      text not null,
  version         text not null,
  definition      jsonb not null,
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  status          text not null default 'draft' check (status in ('draft','active','retired')),
  created_at      timestamptz not null default now(),
  primary key (policy_key, version)
);

-- ── 12. monitor_metrics ───────────────────────────────────────────────────
create table if not exists intelligence.monitor_metrics (
  metric_id        uuid primary key default gen_random_uuid(),
  metric           text not null,
  model_version_id uuid references intelligence.model_versions (model_version_id),
  feature_key      text,
  segment          jsonb not null default '{}'::jsonb,
  "window"         tstzrange not null,
  value            numeric,
  threshold        numeric,
  status           text not null check (status in ('ok','warn','alert')),
  computed_at      timestamptz not null default now(),
  constraint monitor_metrics_subject check (model_version_id is not null or feature_key is not null)
);
create index if not exists monitor_metrics_model_idx on intelligence.monitor_metrics (model_version_id, computed_at desc);
create index if not exists monitor_metrics_computed_brin on intelligence.monitor_metrics using brin (computed_at);

-- ── 13. control_audit (append-only) ───────────────────────────────────────
create table if not exists intelligence.control_audit (
  audit_id  uuid primary key default gen_random_uuid(),
  key       text not null,
  old_value text,
  new_value text,
  actor     text not null check (btrim(actor) <> ''),
  reason    text not null check (btrim(reason) <> ''),
  at        timestamptz not null default now()
);
create index if not exists control_audit_key_idx on intelligence.control_audit (key, at desc);
drop trigger if exists trg_control_audit_append_only on intelligence.control_audit;
create trigger trg_control_audit_append_only
  before update or delete on intelligence.control_audit
  for each row execute function intelligence.reject_mutation();
drop trigger if exists trg_control_audit_no_truncate on intelligence.control_audit;
create trigger trg_control_audit_no_truncate
  before truncate on intelligence.control_audit
  for each statement execute function intelligence.reject_mutation();

-- ── 14. autonomy_envelopes (schema only; nothing reads it before Phase 12) ─
create table if not exists intelligence.autonomy_envelopes (
  envelope_id uuid primary key default gen_random_uuid(),
  domain      text not null,
  version     integer not null check (version > 0),
  envelope    jsonb not null,
  status      text not null default 'draft' check (status in ('draft','active','retired')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  constraint autonomy_envelopes_domain_version unique (domain, version)
);
create unique index if not exists autonomy_envelopes_one_active
  on intelligence.autonomy_envelopes (domain) where status = 'active';

-- ── RLS (on, zero policies) and grants (service_role only) ────────────────
do $rls$
declare
  t text;
  append_only text[] := array['decision_journal','corrections','model_status_events','control_audit'];
begin
  foreach t in array array[
    'feature_definitions','feature_sets','feature_snapshots','outcome_definitions','outcomes',
    'decision_journal','corrections','dataset_snapshots','models','model_versions',
    'model_status_events','training_runs','experiments','experiment_assignments',
    'policy_versions','monitor_metrics','control_audit','autonomy_envelopes']
  loop
    execute format('alter table intelligence.%I enable row level security', t);
    execute format('revoke all on intelligence.%I from public, anon, authenticated', t);
    if t = any (append_only) then
      execute format('revoke all on intelligence.%I from service_role', t);
      execute format('grant select, insert on intelligence.%I to service_role', t);
    else
      execute format('grant select, insert, update, delete on intelligence.%I to service_role', t);
    end if;
  end loop;
end
$rls$;

alter default privileges in schema intelligence revoke all on tables from public, anon, authenticated;
alter default privileges in schema intelligence revoke all on functions from public, anon, authenticated;

comment on schema intelligence is
  'IC8 learning domain (PROPOSED 20261002090000): registries, append-only decision journal, outcomes, corrections, lineage. Service role only; RLS on, zero policies.';
