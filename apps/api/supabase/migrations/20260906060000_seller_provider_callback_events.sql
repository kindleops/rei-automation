-- ─── provider callback event ledger (§11 Slice 2) ──────────────────────────
--
-- INBOUND PROVIDER TRUTH. Append-only.
--
-- WHY A NEW TABLE RATHER THAN message_events.
--   Production holds exactly ONE message_event per provider SID (verified: 0 SIDs
--   appear on 2+ rows, max_events_per_sid = 1), because delivery status is
--   OVERWRITTEN IN PLACE. That means provider status HISTORY IS CURRENTLY LOST:
--   a delivered row that later receives a `failed` callback is silently rewritten,
--   and nothing records that the regression was ever attempted.
--
--   Slice 2 needs the opposite property. Every callback is evidence, evidence is
--   never rewritten, and the CURRENT summary is derived from the strongest
--   evidence rather than from whichever callback happened to arrive last.
--
-- WHY NOT idempotency_ledger.
--   It is inbound-oriented, one mutable row per key, lease-based, and fails OPEN
--   after a lease lapses. Every one of those is wrong here. A callback ledger that
--   fails open would let a duplicate callback re-apply a transition.
--
-- WHAT A CALLBACK MAY AND MAY NOT DO.
--   A callback may only INCREASE certainty about an attempt that already exists.
--   It may never create a logical communication, create an attempt, mint retry
--   authority, replace a bound SID, or regress delivered. Those are enforced by
--   the application transition authority and by the invariant evaluator; this
--   table's job is to make the evidence durable, deduplicated, and auditable.

CREATE TABLE IF NOT EXISTS public.seller_provider_callback_events (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider                  text NOT NULL DEFAULT 'textgrid',

  -- ── DETERMINISTIC EVENT IDENTITY ────────────────────────────────────────
  -- Derived ONLY from stable provider evidence: provider, SID, status,
  -- normalized to/from, and the provider's own timestamp when it supplies one.
  -- Deliberately NOT from received_at, a random UUID, the worker, or the
  -- processing attempt -- any of those would make every redelivery a new event
  -- and defeat the whole point, exactly as a random queue_key defeated dedupe on
  -- the outbound side.
  callback_fingerprint      text NOT NULL,
  fingerprint_policy_version text NOT NULL,

  -- ── RAW PROVIDER EVIDENCE, AS RECEIVED ──────────────────────────────────
  provider_message_sid      text,
  provider_status           text,
  provider_error_code       text,
  provider_error_message    text,
  provider_event_at         timestamptz,
  to_phone_number           text,
  from_phone_number         text,

  -- Hash of the full raw payload. Lets a later reader prove two callbacks that
  -- share a fingerprint really were identical, without storing message bodies.
  raw_evidence_hash         text,

  -- ── TRUST, RECORDED AT RECEIPT ──────────────────────────────────────────
  -- The signature mode in force WHEN THIS ARRIVED. If verification is later
  -- turned off, historical events must not retroactively look less trustworthy,
  -- and vice versa. Trust is a property of the receipt, not of today's config.
  trust_class               text NOT NULL,
  signature_verified        boolean NOT NULL DEFAULT false,

  -- ── BINDING (nullable: an orphan may never bind) ─────────────────────────
  bound_attempt_id             uuid REFERENCES public.seller_communication_attempts(id) ON DELETE RESTRICT,
  bound_logical_communication_id uuid REFERENCES public.seller_logical_communications(id) ON DELETE RESTRICT,

  adoption_status           text NOT NULL DEFAULT 'unprocessed',
  adoption_reason           text,
  adoption_policy_version   text,

  processing_status         text NOT NULL DEFAULT 'pending',
  processed_at              timestamptz,

  source_route              text,
  received_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT seller_provider_callback_events_trust_valid CHECK (trust_class IN (
    'authenticated_provider_callback',
    'shared_secret_callback',
    'network_received_unauthenticated',
    'internal_replay',
    'test_fixture'
  )),

  CONSTRAINT seller_provider_callback_events_adoption_valid CHECK (adoption_status IN (
    'unprocessed',
    'bound_known_sid',          -- SID matched exactly one attempt
    'orphan_adopted',           -- exactly one strict candidate, adopted
    'orphan_unmatched',         -- zero candidates; evidence retained, nothing mutated
    'orphan_ambiguous',         -- 2+ candidates; NEVER adopted
    'identity_mismatch',        -- SID known but to/from contradicts the attempt
    'duplicate',                -- same fingerprint already recorded
    'stale',                    -- weaker than current truth; recorded, not applied
    'conflict'                  -- contradicts durable evidence (e.g. different SID)
  )),

  CONSTRAINT seller_provider_callback_events_processing_valid CHECK (processing_status IN (
    'pending', 'applied', 'no_action', 'refused', 'failed'
  )),

  -- Adoption REQUIRES a binding. An "adopted" event with nothing bound would be
  -- a claim with no referent.
  CONSTRAINT seller_provider_callback_events_adoption_implies_binding CHECK (
    adoption_status NOT IN ('bound_known_sid', 'orphan_adopted')
    OR bound_attempt_id IS NOT NULL
  ),

  -- The converse: an event that never bound must not carry a binding.
  CONSTRAINT seller_provider_callback_events_unmatched_has_no_binding CHECK (
    adoption_status NOT IN ('orphan_unmatched', 'orphan_ambiguous')
    OR bound_attempt_id IS NULL
  )
);

