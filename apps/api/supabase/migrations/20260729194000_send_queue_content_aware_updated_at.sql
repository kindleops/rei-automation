-- send_queue: stop meaningless updated_at churn
--
-- Problem observed in production: the six stale 2026-07-01 rows had updated_at
-- advanced on every reconcile cycle without any change to their content. Two
-- facts combined to produce that:
--
--   1. guard_send_queue_stale_expiration blocks an illegal expiration by
--      REVERTING columns and returning NEW (it does not RAISE), so the UPDATE
--      still commits.
--   2. The legacy trigger update_send_queue_timestamp fires afterwards (BEFORE
--      triggers run in alphabetical name order, so `update_...` ran last) and
--      unconditionally sets updated_at = now().
--
-- Net effect: a fully blocked write still produced a new row version with a
-- fresh updated_at. That is not an audit signal, it is noise — and it is load
-- bearing noise, because campaign-stale-expiration-recovery.js picks rows by
-- max(updated_at) and the reconcile sweep orders by updated_at ASC, so the
-- churn perpetuated itself and skewed recovery selection.
--
-- Fix: make the touch content-aware. Any genuine change to any column still
-- bumps updated_at (audit timestamps are NOT weakened); an UPDATE whose
-- post-trigger row is byte-identical to the old row preserves the previous
-- updated_at.
--
-- Secondary purpose: update_send_queue_timestamp exists in production but in NO
-- repository migration (it came from a baseline dump that was later removed), so
-- a replayed database would have different updated_at semantics than production.
-- This migration brings the behaviour under version control.

CREATE OR REPLACE FUNCTION public.send_queue_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Compare everything except updated_at itself. to_jsonb() comparison keeps
    -- this column-list agnostic, so adding a send_queue column cannot silently
    -- create a new class of unnoticed churn.
    IF (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      NEW.updated_at := OLD.updated_at;
      RETURN NEW;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.send_queue_touch_updated_at() IS
  'Bumps send_queue.updated_at only when row content actually changes. Must fire AFTER the guard_* triggers so guard reverts are visible; the zz_ trigger-name prefix guarantees last-in-alphabetical-order execution.';

REVOKE ALL ON FUNCTION public.send_queue_touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_queue_touch_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.send_queue_touch_updated_at() FROM authenticated;

-- Replace the legacy unconditional trigger. Dropped by name; safe if absent.
DROP TRIGGER IF EXISTS update_send_queue_timestamp ON public.send_queue;
DROP TRIGGER IF EXISTS zz_send_queue_touch_updated_at ON public.send_queue;

CREATE TRIGGER zz_send_queue_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.send_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.send_queue_touch_updated_at();
