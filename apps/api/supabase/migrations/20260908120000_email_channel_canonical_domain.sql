-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL-1: the canonical email domain.
--
-- WHAT THIS MIGRATION IS FOR
--   The §11 seam (seller_logical_communications + seller_communication_attempts)
--   already decides, for every seller-visible message, whether it may be sent,
--   whether an attempt may be repeated, and what a provider outcome means. Its
--   LOGIC is transport-neutral. Its SCHEMA was not: the table could name a
--   recipient only as to_phone_number, and nothing recorded which transport a
--   communication travelled on.
--
--   That omission is not cosmetic. Every anchor set in lck_v1 is channel-blind:
--   campaign_target_id + touch_number, decision_id, follow_up_id and
--   offer_id + offer_version all describe a domain action without saying how it
--   travels. So "touch 3 of target T by SMS" and "touch 3 of target T by email"
--   hashed to the SAME logical key and collapsed onto ONE row. Turning email on
--   would therefore have produced one of two unrecoverable outcomes:
--
--     the email is REFUSED as a duplicate attempt on the SMS communication, or
--     the email ADOPTS the SMS attempt's provider evidence and delivery state.
--
--   lck_v2 adds channel to the identity hash. This migration makes the database
--   able to hold that fact, and refuse rows that contradict it.
--
-- BLAST RADIUS, MEASURED (2026-09-08)
--   seller_logical_communications holds exactly ONE row: an internal_canary in
--   ambiguous_provider_outcome / retry_denied. It is already un-retryable by the
--   transition authority, so re-keying strands nothing that could ever be sent
--   again. No campaign, decision, follow-up or offer communication exists. The
--   backfill below is therefore a one-row, no-op-in-practice statement, and it
--   is written as a backfill rather than a rewrite so that it stays correct if
--   rows appear between review and apply.
--
-- WHY channel HAS A DEFAULT AND THEN LOSES IT
--   The default exists only so the ADD COLUMN can backfill pre-lck_v2 rows,
--   every one of which is SMS by construction (this table predates any email
--   path). It is dropped immediately afterwards. A surviving default would be a
--   silent fallback: a future caller that forgot to name its channel would be
--   quietly filed as SMS instead of failing loudly, which is exactly the class
--   of bug lck_v2 exists to remove.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. seller_logical_communications becomes channel-aware ──────────────────

ALTER TABLE public.seller_logical_communications
  ADD COLUMN IF NOT EXISTS channel  text,
  ADD COLUMN IF NOT EXISTS to_email text;

UPDATE public.seller_logical_communications
   SET channel = 'sms'
 WHERE channel IS NULL;

ALTER TABLE public.seller_logical_communications
  ALTER COLUMN channel SET NOT NULL;

-- Explicitly NO default. See the header: a default here would re-introduce the
-- silent fallback that the required channel component removes.
ALTER TABLE public.seller_logical_communications
  ALTER COLUMN channel DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'seller_logical_communications_channel_valid'
  ) THEN
    ALTER TABLE public.seller_logical_communications
      ADD CONSTRAINT seller_logical_communications_channel_valid
      CHECK (channel IN ('sms', 'email'));
  END IF;
END $$;

