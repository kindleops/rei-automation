-- lc-fixture: verify
-- PROPOSED ONLY — DRY RUN for PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill.sql.
-- Selects only (safe under BEGIN READ ONLY). The first row's detail is the count to pin as
-- lc.disposition_backfill_expected_count. Every row must say ok = true.
-- PRODUCTION: PROVISIONAL — run inside BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; with a
-- role-enforced read-only credential, after PROPOSED_20261017100000 and the authorized correction.
with cohort as (
  select s.id, s.inbox_bucket, s.follow_up_at, s.is_suppressed, s.contactability_status from public.inbox_thread_state s
   where lower(coalesce(s.disposition, '')) = 'not_interested'
     and exists (select 1 from public.contact_property_resolution c
                  where c.contact_property_role = 'ownership_declined_unverified'
                    and c.property_id = s.property_id
                    and c.contact_phone_e164 in (s.thread_key, s.canonical_e164, '+1' || right(regexp_replace(coalesce(s.thread_key, ''), '\D', '', 'g'), 10)))
)
select 'dry run: cohort count (pin as lc.disposition_backfill_expected_count)' as check, true as ok, (select count(*)::text from cohort) as detail
union all select 'dry run: cohort rows with an explicit inbox_bucket (unchanged by the backfill)', true, (select count(*)::text from cohort where inbox_bucket is not null)
union all select 'dry run: cohort rows with a follow_up_at (left in place; the nurture no longer applies)', true, (select count(*)::text from cohort where follow_up_at is not null)
union all select 'dry run: cohort rows already suppressed (suppression is never changed)', true, (select count(*)::text from cohort where is_suppressed is true)
union all select 'dry run: not yet applied', to_regclass('public.disposition_backfill_20261017') is null, null;
