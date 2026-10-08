-- ============================================================================
-- STAGING ONLY — align the branch's two pre-existing tables with production.
-- ============================================================================
-- The branch was created before several production changes. Contract
-- validation (scripts/staging/validate-contract.sh) found, on these tables
-- only: an outdated stage CHECK, a missing strategy CHECK, a missing
-- UNIQUE(thread_key), stricter NOT NULLs than production, missing production
-- indexes, and three legacy policies granting role PUBLIC (anon) read/update
-- on inbox_thread_state that production's lockdown removed. Existing
-- synthetic rows comply (stage needs_review; thread keys unique).

SELECT staging_guard.assert_staging();

BEGIN;

ALTER TABLE public.acquisition_opportunities DROP CONSTRAINT IF EXISTS acquisition_opportunities_stage_check;
ALTER TABLE public.acquisition_opportunities ADD CONSTRAINT acquisition_opportunities_stage_check CHECK ((acquisition_stage = ANY (ARRAY['ownership_confirmation'::text, 'offer_interest'::text, 'asking_price'::text, 'property_condition'::text, 'offer'::text, 'formal_contract'::text, 'under_contract'::text, 'disposition'::text, 'prepared_to_close'::text, 'closed'::text, 'needs_review'::text, 'interest_qualification'::text, 'price_discovery'::text, 'underwriting'::text, 'decision_and_offer'::text, 'contract_to_close'::text])));
ALTER TABLE public.acquisition_opportunities DROP CONSTRAINT IF EXISTS acquisition_opportunities_strategy_status_check;
ALTER TABLE public.acquisition_opportunities ADD CONSTRAINT acquisition_opportunities_strategy_status_check CHECK (((strategy_status IS NULL) OR (strategy_status = ANY (ARRAY['pending'::text, 'active'::text, 'accepted'::text, 'rejected'::text, 'ineligible'::text, 'hold'::text]))));
CREATE INDEX IF NOT EXISTS idx_acquisition_opportunities_strategy ON public.acquisition_opportunities USING btree (strategy, strategy_status) WHERE (strategy IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbox_thread_state_thread_key_key' AND conrelid = 'public.inbox_thread_state'::regclass) THEN
    ALTER TABLE public.inbox_thread_state ADD CONSTRAINT inbox_thread_state_thread_key_key UNIQUE (thread_key);
  END IF;
END $$;
ALTER TABLE public.inbox_thread_state ALTER COLUMN inbound_count DROP NOT NULL;
ALTER TABLE public.inbox_thread_state ALTER COLUMN outbound_count DROP NOT NULL;
ALTER TABLE public.inbox_thread_state ALTER COLUMN message_count DROP NOT NULL;
ALTER TABLE public.inbox_thread_state ALTER COLUMN is_starred DROP NOT NULL;
ALTER TABLE public.inbox_thread_state ALTER COLUMN is_suppressed DROP NOT NULL;
ALTER TABLE public.inbox_thread_state ALTER COLUMN latest_message_event_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_bucket_latest ON public.inbox_thread_state USING btree (inbox_bucket, latest_message_at DESC NULLS LAST, thread_key DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_archived_read ON public.inbox_thread_state USING btree (is_archived, is_read);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_automation_lane ON public.inbox_thread_state USING btree (automation_lane);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_classification_run ON public.inbox_thread_state USING btree (classification_run_id);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_unread ON public.inbox_thread_state USING btree (is_read) WHERE (is_read = false);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_next_action_at ON public.inbox_thread_state USING btree (next_action_at) WHERE (next_action_at IS NOT NULL);
DROP INDEX IF EXISTS public.idx_inbox_thread_state_property; -- branch had it without production's predicate
CREATE INDEX idx_inbox_thread_state_property ON public.inbox_thread_state USING btree (property_id) WHERE (property_id IS NOT NULL);
DO $$
BEGIN
  -- latest_message_event_id stays text on staging: branch inbox views depend on it
  -- and no portal/scheduling contract reads it (accepted deviation, see
  -- scripts/staging/contract-deviations.txt).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbox_thread_state_primary_bucket_migration_guard') THEN
    ALTER TABLE public.inbox_thread_state ADD CONSTRAINT inbox_thread_state_primary_bucket_migration_guard CHECK (((classification_run_id IS NULL) OR (inbox_bucket IS NULL) OR (inbox_bucket = ANY (ARRAY['priority'::text, 'new_replies'::text, 'needs_review'::text, 'waiting'::text])))) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_status ON public.inbox_thread_state USING btree (status);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_thread_key ON public.inbox_thread_state USING btree (thread_key);

-- Production lockdown: no PUBLIC/anon policies.
DROP POLICY IF EXISTS inbox_thread_state_insert ON public.inbox_thread_state;
DROP POLICY IF EXISTS inbox_thread_state_select ON public.inbox_thread_state;
DROP POLICY IF EXISTS inbox_thread_state_update ON public.inbox_thread_state;
DROP POLICY IF EXISTS "Service role can manage inbox_thread_state" ON public.inbox_thread_state;
CREATE POLICY "Service role can manage inbox_thread_state" ON public.inbox_thread_state AS PERMISSIVE FOR ALL TO service_role USING (true);

-- Same function as production's trigger (updated_at), under production's name.
CREATE OR REPLACE FUNCTION public.touch_inbox_thread_state_updated_at()
 RETURNS trigger LANGUAGE plpgsql AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
DROP TRIGGER IF EXISTS trg_inbox_thread_state_updated_at ON public.inbox_thread_state;
DROP TRIGGER IF EXISTS trg_touch_inbox_thread_state_updated_at ON public.inbox_thread_state;
CREATE TRIGGER trg_touch_inbox_thread_state_updated_at BEFORE UPDATE ON public.inbox_thread_state FOR EACH ROW EXECUTE FUNCTION touch_inbox_thread_state_updated_at();

COMMIT;
