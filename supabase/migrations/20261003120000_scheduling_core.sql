-- ============================================================================
-- Shared scheduling core — one company-wide availability and appointment layer.
-- ============================================================================
-- Brands (Prominent first; Reivesti, Everline, SignPro later) are CONTEXT on an
-- appointment, never separate infrastructure. A person is one resource with one
-- availability truth: an appointment booked for any brand removes that time for
-- every brand, enforced by the database (scheduling_appointments_no_overlap),
-- not by application code.
--
-- Google Calendar is a connected calendar and a busy-time source BELOW the brand
-- layer. This database owns appointments; Google mirrors them.
--
-- Reused, not duplicated:
--   * statuses scheduled / completed / cancelled keep the meaning they have in
--     calendar_manual_events (Calendar Nexus); confirmed, rescheduled and
--     no_show are the additions the appointment lifecycle needs;
--   * related records (seller, opportunity, closing case, deal, account...) are
--     generic "type:id" references owned by their domains; no property, seller
--     or offer concept is copied here;
--   * reminder delivery is email_queue + email dispatch (source 'scheduling');
--   * team members are the Supabase users the ops worker already authenticates
--     (x-ops-user-id); there is no second user table, only the scheduling
--     attributes of a person (hours, time zone, calendars).
--
-- Nothing here is reachable by anon or authenticated: service role only.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- People and other bookable resources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduling_resources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'shared')),
  ops_user_id    text UNIQUE,                       -- Supabase auth user id (x-ops-user-id)
  operator_keys  text[] NOT NULL DEFAULT '{}',      -- values canonical tables use in assigned_operator
  display_name   text NOT NULL,                     -- internal
  public_name    text,                              -- shown to customers only when set
  email          text,
  timezone       text NOT NULL,
  -- Working hours in the resource's own time zone. Keys are ISO weekdays as
  -- strings ("1" Monday ... "7" Sunday); values are [["09:00","17:00"], ...].
  weekly_hours   jsonb NOT NULL DEFAULT '{}'::jsonb,
  active         boolean NOT NULL DEFAULT true,
  environment    text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'test')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduling_resources_operator_keys
  ON public.scheduling_resources USING gin (operator_keys);

-- PTO, holidays and ad-hoc blocks that are not on a connected calendar.
CREATE TABLE IF NOT EXISTS public.scheduling_time_off (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  uuid NOT NULL REFERENCES public.scheduling_resources(id) ON DELETE CASCADE,
  start_at     timestamptz NOT NULL,
  end_at       timestamptz NOT NULL,
  kind         text NOT NULL DEFAULT 'block' CHECK (kind IN ('pto', 'holiday', 'block')),
  note         text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_time_off_range CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_scheduling_time_off_resource
  ON public.scheduling_time_off (resource_id, start_at, end_at);

-- Qualified pools, owned by a brand ("prominent_cash_offer" / "seller_advisors").
CREATE TABLE IF NOT EXISTS public.scheduling_pools (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key  text NOT NULL,
  pool_key   text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_pools_unique UNIQUE (brand_key, pool_key)
);
CREATE TABLE IF NOT EXISTS public.scheduling_pool_members (
  pool_id      uuid NOT NULL REFERENCES public.scheduling_pools(id) ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES public.scheduling_resources(id) ON DELETE CASCADE,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, resource_id)
);

-- ---------------------------------------------------------------------------
-- Appointment types: each brand owns its definitions; the core owns mechanics.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduling_event_types (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key              text NOT NULL,
  type_key               text NOT NULL,
  name                   text NOT NULL,
  description            text,
  duration_minutes       integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  slot_interval_minutes  integer NOT NULL DEFAULT 30 CHECK (slot_interval_minutes BETWEEN 5 AND 240),
  buffer_before_minutes  integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes   integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  min_notice_minutes     integer NOT NULL DEFAULT 120 CHECK (min_notice_minutes >= 0),
  horizon_days           integer NOT NULL DEFAULT 14 CHECK (horizon_days BETWEEN 1 AND 120),
  location_kind          text NOT NULL DEFAULT 'outbound_phone' CHECK (location_kind IN ('outbound_phone', 'video', 'in_person')),
  -- { "strategy": "specific_owner" | "round_robin" | "qualified_pool",
  --   "owner": "<adapter owner role>", "pool": "<pool_key>",
  --   "fallback_pool": "<pool_key>",
  --   "owner_unavailable": "next_available_owner" | "route_to_pool" }
  routing                jsonb NOT NULL DEFAULT '{}'::jsonb,
  reminder_offsets_minutes integer[] NOT NULL DEFAULT '{1440,60}',
  active                 boolean NOT NULL DEFAULT true,
  environment            text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'test')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_event_types_unique UNIQUE (brand_key, type_key)
);

