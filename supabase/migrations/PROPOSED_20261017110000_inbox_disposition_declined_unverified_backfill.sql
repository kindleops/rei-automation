-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Historical mutation: separate owner authorization required.
--
-- rc-8.5.21 — OWNER DECISION LOCKED 2026-10-17: the distinct disposition 'declined_unverified' (a polite
-- decline / bare "Not interested" to the OWNERSHIP question, ownership UNVERIFIED). Legacy threads still
-- carry 'not_interested', which is the 30-day nurture.
--
-- COHORT (evidence-backed only, never inferred here): inbox_thread_state rows whose disposition is
-- 'not_interested' AND whose phone × property already has a contact_property_resolution row with role
-- 'ownership_declined_unverified' (written by the live classifier path or by the authorized
-- historical correction PROPOSED_ownership_correction_20261017).
--
-- CHANGES THE DISPOSITION ONLY: inbox_thread_state.disposition 'not_interested' → 'declined_unverified'
-- for the cohort. Nothing else is written: is_suppressed, contactability_status, inbox_bucket,
-- follow_up_at, metadata, sms_suppression_list, contact_property_resolution and send_queue stay
-- byte-identical. The prior value goes to a backup table (public.disposition_backfill_20261017) so the
-- rollback is exact. updated_at is re-stamped by the live touch trigger on any UPDATE, and the backup
-- keeps the original value.
-- INTENDED OUTCOME (the only eligibility difference): the 30-day nurture no longer applies, because the
-- disposition no longer reads not_interested. Suppression and contactability are unchanged.
--
-- PRECONDITIONS (RAISE on drift):
--   * PROPOSED_20261017100000 applied (the role value exists);
--   * the inbox bucket view maps 'declined_unverified' (else the derived bucket would change silently);
--   * lc.disposition_backfill_expected_count is set, and equals the cohort count right now (dry-run first:
--     PROPOSED_20261017110000_..._dryrun.sql);
--   * no backup table yet (not already applied).
--   PGOPTIONS='-c lc.disposition_backfill_expected_count=<N from the dry run>' psql "$DB" -v ON_ERROR_STOP=1 -f <this file>
-- Rollback: PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare n int; expected text; def text;
begin
  if to_regclass('public.disposition_backfill_20261017') is not null then raise exception 'precondition: already applied (backup table exists)'; end if;
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.contact_property_resolution'::regclass and c.conname = 'contact_property_resolution_contact_property_role_check';
  if def is null or position('ownership_declined_unverified' in def) = 0 then raise exception 'precondition: PROPOSED_20261017100000 (role ownership_declined_unverified) is not applied'; end if;
  if to_regclass('public.v_inbox_thread_state_buckets') is null or position('declined_unverified' in pg_get_viewdef('public.v_inbox_thread_state_buckets'::regclass)) = 0 then
    raise exception 'precondition: v_inbox_thread_state_buckets does not map declined_unverified (apply the bucket view first, else derived buckets change silently)';
  end if;
  expected := nullif(current_setting('lc.disposition_backfill_expected_count', true), '');
  if expected is null then raise exception 'precondition: set lc.disposition_backfill_expected_count to the dry-run count'; end if;
  select count(*) into n from public.inbox_thread_state s
   where lower(coalesce(s.disposition, '')) = 'not_interested'
     and exists (select 1 from public.contact_property_resolution c
                  where c.contact_property_role = 'ownership_declined_unverified'
                    and c.property_id = s.property_id
                    and c.contact_phone_e164 in (s.thread_key, s.canonical_e164, '+1' || right(regexp_replace(coalesce(s.thread_key, ''), '\D', '', 'g'), 10)));
  if n::text <> expected then raise exception 'precondition: cohort drifted: % rows now, % expected', n, expected; end if;
end $$;

create table public.disposition_backfill_20261017 (
  thread_state_id uuid primary key,
  prior_disposition text not null,
  prior_updated_at timestamptz,
  backfilled_at timestamptz not null default now()
);
revoke all on public.disposition_backfill_20261017 from public, anon, authenticated;

insert into public.disposition_backfill_20261017 (thread_state_id, prior_disposition, prior_updated_at)
select s.id, s.disposition, s.updated_at from public.inbox_thread_state s
 where lower(coalesce(s.disposition, '')) = 'not_interested'
   and exists (select 1 from public.contact_property_resolution c
                where c.contact_property_role = 'ownership_declined_unverified'
                  and c.property_id = s.property_id
                  and c.contact_phone_e164 in (s.thread_key, s.canonical_e164, '+1' || right(regexp_replace(coalesce(s.thread_key, ''), '\D', '', 'g'), 10)));

update public.inbox_thread_state s set disposition = 'declined_unverified'
  from public.disposition_backfill_20261017 b where b.thread_state_id = s.id;

do $$
declare n int; m int;
begin
  select count(*) into n from public.disposition_backfill_20261017;
  select count(*) into m from public.inbox_thread_state s join public.disposition_backfill_20261017 b on b.thread_state_id = s.id where s.disposition = 'declined_unverified';
  if n <> m or n::text <> current_setting('lc.disposition_backfill_expected_count') then raise exception 'postcondition: % backed up, % rewritten', n, m; end if;
end $$;
commit;
