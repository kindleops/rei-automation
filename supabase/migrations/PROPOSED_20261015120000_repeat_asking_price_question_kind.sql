-- PROPOSED (rc-8.5.15.1, 2026-10-15) — NOT APPLIED. Owner approval required.
--
-- Duplicate asking-price protection on EVERY outbound path.
--
-- Live today (owner directive 2026-10-13): trigger trg_block_repeat_asking_price
-- (BEFORE INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc
-- ON public.send_queue) cancels a pending row whose use_case_template ~*
-- 'asking_price' when the thread already has a sent / delivered / processing
-- asking_price row. Gap: an operator-typed price question is stored as
-- use_case_template = 'manual_reply' (31 in the 30 days to 2026-10-14), so it was
-- neither blocked nor counted as a prior ask; AI and follow-up rows likewise.
--
-- This replaces ONLY the function body (the trigger, its columns, its name and
-- the function's grants are unchanged — CREATE OR REPLACE keeps the ACL):
--
--   an "asking-price row" = use_case_template ~* 'asking_price'
--                         OR use_case_template ~* '^s3_no_response_'
--                         OR metadata->>'question_kind' = 'asking_price'
--   (every app writer stamps question_kind from the shared classifier,
--    apps/api/src/lib/domain/seller-flow/asking-price-question.js)
--   — for the NEW row and for the PRIOR rows alike.
--
--   A pending asking-price row on a thread whose latest prior asking-price row is
--   sent / delivered / processing is CANCELLED (paused_reason
--   'blocked_repeat_asking_price'), except:
--     (c) the S3 no-response follow-up (use_case s3_no_response_* or
--         metadata.no_response_followup.kind = 's3_asking_price') is a legitimate
--         re-ask after SILENCE: allowed when no inbound message arrived on the
--         thread after that latest ask; cancelled
--         ('blocked_repeat_asking_price_seller_replied') when the seller replied;
--     (d) an audited manual override: a manual operator send
--         (metadata.manual_operator_send = true) carrying
--         metadata.repeat_ask_override = {scope:'repeat_asking_price', actor,
--         reason (≥ 10 chars), at}. It lets the row through THIS guard only;
--         suppression / STOP / legal / contact-window guards are separate and
--         unaffected.
--   A cancelled row also records metadata.repeat_ask_guard (prior ask time, rule).
--   It stays a BEFORE trigger that cancels and NEVER raises: no writer crashes.
--
-- Rollback: PROPOSED_20261015120000_repeat_asking_price_question_kind_rollback.sql
-- restores the live body verbatim (captured read-only 2026-10-15).
-- Test: node scripts/db/run-migration-test.mjs --pg-bin <dir> --id repeat_asking_price_question_kind
--       (disposable database only; pretest / posttest are the companion fixtures).
begin;

create or replace function public.block_repeat_asking_price()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
-- Owner directive 2026-10-13: never ask a seller for their asking price twice.
-- rc-8.5.15.1: keyed on use_case_template OR metadata.question_kind (new row and
-- prior rows); S3 no-response follow-up allowed after silence only; audited manual
-- override honoured by this guard only. Cancels, never raises.
declare
  v_last_ask timestamptz;
  v_override jsonb;
  v_is_s3_followup boolean;
begin
  if NEW.queue_status not in ('scheduled','queued','pending','approval') or NEW.thread_key is null then
    return NEW;
  end if;

  if not (coalesce(NEW.use_case_template, '') ~* 'asking_price'
          or coalesce(NEW.use_case_template, '') ~* '^s3_no_response_'
          or coalesce(NEW.metadata ->> 'question_kind', '') = 'asking_price') then
    return NEW;
  end if;

  select max(coalesce(p.sent_at, p.delivered_at, p.updated_at, p.created_at))
    into v_last_ask
    from public.send_queue p
   where p.thread_key = NEW.thread_key
     and p.id <> NEW.id
     and p.queue_status in ('sent','delivered','processing')
     and (coalesce(p.use_case_template, '') ~* 'asking_price'
          or coalesce(p.use_case_template, '') ~* '^s3_no_response_'
          or coalesce(p.metadata ->> 'question_kind', '') = 'asking_price');

  if v_last_ask is null then
    return NEW; -- the first ask on this thread
  end if;

  -- (c) S3 no-response follow-up: a re-ask after SILENCE only.
  v_is_s3_followup := coalesce(NEW.use_case_template, '') ~* '^s3_no_response_'
                      or coalesce(NEW.metadata -> 'no_response_followup' ->> 'kind', '') = 's3_asking_price';
  if v_is_s3_followup then
    if exists (select 1 from public.message_events m
                where m.thread_key = NEW.thread_key
                  and lower(coalesce(m.direction, '')) = 'inbound'
                  and coalesce(m.event_timestamp, m.received_at, m.created_at) > v_last_ask) then
      NEW.queue_status := 'cancelled';
      NEW.paused_reason := 'blocked_repeat_asking_price_seller_replied';
      NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('repeat_ask_guard',
        jsonb_build_object('rule', 's3_followup_seller_replied', 'prior_ask_at', v_last_ask, 'blocked_at', now()));
    end if;
    return NEW;
  end if;

  -- (d) the audited manual override (this guard only).
  v_override := NEW.metadata -> 'repeat_ask_override';
  if jsonb_typeof(v_override) = 'object'
     and coalesce(NEW.metadata ->> 'manual_operator_send', '') = 'true'
     and coalesce(v_override ->> 'scope', '') = 'repeat_asking_price'
     and nullif(btrim(coalesce(v_override ->> 'actor', '')), '') is not null
     and length(btrim(coalesce(v_override ->> 'reason', ''))) >= 10
     and nullif(btrim(coalesce(v_override ->> 'at', '')), '') is not null then
    return NEW;
  end if;

  NEW.queue_status := 'cancelled';
  NEW.paused_reason := 'blocked_repeat_asking_price';
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('repeat_ask_guard',
    jsonb_build_object('rule', 'repeat_asking_price', 'prior_ask_at', v_last_ask, 'blocked_at', now()));
  return NEW;
end
$function$;

comment on function public.block_repeat_asking_price() is
  'Owner directive 2026-10-13 (rc-8.5.15.1): cancels a repeat asking-price ask (use_case_template ~* asking_price | s3_no_response_* | metadata.question_kind = asking_price) when the thread already has a sent/delivered/processing ask. S3 no-response follow-up allowed after silence only; audited manual override (metadata.repeat_ask_override) honoured by this guard only. Never raises.';

commit;
