-- Workflow Studio V2 schema.
-- Adds graph-model tables: definitions, nodes (with node_kind), edges, enrollments,
-- run_steps, events, and node_registry. Extends workflow_runs with nullable V2 FKs.
-- Does NOT modify V1 tables (workflows, workflow_steps, workflow_run_events).
-- live_send_enabled defaults false on every V2 table. Dry-run guard always true.

-- ────────────────────────────────────────────────
-- workflow_definitions  (V2 workflow header)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_definitions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_key    text        NOT NULL UNIQUE,
  name              text        NOT NULL,
  description       text,
  status            text        NOT NULL DEFAULT 'draft',
  live_send_enabled boolean     NOT NULL DEFAULT false,
  trigger_type      text,
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wf_def_status_check CHECK (
    status IN ('draft', 'active', 'paused', 'archived')
  ),
  CONSTRAINT wf_def_live_send_draft_guard CHECK (
    live_send_enabled IS FALSE OR status = 'active'
  )
);

-- ────────────────────────────────────────────────
-- workflow_nodes  (V2 graph nodes)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_nodes (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_definition_id  uuid        NOT NULL REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  node_key                text        NOT NULL,
  node_kind               text        NOT NULL,
  node_type               text        NOT NULL,
  label                   text        NOT NULL,
  config                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  position_x              numeric     NOT NULL DEFAULT 0,
  position_y              numeric     NOT NULL DEFAULT 0,
  is_active               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_nodes_key_unique UNIQUE (workflow_definition_id, node_key),
  CONSTRAINT workflow_nodes_kind_check CHECK (
    node_kind IN ('trigger', 'action', 'condition', 'timing', 'guard')
  )
);

-- ────────────────────────────────────────────────
-- workflow_edges  (directed graph edges)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_edges (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_definition_id  uuid        NOT NULL REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  source_node_id          uuid        NOT NULL REFERENCES public.workflow_nodes(id) ON DELETE CASCADE,
  target_node_id          uuid        NOT NULL REFERENCES public.workflow_nodes(id) ON DELETE CASCADE,
  condition_key           text,
  label                   text,
  config                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_edges_no_self_loop CHECK (source_node_id <> target_node_id)
);

-- ────────────────────────────────────────────────
-- workflow_enrollments  (per-subject enrollment state)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_enrollments (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_definition_id  uuid        NOT NULL REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  subject_type            text        NOT NULL DEFAULT 'lead',
  subject_id              text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'active',
  current_node_id         uuid        REFERENCES public.workflow_nodes(id) ON DELETE SET NULL,
  context                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  enrolled_at             timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_enrollments_status_check CHECK (
    status IN ('active', 'waiting', 'completed', 'cancelled', 'failed')
  ),
  CONSTRAINT workflow_enrollments_subject_unique UNIQUE (workflow_definition_id, subject_type, subject_id)
);

-- ────────────────────────────────────────────────
-- workflow_run_steps  (V2 step-level execution proof)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_run_steps (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id         uuid        NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_definition_id  uuid        NOT NULL REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  node_id                 uuid        REFERENCES public.workflow_nodes(id) ON DELETE SET NULL,
  node_key                text        NOT NULL,
  node_kind               text        NOT NULL,
  node_type               text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'planned',
  dry_run                 boolean     NOT NULL DEFAULT true,
  live_send_blocked       boolean     NOT NULL DEFAULT true,
  block_reason            text,
  execution_result        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_run_steps_status_check CHECK (
    status IN ('planned', 'running', 'completed', 'skipped', 'blocked', 'failed')
  )
);

-- ────────────────────────────────────────────────
-- workflow_events  (inbound event queue for V2 execution)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_events (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type              text        NOT NULL,
  subject_type            text        NOT NULL DEFAULT 'lead',
  subject_id              text        NOT NULL,
  workflow_definition_id  uuid        REFERENCES public.workflow_definitions(id) ON DELETE SET NULL,
  payload                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                  text        NOT NULL DEFAULT 'pending',
  processed_at            timestamptz,
  dedupe_key              text        UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_events_status_check CHECK (
    status IN ('pending', 'matched', 'no_match', 'error', 'skipped')
  )
);

-- ────────────────────────────────────────────────
-- workflow_node_registry  (catalog of available node types)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_node_registry (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type             text        NOT NULL UNIQUE,
  node_kind             text        NOT NULL,
  label                 text        NOT NULL,
  description           text,
  category              text,
  input_schema          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  output_schema         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_communication      boolean     NOT NULL DEFAULT false,
  requires_guard_before boolean     NOT NULL DEFAULT false,
  is_terminal           boolean     NOT NULL DEFAULT false,
  is_enabled            boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_node_registry_kind_check CHECK (
    node_kind IN ('trigger', 'action', 'condition', 'timing', 'guard')
  )
);

