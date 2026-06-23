-- Workflow Studio V2 — Phase 2 enrollment state engine.
-- Adds timing/condition/scheduler columns to enrollment and edge tables.
-- No V1 tables are modified.

-- ── workflow_enrollments: timing + state machine columns ─────────────────────
ALTER TABLE public.workflow_enrollments
  ADD COLUMN IF NOT EXISTS next_execution_at timestamptz,
  ADD COLUMN IF NOT EXISTS waiting_reason    text,
  ADD COLUMN IF NOT EXISTS terminated_at     timestamptz;

-- ── workflow_edges: branch routing ───────────────────────────────────────────
-- edge_type drives graph traversal:
--   next  = default linear progression
--   true  = condition branch evaluated true
--   false = condition branch evaluated false
ALTER TABLE public.workflow_edges
  ADD COLUMN IF NOT EXISTS edge_type text NOT NULL DEFAULT 'next';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'workflow_edges'
      AND constraint_name = 'workflow_edges_edge_type_check'
  ) THEN
    ALTER TABLE public.workflow_edges
      ADD CONSTRAINT workflow_edges_edge_type_check
        CHECK (edge_type IN ('next', 'true', 'false'));
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Scheduler picks up enrollments where next_execution_at is past due.
CREATE INDEX IF NOT EXISTS idx_wf_enrollments_scheduler
  ON public.workflow_enrollments (next_execution_at, status)
  WHERE status IN ('active', 'waiting');

-- Enrollments that are active but have no timer (immediate execution candidates).
CREATE INDEX IF NOT EXISTS idx_wf_enrollments_active_no_wait
  ON public.workflow_enrollments (workflow_definition_id, status)
  WHERE status = 'active' AND next_execution_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wf_edges_edge_type
  ON public.workflow_edges (workflow_definition_id, edge_type);
