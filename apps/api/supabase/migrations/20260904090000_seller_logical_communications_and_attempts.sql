-- ─── seller logical communications + attempt ledger (§11 Slice 1) ───────────
--
-- ONE DOMAIN ACTION -> ONE LOGICAL COMMUNICATION -> MANY TRANSPORT ATTEMPTS.
--
-- WHY THIS EXISTS.
--   send_queue schedules TRANSPORT. It is not, and never was, an identity
--   authority. buildSendQueueInsertPayload does:
--       queue_key:  clean(normalized.queue_key) || crypto.randomUUID()
--       dedupe_key: clean(... || normalized.queue_key) || null
--   so a caller supplying neither key gets a RANDOM queue_key and dedupe_key
--   inherits it. UNIQUE(queue_key) and the partial UNIQUE(dedupe_key) are then
--   satisfied by randomness rather than by identity, which makes them vacuous
--   for exactly the callers that most need them. Several live sources do this.
--
--   Other candidate keys move when the MESSAGE moves: campaign launch hashes
--   templateId + scheduledIso, the canonical writer embeds template_id, and the
--   legacy Podio queue_id is a hash of the rendered body. Rotating a template
--   would mint a new identity and authorise a second seller message.
--
-- THE TWO FACTS THIS MODEL KEEPS SEPARATE.
--   delivery_possibility  "could the seller have received this?"
--   retry_authority       "may another provider attempt happen automatically?"
--   These are NOT the same question. A provider rejecting an invalid phone
--   number proves the seller received nothing (definitely_not_sent) while still
--   granting no retry (terminal). Collapsing them is how duplicates or silent
--   dead-ends get built.
--
-- Additive and forward-safe: CREATE TABLE IF NOT EXISTS, no backfill, no change
-- to any existing table, no historical row touched. Service-role only, matching
-- seller_offers / seller_automation_decisions.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LOGICAL COMMUNICATIONS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.seller_logical_communications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE identity authority. Deterministic from durable business anchors only:
  -- never a body, template, timestamp, queue row or provider id. UNIQUE is
  -- deliberately TOTAL (not partial, not lifecycle-scoped) because a second row
  -- for the same action is the exact failure this table prevents.
  logical_key           text NOT NULL,
  logical_key_version   text NOT NULL,
  communication_type    text NOT NULL,

  -- ── canonical routing/recipient identity ────────────────────────────────
  thread_key            text,
  to_phone_number       text,
  property_id           text,
  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,

  -- ── source lineage. Which durable entity authorised this communication? ──
  decision_id           text,
  message_event_id      text,
  campaign_id           uuid,
  campaign_target_id    uuid,
  touch_number          integer,
  follow_up_id          uuid,
  referral_id           text,
  source_event_id       text,
  seller_offer_id       text,
  seller_offer_version  integer,
  operator_action_id    text,
  canary_run_id         text,
  canary_leg            text,

  -- A manual operator action may deliberately FOLLOW an ambiguous one. It is a
  -- new action, never a silent retry, and the lineage says so out loud.
  supersedes_communication_id uuid REFERENCES public.seller_logical_communications(id) ON DELETE SET NULL,

  -- ── outcome model: three independent axes ───────────────────────────────
  state                 text NOT NULL DEFAULT 'created',
  delivery_possibility  text NOT NULL DEFAULT 'definitely_not_sent',
  retry_authority       text NOT NULL DEFAULT 'retry_allowed',
  retry_after_at        timestamptz,

  current_attempt_id    uuid,
  attempt_count         integer NOT NULL DEFAULT 0,

  -- ── policy lineage for deterministic replay ─────────────────────────────
  logical_key_policy_version text,
  retry_policy_version       text,
  outcome_policy_version     text,

  no_send_reason        text,
  last_failure_class    text,

  created_at            timestamptz NOT NULL DEFAULT now(),

  -- SEMANTIC timestamp. Moves ONLY on a real state transition. Stale timers,
  -- reconciliation clocks and operator activity ordering all read this, so a
  -- duplicate worker asking "does this action already exist?" must never move
  -- it -- a replay is an observation, not a business event.
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- NON-SEMANTIC. Bumped by duplicate get-or-create so replay pressure is still
  -- observable, without contaminating updated_at.
  last_observed_at      timestamptz NOT NULL DEFAULT now(),
  observation_count     integer NOT NULL DEFAULT 1,

  -- The identity must look like something the canonical builder produced. A
  -- hand-made or legacy identifier must never masquerade as a logical key.
  CONSTRAINT seller_logical_communications_key_shape
    CHECK (logical_key ~ '^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$'),

  CONSTRAINT seller_logical_communications_state_valid CHECK (state IN (
    'created', 'ready', 'claimed', 'provider_request_started', 'provider_accepted',
    'ambiguous_provider_outcome', 'failed_retry_allowed', 'failed_terminal',
    'reconciliation_pending', 'delivered', 'suppressed', 'no_send', 'cancelled'
  )),

  CONSTRAINT seller_logical_communications_delivery_possibility_valid
    CHECK (delivery_possibility IN (
      'definitely_not_sent', 'may_have_been_sent', 'provider_accepted', 'delivered', 'unknown'
    )),

  CONSTRAINT seller_logical_communications_retry_authority_valid
    CHECK (retry_authority IN (
      'retry_allowed', 'retry_after', 'retry_denied', 'operator_hold', 'terminal'
    )),

  -- ── SOURCE LINEAGE IS ENFORCED IN THE DATABASE, not only in JavaScript ──
  -- A communication that cannot name the durable entity authorising it has no
  -- business existing, because nothing could later prove it was legitimate.
  CONSTRAINT seller_logical_communications_lineage_required CHECK (
    CASE communication_type
      WHEN 'autonomous_reply'      THEN decision_id IS NOT NULL
      WHEN 'clarification_reply'   THEN decision_id IS NOT NULL
      WHEN 'negotiation_reply'     THEN decision_id IS NOT NULL
      WHEN 'monetary_offer'        THEN seller_offer_id IS NOT NULL AND seller_offer_version IS NOT NULL
      WHEN 'campaign_touch'        THEN campaign_target_id IS NOT NULL AND touch_number IS NOT NULL
      WHEN 'follow_up'             THEN follow_up_id IS NOT NULL
      WHEN 'referral_outreach'     THEN referral_id IS NOT NULL AND source_event_id IS NOT NULL
      WHEN 'unknown_inbound_reply' THEN message_event_id IS NOT NULL
      WHEN 'manual_operator_send'  THEN operator_action_id IS NOT NULL
      WHEN 'internal_canary'       THEN canary_run_id IS NOT NULL AND canary_leg IS NOT NULL
      ELSE false
    END
  ),

  -- An ambiguous outcome may never simultaneously advertise retry authority.
  -- Belt and braces with the application state machine: if the two ever
  -- disagree, the database refuses the write rather than allowing a resend.
  CONSTRAINT seller_logical_communications_ambiguous_is_absorbing CHECK (
    NOT (
      (state = 'ambiguous_provider_outcome' OR delivery_possibility = 'may_have_been_sent')
      AND retry_authority IN ('retry_allowed', 'retry_after')
    )
  ),

  -- Likewise for outcomes that are already resolved or forbidden.
  CONSTRAINT seller_logical_communications_terminal_has_no_retry CHECK (
    NOT (
      state IN ('delivered', 'no_send', 'suppressed', 'cancelled', 'failed_terminal')
      AND retry_authority IN ('retry_allowed', 'retry_after')
    )
  )
);

