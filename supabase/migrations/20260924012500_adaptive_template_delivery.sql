-- ADAPTIVE TEMPLATE DELIVERY
--
-- Production evidence this is built on: within one estate, the same intent
-- reaches 0% content-filter over 138 attempts on one body and 100% over 21 on
-- another. 1,933 of ~2,305 lifetime failures (84%) are content-filter blocks,
-- spread evenly across every sender -- which is why every number looks equally
-- unhealthy. The variable is the WORDING, not the number.
--
-- Everything here is ADDITIVE. No existing column changes meaning, and no
-- historical send row is rewritten: performance is DERIVED from send_queue.
--
-- The logical-communication model (seller_logical_communications +
-- seller_communication_attempts) already exists and already carries the
-- invariant that a delivered/terminal communication cannot hold retry
-- authority. Variant fallback reuses it rather than inventing a second one.

-- ── 1. VARIANT GROUPING ──────────────────────────────────────────────────
--
-- A group is the conceptual identity of a message: stage + intent + language
-- + property-context class. It is GENERATED, not hand-maintained, so a
-- template cannot drift out of its own group and no backfill can miss a row.
--
-- property_type_scope participates because a multifamily expenses follow-up
-- and an SFR one are not interchangeable bodies for the same conversation.
alter table public.sms_templates
  add column if not exists variant_group_key text
    generated always as (
      coalesce(nullif(btrim(stage_code), ''), 'nostage') || '|' ||
      coalesce(nullif(btrim(use_case),   ''), 'nouse')   || '|' ||
      coalesce(nullif(btrim(language),   ''), 'nolang')  || '|' ||
      coalesce(nullif(btrim(property_type_scope), ''), 'any')
    ) stored;

-- Ordering hint WITHIN a group. NULL means "rank me by measured performance",
-- which is the default and the honest answer for almost every template.
alter table public.sms_templates
  add column if not exists fallback_rank integer;

-- The final approved low-complexity candidate for a group. Deliberately not
-- called "guaranteed" -- nothing is, across carriers.
alter table public.sms_templates
  add column if not exists minimal_fallback boolean not null default false;

-- ── 2. QUARANTINE ────────────────────────────────────────────────────────
--
-- Demotion, never deletion. A quarantined template stays readable, keeps its
-- history, and can be released by an operator.
alter table public.sms_templates
  add column if not exists quarantine_state text not null default 'active';

alter table public.sms_templates
  add column if not exists quarantined_at timestamptz;

alter table public.sms_templates
  add column if not exists quarantine_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sms_templates'::regclass
      and conname = 'sms_templates_quarantine_state_valid'
  ) then
    alter table public.sms_templates
      add constraint sms_templates_quarantine_state_valid
      check (quarantine_state in ('active', 'quarantined'));
  end if;
end $$;

-- A quarantine must always say why. An unexplained demotion is indistinguishable
-- from a bug, and an operator reviewing it later has nothing to act on.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sms_templates'::regclass
      and conname = 'sms_templates_quarantine_has_reason'
  ) then
    alter table public.sms_templates
      add constraint sms_templates_quarantine_has_reason
      check (
        quarantine_state <> 'quarantined'
        or (quarantine_reason is not null and quarantined_at is not null)
      );
  end if;
end $$;

create index if not exists sms_templates_variant_group_idx
  on public.sms_templates (variant_group_key)
  where is_active and quarantine_state = 'active';

-- ── 3. PER-ATTEMPT VARIANT LINEAGE ───────────────────────────────────────
--
-- seller_communication_attempts is already the durable, per-logical-communication
-- attempt ledger and already records failure_class. It only lacked the answer to
-- "which body did this attempt use, and what did we fall back FROM".
alter table public.seller_communication_attempts
  add column if not exists template_id text;

alter table public.seller_communication_attempts
  add column if not exists variant_group_key text;

alter table public.seller_communication_attempts
  add column if not exists variant_attempt_number integer;

alter table public.seller_communication_attempts
  add column if not exists fallback_from_template_id text;

alter table public.seller_communication_attempts
  add column if not exists fallback_reason text;

