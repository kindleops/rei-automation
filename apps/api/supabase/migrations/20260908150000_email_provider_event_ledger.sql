-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL-2: the inbound half of the transport.
--
-- Outbound evidence is OURS: we know whether we called the provider, because we
-- wrote provider_request_started before doing it. Inbound evidence is THEIRS.
-- It arrives out of order, may be duplicated arbitrarily, and cannot be proven
-- authentic from repository configuration alone. So a provider event is recorded
-- as a CLAIM, then authorised as a TRANSITION -- never executed as an
-- instruction.
--
-- email_events already existed with a unique event_key, which is the
-- idempotency spine. What it lacked was any way to say who sent an event, what
-- we decided about it, or which communication it belongs to -- so a duplicate
-- and a first delivery were indistinguishable after the fact, and an event could
-- not be traced back to the send it describes.
--
-- WHAT A PROVIDER EVENT MAY NEVER DO, enforced by the reconciler and recorded
-- here: create a logical communication, create an attempt, mint retry
-- authority, or regress a delivered message.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. email_events becomes an auditable ledger ─────────────────────────────

ALTER TABLE public.email_events
  ADD COLUMN IF NOT EXISTS provider                 text,
  ADD COLUMN IF NOT EXISTS provider_event_id        text,
  ADD COLUMN IF NOT EXISTS event_at                 timestamptz,
  -- WHO sent it. An event that could not be authenticated is recorded with the
  -- rest of its evidence and is simply not allowed to advance anything.
  ADD COLUMN IF NOT EXISTS trust_class              text,
  ADD COLUMN IF NOT EXISTS event_kind               text,
  ADD COLUMN IF NOT EXISTS provider_outcome         text,
  ADD COLUMN IF NOT EXISTS suppression_reason       text,
  -- WHICH send it describes. Null means we could not resolve it, which is a
  -- state worth being able to query rather than a silent drop.
  ADD COLUMN IF NOT EXISTS logical_communication_id uuid
    REFERENCES public.seller_logical_communications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt_id               uuid,
  -- WHAT WE DECIDED. The lattice verdict, kept so "why did this delivered event
  -- change nothing?" is answerable from the row instead of from a log search.
  ADD COLUMN IF NOT EXISTS processing_status        text,
  ADD COLUMN IF NOT EXISTS processing_reason        text,
  ADD COLUMN IF NOT EXISTS raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at               timestamptz NOT NULL DEFAULT now();