-- THE identity constraint. Total, unconditional.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_logical_key
  ON public.seller_logical_communications (logical_key);

-- Lineage lookups used by invariants and reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_decision_action
  ON public.seller_logical_communications (decision_id, communication_type)
  WHERE decision_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_campaign_touch
  ON public.seller_logical_communications (campaign_target_id, touch_number)
  WHERE campaign_target_id IS NOT NULL AND touch_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_offer_action
  ON public.seller_logical_communications (seller_offer_id, seller_offer_version, communication_type)
  WHERE seller_offer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_logical_communications_state
  ON public.seller_logical_communications (state, retry_authority);

CREATE INDEX IF NOT EXISTS idx_seller_logical_communications_ambiguous
  ON public.seller_logical_communications (delivery_possibility)
  WHERE delivery_possibility = 'may_have_been_sent';

CREATE INDEX IF NOT EXISTS idx_seller_logical_communications_recipient
  ON public.seller_logical_communications (to_phone_number, created_at DESC)
  WHERE to_phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_logical_communications_thread
  ON public.seller_logical_communications (thread_key, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ATTEMPT LEDGER
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.seller_communication_attempts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_communication_id    uuid NOT NULL
    REFERENCES public.seller_logical_communications(id) ON DELETE RESTRICT,
  attempt_number              integer NOT NULL CHECK (attempt_number >= 1),

  provider                    text NOT NULL DEFAULT 'textgrid',
  queue_row_id                text,
  claim_token                 text,

  -- ── THE TIMELINE. This is the evidence that distinguishes "we crashed
  --    before the request" from "we crashed after it may have been sent".
  --    provider_request_started_at is persisted BEFORE the network call, so a
  --    crash in between leaves a conservative ambiguous attempt rather than a
  --    row that looks safe to retry.
  claimed_at                  timestamptz,
  provider_request_started_at timestamptz,
  provider_response_received_at timestamptz,
  completed_at                timestamptz,

  provider_message_id         text,
  transport_phase             text,
  outcome_class               text,
  delivery_possibility        text,
  retry_authority             text,
  retry_after_at              timestamptz,

  http_status                 integer,
  provider_status             text,
  failure_class               text,
  provider_error_code         text,

  -- Evidence of WHAT was transmitted. Deliberately NOT identity.
  request_fingerprint         text,
  response_fingerprint        text,

  retry_policy_version        text,
  outcome_policy_version      text,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT seller_communication_attempts_delivery_possibility_valid
    CHECK (delivery_possibility IS NULL OR delivery_possibility IN (
      'definitely_not_sent', 'may_have_been_sent', 'provider_accepted', 'delivered', 'unknown'
    )),
  CONSTRAINT seller_communication_attempts_retry_authority_valid
    CHECK (retry_authority IS NULL OR retry_authority IN (
      'retry_allowed', 'retry_after', 'retry_denied', 'operator_hold', 'terminal'
    )),

  -- A response cannot precede the request that produced it.
  CONSTRAINT seller_communication_attempts_timeline_ordered CHECK (
    provider_response_received_at IS NULL
    OR provider_request_started_at IS NULL
    OR provider_response_received_at >= provider_request_started_at
  ),

  -- Holding a provider SID means the request certainly went out.
  CONSTRAINT seller_communication_attempts_sid_implies_request CHECK (
    provider_message_id IS NULL OR provider_request_started_at IS NOT NULL
  )
);