-- A communication travels on ONE transport. Holding both recipient kinds on one
-- row would let a reader answer "who received this?" two different ways, and a
-- reconciler pick the wrong one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'seller_logical_communications_recipient_matches_channel'
  ) THEN
    ALTER TABLE public.seller_logical_communications
      ADD CONSTRAINT seller_logical_communications_recipient_matches_channel
      CHECK (
        (channel = 'sms'   AND to_email        IS NULL)
        OR
        (channel = 'email' AND to_phone_number IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS seller_logical_communications_channel_state_idx
  ON public.seller_logical_communications (channel, state);

CREATE INDEX IF NOT EXISTS seller_logical_communications_to_email_idx
  ON public.seller_logical_communications (to_email)
  WHERE to_email IS NOT NULL;

COMMENT ON COLUMN public.seller_logical_communications.channel IS
  'Transport this communication travels on. Part of the lck_v2 identity hash: the same domain action on two channels is two communications, never one.';
COMMENT ON COLUMN public.seller_logical_communications.to_email IS
  'Recipient address for channel = email. Mutually exclusive with to_phone_number.';

-- ── 1b. the anchor uniqueness indexes must learn channel too ────────────────
--
-- FOUND BY EXECUTING THIS MIGRATION, NOT BY READING IT.
--
--   Putting channel into the logical key is necessary and was not sufficient.
--   Three partial unique indexes enforce "one communication per anchor" at the
--   database level, and every one of them is channel-blind:
--
--     uq_..._decision_action  (decision_id, communication_type)
--     uq_..._campaign_touch   (campaign_target_id, touch_number)
--     uq_..._offer_action     (seller_offer_id, seller_offer_version, communication_type)
--
--   With lck_v2 alone, an SMS touch and an email touch on the same campaign
--   target produce two DIFFERENT logical keys -- and the second insert then dies
--   on uq_..._campaign_touch. The collision simply moves from the hash to the
--   index, and the email is still refused.
--
--   So each index gains channel, for exactly the reason the key did: the same
--   domain action on two transports is two communications. What each index still
--   guarantees is the thing it was written to guarantee -- one communication per
--   anchor PER CHANNEL -- which is what "this touch must happen once" always
--   meant once more than one transport exists.
--
--   These are indexes, not data. Dropping and recreating them inside this
--   transaction rewrites no rows and loses no history.

DROP INDEX IF EXISTS public.uq_seller_logical_communications_decision_action;
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_decision_action
  ON public.seller_logical_communications (decision_id, communication_type, channel)
  WHERE decision_id IS NOT NULL;

DROP INDEX IF EXISTS public.uq_seller_logical_communications_campaign_touch;
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_campaign_touch
  ON public.seller_logical_communications (campaign_target_id, touch_number, channel)
  WHERE campaign_target_id IS NOT NULL AND touch_number IS NOT NULL;

DROP INDEX IF EXISTS public.uq_seller_logical_communications_offer_action;
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_offer_action
  ON public.seller_logical_communications (seller_offer_id, seller_offer_version, communication_type, channel)
  WHERE seller_offer_id IS NOT NULL;

COMMENT ON INDEX public.uq_seller_logical_communications_campaign_touch IS
  'One communication per (campaign target, touch) PER CHANNEL. Without channel this index re-created the cross-channel collision that lck_v2 removed from the key.';

-- ── 2. the get-or-create RPC learns channel and to_email ────────────────────
--
-- Two changes, and nothing else:
--   * channel and to_email are written on INSERT.
--   * channel joins the identity-conflict guard.
--
-- The conflict guard matters even though channel is already inside the hash.
-- That guard exists precisely for the case where the hash is WRONG -- an lck
-- construction bug or a genuine SHA-256 collision -- and its whole job is to
-- refuse rather than hand back a row that means something else. A guard that
-- omitted channel would let exactly one class of collision through: two
-- channels' actions meeting on one key, which is the failure this release is
-- about.

CREATE OR REPLACE FUNCTION public.seller_logical_communication_get_or_create(
  p_logical_key          text,
  p_logical_key_version  text,
  p_communication_type   text,
  p_lineage              jsonb DEFAULT '{}'::jsonb,
  p_policy               jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_row      public.seller_logical_communications;
  v_existing public.seller_logical_communications;
  v_conflict text[] := ARRAY[]::text[];
BEGIN
  -- ON CONFLICT DO UPDATE (not DO NOTHING) so the LOSER of a race also receives
  -- the canonical row in its own transaction. With DO NOTHING the loser gets
  -- zero rows and would have to re-SELECT, reintroducing the very race this
  -- function exists to remove.
  --
  -- The update is deliberately NON-SEMANTIC: it advances last_observed_at and
  -- observation_count only. updated_at is untouched, because a duplicate
  -- execution or replay is not a state transition and must not reset stale
  -- timers, reconciliation clocks or activity ordering.
  --
  -- The WHERE clause is the identity-conflict guard. If the stored lineage does
  -- not match what this caller believes, NO row is updated or returned, and we
  -- fall through to raise a deterministic conflict rather than silently
  -- handing back a row that means something else. That protects us if lck_v2
  -- construction ever has a bug or a genuine hash collision.
  INSERT INTO public.seller_logical_communications (
    logical_key, logical_key_version, communication_type,
    channel, thread_key, to_phone_number, to_email,
    property_id, opportunity_id, master_owner_id,
    decision_id, message_event_id, campaign_id, campaign_target_id, touch_number,
    follow_up_id, referral_id, source_event_id,
    seller_offer_id, seller_offer_version, operator_action_id,
    canary_run_id, canary_leg, supersedes_communication_id,
    logical_key_policy_version, retry_policy_version, outcome_policy_version
  ) VALUES (
    p_logical_key, p_logical_key_version, p_communication_type,
    -- No COALESCE to 'sms'. An absent channel violates NOT NULL and the caller
    -- hears about it, which is the correct outcome for a caller that cannot say
    -- how its message travels.
    NULLIF(p_lineage->>'channel','')             , NULLIF(p_lineage->>'thread_key',''),
    NULLIF(p_lineage->>'to_phone_number','')     , NULLIF(p_lineage->>'to_email',''),
    NULLIF(p_lineage->>'property_id','')         , (NULLIF(p_lineage->>'opportunity_id',''))::uuid,
    NULLIF(p_lineage->>'master_owner_id',''),
    NULLIF(p_lineage->>'decision_id','')         , NULLIF(p_lineage->>'message_event_id',''),
    (NULLIF(p_lineage->>'campaign_id',''))::uuid , (NULLIF(p_lineage->>'campaign_target_id',''))::uuid,
    (NULLIF(p_lineage->>'touch_number',''))::integer,
    (NULLIF(p_lineage->>'follow_up_id',''))::uuid, NULLIF(p_lineage->>'referral_id',''),
    NULLIF(p_lineage->>'source_event_id',''),
    NULLIF(p_lineage->>'seller_offer_id','')     , (NULLIF(p_lineage->>'seller_offer_version',''))::integer,
    NULLIF(p_lineage->>'operator_action_id',''),
    NULLIF(p_lineage->>'canary_run_id','')       , NULLIF(p_lineage->>'canary_leg',''),
    (NULLIF(p_lineage->>'supersedes_communication_id',''))::uuid,
    NULLIF(p_policy->>'logical_key_policy_version',''),
    NULLIF(p_policy->>'retry_policy_version',''),
    NULLIF(p_policy->>'outcome_policy_version','')
  )
  ON CONFLICT (logical_key) DO UPDATE
     SET last_observed_at  = now(),
         observation_count = public.seller_logical_communications.observation_count + 1
   WHERE public.seller_logical_communications.communication_type   IS NOT DISTINCT FROM EXCLUDED.communication_type
     AND public.seller_logical_communications.channel              IS NOT DISTINCT FROM EXCLUDED.channel
     AND public.seller_logical_communications.decision_id          IS NOT DISTINCT FROM EXCLUDED.decision_id
     AND public.seller_logical_communications.message_event_id     IS NOT DISTINCT FROM EXCLUDED.message_event_id
     AND public.seller_logical_communications.campaign_target_id   IS NOT DISTINCT FROM EXCLUDED.campaign_target_id
     AND public.seller_logical_communications.touch_number         IS NOT DISTINCT FROM EXCLUDED.touch_number
     AND public.seller_logical_communications.follow_up_id         IS NOT DISTINCT FROM EXCLUDED.follow_up_id
     AND public.seller_logical_communications.referral_id          IS NOT DISTINCT FROM EXCLUDED.referral_id
     AND public.seller_logical_communications.source_event_id      IS NOT DISTINCT FROM EXCLUDED.source_event_id
     AND public.seller_logical_communications.seller_offer_id      IS NOT DISTINCT FROM EXCLUDED.seller_offer_id
     AND public.seller_logical_communications.seller_offer_version IS NOT DISTINCT FROM EXCLUDED.seller_offer_version
     AND public.seller_logical_communications.operator_action_id   IS NOT DISTINCT FROM EXCLUDED.operator_action_id
     AND public.seller_logical_communications.canary_run_id        IS NOT DISTINCT FROM EXCLUDED.canary_run_id
     AND public.seller_logical_communications.canary_leg           IS NOT DISTINCT FROM EXCLUDED.canary_leg
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reused', v_row.observation_count > 1,
      'logical_communication_id', v_row.id,
      'logical_key', v_row.logical_key,
      'channel', v_row.channel,
      'state', v_row.state,
      'delivery_possibility', v_row.delivery_possibility,
      'retry_authority', v_row.retry_authority,
      'updated_at', v_row.updated_at,
      'last_observed_at', v_row.last_observed_at,
      'observation_count', v_row.observation_count
    );
  END IF;

  -- The key exists but the lineage disagrees. Do NOT return the stored row: the
  -- caller would proceed believing it owns a communication that actually
  -- represents a different business action.
  SELECT * INTO v_existing
  FROM public.seller_logical_communications
  WHERE logical_key = p_logical_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'logical_communication_upsert_failed');
  END IF;

  IF v_existing.communication_type   IS DISTINCT FROM p_communication_type                                  THEN v_conflict := array_append(v_conflict, 'communication_type'); END IF;
  IF v_existing.channel              IS DISTINCT FROM NULLIF(p_lineage->>'channel','')                      THEN v_conflict := array_append(v_conflict, 'channel'); END IF;
  IF v_existing.decision_id          IS DISTINCT FROM NULLIF(p_lineage->>'decision_id','')                  THEN v_conflict := array_append(v_conflict, 'decision_id'); END IF;
  IF v_existing.message_event_id     IS DISTINCT FROM NULLIF(p_lineage->>'message_event_id','')             THEN v_conflict := array_append(v_conflict, 'message_event_id'); END IF;
  IF v_existing.campaign_target_id   IS DISTINCT FROM (NULLIF(p_lineage->>'campaign_target_id',''))::uuid   THEN v_conflict := array_append(v_conflict, 'campaign_target_id'); END IF;
  IF v_existing.touch_number         IS DISTINCT FROM (NULLIF(p_lineage->>'touch_number',''))::integer      THEN v_conflict := array_append(v_conflict, 'touch_number'); END IF;
  IF v_existing.follow_up_id         IS DISTINCT FROM (NULLIF(p_lineage->>'follow_up_id',''))::uuid         THEN v_conflict := array_append(v_conflict, 'follow_up_id'); END IF;
  IF v_existing.referral_id          IS DISTINCT FROM NULLIF(p_lineage->>'referral_id','')                  THEN v_conflict := array_append(v_conflict, 'referral_id'); END IF;
  IF v_existing.source_event_id      IS DISTINCT FROM NULLIF(p_lineage->>'source_event_id','')              THEN v_conflict := array_append(v_conflict, 'source_event_id'); END IF;
  IF v_existing.seller_offer_id      IS DISTINCT FROM NULLIF(p_lineage->>'seller_offer_id','')              THEN v_conflict := array_append(v_conflict, 'seller_offer_id'); END IF;
  IF v_existing.seller_offer_version IS DISTINCT FROM (NULLIF(p_lineage->>'seller_offer_version',''))::integer THEN v_conflict := array_append(v_conflict, 'seller_offer_version'); END IF;
  IF v_existing.operator_action_id   IS DISTINCT FROM NULLIF(p_lineage->>'operator_action_id','')           THEN v_conflict := array_append(v_conflict, 'operator_action_id'); END IF;
  IF v_existing.canary_run_id        IS DISTINCT FROM NULLIF(p_lineage->>'canary_run_id','')                THEN v_conflict := array_append(v_conflict, 'canary_run_id'); END IF;
  IF v_existing.canary_leg           IS DISTINCT FROM NULLIF(p_lineage->>'canary_leg','')                   THEN v_conflict := array_append(v_conflict, 'canary_leg'); END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'logical_communication_identity_conflict',
    'logical_key', p_logical_key,
    'existing_logical_communication_id', v_existing.id,
    'conflicting_fields', to_jsonb(v_conflict)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) TO service_role;