-- ---------------------------------------------------------------------------
-- Appointments — the system of record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduling_appointments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key             text NOT NULL,
  event_type_id         uuid NOT NULL REFERENCES public.scheduling_event_types(id),
  resource_id           uuid REFERENCES public.scheduling_resources(id),
  status                text NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'no_show')),
  start_at              timestamptz NOT NULL,
  end_at                timestamptz NOT NULL,
  -- The time the resource is held, buffers included. Written by the service
  -- from the event type at booking; the overlap constraint is on this range.
  block_start_at        timestamptz NOT NULL,
  block_end_at          timestamptz NOT NULL,
  customer_timezone     text,
  customer              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { name, email, phone }
  related_refs          text[] NOT NULL DEFAULT '{}',         -- "opportunity:<uuid>", "closing_case:<id>", ...
  source                text NOT NULL,                        -- "prominent_portal", "prominent_public", "cockpit", ...
  reason_key            text,
  note                  text,
  routed_via            text,
  rescheduled_from_id   uuid REFERENCES public.scheduling_appointments(id),
  rescheduled_to_id     uuid REFERENCES public.scheduling_appointments(id),
  cancelled_at          timestamptz,
  cancelled_by          text,
  cancel_reason         text,
  completed_at          timestamptz,
  outcome_by            text,
  google_calendar_id    text,
  google_event_id       text,
  sync_status           text NOT NULL DEFAULT 'pending'
                          CHECK (sync_status IN ('pending', 'synced', 'not_connected', 'failed', 'drift')),
  sync_error            text,
  synced_at             timestamptz,
  idempotency_key       text UNIQUE,
  version               integer NOT NULL DEFAULT 1,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_appointments_range CHECK (end_at > start_at),
  CONSTRAINT scheduling_appointments_block CHECK (block_start_at <= start_at AND block_end_at >= end_at),
  -- ONE availability truth. No two live appointments may hold overlapping time
  -- on the same resource, whatever their brand. Concurrent inserts serialize on
  -- the index; the loser gets 23P01 (exclusion_violation).
  CONSTRAINT scheduling_appointments_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(block_start_at, block_end_at, '[)') WITH &&
  ) WHERE (status IN ('scheduled', 'confirmed') AND resource_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_resource_time
  ON public.scheduling_appointments (resource_id, block_start_at, block_end_at)
  WHERE status IN ('scheduled', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_brand_time
  ON public.scheduling_appointments (brand_key, start_at);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_related
  ON public.scheduling_appointments USING gin (related_refs);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_google
  ON public.scheduling_appointments (google_event_id) WHERE google_event_id IS NOT NULL;

-- Ledger of everything that happened to an appointment. It is also the
-- core's outbox: domains and the communication layer read from it.
CREATE TABLE IF NOT EXISTS public.scheduling_appointment_events (
  id              bigserial PRIMARY KEY,
  appointment_id  uuid NOT NULL REFERENCES public.scheduling_appointments(id) ON DELETE CASCADE,
  brand_key       text NOT NULL,
  event           text NOT NULL,   -- booked, rescheduled, cancelled, completed, no_show, assigned, synced, sync_failed, drift_detected
  actor           text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointment_events_appt
  ON public.scheduling_appointment_events (appointment_id, created_at);

-- ---------------------------------------------------------------------------
-- Connected calendars (Google), per team member
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduling_calendar_connections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id               uuid NOT NULL REFERENCES public.scheduling_resources(id) ON DELETE CASCADE,
  provider                  text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  account_email             text,
  calendar_id               text NOT NULL DEFAULT 'primary',
  -- AES-256-GCM ciphertext produced by the API with SCHEDULING_TOKEN_KEYS;
  -- the database never sees a usable refresh token.
  refresh_token_ciphertext  text,
  token_key_id              text,
  scopes                    text[] NOT NULL DEFAULT '{}',
  status                    text NOT NULL DEFAULT 'connected'
                              CHECK (status IN ('connected', 'needs_reauth', 'disconnected', 'error')),
  connected_at              timestamptz,
  last_error_code           text,
  last_error_at             timestamptz,
  busy_synced_at            timestamptz,
  sync_token                text,
  watch_channel_id          text,
  watch_resource_id         text,
  watch_token_hash          text,
  watch_expires_at          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_calendar_connections_unique UNIQUE (resource_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_scheduling_calendar_connections_channel
  ON public.scheduling_calendar_connections (watch_channel_id) WHERE watch_channel_id IS NOT NULL;

-- Busy time mirrored from a connected calendar: times only. No titles,
-- attendees, descriptions or locations are stored.
CREATE TABLE IF NOT EXISTS public.scheduling_external_busy (
  connection_id      uuid NOT NULL REFERENCES public.scheduling_calendar_connections(id) ON DELETE CASCADE,
  resource_id        uuid NOT NULL REFERENCES public.scheduling_resources(id) ON DELETE CASCADE,
  external_event_id  text NOT NULL,
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_scheduling_external_busy_resource
  ON public.scheduling_external_busy (resource_id, start_at, end_at);

-- Single-use OAuth state (CSRF + PKCE verifier), expires in minutes.
CREATE TABLE IF NOT EXISTS public.scheduling_oauth_states (
  state_hash            text PRIMARY KEY,
  resource_id           uuid NOT NULL REFERENCES public.scheduling_resources(id) ON DELETE CASCADE,
  ops_user_id           text NOT NULL,
  verifier_ciphertext   text NOT NULL,
  return_to             text,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reschedule: release the old time and hold the new one in ONE transaction.
-- If the new time is taken the whole call fails (23P01) and the original
-- appointment is untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scheduling_reschedule_appointment(
  p_appointment_id uuid,
  p_expected_version integer,
  p_new jsonb,
  p_actor text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  old_row public.scheduling_appointments;
  new_id uuid;
BEGIN
  SELECT * INTO old_row FROM public.scheduling_appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'appointment_not_found' USING ERRCODE = 'P0002'; END IF;
  IF old_row.status NOT IN ('scheduled', 'confirmed') THEN RAISE EXCEPTION 'appointment_not_active' USING ERRCODE = 'P0001'; END IF;
  IF p_expected_version IS NOT NULL AND old_row.version <> p_expected_version THEN RAISE EXCEPTION 'appointment_version_conflict' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.scheduling_appointments
     SET status = 'rescheduled', version = version + 1, updated_at = now()
   WHERE id = p_appointment_id;

  INSERT INTO public.scheduling_appointments (
    brand_key, event_type_id, resource_id, status, start_at, end_at, block_start_at, block_end_at,
    customer_timezone, customer, related_refs, source, reason_key, note, routed_via,
    rescheduled_from_id, google_calendar_id, google_event_id, sync_status, created_by
  ) VALUES (
    old_row.brand_key, old_row.event_type_id,
    COALESCE((p_new->>'resource_id')::uuid, old_row.resource_id),
    'scheduled',
    (p_new->>'start_at')::timestamptz, (p_new->>'end_at')::timestamptz,
    (p_new->>'block_start_at')::timestamptz, (p_new->>'block_end_at')::timestamptz,
    COALESCE(p_new->>'customer_timezone', old_row.customer_timezone),
    old_row.customer, old_row.related_refs, old_row.source, old_row.reason_key, old_row.note,
    COALESCE(p_new->>'routed_via', old_row.routed_via),
    old_row.id,
    -- The Google event moves with the appointment when the resource is unchanged.
    CASE WHEN COALESCE((p_new->>'resource_id')::uuid, old_row.resource_id) = old_row.resource_id THEN old_row.google_calendar_id END,
    CASE WHEN COALESCE((p_new->>'resource_id')::uuid, old_row.resource_id) = old_row.resource_id THEN old_row.google_event_id END,
    'pending', p_actor
  ) RETURNING id INTO new_id;

  UPDATE public.scheduling_appointments SET rescheduled_to_id = new_id WHERE id = p_appointment_id;
  INSERT INTO public.scheduling_appointment_events (appointment_id, brand_key, event, actor, detail)
  VALUES (p_appointment_id, old_row.brand_key, 'rescheduled', p_actor, jsonb_build_object('to', new_id)),
         (new_id, old_row.brand_key, 'booked', p_actor, jsonb_build_object('rescheduled_from', p_appointment_id));
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.scheduling_reschedule_appointment(uuid, integer, jsonb, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Service role only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'scheduling_resources', 'scheduling_time_off', 'scheduling_pools', 'scheduling_pool_members',
    'scheduling_event_types', 'scheduling_appointments', 'scheduling_appointment_events',
    'scheduling_calendar_connections', 'scheduling_external_busy', 'scheduling_oauth_states'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.scheduling_appointment_events_id_seq FROM anon, authenticated;

COMMIT;