-- Two workers cannot both own attempt #2.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_communication_attempts_number
  ON public.seller_communication_attempts (logical_communication_id, attempt_number);

-- One provider message belongs to exactly one attempt, so a delivery receipt
-- can never be credited to two different seller communications.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_communication_attempts_provider_message_id
  ON public.seller_communication_attempts (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_communication_attempts_logical
  ON public.seller_communication_attempts (logical_communication_id, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_seller_communication_attempts_queue_row
  ON public.seller_communication_attempts (queue_row_id)
  WHERE queue_row_id IS NOT NULL;

-- Attempts whose network may have started but which never completed: the
-- reconciliation work-list for Slice 2.
CREATE INDEX IF NOT EXISTS idx_seller_communication_attempts_unresolved
  ON public.seller_communication_attempts (provider_request_started_at)
  WHERE completed_at IS NULL AND provider_request_started_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ATTEMPT EVIDENCE IS APPEND-ONLY / MONOTONIC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Attempts are evidence. History is never rewritten to look cleaner.
--
-- IMMUTABLE once written: identity and transport facts.
--   id, logical_communication_id, attempt_number, provider, created_at,
--   claimed_at, provider_request_started_at, provider_message_id,
--   request_fingerprint
--
-- MONOTONIC (NULL -> value once, never value -> different value):
--   provider_response_received_at, completed_at, outcome_class,
--   delivery_possibility, retry_authority, http_status, provider_status,
--   failure_class, provider_error_code, response_fingerprint, transport_phase
--
-- FORBIDDEN entirely: DELETE.

CREATE OR REPLACE FUNCTION public.enforce_seller_communication_attempt_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seller_communication_attempts is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Identity and transport facts can never change once recorded.
  IF NEW.logical_communication_id IS DISTINCT FROM OLD.logical_communication_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'seller_communication_attempts: attempt identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A recorded transport fact may be SET once, never rewritten. This is what
  -- stops a later attempt (or a tidy-up) from erasing the evidence that a
  -- request may already have reached the provider.
  IF OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'seller_communication_attempts: claimed_at is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.provider_request_started_at IS NOT NULL
     AND NEW.provider_request_started_at IS DISTINCT FROM OLD.provider_request_started_at THEN
    RAISE EXCEPTION 'seller_communication_attempts: provider_request_started_at is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.provider_message_id IS NOT NULL
     AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'seller_communication_attempts: provider_message_id is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.request_fingerprint IS NOT NULL
     AND NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
    RAISE EXCEPTION 'seller_communication_attempts: request_fingerprint is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'seller_communication_attempts: completed_at is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seller_communication_attempts_immutable
  ON public.seller_communication_attempts;
CREATE TRIGGER trg_seller_communication_attempts_immutable
  BEFORE UPDATE OR DELETE ON public.seller_communication_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_seller_communication_attempt_immutability();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ATOMIC GET-OR-CREATE  (no SELECT-then-INSERT race)
-- ═══════════════════════════════════════════════════════════════════════════

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
AS $$
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
  -- handing back a row that means something else. That protects us if lck_v1
  -- construction ever has a bug or a genuine hash collision.
  INSERT INTO public.seller_logical_communications (
    logical_key, logical_key_version, communication_type,
    thread_key, to_phone_number, property_id, opportunity_id, master_owner_id,
    decision_id, message_event_id, campaign_id, campaign_target_id, touch_number,
    follow_up_id, referral_id, source_event_id,
    seller_offer_id, seller_offer_version, operator_action_id,
    canary_run_id, canary_leg, supersedes_communication_id,
    logical_key_policy_version, retry_policy_version, outcome_policy_version
  ) VALUES (
    p_logical_key, p_logical_key_version, p_communication_type,
    NULLIF(p_lineage->>'thread_key','')          , NULLIF(p_lineage->>'to_phone_number',''),
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

  IF v_existing.communication_type   IS DISTINCT FROM p_communication_type                                  THEN v_conflict := v_conflict || 'communication_type'; END IF;
  IF v_existing.decision_id          IS DISTINCT FROM NULLIF(p_lineage->>'decision_id','')                  THEN v_conflict := v_conflict || 'decision_id'; END IF;
  IF v_existing.message_event_id     IS DISTINCT FROM NULLIF(p_lineage->>'message_event_id','')             THEN v_conflict := v_conflict || 'message_event_id'; END IF;
  IF v_existing.campaign_target_id   IS DISTINCT FROM (NULLIF(p_lineage->>'campaign_target_id',''))::uuid   THEN v_conflict := v_conflict || 'campaign_target_id'; END IF;
  IF v_existing.touch_number         IS DISTINCT FROM (NULLIF(p_lineage->>'touch_number',''))::integer      THEN v_conflict := v_conflict || 'touch_number'; END IF;
  IF v_existing.follow_up_id         IS DISTINCT FROM (NULLIF(p_lineage->>'follow_up_id',''))::uuid         THEN v_conflict := v_conflict || 'follow_up_id'; END IF;
  IF v_existing.referral_id          IS DISTINCT FROM NULLIF(p_lineage->>'referral_id','')                  THEN v_conflict := v_conflict || 'referral_id'; END IF;
  IF v_existing.source_event_id      IS DISTINCT FROM NULLIF(p_lineage->>'source_event_id','')              THEN v_conflict := v_conflict || 'source_event_id'; END IF;
  IF v_existing.seller_offer_id      IS DISTINCT FROM NULLIF(p_lineage->>'seller_offer_id','')              THEN v_conflict := v_conflict || 'seller_offer_id'; END IF;
  IF v_existing.seller_offer_version IS DISTINCT FROM (NULLIF(p_lineage->>'seller_offer_version',''))::integer THEN v_conflict := v_conflict || 'seller_offer_version'; END IF;
  IF v_existing.operator_action_id   IS DISTINCT FROM NULLIF(p_lineage->>'operator_action_id','')           THEN v_conflict := v_conflict || 'operator_action_id'; END IF;
  IF v_existing.canary_run_id        IS DISTINCT FROM NULLIF(p_lineage->>'canary_run_id','')                THEN v_conflict := v_conflict || 'canary_run_id'; END IF;
  IF v_existing.canary_leg           IS DISTINCT FROM NULLIF(p_lineage->>'canary_leg','')                   THEN v_conflict := v_conflict || 'canary_leg'; END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'logical_communication_identity_conflict',
    'logical_key', p_logical_key,
    'existing_logical_communication_id', v_existing.id,
    'conflicting_fields', to_jsonb(v_conflict)
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ATOMIC ATTEMPT ALLOCATION  (no MAX()+1 race)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.seller_communication_attempt_allocate(
  p_logical_communication_id uuid,
  p_provider                 text DEFAULT 'textgrid',
  p_queue_row_id             text DEFAULT NULL,
  p_claim_token              text DEFAULT NULL,
  p_policy                   jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_comm    public.seller_logical_communications;
  v_next    integer;
  v_attempt public.seller_communication_attempts;
BEGIN
  -- Serialise allocation on the PARENT row. Two concurrent callers queue here,
  -- so the "next attempt number" is computed under an exclusive lock rather
  -- than by an optimistic MAX()+1 that both workers could read identically.
  SELECT * INTO v_comm
  FROM public.seller_logical_communications
  WHERE id = p_logical_communication_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'logical_communication_not_found');
  END IF;

  -- AMBIGUITY IS ABSORBING. No amount of retry budget, lease expiry or operator
  -- impatience may allocate another provider attempt for a communication that
  -- may already have reached the seller. Enforced here, in the database, so it
  -- holds even if a caller forgets to ask.
  IF v_comm.delivery_possibility = 'may_have_been_sent'
     OR v_comm.state = 'ambiguous_provider_outcome' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'ambiguous_outcome_absorbing',
      'logical_communication_id', v_comm.id, 'state', v_comm.state
    );
  END IF;

  IF v_comm.state IN ('delivered', 'provider_accepted', 'no_send', 'suppressed',
                      'cancelled', 'failed_terminal') THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'state_forbids_attempt',
      'logical_communication_id', v_comm.id, 'state', v_comm.state
    );
  END IF;

  IF v_comm.retry_authority IN ('retry_denied', 'operator_hold', 'terminal') THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'retry_authority_denies',
      'logical_communication_id', v_comm.id, 'retry_authority', v_comm.retry_authority
    );
  END IF;

  IF v_comm.retry_authority = 'retry_after'
     AND v_comm.retry_after_at IS NOT NULL
     AND v_comm.retry_after_at > now() THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'retry_after_not_elapsed',
      'retry_after_at', v_comm.retry_after_at
    );
  END IF;

  -- ONE ATTEMPT IN FLIGHT AT A TIME.
  --
  -- Without this the state guards above are not enough. Allocation sets the
  -- parent to 'claimed', which is not a forbidden state (it must not be: a
  -- claimed communication is exactly the one that is allowed to proceed). So a
  -- second worker queued on the FOR UPDATE above would wake, see 'claimed',
  -- still read delivery_possibility = 'definitely_not_sent' and
  -- retry_authority = 'retry_allowed' -- because the first worker has not
  -- reached the provider yet -- and allocate attempt 2. Two workers, one domain
  -- action, two seller messages. That is the original duplicate-send defect
  -- reproduced inside the machinery built to prevent it.
  --
  -- An attempt is unresolved until completed_at is set. While one is unresolved
  -- no sibling may be allocated, whether it is mid-flight or orphaned by a
  -- crash. A crashed attempt therefore BLOCKS rather than silently yielding to
  -- a replacement: resolving it requires recording an outcome through the
  -- transition authority, which is a decision about what the seller received,
  -- not a lease timer. Fail closed is the whole point.
  IF EXISTS (
    SELECT 1 FROM public.seller_communication_attempts
    WHERE logical_communication_id = p_logical_communication_id
      AND completed_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'attempt_already_in_flight',
      'logical_communication_id', v_comm.id,
      'current_attempt_id', v_comm.current_attempt_id
    );
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next
  FROM public.seller_communication_attempts
  WHERE logical_communication_id = p_logical_communication_id;

  INSERT INTO public.seller_communication_attempts (
    logical_communication_id, attempt_number, provider, queue_row_id,
    claim_token, claimed_at, retry_policy_version, outcome_policy_version
  ) VALUES (
    p_logical_communication_id, v_next, COALESCE(NULLIF(p_provider,''), 'textgrid'),
    NULLIF(p_queue_row_id,''), NULLIF(p_claim_token,''), now(),
    NULLIF(p_policy->>'retry_policy_version',''),
    NULLIF(p_policy->>'outcome_policy_version','')
  )
  RETURNING * INTO v_attempt;

  UPDATE public.seller_logical_communications
     SET state = 'claimed',
         current_attempt_id = v_attempt.id,
         attempt_count = v_next,
         updated_at = now()
   WHERE id = p_logical_communication_id;

  RETURN jsonb_build_object(
    'ok', true,
    'logical_communication_id', v_comm.id,
    'attempt_id', v_attempt.id,
    'attempt_number', v_attempt.attempt_number,
    'owns_execution_authority', true
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. SERVICE-ROLE ONLY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.seller_logical_communications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_logical_communications FROM anon, authenticated;

ALTER TABLE public.seller_communication_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_communication_attempts FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seller_communication_attempt_allocate(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.seller_communication_attempt_allocate(uuid, text, text, text, jsonb) TO service_role;

COMMENT ON TABLE public.seller_logical_communications IS
  'One row per seller-visible communication ACTION (§11 Slice 1). Identity is the deterministic lck_v* logical_key, never a body/template/queue row/provider id. delivery_possibility and retry_authority are deliberately separate axes.';
COMMENT ON TABLE public.seller_communication_attempts IS
  'Append-only transport attempt ledger (§11 Slice 1). provider_request_started_at is persisted BEFORE the network call so a crash cannot look like a safe retry. DELETE forbidden; transport facts immutable once set.';
