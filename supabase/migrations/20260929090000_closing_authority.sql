-- CLOSING AUTHORITY (2026-09-29)
--
-- Gives LeadCommand canonical write authority over a closing, from executed
-- contract to settled money, and makes CLOSED-WON impossible without it.
-- Additive: no existing column changes meaning; the one live row (the voided
-- $4,100 case) is untouched.
--
--   closing_cases            + explicit title / clear-to-close / closed / terminal
--                              / automation columns (with provenance CHECKs)
--   closing_title_issues     real transaction title issues (not property intel)
--   closing_email_requests   the Closing → Email Command contract (outbox)
--   settlement immutability  a settled leg's actuals can never be rewritten
--   finalize_closing_case()  the ONE atomic S10 transition
--   closed-won guard         no writer anywhere can set acquisition_stage
--                              'closed' / status 'won' for a live deal unless
--                              its closing case was finalized

-- ── closing_cases: explicit authority columns ──────────────────────────────
alter table public.closing_cases
  add column if not exists closing_tz text,
  add column if not exists closing_date_confirmed_at timestamptz,
  add column if not exists closing_date_source text,
  add column if not exists title_acknowledged_at timestamptz,
  add column if not exists title_acknowledged_source text,
  add column if not exists title_commitment_received_at timestamptz,
  add column if not exists title_commitment_evidence text,
  add column if not exists clear_to_close_at timestamptz,
  add column if not exists clear_to_close_source text,
  add column if not exists clear_to_close_evidence text,
  add column if not exists clear_to_close_actor text,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by text,
  add column if not exists terminal_outcome text,
  add column if not exists terminal_reason text,
  add column if not exists terminal_at timestamptz,
  add column if not exists terminal_actor text,
  add column if not exists automation_paused_at timestamptz,
  add column if not exists automation_paused_reason text,
  add column if not exists automation_paused_by text,
  add column if not exists automation_state jsonb not null default '{}'::jsonb;