UPDATE public.email_events SET provider = 'brevo' WHERE provider IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_events_processing_status_valid') THEN
    ALTER TABLE public.email_events
      ADD CONSTRAINT email_events_processing_status_valid
      CHECK (processing_status IS NULL OR processing_status IN (
        'applied',       -- the lattice advanced
        'idempotent',    -- the same outcome was already recorded
        'stale',         -- weaker than what we already believe (out-of-order)
        'conflict',      -- contradictory terminal outcomes; recorded, not applied
        'inert',         -- telemetry or an unrecognised event; no delivery meaning
        'unresolved',    -- no attempt matched this provider message id
        'untrusted'      -- the receipt could not be authenticated
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_events_event_kind_valid') THEN
    ALTER TABLE public.email_events
      ADD CONSTRAINT email_events_event_kind_valid
      CHECK (event_kind IS NULL OR event_kind IN ('delivery', 'telemetry', 'preference', 'unknown'));
  END IF;
END $$;

-- Resolution is by provider_message_id, so it must be indexed on both sides.
CREATE INDEX IF NOT EXISTS email_events_provider_message_idx
  ON public.email_events (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_events_logical_communication_idx
  ON public.email_events (logical_communication_id, event_at DESC)
  WHERE logical_communication_id IS NOT NULL;

-- "Which events did we receive but fail to attach to a send?" must be one query.
-- Unresolved events are the early warning that message-id resolution has broken.
CREATE INDEX IF NOT EXISTS email_events_unresolved_idx
  ON public.email_events (created_at DESC)
  WHERE processing_status IN ('unresolved', 'untrusted', 'conflict');

COMMENT ON COLUMN public.email_events.trust_class IS
  'Receipt-time trust, from the shared callback trust policy. An unauthenticated event is stored with its evidence and may not advance canonical truth.';
COMMENT ON COLUMN public.email_events.processing_status IS
  'What the monotonic lattice decided. stale means a late, weaker event arrived out of order and was recorded rather than applied.';

-- ── 2. resolve a provider message id back to the attempt that produced it ───
--
-- The attempt ledger is append-only and already stores provider_message_id; it
-- simply was not indexed for lookup in this direction, because until now nothing
-- arrived from a provider asking "which send was this?".

CREATE INDEX IF NOT EXISTS seller_communication_attempts_provider_message_idx
  ON public.seller_communication_attempts (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ── 3. email_queue learns the delivery state of its own send ────────────────
--
-- A projection, never authority. The ledger is the truth; these columns exist so
-- an operator reading the queue can see what happened without a join, and they
-- are written LAST, after the transition has already been authorised.

ALTER TABLE public.email_queue
  ADD COLUMN IF NOT EXISTS provider_outcome     text,
  ADD COLUMN IF NOT EXISTS delivered_at_event   timestamptz,
  ADD COLUMN IF NOT EXISTS bounced_at           timestamptz,
  ADD COLUMN IF NOT EXISTS complained_at        timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS last_event_at        timestamptz,
  -- Telemetry lives beside the delivery state and is never mistaken for it.
  ADD COLUMN IF NOT EXISTS first_opened_at      timestamptz,
  ADD COLUMN IF NOT EXISTS open_count           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_clicked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS click_count          integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.email_queue.open_count IS
  'Telemetry only. An open is a resource fetch, which scanners, gateways and Apple Mail Privacy Protection all perform without a human reading anything. It is never delivery evidence and never engagement evidence.';

-- ── 4. telemetry counters, incremented atomically ───────────────────────────
--
-- A read-modify-write from the application would lose counts under the
-- concurrency a webhook endpoint actually sees: two opens delivered in parallel
-- both read 4 and both write 5. The increment therefore happens in one
-- statement, inside the database.
--
-- It touches ONLY telemetry columns. That is enforced by the function body
-- rather than by convention, so a future edit that tried to set delivered_at
-- here would have to do so visibly, in the one place reviewers look for exactly
-- that mistake.

CREATE OR REPLACE FUNCTION public.email_queue_record_telemetry(
  p_provider_message_id text,
  p_event_type          text,
  p_event_at            timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_provider_message_id IS NULL OR btrim(p_provider_message_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_provider_message_id');
  END IF;

  IF p_event_type IN ('opened', 'unique_opened', 'proxy_open') THEN
    UPDATE public.email_queue
       SET open_count      = COALESCE(open_count, 0) + 1,
           first_opened_at = LEAST(COALESCE(first_opened_at, p_event_at), p_event_at),
           updated_at      = now()
     WHERE provider_message_id = p_provider_message_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

  ELSIF p_event_type IN ('click', 'clicked', 'unique_click') THEN
    UPDATE public.email_queue
       SET click_count      = COALESCE(click_count, 0) + 1,
           first_clicked_at = LEAST(COALESCE(first_clicked_at, p_event_at), p_event_at),
           updated_at       = now()
     WHERE provider_message_id = p_provider_message_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

  ELSE
    -- Not telemetry. Silently doing nothing is correct here: the caller already
    -- decided this event was inert, and this function must not become a second
    -- place where event semantics are interpreted.
    RETURN jsonb_build_object('ok', true, 'updated', 0, 'reason', 'not_a_telemetry_event');
  END IF;

  RETURN jsonb_build_object('ok', true, 'updated', v_updated);
END;
$fn$;

REVOKE ALL ON FUNCTION public.email_queue_record_telemetry(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_queue_record_telemetry(text, text, timestamptz) TO service_role;

COMMIT;
