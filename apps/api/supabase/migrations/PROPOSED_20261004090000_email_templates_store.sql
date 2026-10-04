-- PROPOSED — NOT APPLIED. Owner approval required before applying.
-- Email template store: public.email_templates as the Supabase home of every
-- email's copy, KPI-joinable by template_id (email_queue.template_id and
-- email_events.template_id carry the registry key, e.g. 'seller.nurture').
--
-- Mirrors public.sms_templates conventions (template_id, template_name,
-- use_case, stage_code, language, agent_persona, is_active, version,
-- is_follow_up, quarantine_state) and adds an explicit approval state so copy
-- can never go live unreviewed.
--
-- Facts measured 2026-10-04 (read-only):
--   email_templates exists, 0 rows; template_id has NO unique index;
--   is_active DEFAULTS TO TRUE (a naive seed would be live) — changed below.
--
-- Code contract (apps/api/src/lib/domain/email/email-templates.js):
--   * a row overrides the code copy only when is_active = true and its body/
--     subject do not contain the marker 'COPY NOT APPROVED';
--   * seller.followup and seller.nurture are requiresApprovedCopy: with no
--     usable row they REFUSE to render (template_copy_not_approved) and the
--     seller follow-up email lane queues nothing.
--
-- Idempotent; safe to re-run. Wrapped in a transaction.

begin;

-- 1. One row per template_id (0 rows today, so no duplicates to resolve).
create unique index if not exists email_templates_template_id_uidx
  on public.email_templates (template_id)
  where template_id is not null;

-- 2. Approval + lineage columns.
alter table public.email_templates
  add column if not exists family text,
  add column if not exists lane text,
  add column if not exists approval_status text not null default 'draft',
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists quarantine_state text not null default 'active',
  add column if not exists required_variables text[] not null default '{}';

alter table public.email_templates alter column is_active set default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_templates_approval_check') then
    alter table public.email_templates
      add constraint email_templates_approval_check
      check (approval_status in ('draft', 'approved', 'retired'));
  end if;
  -- Copy can only be live once approved, with an approver on record.
  if not exists (select 1 from pg_constraint where conname = 'email_templates_active_requires_approval') then
    alter table public.email_templates
      add constraint email_templates_active_requires_approval
      check (not is_active or (approval_status = 'approved' and approved_by is not null and approved_at is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_templates_lane_check') then
    alter table public.email_templates
      add constraint email_templates_lane_check
      check (lane is null or lane in ('acquisition', 'seller_conversation', 'transactional', 'closing', 'buyer', 'system', 'manual'));
  end if;
end $$;

-- 3. Seed rows for every registry key, INACTIVE + DRAFT, copy placeholder.
--    The owner writes the copy, sets approval_status='approved', approved_by,
--    approved_at, then is_active=true. Closing keys keep their code copy as
--    fallback until a row is approved; seller follow-up/nurture have none.
insert into public.email_templates
  (template_id, template_name, use_case, stage_code, language, family, lane, is_follow_up,
   subject, template_body, required_variables, is_active, approval_status, version, metadata)
values
  ('seller.followup', 'Seller follow-up (email)', 'seller_followup', 'S1-S6', 'en', 'seller', 'seller_conversation', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Owner writes this. Variables: {{first_name}} (optional), {{property_address}}, {{sender_name}}.',
   array['sender_name', 'property_address'], false, 'draft', 1, '{"proposed":"2026-10-04","copy":"not_approved"}'::jsonb),
  ('seller.nurture', 'Seller 30-day nurture (email)', 'nurture_not_interested', 'nurture', 'en', 'seller', 'seller_conversation', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Owner writes this. Sent ~30 days after "not interested" / "not now". Variables: {{first_name}} (optional), {{property_address}}, {{sender_name}}.',
   array['sender_name', 'property_address'], false, 'draft', 1, '{"proposed":"2026-10-04","copy":"not_approved"}'::jsonb),
  ('closing.title_open', 'Open title', 'title_open', 'S7', 'en', 'title', 'closing', false,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.title_followup', 'Title order follow-up', 'title_followup', 'S7', 'en', 'title', 'closing', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name', 'sequence'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.title_commitment_reminder', 'Title commitment reminder', 'title_commitment_reminder', 'S8', 'en', 'title', 'closing', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.clear_to_close_followup', 'Clear-to-close follow-up', 'clear_to_close_followup', 'S9', 'en', 'title', 'closing', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.closing_confirmation', 'Closing confirmation', 'closing_confirmation', 'S9', 'en', 'title', 'closing', false,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name', 'scheduled_closing_date'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.settlement_request', 'Settlement statement request', 'settlement_request', 'S9', 'en', 'settlement', 'closing', false,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.buyer_emd_reminder', 'Buyer EMD reminder', 'buyer_emd_reminder', 'S8', 'en', 'emd', 'buyer', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb),
  ('closing.buyer_agreement_followup', 'Buyer agreement follow-up', 'buyer_agreement_followup', 'S8', 'en', 'agreement', 'buyer', true,
   '[COPY NOT APPROVED] subject', '[COPY NOT APPROVED] Code copy in email-templates.js is used until this row is approved.', array['property_address', 'sender_name'], false, 'draft', 1, '{"proposed":"2026-10-04"}'::jsonb)
on conflict (template_id) where template_id is not null do nothing;

-- 4. KPI join support.
create index if not exists email_queue_template_idx
  on public.email_queue (template_id, sent_at)
  where template_id is not null;

create index if not exists email_events_template_idx
  on public.email_events (template_id, event_type)
  where template_id is not null;

-- 5. Per-template performance read model (events are the truth; opens are
--    signals, never seller intent). security_invoker + no anon, like the
--    other email views (20260929150000_email_views_security).
create or replace view public.v_email_template_performance
with (security_invoker = true) as
select
  t.template_id,
  t.template_name,
  t.family,
  t.lane,
  t.approval_status,
  t.is_active,
  t.version,
  count(*) filter (where e.event_type = 'sent')                          as sent,
  count(*) filter (where e.event_type = 'delivered')                     as delivered,
  count(*) filter (where e.event_type = 'replied')                       as replied,
  count(*) filter (where e.event_type in ('hard_bounce', 'invalid_address')) as hard_bounced,
  count(*) filter (where e.event_type = 'soft_bounce')                   as soft_bounced,
  count(*) filter (where e.event_type = 'unsubscribed')                  as unsubscribed,
  count(*) filter (where e.event_type = 'complaint')                     as complaints,
  count(*) filter (where e.event_type = 'open_signal' and e.signal_class = 'likely_human') as open_signals_likely_human,
  max(e.event_at) filter (where e.event_type = 'sent')                   as last_sent_at
from public.email_templates t
left join public.email_events e on e.template_id = t.template_id
group by t.template_id, t.template_name, t.family, t.lane, t.approval_status, t.is_active, t.version;

revoke all on public.v_email_template_performance from anon;
grant select on public.v_email_template_performance to authenticated, service_role;

commit;

-- ROLLBACK (if needed):
--   drop view if exists public.v_email_template_performance;
--   drop index if exists public.email_events_template_idx;
--   drop index if exists public.email_queue_template_idx;
--   delete from public.email_templates where metadata->>'proposed' = '2026-10-04' and not is_active;
--   alter table public.email_templates drop constraint if exists email_templates_lane_check,
--     drop constraint if exists email_templates_active_requires_approval,
--     drop constraint if exists email_templates_approval_check;
--   alter table public.email_templates alter column is_active set default true;
--   drop index if exists public.email_templates_template_id_uidx;