do $$ begin
  alter table public.closing_cases add constraint closing_cases_ctc_requires_provenance
    check (clear_to_close_at is null or (clear_to_close_source is not null and clear_to_close_evidence is not null and clear_to_close_actor is not null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.closing_cases add constraint closing_cases_terminal_outcome_check
    check (terminal_outcome is null or terminal_outcome in ('cancelled', 'failed', 'withdrawn'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.closing_cases add constraint closing_cases_terminal_requires_reason
    check (terminal_outcome is null or (terminal_reason is not null and terminal_at is not null and terminal_actor is not null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.closing_cases add constraint closing_cases_closed_requires_closed_at
    check (closing_status is distinct from 'closed' or closed_at is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.closing_cases add constraint closing_cases_closed_not_terminal
    check (closed_at is null or terminal_outcome is null);
exception when duplicate_object then null; end $$;

-- ── title issues ───────────────────────────────────────────────────────────
create table if not exists public.closing_title_issues (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null unique,
  closing_case_id text not null references public.closing_cases (closing_case_id),
  issue_type text not null check (issue_type in ('open_lien', 'probate', 'name_discrepancy', 'hoa_balance', 'missing_release', 'tax', 'judgment', 'easement', 'survey', 'other')),
  description text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'waived')),
  owner text not null default 'title' check (owner in ('you', 'seller', 'buyer', 'title', 'lender', 'system')),
  source text not null,
  evidence_reference text,
  notes text,
  opened_at timestamptz not null default now(),
  opened_by text not null,
  resolved_at timestamptz,
  resolved_by text,
  resolution_evidence text,
  updated_at timestamptz not null default now(),
  -- a closed issue must say how and by whom
  constraint closing_title_issues_resolution_provenance check (
    status in ('open', 'in_progress') or (resolved_at is not null and resolved_by is not null and resolution_evidence is not null)
  )
);
create index if not exists closing_title_issues_case_idx on public.closing_title_issues (closing_case_id, status);
alter table public.closing_title_issues enable row level security;
revoke all on public.closing_title_issues from anon, authenticated;

-- ── closing → email command contract (outbox) ──────────────────────────────
-- Closing automation never sends. It requests; the email system claims
-- pending_transport rows, sends through its own suppression/thread rules and
-- writes the result back here.
create table if not exists public.closing_email_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  closing_case_id text not null references public.closing_cases (closing_case_id),
  opportunity_id uuid,
  property_id text,
  title_company_key text,
  action text not null check (action in (
    'title_open', 'title_followup', 'title_commitment_reminder', 'clear_to_close_followup',
    'closing_confirmation', 'settlement_request', 'buyer_emd_reminder', 'buyer_agreement_followup')),
  category text not null,
  sequence integer not null default 1,
  recipient_role text not null check (recipient_role in ('title', 'buyer', 'seller', 'lender')),
  recipient_email text,
  template_key text not null,
  template_version text not null,
  thread_key text not null,
  status text not null default 'pending_transport' check (status in ('pending_transport', 'claimed', 'sent', 'failed', 'cancelled', 'skipped')),
  status_reason text,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  due_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  delivery_status text,
  email_queue_id text,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists closing_email_requests_pending_idx on public.closing_email_requests (status, due_at) where status = 'pending_transport';
create index if not exists closing_email_requests_case_idx on public.closing_email_requests (closing_case_id, category, sequence);
alter table public.closing_email_requests enable row level security;
revoke all on public.closing_email_requests from anon, authenticated;

-- ── settlement immutability ────────────────────────────────────────────────
-- Once a leg is settled its actuals and evidence are the financial record.
-- Corrections go through post_close_exception_* (additive), never rewrites.
create or replace function public.settlement_records_immutable_when_settled()
returns trigger language plpgsql as $$
begin
  if old.settlement_status = 'settled' then
    if new.settlement_status is distinct from old.settlement_status and new.settlement_status <> 'reversed'
      or new.actual_seller_amount is distinct from old.actual_seller_amount
      or new.actual_buyer_amount is distinct from old.actual_buyer_amount
      or new.actual_assignment_fee is distinct from old.actual_assignment_fee
      or new.actual_closing_costs is distinct from old.actual_closing_costs
      or new.actual_other_costs is distinct from old.actual_other_costs
      or new.actual_net_proceeds is distinct from old.actual_net_proceeds
      or new.closed_at is distinct from old.closed_at
      or new.evidence_reference is distinct from old.evidence_reference
      or new.settlement_statement_reference is distinct from old.settlement_statement_reference
      or new.verified_by is distinct from old.verified_by
      or new.verified_at is distinct from old.verified_at
    then
      raise exception using errcode = 'P0001', message = 'SETTLEMENT_IMMUTABLE: a settled record''s actuals cannot be rewritten; record a post-close exception instead';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_settlement_records_immutable on public.settlement_records;
create trigger trg_settlement_records_immutable before update on public.settlement_records
  for each row execute function public.settlement_records_immutable_when_settled();

-- ── closed-won guard (the backstop under every writer) ─────────────────────
-- A deal may be CLOSED-LOST freely (dead / suppressed / lost / archived).
-- CLOSED-WON (stage closed with a live status, or status won) requires its
-- closing case to have been finalized by finalize_closing_case().
create or replace function public.enforce_closed_won_authority()
returns trigger language plpgsql as $$
declare
  v_lost boolean := coalesce(new.opportunity_status, 'active') in ('dead', 'suppressed', 'lost', 'archived');
  v_entering_closed boolean := new.acquisition_stage = 'closed'
    and (tg_op = 'INSERT' or old.acquisition_stage is distinct from 'closed' or old.opportunity_status is distinct from new.opportunity_status);
  v_entering_won boolean := new.opportunity_status = 'won'
    and (tg_op = 'INSERT' or old.opportunity_status is distinct from 'won');
begin
  if (v_entering_closed and not v_lost) or v_entering_won then
    if not exists (
      select 1 from public.closing_cases cc
      where cc.opportunity_id = new.id and cc.closing_status = 'closed' and cc.closed_at is not null and cc.terminal_outcome is null
    ) then
      raise exception using errcode = 'P0001',
        message = 'CLOSING_BLOCKED: closed-won requires a finalized closing (finalize_closing_case)';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_acquisition_opportunities_closed_won_authority on public.acquisition_opportunities;
create trigger trg_acquisition_opportunities_closed_won_authority
  before insert or update of acquisition_stage, opportunity_status on public.acquisition_opportunities
  for each row execute function public.enforce_closed_won_authority();

-- ── the ONE atomic S10 transition ──────────────────────────────────────────
-- The application evaluates the full guard (buyer, agreement, EMD, title,
-- schedule, settlement) and returns structured blockers. This function
-- re-checks the financial core under a row lock so a concurrent change
-- cannot slip between check and write, then moves case + opportunity +
-- milestone + audit event in one transaction. Idempotent.
create or replace function public.finalize_closing_case(p_closing_case_id text, p_actor text, p_source text)
returns jsonb language plpgsql as $$
declare
  c public.closing_cases%rowtype;
  v_missing text[] := '{}';
  v_now timestamptz := now();
  v_fee numeric; v_net numeric; v_closed_at timestamptz; v_funded_at timestamptz; v_recorded_at timestamptz;
begin
  if coalesce(trim(p_actor), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'CLOSING_BLOCKED', 'missing', jsonb_build_array('actor_required'));
  end if;
  perform pg_advisory_xact_lock(hashtext('closing_finalize:' || p_closing_case_id));
  select * into c from public.closing_cases where closing_case_id = p_closing_case_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CLOSING_NOT_FOUND');
  end if;
  if c.closing_status = 'closed' and c.closed_at is not null then
    return jsonb_build_object('ok', true, 'already_closed', true, 'closed_at', c.closed_at);
  end if;

  if c.terminal_outcome is not null or coalesce((c.provenance ->> 'voided')::boolean, false) or c.contract_status in ('cancelled', 'declined') then
    v_missing := array_append(v_missing, 'closing_terminated');
  end if;
  if c.contract_status is distinct from 'fully_executed' then v_missing := array_append(v_missing, 'seller_contract_not_executed'); end if;
  if c.clear_to_close_at is null then v_missing := array_append(v_missing, 'title_not_clear_to_close'); end if;
  if c.closing_date_confirmed_at is null or c.scheduled_closing_date is null then v_missing := array_append(v_missing, 'closing_date_not_confirmed'); end if;
  if exists (select 1 from public.closing_title_issues i where i.closing_case_id = c.closing_case_id and i.status in ('open', 'in_progress')) then
    v_missing := array_append(v_missing, 'open_title_issues');
  end if;
  if not exists (select 1 from public.settlement_records s where s.closing_case_id = c.closing_case_id and s.settlement_status = 'settled') then
    v_missing := array_append(v_missing, 'settlement_not_settled');
  end if;
  if exists (select 1 from public.settlement_records s where s.closing_case_id = c.closing_case_id and s.settlement_status in ('pending', 'failed')) then
    v_missing := array_append(v_missing, 'settlement_leg_unsettled');
  end if;
  if array_length(v_missing, 1) is not null then
    return jsonb_build_object('ok', false, 'code', 'CLOSING_BLOCKED', 'missing', to_jsonb(v_missing));
  end if;

  select sum(actual_assignment_fee), sum(actual_net_proceeds), max(closed_at), max(funded_at), max(recorded_at)
    into v_fee, v_net, v_closed_at, v_funded_at, v_recorded_at
    from public.settlement_records where closing_case_id = c.closing_case_id and settlement_status = 'settled';

  update public.closing_cases set
    closing_status = 'closed',
    universal_stage = 'closed',
    closed_at = coalesce(v_closed_at, v_now),
    closed_by = p_actor,
    funding_date = coalesce(funding_date, v_funded_at, v_closed_at, v_now),
    recording_date = coalesce(recording_date, v_recorded_at),
    confirmed_gross_revenue = coalesce(v_fee, confirmed_gross_revenue),
    net_revenue = coalesce(v_net, net_revenue),
    revenue_status = 'confirmed',
    revenue_confirmed_date = v_now,
    last_activity_at = v_now
  where closing_case_id = c.closing_case_id;

  if c.opportunity_id is not null then
    update public.acquisition_opportunities set
      acquisition_stage = 'closed',
      opportunity_status = 'won',
      stage_entered_at = v_now,
      last_updated_source = 'closing_authority'
    where id = c.opportunity_id;
  end if;

  insert into public.closing_milestones (closing_case_id, milestone_type, source_system, source_entity_id, occurred_at, actor, prior_state, resulting_state, snapshot, idempotency_key)
  values (c.closing_case_id, 'closed', 'closing_authority', c.closing_case_id, coalesce(v_closed_at, v_now), p_actor, c.closing_status, 'closed',
          jsonb_build_object('source', p_source, 'actual_assignment_fee', v_fee, 'actual_net_proceeds', v_net), 'closing:' || c.closing_case_id || ':closed:final')
  on conflict (idempotency_key) do nothing;

  insert into public.closing_activity_events (closing_case_id, event_type, actor, source, detail, idempotency_key)
  values (c.closing_case_id, 'closing_finalized', p_actor, p_source,
          jsonb_build_object('prior_closing_status', c.closing_status, 'prior_stage', c.universal_stage, 'actual_assignment_fee', v_fee, 'actual_net_proceeds', v_net),
          'closing_finalized:' || c.closing_case_id)
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('ok', true, 'closed_at', coalesce(v_closed_at, v_now), 'actual_assignment_fee', v_fee, 'actual_net_proceeds', v_net);
end $$;
revoke all on function public.finalize_closing_case(text, text, text) from public, anon, authenticated;

-- automation kill switch (explicit row: getSystemFlag fails closed on absence)
insert into public.system_control (key, value)
values ('closing_automation_enabled', 'true')
on conflict (key) do nothing;
