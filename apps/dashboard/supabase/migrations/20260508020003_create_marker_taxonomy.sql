-- Deal Marker Taxonomy for Map visualization
create table if not exists public.deal_marker_taxonomy (
  id uuid primary key default gen_random_uuid(),
  rule_name text not null,
  priority integer not null default 0, -- Higher priority rules evaluated first
  
  -- Match criteria (null means match all)
  match_intent text,
  match_stage text,
  match_property_type text,
  match_min_score integer,
  match_status text,
  
  -- Visual config
  shape text not null default 'circle',
  color text not null default '#6b7280',
  size integer not null default 10,
  label text,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.deal_marker_taxonomy enable row level security;
create policy deal_marker_taxonomy_select on public.deal_marker_taxonomy for select using (true);

-- Insert Default Taxonomy
insert into public.deal_marker_taxonomy (rule_name, priority, match_intent, color, label, shape)
values
  ('Hot Leads', 100, 'potential_interest', '#ef4444', 'HOT', 'star'),
  ('Asking Price Given', 90, 'price_anchor', '#a855f7', 'PRICE', 'diamond'),
  ('Interested', 80, 'interested', '#10b981', 'INT', 'circle'),
  ('Needs Offer', 70, 'needs_offer', '#3b82f6', 'OFFER', 'square'),
  ('DNC / Opt-Out', 60, 'opt_out', '#6b7280', 'DNC', 'cross'),
  ('Wrong Number', 50, 'wrong_person', '#9ca3af', 'WRONG', 'cross');

-- Function to get marker for a thread
create or replace function public.get_thread_marker(
  p_intent text,
  p_stage text,
  p_property_type text,
  p_score integer,
  p_status text
)
returns jsonb
language sql
stable
as 10256
  select jsonb_build_object(
    'shape', shape,
    'color', color,
    'size', size,
    'label', label
  )
  from public.deal_marker_taxonomy
  where (match_intent is null or match_intent = p_intent)
    and (match_stage is null or match_stage = p_stage)
    and (match_property_type is null or match_property_type = p_property_type)
    and (match_min_score is null or p_score >= match_min_score)
    and (match_status is null or match_status = p_status)
  order by priority desc
  limit 1;
10256;
