-- P2 counterpart to 20260906120000_scoped_canary_null_campaign.sql.
--
-- WHY THIS IS REQUIRED
-- Patching queue_atomic_claim_send_row alone is insufficient: an exact-row
-- canary authorization for an ordinary (non-campaign) seller row cannot even be
-- INSERTED while queue_canary_authorizations.campaign_id is NOT NULL. The RPC
-- would accept a NULL campaign; the table refuses to store one.
--
-- WHY IT DOES NOT WEAKEN SCOPING
-- The RPC still enforces, for every scoped-canary claim:
--   * canary_run_id and authorization_token_hash NOT NULL
--   * v_auth.campaign_id IS DISTINCT FROM p_campaign_id  -> deny
--   * v_row.campaign_id  IS DISTINCT FROM p_campaign_id  -> deny
--   * p_queue_row_id must appear in queue_row_ids        -> authorization_row_not_allowlisted
--   * authorization_token_hash match, expires_at, consumed_at
--   * queue_execution_mode = 'scoped_canary_only'
--   * queue_global_execution_lock owner_type/canary_run_id match
--
-- So a NULL-campaign authorization can only ever claim explicitly enumerated
-- NULL-campaign rows. Campaign-scoped authorizations are entirely unaffected,
-- and no existing row is modified: every current authorization keeps its
-- campaign_id value.
--
-- queue_row_ids remains NOT NULL -- the exact-row allowlist stays mandatory.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'queue_canary_authorizations'
      AND column_name = 'campaign_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.queue_canary_authorizations
      ALTER COLUMN campaign_id DROP NOT NULL;
  ELSE
    RAISE NOTICE 'campaign_id already nullable; nothing to do';
  END IF;

  -- Assert the exact-row scope was not loosened by this migration.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'queue_canary_authorizations'
      AND column_name = 'queue_row_ids'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'queue_row_ids must remain NOT NULL';
  END IF;
END
$migration$;