-- THE dedupe constraint. Total and unconditional: one canonical event per
-- fingerprint, so a redelivered callback collapses onto the row that already
-- exists rather than re-applying its transition.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_provider_callback_events_fingerprint
  ON public.seller_provider_callback_events (callback_fingerprint);

CREATE INDEX IF NOT EXISTS idx_seller_provider_callback_events_sid
  ON public.seller_provider_callback_events (provider_message_sid)
  WHERE provider_message_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_provider_callback_events_attempt
  ON public.seller_provider_callback_events (bound_attempt_id)
  WHERE bound_attempt_id IS NOT NULL;

-- The operational work-list: evidence that never resolved to an attempt.
CREATE INDEX IF NOT EXISTS idx_seller_provider_callback_events_unresolved
  ON public.seller_provider_callback_events (received_at DESC)
  WHERE adoption_status IN ('orphan_unmatched', 'orphan_ambiguous', 'identity_mismatch', 'conflict');

CREATE INDEX IF NOT EXISTS idx_seller_provider_callback_events_recipient
  ON public.seller_provider_callback_events (to_phone_number, received_at DESC)
  WHERE to_phone_number IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- EVIDENCE IS APPEND-ONLY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- What the provider told us, and when, and how much we trusted it at the time,
-- are historical facts. Interpretation may change; the evidence may not.
--
-- MUTABLE (interpretation): adoption_status, adoption_reason,
--   adoption_policy_version, processing_status, processed_at, and the bindings
--   -- but a binding is set-once, because re-pointing an event at a different
--   attempt would rewrite which seller communication the provider was talking
--   about.

CREATE OR REPLACE FUNCTION public.enforce_seller_provider_callback_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seller_provider_callback_events is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.callback_fingerprint IS DISTINCT FROM OLD.callback_fingerprint
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_message_sid IS DISTINCT FROM OLD.provider_message_sid
     OR NEW.provider_status IS DISTINCT FROM OLD.provider_status
     OR NEW.to_phone_number IS DISTINCT FROM OLD.to_phone_number
     OR NEW.from_phone_number IS DISTINCT FROM OLD.from_phone_number
     OR NEW.provider_event_at IS DISTINCT FROM OLD.provider_event_at
     OR NEW.raw_evidence_hash IS DISTINCT FROM OLD.raw_evidence_hash
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.trust_class IS DISTINCT FROM OLD.trust_class
     OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'seller_provider_callback_events: received provider evidence is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A binding may be established once. Re-pointing it would change which seller
  -- communication this provider evidence is about.
  IF OLD.bound_attempt_id IS NOT NULL
     AND NEW.bound_attempt_id IS DISTINCT FROM OLD.bound_attempt_id THEN
    RAISE EXCEPTION 'seller_provider_callback_events: attempt binding is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.bound_logical_communication_id IS NOT NULL
     AND NEW.bound_logical_communication_id IS DISTINCT FROM OLD.bound_logical_communication_id THEN
    RAISE EXCEPTION 'seller_provider_callback_events: logical binding is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seller_provider_callback_events_immutable
  ON public.seller_provider_callback_events;
