-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. Synthetic seed for PROPOSED_20261017110000 (no real phones): the cohort (2
-- not_interested threads with an ownership_declined_unverified resolution row), controls that must NOT
-- move (a not_interested thread without that evidence, a declined row on ANOTHER property, a
-- wrong_number, an interested thread with a declined row), a stub bucket view with the view's disposition
-- CASE, the snapshot the posttest compares against, and the pinned expected count (database setting).
insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, disposition, inbox_bucket, follow_up_at, is_suppressed, contactability_status, latest_direction) values
  ('d1500000-0000-4000-8000-000000000001', '+15550001001', '+15550001001', 'P-D1', 'not_interested', null, now() + interval '20 days', false, null, 'outbound'),
  ('d1500000-0000-4000-8000-000000000002', '+15550001002', '+15550001002', 'P-D2', 'not_interested', null, now() + interval '25 days', false, null, 'inbound'),
  ('d1500000-0000-4000-8000-000000000003', '+15550001003', '+15550001003', 'P-C3', 'not_interested', null, now() + interval '30 days', false, null, 'outbound'),
  ('d1500000-0000-4000-8000-000000000004', '+15550001004', '+15550001004', 'P-C4', 'not_interested', null, null, false, null, 'outbound'),
  ('d1500000-0000-4000-8000-000000000005', '+15550001005', '+15550001005', 'P-C5', 'wrong_number', null, null, false, 'invalid_number', 'inbound'),
  ('d1500000-0000-4000-8000-000000000006', '+15550001006', '+15550001006', 'P-C6', 'interested', 'priority', null, false, null, 'inbound');
insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope) values
  ('P-D1', '+15550001001', 'ownership_declined_unverified', null, 'contact_property_pair'),
  ('P-D2', '+15550001002', 'ownership_declined_unverified', null, 'contact_property_pair'),
  ('P-OTHER', '+15550001004', 'ownership_declined_unverified', null, 'contact_property_pair'),
  ('P-C6', '+15550001006', 'ownership_declined_unverified', null, 'contact_property_pair');
insert into public.sms_suppression_list (phone_e164, is_active) values ('+15550001005', true);
-- stub of v_inbox_thread_state_buckets: the same disposition CASE as PROPOSED_20261010120000 (f_bucket)
create or replace view public.v_inbox_thread_state_buckets as
  select s.id, lower(coalesce(s.inbox_bucket,
    case
      when s.is_suppressed = true then 'suppressed'
      when lower(coalesce(s.disposition, '')) = any (array['wrong_number','wrong_person']) then 'dead'
      when lower(coalesce(s.disposition, '')) = any (array['sold','unqualified','declined_unverified']) then 'dead'
      when lower(coalesce(s.disposition, '')) = 'not_interested' then 'follow_up'
      when s.latest_direction = 'inbound' then 'new_replies'
      else 'cold'
    end)) as f_bucket
  from public.inbox_thread_state s;
create table public.lc_mt_dispo_before as
  select s.id, s.disposition, v.f_bucket, (s.property_id in ('P-D1', 'P-D2')) as cohort
    from public.inbox_thread_state s join public.v_inbox_thread_state_buckets v on v.id = s.id;
create table public.lc_mt_dispo_snapshot as
  select (select md5(string_agg(md5((to_jsonb(s) - 'disposition' - 'updated_at')::text), ',' order by s.id)) from public.inbox_thread_state s) as thread_inputs_md5,
         (select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by x.id), '')) from public.sms_suppression_list x) as suppression_md5,
         (select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by x.id), '')) from public.contact_property_resolution x) as cpr_md5;
do $$ begin execute format('alter database %I set lc.disposition_backfill_expected_count = %L', current_database(), '2'); end $$;
