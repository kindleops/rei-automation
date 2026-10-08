-- PROPOSED DB-level tests for PROPOSED_20261008120000_campaign_recipient_exclusions.sql
-- Run ONLY against a disposable database (CI Postgres or a Supabase branch) after
-- applying that migration. Never against production.
--
--   psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -f PROPOSED_campaign_recipient_exclusions.db-test.sql
--
-- Concurrency (two sessions, run manually or via the CI harness):
--   S1: BEGIN; SELECT upsert_campaign_recipient_exclusion(:c, '305-555-0101', 'a', 'actor1');
--   S2: BEGIN; SELECT upsert_campaign_recipient_exclusion(:c, '+13055550101', 'b', 'actor2');  -- blocks on the unique row
--   S1: COMMIT;  S2: COMMIT;
--   Expect: exactly 1 row, is_active = true, version = 2, reason = 'b', 2 audit events (created, updated).
--   Repeat with S2 = deactivate_campaign_recipient_exclusion(...): final state is the last committed writer; nothing lost.

BEGIN;

INSERT INTO public.campaigns (id, name, status) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'exclusion test c1', 'paused'),
  ('00000000-0000-0000-0000-0000000000c2', 'exclusion test c2', 'paused');

-- 1. normalization + insert
SELECT public.upsert_campaign_recipient_exclusion('00000000-0000-0000-0000-0000000000c1', '(305) 555-0101', 'moved_to_acquisition_campaign', 'tester', 'p1');
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.campaign_recipient_exclusions WHERE phone_e164 = '+13055550101') = 1, 'normalized insert';
END $$;

-- 2. idempotent upsert (same campaign + phone, different format) -> one row, version 2
SELECT public.upsert_campaign_recipient_exclusion('00000000-0000-0000-0000-0000000000c1', '13055550101', 'moved_to_acquisition_campaign', 'tester');
DO $$ BEGIN
  ASSERT (SELECT version FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1') = 2, 'upsert increments version';
  ASSERT (SELECT count(*) FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1') = 1, 'unique per campaign+phone';
END $$;

-- 3. campaign isolation: same phone in c2 is a separate row; c1 does not affect c2
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c2') = 0, 'c2 unaffected';
END $$;

-- 4. invalid input rejected
DO $$ BEGIN
  BEGIN PERFORM public.upsert_campaign_recipient_exclusion('00000000-0000-0000-0000-0000000000c1', '12345', 'x', 'tester'); ASSERT false, 'invalid phone accepted';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN PERFORM public.upsert_campaign_recipient_exclusion('00000000-0000-0000-0000-0000000000c1', '3055550199', 'x', ''); ASSERT false, 'empty actor accepted';
  EXCEPTION WHEN raise_exception THEN NULL; END;
END $$;

-- 5. authorized removal = deactivation; history retained; delete blocked
SELECT public.deactivate_campaign_recipient_exclusion('00000000-0000-0000-0000-0000000000c1', '3055550101', 'tester', 'review complete');
DO $$ BEGIN
  ASSERT (SELECT NOT is_active AND deactivated_at IS NOT NULL FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1'), 'deactivated';
  ASSERT (SELECT count(*) FROM public.campaign_recipient_exclusion_events WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1') = 3, 'created + updated + deactivated events';
  BEGIN DELETE FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1'; ASSERT false, 'delete allowed';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN UPDATE public.campaign_recipient_exclusion_events SET actor = 'x'; ASSERT false, 'audit mutable';
  EXCEPTION WHEN raise_exception THEN NULL; END;
END $$;

-- 6. reactivation
SELECT public.upsert_campaign_recipient_exclusion('00000000-0000-0000-0000-0000000000c1', '3055550101', 'moved_to_acquisition_campaign', 'tester');
DO $$ BEGIN
  ASSERT (SELECT is_active FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1'), 'reactivated';
END $$;

-- 7. campaign delete cascades (test-only campaigns)
DELETE FROM public.campaigns WHERE id IN ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2');
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.campaign_recipient_exclusions WHERE campaign_id = '00000000-0000-0000-0000-0000000000c1') = 0, 'cascade';
END $$;

ROLLBACK;