-- ────────────────────────────────────────────────
-- Extend workflow_runs with V2 nullable FKs
-- (V1 uses workflow_id → workflows; V2 uses workflow_definition_id → workflow_definitions)
-- ────────────────────────────────────────────────
ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS workflow_definition_id uuid REFERENCES public.workflow_definitions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enrollment_id          uuid REFERENCES public.workflow_enrollments(id)  ON DELETE SET NULL;

-- ────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_wf_definitions_status
  ON public.workflow_definitions (status);
CREATE INDEX IF NOT EXISTS idx_wf_definitions_trigger_type
  ON public.workflow_definitions (trigger_type)
  WHERE trigger_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wf_definitions_created_at
  ON public.workflow_definitions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wf_nodes_definition_id
  ON public.workflow_nodes (workflow_definition_id);
CREATE INDEX IF NOT EXISTS idx_wf_nodes_kind
  ON public.workflow_nodes (node_kind);
CREATE INDEX IF NOT EXISTS idx_wf_nodes_type
  ON public.workflow_nodes (node_type);
CREATE INDEX IF NOT EXISTS idx_wf_nodes_active
  ON public.workflow_nodes (workflow_definition_id, is_active);

CREATE INDEX IF NOT EXISTS idx_wf_edges_definition_id
  ON public.workflow_edges (workflow_definition_id);
CREATE INDEX IF NOT EXISTS idx_wf_edges_source
  ON public.workflow_edges (source_node_id);
CREATE INDEX IF NOT EXISTS idx_wf_edges_target
  ON public.workflow_edges (target_node_id);

CREATE INDEX IF NOT EXISTS idx_wf_enrollments_definition
  ON public.workflow_enrollments (workflow_definition_id);