alter table public.seller_communication_attempts
  add column if not exists template_selection_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.seller_communication_attempts'::regclass
      and conname = 'seller_communication_attempts_variant_attempt_bounded'
  ) then
    alter table public.seller_communication_attempts
      add constraint seller_communication_attempts_variant_attempt_bounded
      check (variant_attempt_number is null
             or (variant_attempt_number >= 1 and variant_attempt_number <= 8));
  end if;
end $$;

-- THE STRUCTURAL GUARANTEE THAT A BODY IS NEVER RETRIED.
--
-- §3 says "do not retry the identical rendered body" and §19 says two delivery
-- callbacks must not race into two fallbacks. Both are the same claim: one
-- template may be attempted at most once per logical communication. Enforcing
-- it as a unique index means the database refuses the duplicate even if two
-- workers decide to send simultaneously -- application-level checking cannot
-- make that promise.
create unique index if not exists seller_communication_attempts_one_try_per_template
  on public.seller_communication_attempts (logical_communication_id, template_id)
  where template_id is not null;

-- ── 4. DERIVED TEMPLATE PERFORMANCE ──────────────────────────────────────
--
-- A VIEW, not a fact table: send_queue already holds every attempt and its
-- normalized failure. Copying that into a second store would create two
-- numbers that disagree the first time a backfill is missed.
--
-- The join key is sms_templates.template_id (text) = send_queue.template_id
-- (text). The uuid `id` column does NOT join -- measured: 10,069 rows match on
-- the text key, 0 on the uuid.
create or replace view public.v_template_performance as
with attempts as (
  select
    q.template_id,
    q.from_phone_number,
    q.sent_at,
    (q.queue_status = 'delivered')                     as delivered,
    (q.queue_status in ('delivered', 'sent'))          as accepted,
    (coalesce(q.metadata->>'normalized_reason', '') = 'blocked_by_textgrid_content_filter')
                                                       as content_filtered,
    (q.queue_status like 'failed%')                    as failed
  from public.send_queue q
  where q.template_id is not null
    and q.sent_at is not null
)
select
  template_id,
  count(*)                                              as attempts,
  count(*) filter (where accepted)                      as accepted,
  count(*) filter (where delivered)                     as delivered,
  count(*) filter (where content_filtered)              as content_filtered,
  count(*) filter (where failed and not content_filtered) as other_failures,
  round(count(*) filter (where delivered)::numeric
        / nullif(count(*), 0), 4)                       as delivery_rate,
  round(count(*) filter (where content_filtered)::numeric
        / nullif(count(*), 0), 4)                       as content_filter_rate,
  round(count(*) filter (where failed and not content_filtered)::numeric
        / nullif(count(*), 0), 4)                       as other_failure_rate,
  -- Recency: carrier behaviour changes, so a template that has started being
  -- filtered must be able to lose its ranking even with a strong lifetime record.
  count(*) filter (where sent_at >= now() - interval '7 days')  as attempts_7d,
  count(*) filter (where sent_at >= now() - interval '7 days' and content_filtered)
                                                                as content_filtered_7d,
  round(count(*) filter (where sent_at >= now() - interval '7 days' and delivered)::numeric
        / nullif(count(*) filter (where sent_at >= now() - interval '7 days'), 0), 4)
                                                                as delivery_rate_7d,
  round(count(*) filter (where sent_at >= now() - interval '7 days' and content_filtered)::numeric
        / nullif(count(*) filter (where sent_at >= now() - interval '7 days'), 0), 4)
                                                                as content_filter_rate_7d,
  count(*) filter (where sent_at >= now() - interval '30 days') as attempts_30d,
  round(count(*) filter (where sent_at >= now() - interval '30 days' and delivered)::numeric
        / nullif(count(*) filter (where sent_at >= now() - interval '30 days'), 0), 4)
                                                                as delivery_rate_30d,
  round(count(*) filter (where sent_at >= now() - interval '30 days' and content_filtered)::numeric
        / nullif(count(*) filter (where sent_at >= now() - interval '30 days'), 0), 4)
                                                                as content_filter_rate_30d,
  max(sent_at)                                                  as last_sent_at
from attempts
group by template_id;

comment on view public.v_template_performance is
  'Derived per-template deliverability from send_queue. Canonical content-filter '
  'signal is metadata->>normalized_reason = blocked_by_textgrid_content_filter.';

