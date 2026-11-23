-- ─── P0 SAFETY (founder 2026-11-23, item 1), round 2 ──────────────────────────
-- Marker-independent history for the final dispatch gate.
--
-- WHY. The round-1 gate decided "is this row historical?" from metadata markers
-- written by the paths that used to revive rows. A row whose status was flipped
-- back by hand (UPDATE send_queue SET queue_status='queued') or whose markers
-- were never written (brake set and lifted between two reconcile passes) looked
-- fresh. These two append-only tables are written by TRIGGERS, so no
-- application path, reconcile pass or hand-written UPDATE can skip them:
--
--   send_queue_status_history  every INSERT and every queue_status change on
--                              send_queue (from, to, when, which DB role).
--   send_authority_events      every change to a send-authority key in
--                              system_control (emergency stop, shutdown,
--                              processor / execution / campaign modes ...),
--                              plus ONE floor event written by this migration.
--
-- THE FLOOR EVENT. This migration inserts a 'p0_history_floor' event at apply
-- time. The gate treats every row created at or before the latest authority
-- event as historical, so every row that exists when this migration runs needs
-- a fresh owner release, whatever happens to the brake afterwards. Lifting the
-- brake right after deploy writes a newer event and changes nothing for those
-- rows (they are older still).
--
-- DEPLOY ORDER (docs/P0-FINAL-DISPATCH-GATE-ROUTE-INVENTORY.md, "Deploy order"):
--   1. apply this migration (brake still set)
--   2. deploy the API build containing final_dispatch_gate_v2
--   3. only then may anyone touch the brake
-- If the code ships first, the gate cannot read these tables and refuses every
-- automated send (fail closed). If this migration is applied first, the old
-- code ignores the tables; the brake is still set, so nothing sends.
--
-- Append-only: UPDATE / DELETE / TRUNCATE raise for every role, and direct
-- INSERT is revoked from API roles (rows come only from the triggers and the
-- one floor insert below).

BEGIN;

CREATE TABLE IF NOT EXISTS public.send_queue_status_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_row_id  text        NOT NULL,
  from_status   text,
  to_status     text,
  changed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  db_role       text        NOT NULL DEFAULT current_user,
  application   text        DEFAULT current_setting('application_name', true)
);

CREATE INDEX IF NOT EXISTS send_queue_status_history_row_idx
  ON public.send_queue_status_history (queue_row_id, changed_at);

CREATE TABLE IF NOT EXISTS public.send_authority_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text        NOT NULL,
  old_value   text,
  new_value   text,
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  db_role     text        NOT NULL DEFAULT current_user
);

CREATE INDEX IF NOT EXISTS send_authority_events_changed_idx
  ON public.send_authority_events (changed_at DESC);

-- ── writers (triggers) ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.p0_record_send_queue_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.send_queue_status_history (queue_row_id, from_status, to_status)
    VALUES (NEW.id::text, NULL, NEW.queue_status);
  ELSIF NEW.queue_status IS DISTINCT FROM OLD.queue_status THEN
    INSERT INTO public.send_queue_status_history (queue_row_id, from_status, to_status)
    VALUES (NEW.id::text, OLD.queue_status, NEW.queue_status);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p0_send_queue_status_history_ins ON public.send_queue;
CREATE TRIGGER p0_send_queue_status_history_ins
  AFTER INSERT ON public.send_queue
  FOR EACH ROW EXECUTE FUNCTION public.p0_record_send_queue_status();

DROP TRIGGER IF EXISTS p0_send_queue_status_history_upd ON public.send_queue;
CREATE TRIGGER p0_send_queue_status_history_upd
  AFTER UPDATE OF queue_status ON public.send_queue
  FOR EACH ROW EXECUTE FUNCTION public.p0_record_send_queue_status();

-- The keys whose change can turn sending on or off. Any change (set, clear or
-- mode switch) is recorded; the gate treats rows created before the latest one
-- as historical.
CREATE OR REPLACE FUNCTION public.p0_record_send_authority_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text := COALESCE(NEW.key, OLD.key);
BEGIN
  IF k IN (
    -- Freeze / brake switches only. Ordinary feature flags (retry, follow-up,
    -- manual mode) are not a freeze and do not make every waiting row historical.
    'queue_emergency_stop_at', 'queue_emergency_stop_active', 'global_send_shutdown_at',
    'queue_processor_mode', 'queue_execution_mode', 'campaign_mode',
    'outbound_sms_enabled', 'queue_runner_enabled'
  ) THEN
    IF TG_OP = 'DELETE' THEN
      INSERT INTO public.send_authority_events (key, old_value, new_value) VALUES (k, OLD.value, NULL);
    ELSIF TG_OP = 'INSERT' THEN
      INSERT INTO public.send_authority_events (key, old_value, new_value) VALUES (k, NULL, NEW.value);
    ELSIF NEW.value IS DISTINCT FROM OLD.value THEN
      INSERT INTO public.send_authority_events (key, old_value, new_value) VALUES (k, OLD.value, NEW.value);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS p0_send_authority_events_trg ON public.system_control;
CREATE TRIGGER p0_send_authority_events_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.system_control
  FOR EACH ROW EXECUTE FUNCTION public.p0_record_send_authority_event();

-- ── append-only ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.p0_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'p0_append_only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS p0_status_history_append_only ON public.send_queue_status_history;
CREATE TRIGGER p0_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.send_queue_status_history
  FOR EACH ROW EXECUTE FUNCTION public.p0_append_only_guard();
DROP TRIGGER IF EXISTS p0_status_history_no_truncate ON public.send_queue_status_history;
CREATE TRIGGER p0_status_history_no_truncate
  BEFORE TRUNCATE ON public.send_queue_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.p0_append_only_guard();

DROP TRIGGER IF EXISTS p0_authority_events_append_only ON public.send_authority_events;
CREATE TRIGGER p0_authority_events_append_only
  BEFORE UPDATE OR DELETE ON public.send_authority_events
  FOR EACH ROW EXECUTE FUNCTION public.p0_append_only_guard();
DROP TRIGGER IF EXISTS p0_authority_events_no_truncate ON public.send_authority_events;
CREATE TRIGGER p0_authority_events_no_truncate
  BEFORE TRUNCATE ON public.send_authority_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.p0_append_only_guard();

ALTER TABLE public.send_queue_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_authority_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.send_queue_status_history FROM anon, authenticated;
REVOKE ALL ON public.send_authority_events FROM anon, authenticated;
-- The API reads with service_role; it never writes these tables directly.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.send_queue_status_history FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.send_authority_events FROM service_role;
GRANT SELECT ON public.send_queue_status_history TO service_role;
GRANT SELECT ON public.send_authority_events TO service_role;

-- ── the floor: every row that exists now is historical ──────────────────────
INSERT INTO public.send_authority_events (key, old_value, new_value)
VALUES ('p0_history_floor', NULL, 'final_dispatch_gate_v2 migration applied');

COMMIT;

-- ROLLBACK (manual, only with the brake set):
--   DROP TRIGGER p0_send_queue_status_history_ins ON public.send_queue;
--   DROP TRIGGER p0_send_queue_status_history_upd ON public.send_queue;
--   DROP TRIGGER p0_send_authority_events_trg ON public.system_control;
-- Keep both tables: they are the audit record. With the triggers gone the
-- v2 gate still reads the tables, so new rows have no INSERT history and are
-- refused (status_history_absent): rolling back the triggers stops sending,
-- it never widens it.
