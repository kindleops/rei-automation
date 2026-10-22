-- ════════════════════════════════════════════════════════════════════════
-- PROPOSED — Campaign-scoped recipient exclusions.
--
-- ⚠ NOT APPLIED. Filename is prefixed `PROPOSED_` so `supabase db push` / the
--   migration runner ignore it. Rename to a real timestamp only after the
--   8.4.7 sending-safety owners approve this file AND the final-dispatch guard.
--   ADDITIVE ONLY: no existing table, column, function or row is altered.
--
-- Purpose: keep ONE recipient (canonical phone) out of ONE campaign without
-- suppressing them anywhere else. Target building, queue planning and final
-- dispatch all read active rows from this table through one shared rule
-- (apps/api/src/lib/domain/campaigns/campaign-recipient-exclusions.js).
--
-- Concurrency: uniqueness is enforced by the database (campaign_id, phone_e164);
-- writes go through two functions that use INSERT … ON CONFLICT and a
-- row-locking UPDATE, so concurrent requests serialize on the unique row and
-- can never lose an exclusion. Campaign settings edits cannot touch this data.
-- Audit: an AFTER trigger appends every change to an immutable events table.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.campaign_recipient_exclusions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  -- Canonical US E.164 only. Anything else is rejected at write time.
  phone_e164      text NOT NULL CHECK (phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  property_id     text,                          -- informational context only
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  is_active       boolean NOT NULL DEFAULT true,
  created_by      text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_by  text,
  deactivated_at  timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT campaign_recipient_exclusions_campaign_phone_key UNIQUE (campaign_id, phone_e164),
  CONSTRAINT campaign_recipient_exclusions_deactivation_consistent
    CHECK ((is_active AND deactivated_at IS NULL) OR (NOT is_active AND deactivated_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS campaign_recipient_exclusions_active_idx
  ON public.campaign_recipient_exclusions (campaign_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.campaign_recipient_exclusion_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exclusion_id  uuid NOT NULL,
  campaign_id   uuid NOT NULL,
  phone_e164    text NOT NULL,
  action        text NOT NULL CHECK (action IN ('created', 'reactivated', 'deactivated', 'updated')),
  actor         text NOT NULL,
  reason        text,
  version       integer NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_recipient_exclusion_events_campaign_idx
  ON public.campaign_recipient_exclusion_events (campaign_id, phone_e164, occurred_at);

-- Append-only: block UPDATE/DELETE on the audit table.
CREATE OR REPLACE FUNCTION public.campaign_recipient_exclusion_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'campaign_recipient_exclusion_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS campaign_recipient_exclusion_events_no_mutation ON public.campaign_recipient_exclusion_events;
CREATE TRIGGER campaign_recipient_exclusion_events_no_mutation
  BEFORE UPDATE OR DELETE ON public.campaign_recipient_exclusion_events
  FOR EACH ROW EXECUTE FUNCTION public.campaign_recipient_exclusion_events_immutable();

CREATE OR REPLACE FUNCTION public.campaign_recipient_exclusions_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
  ELSIF OLD.is_active AND NOT NEW.is_active THEN
    v_action := 'deactivated';
  ELSIF NOT OLD.is_active AND NEW.is_active THEN
    v_action := 'reactivated';
  ELSE
    v_action := 'updated';
  END IF;
  INSERT INTO public.campaign_recipient_exclusion_events
    (exclusion_id, campaign_id, phone_e164, action, actor, reason, version)
  VALUES
    (NEW.id, NEW.campaign_id, NEW.phone_e164, v_action,
     CASE WHEN v_action = 'deactivated' THEN NEW.deactivated_by ELSE NEW.updated_by END,
     NEW.reason, NEW.version);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS campaign_recipient_exclusions_audit_trg ON public.campaign_recipient_exclusions;
CREATE TRIGGER campaign_recipient_exclusions_audit_trg
  AFTER INSERT OR UPDATE ON public.campaign_recipient_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.campaign_recipient_exclusions_audit();

-- Physical deletes are not part of the workflow (deactivate instead); block them
-- so history cannot be erased outside a campaign cascade.
CREATE OR REPLACE FUNCTION public.campaign_recipient_exclusions_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;  -- allow ON DELETE CASCADE from campaigns
  RAISE EXCEPTION 'campaign_recipient_exclusions: deactivate instead of delete';
END;
$$;
DROP TRIGGER IF EXISTS campaign_recipient_exclusions_no_delete_trg ON public.campaign_recipient_exclusions;
CREATE TRIGGER campaign_recipient_exclusions_no_delete_trg
  BEFORE DELETE ON public.campaign_recipient_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.campaign_recipient_exclusions_no_delete();

-- Normalize any US phone input to canonical E.164, or NULL.
CREATE OR REPLACE FUNCTION public.normalize_us_phone_e164(p_phone text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(d) = 10 THEN '+1' || d
    WHEN length(d) = 11 AND left(d, 1) = '1' THEN '+' || d
    ELSE NULL
  END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') AS d) s;
$$;

-- Atomic add / reactivate. Concurrent callers serialize on the unique key.
CREATE OR REPLACE FUNCTION public.upsert_campaign_recipient_exclusion(
  p_campaign_id uuid, p_phone text, p_reason text, p_actor text, p_property_id text DEFAULT NULL)
RETURNS public.campaign_recipient_exclusions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone text := public.normalize_us_phone_e164(p_phone);
  v_row public.campaign_recipient_exclusions;
BEGIN
  IF v_phone IS NULL THEN RAISE EXCEPTION 'invalid_phone'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor_required'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'reason_required'; END IF;
  INSERT INTO public.campaign_recipient_exclusions
    (campaign_id, phone_e164, property_id, reason, created_by, updated_by)
  VALUES (p_campaign_id, v_phone, p_property_id, btrim(p_reason), btrim(p_actor), btrim(p_actor))
  ON CONFLICT ON CONSTRAINT campaign_recipient_exclusions_campaign_phone_key DO UPDATE
    SET is_active = true,
        reason = EXCLUDED.reason,
        property_id = coalesce(EXCLUDED.property_id, public.campaign_recipient_exclusions.property_id),
        updated_by = EXCLUDED.updated_by,
        updated_at = now(),
        deactivated_by = NULL,
        deactivated_at = NULL,
        version = public.campaign_recipient_exclusions.version + 1
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Authorized removal = deactivation (row and history are kept).
CREATE OR REPLACE FUNCTION public.deactivate_campaign_recipient_exclusion(
  p_campaign_id uuid, p_phone text, p_actor text, p_reason text)
RETURNS public.campaign_recipient_exclusions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone text := public.normalize_us_phone_e164(p_phone);
  v_row public.campaign_recipient_exclusions;
BEGIN
  IF v_phone IS NULL THEN RAISE EXCEPTION 'invalid_phone'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor_required'; END IF;
  UPDATE public.campaign_recipient_exclusions
     SET is_active = false,
         reason = coalesce(nullif(btrim(p_reason), ''), reason),
         updated_by = btrim(p_actor),
         updated_at = now(),
         deactivated_by = btrim(p_actor),
         deactivated_at = now(),
         version = version + 1
   WHERE campaign_id = p_campaign_id AND phone_e164 = v_phone AND is_active
  RETURNING * INTO v_row;
  RETURN v_row;  -- NULL when nothing was active
END;
$$;

ALTER TABLE public.campaign_recipient_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipient_exclusion_events ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies: service-role only.
-- Supabase's default privileges grant EXECUTE on new public functions (and table
-- privileges) directly to anon/authenticated, so REVOKE FROM PUBLIC alone would
-- leave these SECURITY DEFINER writers callable with the anon key. Revoke the
-- named API roles explicitly and grant only service_role.
REVOKE ALL ON TABLE public.campaign_recipient_exclusions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.campaign_recipient_exclusion_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.campaign_recipient_exclusions TO service_role;
GRANT SELECT ON TABLE public.campaign_recipient_exclusion_events TO service_role;
REVOKE ALL ON FUNCTION public.upsert_campaign_recipient_exclusion(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deactivate_campaign_recipient_exclusion(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_campaign_recipient_exclusion(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_campaign_recipient_exclusion(uuid, text, text, text) TO service_role;
