-- PROPOSED ONLY (8.5.16) — repo MIRROR of the LIVE production trigger trg_block_repeat_asking_price
-- on public.send_queue (owner directive 2026-10-13: never ask a seller for their asking price twice).
-- It is ALREADY LIVE in production; this file reconciles repo history and is the source the
-- critical tests mirror (tests/helpers/block-repeat-asking-price-mirror.mjs parses it).
-- Applying it is idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS / CREATE TRIGGER) and
-- reproduces the live definition byte-for-byte (function body md5 06b3a9f70fd9d823e15bcdd81816659e,
-- read 2026-10-14, BEGIN READ ONLY). No rollback file: dropping it would remove a live guard.
-- Pretest (READ ONLY, changes nothing): PROPOSED_20261014120000_block_repeat_asking_price_mirror_pretest.sql

CREATE OR REPLACE FUNCTION public.block_repeat_asking_price()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- Owner directive 2026-10-13: never ask a seller for their asking price twice.
BEGIN
  IF NEW.queue_status IN ('scheduled','queued','pending','approval')
     AND NEW.thread_key IS NOT NULL
     AND coalesce(NEW.use_case_template,'') ~* 'asking_price'
     AND EXISTS (SELECT 1 FROM public.send_queue p
                 WHERE p.thread_key = NEW.thread_key AND p.id <> NEW.id
                   AND p.queue_status IN ('sent','delivered','processing')
                   AND coalesce(p.use_case_template,'') ~* 'asking_price')
  THEN
    NEW.queue_status := 'cancelled';
    NEW.paused_reason := 'blocked_repeat_asking_price';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_block_repeat_asking_price ON public.send_queue;
CREATE TRIGGER trg_block_repeat_asking_price BEFORE INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc ON public.send_queue FOR EACH ROW EXECUTE FUNCTION public.block_repeat_asking_price();
