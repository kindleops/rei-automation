-- ROLLBACK for PROPOSED_20261015120000_repeat_asking_price_question_kind.sql.
-- Restores the LIVE production body of public.block_repeat_asking_price() verbatim
-- (pg_get_functiondef, captured read-only 2026-10-15) and removes the comment the
-- migration added. Trigger and grants were never changed. Rows the new body
-- cancelled stay cancelled (their metadata.repeat_ask_guard records why).
begin;

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

comment on function public.block_repeat_asking_price() is null;

commit;
