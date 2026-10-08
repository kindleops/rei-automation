-- ============================================================================
-- Operator permissions — least privilege on top of the operator allowlist.
-- ============================================================================
-- public.ops_operators (20261003120000_operator_read_policies) says WHO is an
-- operator. It has no notion of what an operator may change. Scheduling
-- configuration — who is bookable, pools and routing, appointment types,
-- other people's calendars — must not be editable by every operator, so a
-- permission is granted explicitly, per operator, here.
--
--   scheduling.admin   create/update bookable people (incl. their routing
--                      keys), pool membership, appointment types and routing.
--
-- Everyone else may still: see appointments, act on them (confirm, complete,
-- no-show, assign, reschedule, cancel, resync), connect/disconnect THEIR OWN
-- calendar, set THEIR OWN hours and time off — once an admin has made them a
-- bookable person.
--
-- No grant is made by this migration. The first admin is granted explicitly
-- by the owner (see docs/integrations/scheduling-core.md, "Permissions").
-- Service role only: the API checks permissions server-side.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ops_operator_permissions (
  user_id     uuid NOT NULL REFERENCES public.ops_operators (user_id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN ('scheduling.admin')),
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

COMMENT ON TABLE public.ops_operator_permissions IS
  'Explicit per-operator permissions (least privilege). Only allowlisted operators (ops_operators) can hold one. Writable only by service_role/postgres.';

ALTER TABLE public.ops_operator_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ops_operator_permissions FROM PUBLIC, anon, authenticated;

COMMIT;