CREATE INDEX IF NOT EXISTS idx_wf_enrollments_subject
  ON public.workflow_enrollments (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_wf_enrollments_status
  ON public.workflow_enrollments (status);

CREATE INDEX IF NOT EXISTS idx_wf_run_steps_run_id
  ON public.workflow_run_steps (workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_wf_run_steps_definition
  ON public.workflow_run_steps (workflow_definition_id);
CREATE INDEX IF NOT EXISTS idx_wf_run_steps_node_id
  ON public.workflow_run_steps (node_id)
  WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wf_run_steps_status
  ON public.workflow_run_steps (status);

CREATE INDEX IF NOT EXISTS idx_wf_events_status
  ON public.workflow_events (status);
CREATE INDEX IF NOT EXISTS idx_wf_events_subject
  ON public.workflow_events (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_wf_events_event_type
  ON public.workflow_events (event_type);
CREATE INDEX IF NOT EXISTS idx_wf_events_definition
  ON public.workflow_events (workflow_definition_id)
  WHERE workflow_definition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wf_events_created_at
  ON public.workflow_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wf_node_registry_kind
  ON public.workflow_node_registry (node_kind);
CREATE INDEX IF NOT EXISTS idx_wf_node_registry_category
  ON public.workflow_node_registry (category)
  WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wf_node_registry_enabled
  ON public.workflow_node_registry (is_enabled);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf_def_id
  ON public.workflow_runs (workflow_definition_id)
  WHERE workflow_definition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_enrollment_id
  ON public.workflow_runs (enrollment_id)
  WHERE enrollment_id IS NOT NULL;

-- ────────────────────────────────────────────────
-- updated_at triggers (reuse V1 trigger function)
-- ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_wf_definitions_updated_at ON public.workflow_definitions;
CREATE TRIGGER trg_wf_definitions_updated_at
  BEFORE UPDATE ON public.workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_wf_nodes_updated_at ON public.workflow_nodes;
CREATE TRIGGER trg_wf_nodes_updated_at
  BEFORE UPDATE ON public.workflow_nodes
  FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_wf_enrollments_updated_at ON public.workflow_enrollments;
CREATE TRIGGER trg_wf_enrollments_updated_at
  BEFORE UPDATE ON public.workflow_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

-- ────────────────────────────────────────────────
-- RLS  (service_role full access — same pattern as V1)
-- ────────────────────────────────────────────────
ALTER TABLE public.workflow_definitions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_nodes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_edges         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_enrollments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_run_steps     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_node_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wf_def_svc_all    ON public.workflow_definitions;
CREATE POLICY wf_def_svc_all    ON public.workflow_definitions   FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS wf_nodes_svc_all  ON public.workflow_nodes;
CREATE POLICY wf_nodes_svc_all  ON public.workflow_nodes         FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS wf_edges_svc_all  ON public.workflow_edges;
CREATE POLICY wf_edges_svc_all  ON public.workflow_edges         FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS wf_enroll_svc_all ON public.workflow_enrollments;
CREATE POLICY wf_enroll_svc_all ON public.workflow_enrollments   FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS wf_run_steps_svc_all ON public.workflow_run_steps;
CREATE POLICY wf_run_steps_svc_all ON public.workflow_run_steps  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS wf_events_svc_all ON public.workflow_events;
CREATE POLICY wf_events_svc_all ON public.workflow_events        FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS wf_registry_svc_all ON public.workflow_node_registry;
CREATE POLICY wf_registry_svc_all ON public.workflow_node_registry FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON TABLE
  public.workflow_definitions,
  public.workflow_nodes,
  public.workflow_edges,
  public.workflow_enrollments,
  public.workflow_run_steps,
  public.workflow_events,
  public.workflow_node_registry
TO service_role;

-- ────────────────────────────────────────────────
-- Seed node registry
-- ────────────────────────────────────────────────
INSERT INTO public.workflow_node_registry
  (node_type, node_kind, label, description, category, is_communication, requires_guard_before, is_terminal, is_enabled)
VALUES
  ('trigger.lead_entered_workflow', 'trigger',   'Lead Entered Workflow', 'Fires when a lead is enrolled into this workflow.',                  'triggers',   false, false, false, true),
  ('action.send_sms',               'action',    'Send SMS',              'Sends an SMS to the lead. Dry-run only until live_send_enabled.',    'messaging',  true,  true,  false, true),
  ('action.update_stage',           'action',    'Update Stage',          'Updates the lead pipeline stage.',                                   'crm',        false, false, false, true),
  ('action.update_status',          'action',    'Update Status',         'Updates the lead contact status.',                                   'crm',        false, false, false, true),
  ('timing.wait_duration',          'timing',    'Wait Duration',         'Pauses execution for a specified duration.',                         'timing',     false, false, false, true),
  ('condition.seller_replied',      'condition', 'Seller Replied',        'Branches on whether the seller has replied.',                        'conditions', false, false, false, true),
  ('condition.no_reply_after',      'condition', 'No Reply After',        'Branches true if no reply after a given duration.',                  'conditions', false, false, false, true),
  ('guard.stop_suppression',        'guard',     'Stop If Suppressed',    'Halts execution if the contact is on DNC/opt-out list.',             'guards',     false, false, true,  true),
  ('guard.quiet_hours',             'guard',     'Quiet Hours',           'Blocks communication actions outside the quiet-hours window.',       'guards',     false, false, false, true),
  ('guard.max_touches',             'guard',     'Max Touches',           'Blocks if the lead has exceeded the maximum contact attempt limit.', 'guards',     false, false, false, true)
ON CONFLICT (node_type) DO UPDATE
  SET node_kind             = EXCLUDED.node_kind,
      label                 = EXCLUDED.label,
      description           = EXCLUDED.description,
      category              = EXCLUDED.category,
      is_communication      = EXCLUDED.is_communication,
      requires_guard_before = EXCLUDED.requires_guard_before,
      is_terminal           = EXCLUDED.is_terminal,
      is_enabled            = EXCLUDED.is_enabled;

-- ────────────────────────────────────────────────
-- Comments
-- ────────────────────────────────────────────────
COMMENT ON TABLE public.workflow_definitions   IS 'Workflow Studio V2 workflow headers. live_send_enabled defaults false; V1 table workflows is unchanged.';
COMMENT ON TABLE public.workflow_nodes         IS 'V2 graph nodes. node_kind classifies role (trigger/action/condition/timing/guard); node_type matches registry.';
COMMENT ON TABLE public.workflow_edges         IS 'V2 directed graph edges. source_node_id → target_node_id. condition_key for conditional branches.';
COMMENT ON TABLE public.workflow_enrollments   IS 'V2 per-subject enrollment state. One active enrollment per (workflow, subject_type, subject_id).';
COMMENT ON TABLE public.workflow_run_steps     IS 'V2 step-level execution proof. dry_run=true, live_send_blocked=true until live execution is explicitly enabled.';
COMMENT ON TABLE public.workflow_events        IS 'V2 inbound event queue. Events fan out to matching workflow trigger nodes.';
COMMENT ON TABLE public.workflow_node_registry IS 'Catalog of available V2 node types. Source of truth for validation and UI rendering.';