-- Per-sender breakdown (§25). Kept separate so a sparse sender segment can be
-- consulted when it is meaningful and ignored when it is not, rather than
-- diluting the global number.
create or replace view public.v_template_sender_performance as
select
  q.template_id,
  q.from_phone_number,
  count(*)                                   as attempts,
  count(*) filter (where q.queue_status = 'delivered') as delivered,
  count(*) filter (where coalesce(q.metadata->>'normalized_reason','') = 'blocked_by_textgrid_content_filter')
                                             as content_filtered,
  round(count(*) filter (where q.queue_status = 'delivered')::numeric
        / nullif(count(*), 0), 4)            as delivery_rate,
  round(count(*) filter (where coalesce(q.metadata->>'normalized_reason','') = 'blocked_by_textgrid_content_filter')::numeric
        / nullif(count(*), 0), 4)            as content_filter_rate
from public.send_queue q
where q.template_id is not null
  and q.sent_at is not null
  and q.from_phone_number is not null
group by q.template_id, q.from_phone_number;

-- Group-level candidate inventory: how deep a fallback chain each group can
-- actually support. Reported rather than assumed -- a group with 2 candidates
-- cannot honour an 8-deep contract and must say so.
create or replace view public.v_template_variant_groups as
select
  t.variant_group_key,
  max(t.stage_code)          as stage_code,
  max(t.use_case)            as use_case,
  max(t.language)            as language,
  max(t.property_type_scope) as property_type_scope,
  count(*)                                                as candidates,
  count(*) filter (where t.quarantine_state = 'active')   as usable_candidates,
  count(*) filter (where t.minimal_fallback)              as minimal_fallbacks,
  sum(coalesce(p.attempts, 0))                            as group_attempts,
  round(sum(coalesce(p.content_filtered, 0))::numeric
        / nullif(sum(coalesce(p.attempts, 0)), 0), 4)     as group_content_filter_rate
from public.sms_templates t
left join public.v_template_performance p on p.template_id = t.template_id
where t.is_active
group by t.variant_group_key;

-- ── 5. AUTOMATIC QUARANTINE ──────────────────────────────────────────────
--
-- Demotion, never deletion, and always with a recorded reason: an unexplained
-- demotion is indistinguishable from a bug, and an operator reviewing it later
-- would have nothing to act on.
--
-- Two independent triggers, both requiring a meaningful sample. Thresholds are
-- deliberately conservative -- against current production only 2 of 8,782
-- templates qualify, both from the lc-reengage-agent-* family at 86% and 100%
-- content-filtered.
--
-- A group is never emptied: the last surviving candidate is never quarantined,
-- because a group with no usable variant cannot send at all, which is worse
-- than sending copy with a poor record.
create or replace function public.apply_template_quarantine(
  p_min_attempts integer default 20,
  p_filter_ceiling numeric default 0.60,
  p_recent_min integer default 15,
  p_recent_ceiling numeric default 0.70,
  p_dry_run boolean default false
)
returns table (template_id text, variant_group_key text, reason text, attempts bigint, rate numeric)
language plpgsql
as $$
begin
  return query
  with candidates as (
    select t.template_id, t.variant_group_key, p.attempts,
           p.content_filter_rate, p.attempts_7d, p.content_filter_rate_7d,
           case
             when p.attempts >= p_min_attempts and p.content_filter_rate >= p_filter_ceiling
               then 'high_content_filter_rate'
             when p.attempts_7d >= p_recent_min and p.content_filter_rate_7d >= p_recent_ceiling
               then 'recent_filter_spike'
           end as q_reason,
           count(*) over (partition by t.variant_group_key) as group_size
    from public.sms_templates t
    join public.v_template_performance p on p.template_id = t.template_id
    where t.is_active and t.quarantine_state = 'active'
  ),
  eligible as (
    select c.* from candidates c
    where c.q_reason is not null and c.group_size > 1
  ),
  applied as (
    update public.sms_templates s
    set quarantine_state = 'quarantined',
        quarantined_at = now(),
        quarantine_reason = e.q_reason
    from eligible e
    where s.template_id = e.template_id and not p_dry_run
    returning s.template_id
  )
  select e.template_id, e.variant_group_key, e.q_reason,
         e.attempts, coalesce(e.content_filter_rate, e.content_filter_rate_7d)
  from eligible e
  where p_dry_run or e.template_id in (select a.template_id from applied a);
end;
$$;
