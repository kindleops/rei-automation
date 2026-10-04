-- PRETEST for PROPOSED_20261005120000_lead_visibility.sql — one DO block whose
-- every change is rolled back by the RAISE at the end (RC 7.1 practice: never an
-- explicit BEGIN through MCP; an aborted txn can hold locks on a pooled
-- connection). Expected result: ERROR 'pretest ok: ...' and NO schema change.
DO $pretest$
DECLARE
  v_opp uuid;
  v_status text;
  v_stage text;
  v_n int;
BEGIN
  ALTER TABLE public.acquisition_opportunities
    ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS archived_by text,
    ADD COLUMN IF NOT EXISTS archive_reason text,
    ADD COLUMN IF NOT EXISTS archive_action_id uuid;
  CREATE TABLE IF NOT EXISTS public.lead_visibility_actions (
    action_id uuid PRIMARY KEY, operator_id text NOT NULL, action text NOT NULL, source text NOT NULL,
    undo_of uuid, thread_key text, request jsonb NOT NULL DEFAULT '{}'::jsonb, resolved jsonb NOT NULL DEFAULT '[]'::jsonb,
    results jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

  -- the overlay write must not touch lifecycle columns, and the closed-won trigger must allow it
  SELECT id, opportunity_status, acquisition_stage INTO v_opp, v_status, v_stage
    FROM public.acquisition_opportunities WHERE opportunity_status = 'nurture' LIMIT 1;
  IF v_opp IS NOT NULL THEN
    UPDATE public.acquisition_opportunities
       SET archived_at = now(), archived_by = 'pretest', archive_reason = 'pretest', archive_action_id = gen_random_uuid()
     WHERE id = v_opp;
    SELECT count(*) INTO v_n FROM public.acquisition_opportunities
     WHERE id = v_opp AND opportunity_status = v_status AND acquisition_stage = v_stage AND archived_at IS NOT NULL;
    IF v_n <> 1 THEN RAISE EXCEPTION 'pretest FAILED: overlay write changed lifecycle columns'; END IF;
  END IF;

  INSERT INTO public.lead_visibility_actions (action_id, operator_id, action, source, thread_key, status)
  VALUES (gen_random_uuid(), 'pretest', 'unarchive', 'inbound_auto', '+10000000000', 'pending_resolution');

  RAISE EXCEPTION 'pretest ok: columns + table created, nurture overlay write kept status=% stage=% (all rolled back)', v_status, v_stage;
END
$pretest$;
