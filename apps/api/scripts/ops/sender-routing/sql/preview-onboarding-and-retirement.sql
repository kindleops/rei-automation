-- READ-ONLY preview of onboard-indianapolis-tampa.sql (CONFIGURING step) and
-- retire-miami-3057604780.sql: the rows as they are, the rows as the scripts
-- would leave them, and the duplicate / evidence checks. Safe to run any time.
set default_transaction_read_only = on;
begin read only;
-- 1. duplicates: neither new number may already exist locally
select 'duplicate_check' as check, p.phone, exists (select 1 from public.textgrid_numbers t where t.phone_number = p.phone) as already_local
  from (values ('+13173494612'), ('+18138947553')) p(phone);
-- 2. history on the new numbers (expect zero everywhere)
select 'history' as check, p.phone,
       (select count(*) from public.message_events m where m.to_phone_number = p.phone or m.from_phone_number = p.phone) as message_events,
       (select count(*) from public.send_queue s where s.from_phone_number = p.phone) as send_queue
  from (values ('+13173494612'), ('+18138947553'), ('+13057604780')) p(phone);
-- 3. CONFIGURING projection (not inserted)
select 'configuring_projection' as check, v.* from (values
  ('+13173494612', 'INDIANAPOLIS', 'Indianapolis, IN', 'paused', 'registered', 'configuring'),
  ('+18138947553', 'TAMPA, FL', 'Tampa, FL', 'paused', 'registered', 'configuring')) v(phone, friendly_name, market, status, registration_status, onboarding_stage);
-- 4. markets exist canonically
select 'canonical_market' as check, id, display_name from public.canonical_markets where id in ('indianapolis-in', 'tampa-fl');
-- 5. retirement: current vs projected
select 'retire_current' as check, phone_number, status, health_state, metadata->>'lifecycle_state' as lifecycle, last_used_at
  from public.textgrid_numbers where phone_number = '+13057604780';
select 'retire_projection' as check, '+13057604780' as phone_number, 'paused' as status, 'disabled' as health_state, 'retired' as lifecycle;
rollback;
