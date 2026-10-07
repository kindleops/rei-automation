-- PROPOSED — opt-out list guard (2026-10-06). WRITTEN, NOT APPLIED.
--
-- Belt and braces under the fail-closed code writer
-- (apps/api/src/lib/domain/compliance/record-phone-suppression.js): whenever a
-- conversation becomes contactability_status = 'opted_out' — by ANY code path,
-- old or new — the database itself guarantees the phone-scoped
-- sms_suppression_list row that campaign eligibility, the campaign target graph
-- and the send-time guard read. Measured 2026-10-06: 10 opted-out threads had
-- no list row (7 from the 2026-09-08/09 defect, 2 swallowed upsert errors, 1
-- hostile-era "Don't ever text me again").
--
-- Scope is deliberately ONLY 'opted_out' (an explicit seller opt-out). It does
-- not touch do_not_text (wrong person / legal hold are relationship- or
-- review-scoped; the code paths own those), never deactivates a row, and is
-- idempotent on the NULLS NOT DISTINCT (phone_e164, sender_phone_e164) key.
-- The existing 10 are repaired by scripts/repair/optout-sweep-20261006.mjs.
-- Rollback: PROPOSED_20261007020000_opt_out_thread_state_list_guard_rollback.sql

begin;

create or replace function public.trg_opt_out_thread_state_list_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.thread_key ~ '^\+1[2-9][0-9]{9}$'
     and lower(coalesce(new.contactability_status, '')) = 'opted_out'
     and (tg_op = 'INSERT' or lower(coalesce(old.contactability_status, '')) is distinct from 'opted_out') then
    insert into public.sms_suppression_list
      (phone_e164, sender_phone_e164, phone_number, suppression_type, suppression_reason, reason, is_active, suppressed_at, source)
    values
      (new.thread_key, null, new.thread_key, 'opt_out', 'opt_out', 'opt_out', true, now(), 'thread_state_opt_out_guard')
    on conflict (phone_e164, sender_phone_e164) do update
      set is_active = true
      where public.sms_suppression_list.is_active is distinct from true
        and public.sms_suppression_list.suppression_type = 'opt_out';
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_opt_out_thread_state_list_guard on public.inbox_thread_state;
create trigger trg_opt_out_thread_state_list_guard
  after insert or update of contactability_status on public.inbox_thread_state
  for each row execute function public.trg_opt_out_thread_state_list_guard();

commit;

-- Pretest (read-only): threads the guard would have covered, today.
--   select count(*) from public.inbox_thread_state t
--    where lower(coalesce(t.contactability_status,'')) = 'opted_out'
--      and not exists (select 1 from public.sms_suppression_list s
--                       where s.phone_e164 = t.thread_key and s.sender_phone_e164 is null);
--   -- 2026-10-06: 13 (all time; the sweep since 09-01 covers 10). Also 154 threads are is_suppressed with no list row (wrong number, do_not_text, legacy) — out of scope here, blocked at send time by the is_suppressed guard.
-- Verify after apply: the same query returns 0 for every NEW opt-out.