-- ── 3. email suppression: the list that did not exist ───────────────────────
--
-- Until now there was NO durable place for an email opt-out, hard bounce or
-- spam complaint to land. lib/email/email-suppression.js and
-- domain/email/email-service.js both read and write a table named
-- email_suppression that has never existed in this database, so every
-- suppression check returned "not suppressed" via its error path and every
-- recorded opt-out was discarded. With sending disabled that was inert; it
-- would become a legal exposure the moment it was not.
--
-- Keyed on the NORMALIZED address so that Bob@Example.COM and bob@example.com
-- cannot be suppressed independently of one another.

CREATE TABLE IF NOT EXISTS public.email_suppression (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address       text        NOT NULL,
  reason              text        NOT NULL,
  source              text,
  is_active           boolean     NOT NULL DEFAULT true,
  -- Suppression is normally permanent. expires_at exists for the one honest
  -- exception, a soft bounce, and is NULL for everything else.
  expires_at          timestamptz,
  provider            text,
  provider_message_id text,
  event_key           text,
  master_owner_id     text,
  raw_payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  first_event_at      timestamptz NOT NULL DEFAULT now(),
  last_event_at       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_suppression_reason_valid') THEN
    ALTER TABLE public.email_suppression
      ADD CONSTRAINT email_suppression_reason_valid
      CHECK (reason IN (
        'unsubscribed',      -- the seller asked us to stop
        'hard_bounce',       -- the address does not exist
        'soft_bounce',       -- transient; the only reason that may expire
        'complaint',         -- marked as spam
        'blocked',           -- provider or recipient server refused
        'invalid_address',   -- failed normalization or provider validation
        'manual'             -- an operator suppressed it
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_suppression_expiry_only_for_soft_bounce') THEN
    ALTER TABLE public.email_suppression
      ADD CONSTRAINT email_suppression_expiry_only_for_soft_bounce
      CHECK (expires_at IS NULL OR reason = 'soft_bounce');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS email_suppression_address_uq
  ON public.email_suppression (email_address);

CREATE INDEX IF NOT EXISTS email_suppression_active_idx
  ON public.email_suppression (email_address)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS email_suppression_reason_idx
  ON public.email_suppression (reason);

COMMENT ON TABLE public.email_suppression IS
  'Canonical email suppression list. email_address is the NORMALIZED form produced by domain/email/normalize-email-address.js; suppressing a raw address would leave its normalized twin sendable.';

-- ── 4. email_queue gains the lineage the canonical seam requires ────────────
--
-- email_queue already mirrors send_queue's mechanics (queue_key, lock_token,
-- retry_count, next_retry_at). What it lacked is the lineage that lets a row
-- NAME the domain action it schedules. Without it, an email queue row can only
-- say "somebody wanted an email sent", which under §11 is not permission to
-- send -- exactly as it is not for an SMS row.
--
-- These columns are nullable because rows are bound as they are created by the
-- feeders that will follow in EMAIL-2. Nullable is not permissive here: a row
-- that cannot derive an action is REFUSED at dispatch, not defaulted.

ALTER TABLE public.email_queue
  ADD COLUMN IF NOT EXISTS logical_communication_id uuid
    REFERENCES public.seller_logical_communications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel            text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS dedupe_key         text,
  ADD COLUMN IF NOT EXISTS use_case           text,
  ADD COLUMN IF NOT EXISTS thread_key         text,
  ADD COLUMN IF NOT EXISTS campaign_id        uuid,
  ADD COLUMN IF NOT EXISTS campaign_target_id uuid,
  ADD COLUMN IF NOT EXISTS touch_number       integer,
  ADD COLUMN IF NOT EXISTS decision_id        text,
  ADD COLUMN IF NOT EXISTS follow_up_id       uuid,
  ADD COLUMN IF NOT EXISTS message_event_id   text,
  ADD COLUMN IF NOT EXISTS operator_action_id text,
  ADD COLUMN IF NOT EXISTS seller_offer_id    text,
  ADD COLUMN IF NOT EXISTS seller_offer_version integer,
  ADD COLUMN IF NOT EXISTS email_sender_id    uuid REFERENCES public.email_senders(id),
  ADD COLUMN IF NOT EXISTS subject_rendered   text,
  ADD COLUMN IF NOT EXISTS text_body          text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_queue_channel_is_email') THEN
    ALTER TABLE public.email_queue
      ADD CONSTRAINT email_queue_channel_is_email CHECK (channel = 'email');
  END IF;
END $$;

-- Partial unique: a dedupe_key means something only while a row is live. Two
-- historical rows may legitimately share one; two QUEUED rows may not.
CREATE UNIQUE INDEX IF NOT EXISTS email_queue_dedupe_key_inflight_uq
  ON public.email_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND queue_status IN ('queued', 'claimed', 'sending');

CREATE INDEX IF NOT EXISTS email_queue_logical_communication_idx
  ON public.email_queue (logical_communication_id)
  WHERE logical_communication_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_queue_status_scheduled_idx
  ON public.email_queue (queue_status, scheduled_for);

CREATE INDEX IF NOT EXISTS email_queue_to_email_idx
  ON public.email_queue (to_email);

COMMENT ON COLUMN public.email_queue.logical_communication_id IS
  'The §11 communication this row schedules. A row that is neither bound nor able to derive an action is refused at dispatch, never sent on the strength of queue_status alone.';

-- ── 5. contact_outreach_state gains the email identity it never had ─────────
--
-- This table is already the cross-channel contact governor: it holds
-- to_phone_number AND to_email, last_sms_at AND last_email_at, and a shared
-- next_allowed_any_contact_at. What it lacked was a way to address a row BY
-- email. The only unique key is (podio_master_owner_id, to_phone_number), so an
-- email path had nothing to upsert against and could not record that a seller
-- had been contacted -- which meant the next cooldown check found nothing and
-- allowed a second contact.
--
-- The index deliberately mirrors the phone one, including its NULL semantics:
-- NULLs are distinct in a btree unique index, so rows with no to_email are
-- unconstrained exactly as rows with no to_phone_number already are. It is NOT
-- partial, because PostgREST issues ON CONFLICT without a predicate and cannot
-- infer a partial index.

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_outreach_state_owner_email
  ON public.contact_outreach_state (podio_master_owner_id, to_email);

CREATE INDEX IF NOT EXISTS contact_outreach_state_last_outbound_idx
  ON public.contact_outreach_state (last_outbound_at DESC NULLS LAST);

COMMENT ON INDEX public.uq_contact_outreach_state_owner_email IS
  'Email twin of uq_contact_outreach_state_owner_phone. Without it the email path had no upsert target and silently recorded no outreach, defeating every downstream cooldown.';

-- ── 6. RLS: service_role only, matching every other seller-communication table ─

ALTER TABLE public.email_suppression ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'email_suppression'
       AND policyname = 'email_suppression_service_role_all'
  ) THEN
    CREATE POLICY email_suppression_service_role_all
      ON public.email_suppression
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.email_suppression FROM PUBLIC, anon, authenticated;
GRANT ALL  ON TABLE public.email_suppression TO service_role;

COMMIT;
