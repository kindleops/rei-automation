-- PROPOSED — NOT APPLIED. Owner applies (MCP apply_migration), then sets
-- system_control lead_visibility_sync_enabled = true to switch the code on.
--
-- LEAD VISIBILITY: archive becomes a shared visibility overlay across the Inbox
-- and Pipeline (owner decisions 2026-10-04). It never changes acquisition_stage,
-- opportunity_status, automation, nurture, suppression or read state.
--
-- Additive only: four nullable columns on acquisition_opportunities (no
-- default, no rewrite), one new table. Nothing existing changes. The code
-- names these columns ONLY after its gate confirms they exist
-- (lib/domain/lead-visibility/lead-visibility-gate.js).

BEGIN;

ALTER TABLE public.acquisition_opportunities
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by       text,
  ADD COLUMN IF NOT EXISTS archive_reason    text,
  ADD COLUMN IF NOT EXISTS archive_action_id uuid;

COMMENT ON COLUMN public.acquisition_opportunities.archived_at IS
  'Lead visibility overlay: hidden from working Pipeline views when set. Never a lifecycle fact — stage/status/automation unchanged.';

CREATE INDEX IF NOT EXISTS idx_acq_opp_archived_at
  ON public.acquisition_opportunities (archived_at)
  WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.lead_visibility_actions (
  action_id    uuid PRIMARY KEY,
  operator_id  text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 128),
  action       text NOT NULL CHECK (action IN ('archive', 'unarchive')),
  source       text NOT NULL CHECK (source IN ('inbox', 'pipeline', 'bulk', 'inbound_auto')),
  undo_of      uuid REFERENCES public.lead_visibility_actions (action_id),
  thread_key   text,
  request      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- for pending_resolution: the candidate deals [{opportunity_id, property_id, address, stage}]
  resolved     jsonb NOT NULL DEFAULT '[]'::jsonb,
  results      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'applied', 'partial', 'refused', 'pending_resolution', 'resolved')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lva_operator_created ON public.lead_visibility_actions (operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lva_pending_thread ON public.lead_visibility_actions (thread_key) WHERE status = 'pending_resolution';

-- service role only (the API); no anon / authenticated access
ALTER TABLE public.lead_visibility_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_visibility_actions FROM anon, authenticated;

COMMIT;