CREATE TRIGGER trg_seller_provider_callback_events_immutable
  BEFORE UPDATE OR DELETE ON public.seller_provider_callback_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_seller_provider_callback_event_immutability();

-- ═══════════════════════════════════════════════════════════════════════════
-- ATOMIC CALLBACK-EVENT GET-OR-CREATE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Same shape as the outbound get-or-create, and for the same reason: two
-- concurrent redeliveries of one callback must resolve to ONE row, and the race
-- LOSER must still receive that row rather than zero rows.
--
-- DO UPDATE (not DO NOTHING) so the loser gets the canonical row back. The update
-- is deliberately non-semantic: it touches nothing an authority reads.

CREATE OR REPLACE FUNCTION public.seller_provider_callback_event_get_or_create(
  p_fingerprint        text,
  p_fingerprint_policy text,
  p_provider           text,
  p_evidence           jsonb DEFAULT '{}'::jsonb,
  p_trust              jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row public.seller_provider_callback_events;
  v_created boolean := false;
BEGIN
  INSERT INTO public.seller_provider_callback_events (
    callback_fingerprint, fingerprint_policy_version, provider,
    provider_message_sid, provider_status, provider_error_code, provider_error_message,
    provider_event_at, to_phone_number, from_phone_number, raw_evidence_hash,
    trust_class, signature_verified, source_route
  ) VALUES (
    p_fingerprint,
    p_fingerprint_policy,
    COALESCE(NULLIF(p_provider,''), 'textgrid'),
    NULLIF(p_evidence->>'provider_message_sid',''),
    NULLIF(p_evidence->>'provider_status',''),
    NULLIF(p_evidence->>'provider_error_code',''),
    NULLIF(p_evidence->>'provider_error_message',''),
    (NULLIF(p_evidence->>'provider_event_at',''))::timestamptz,
    NULLIF(p_evidence->>'to_phone_number',''),
    NULLIF(p_evidence->>'from_phone_number',''),
    NULLIF(p_evidence->>'raw_evidence_hash',''),
    COALESCE(NULLIF(p_trust->>'trust_class',''), 'network_received_unauthenticated'),
    COALESCE((p_trust->>'signature_verified')::boolean, false),
    NULLIF(p_evidence->>'source_route','')
  )
  -- DO UPDATE, NOT DO NOTHING -- and the difference is not cosmetic.
  --
  -- With DO NOTHING, a race loser gets zero rows back and must re-SELECT. Under
  -- READ COMMITTED that SELECT does not block on the winner's uncommitted row,
  -- so it finds nothing and the function reports a spurious failure. With DO
  -- UPDATE the loser takes the row lock, waits for the winner to commit, and is
  -- handed the canonical row -- which is the entire contract of this function.
  --
  -- The SET is deliberately a self-assignment: it writes no new information, and
  -- the immutability trigger passes it precisely because nothing is DISTINCT.
  ON CONFLICT (callback_fingerprint) DO UPDATE
    SET provider = public.seller_provider_callback_events.provider
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Unreachable via the conflict path now that DO UPDATE always returns a row.
    -- Retained as a fail-closed guard: no row means no evidence, and no evidence
    -- is never permission to advance truth.
    RETURN jsonb_build_object('ok', false, 'reason', 'callback_event_upsert_failed');
  END IF;

  -- INSERTED vs CONFLICTED, without depending on xmax. The insert path is the
  -- only one that can leave processed_at NULL *and* a fresh created_at, so
  -- rather than infer it we ask the row: an event we just created has never been
  -- ruled on. Callers gate on processing_status regardless (see below), so this
  -- flag is advisory, not load-bearing.
  v_created := (v_row.processing_status = 'pending' AND v_row.processed_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true,
    'created', v_created,
    'duplicate', NOT v_created,
    'callback_event_id', v_row.id,
    'adoption_status', v_row.adoption_status,
    'processing_status', v_row.processing_status,
    'bound_attempt_id', v_row.bound_attempt_id,
    'provider_message_sid', v_row.provider_message_sid,
    'provider_status', v_row.provider_status
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- STRICT ORPHAN CANDIDATE RESOLUTION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Returns the candidate COUNT and, only when the count is exactly one, that
-- candidate. It deliberately does not pick a "best" candidate: choosing between
-- two possible seller communications is how a delivery receipt gets credited to
-- the wrong person.
--
-- A candidate must satisfy EVERY constraint. Any loosening here is a licence to
-- misattribute provider evidence.

CREATE OR REPLACE FUNCTION public.seller_provider_callback_orphan_candidates(
  p_to_phone   text,
  p_from_phone text,
  p_window_start timestamptz,
  p_window_end   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count integer;
  v_attempt_id uuid;
  v_logical_id uuid;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.seller_communication_attempts a
  JOIN public.seller_logical_communications c ON c.id = a.logical_communication_id
  WHERE a.provider = 'textgrid'
    -- The request provably left us: a callback cannot belong to an attempt that
    -- never started a provider request.
    AND a.provider_request_started_at IS NOT NULL
    -- Never steal a SID from an attempt that already has one.
    AND a.provider_message_id IS NULL
    -- Only unresolved provider outcomes are adoptable.
    AND c.delivery_possibility IN ('may_have_been_sent', 'unknown')
    -- Never adopt into something that already resolved elsewhere.
    AND c.state NOT IN ('delivered', 'no_send', 'suppressed', 'cancelled')
    AND a.provider_request_started_at BETWEEN p_window_start AND p_window_end
    AND c.to_phone_number IS NOT DISTINCT FROM p_to_phone;

  IF v_count = 1 THEN
    SELECT a.id, c.id INTO v_attempt_id, v_logical_id
    FROM public.seller_communication_attempts a
    JOIN public.seller_logical_communications c ON c.id = a.logical_communication_id
    WHERE a.provider = 'textgrid'
      AND a.provider_request_started_at IS NOT NULL
      AND a.provider_message_id IS NULL
      AND c.delivery_possibility IN ('may_have_been_sent', 'unknown')
      AND c.state NOT IN ('delivered', 'no_send', 'suppressed', 'cancelled')
      AND a.provider_request_started_at BETWEEN p_window_start AND p_window_end
      AND c.to_phone_number IS NOT DISTINCT FROM p_to_phone;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'candidate_count', v_count,
    'attempt_id', v_attempt_id,
    'logical_communication_id', v_logical_id,
    -- Adoption is permitted ONLY at exactly one. Zero is "we do not know".
    -- Two or more is "we must not guess".
    'adoptable', (v_count = 1)
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SERVICE-ROLE ONLY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.seller_provider_callback_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_provider_callback_events FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.seller_provider_callback_event_get_or_create(text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seller_provider_callback_orphan_candidates(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seller_provider_callback_event_get_or_create(text, text, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.seller_provider_callback_orphan_candidates(text, text, timestamptz, timestamptz) TO service_role;

COMMENT ON TABLE public.seller_provider_callback_events IS
  'Append-only provider callback evidence (§11 Slice 2). One row per deterministic callback fingerprint. Provider evidence and receipt-time trust are immutable; only interpretation (adoption/processing) may advance. A callback may increase certainty about an existing attempt and may never create an attempt, create a logical communication, mint retry authority, replace a bound SID, or regress delivered.';
