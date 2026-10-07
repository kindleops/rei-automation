#!/usr/bin/env python3
"""Generates the PROPOSED inferred-investor extension of the Market Intelligence summary:

  PROPOSED_20261005140000_market_intel_inferred_investor.sql           the migration
  PROPOSED_20261005140000_market_intel_inferred_investor_rollback.sql  restores the applied functions/view verbatim
  PROPOSED_20261005140000_market_intel_inferred_investor_pretest.sql   rollback-only DO block (RC 7.1 practice)

The applied summary migration (20261004150000_market_intel_geo_rollup.sql, identical to prod:
prosrc md5 checked 2026-10-05) is the base. Its view and three functions are PATCHED here by exact
string insertion, never retyped, so the extension cannot drift from what is live, and the rollback
re-creates the originals byte for byte. A unit test (market-intel-inferred.test.mjs) asserts the
generated files are current and that the SQL tier rule equals the JS rule (mi-inferred-investor.js).
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[3] / 'supabase/migrations'
base = (root / '20261004150000_market_intel_geo_rollup.sql').read_text()
STAMP = '20261005140000_market_intel_inferred_investor'


def block(pattern):
    m = re.search(pattern, base, re.S)
    assert m, pattern
    return m.group(0)


def fn(name):
    return block(r"create or replace function public\.%s\(.*?\n\$\$;\n" % re.escape(name))


def patch(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)


# The link is split into LINK_SLICES contiguous property_id ranges (bounds per build, set by i:bounds).
LINK_SLICES = 8
LINK_UNITS = [f'i:link:{i}' for i in range(LINK_SLICES)]
LINK_UNITS_SQL = ', '.join(f"'{u}'" for u in LINK_UNITS)
BOUND_FRACTIONS = ', '.join(f'{k / LINK_SLICES:g}' for k in range(1, LINK_SLICES))
# every unit must finish well inside one tick; the pretest RAISEs above this
UNIT_LIMIT_MS = 15000
# owner gate: an ownership-linking unit (i:clusters, i:bounds, i:link:*) passes only below this
LINK_PASS_MS = 8000

view_orig = block(r"create or replace view public\.mi_rollup_sales_v as.*?\n where m\.sold_on is not null and upper\(btrim\(m\.state\)\) ~ '\^\[A-Z\]\{2\}\$';\n")
units_orig = fn('mi_rollup_units')
fp_orig = fn('mi_rollup_fingerprint')
run_orig = fn('mi_rollup_run_unit')

# 1. the view gains property_id as its LAST column (create or replace view may only append).
view_new = patch(view_orig, "a.asset in ('mf_2_4', 'mf_5_plus', 'mf_unknown') as is_mf\n",
                 "a.asset in ('mf_2_4', 'mf_5_plus', 'mf_unknown') as is_mf,\n       m.property_id\n")
# 2. units: the inferred units run inside the build (before finalize), cleanup right after it.
units_new = patch(units_orig, "select array['prepare', 'buyers']",
                  "select array['prepare', 'buyers', 'i:clusters', 'i:bounds', " + LINK_UNITS_SQL + ", 'i:stacks']")
units_new = patch(units_new, "'m:zip', 'finalize', 'c:period'",
                  "'m:zip', 'i:g:nation', 'i:g:state', 'i:g:market', 'i:g:county', 'i:g:city', 'i:g:zip', 'i:validate', 'finalize', 'i:cleanup', 'c:period'")
# 3. fingerprint: an owner-snapshot change also rebuilds (the inferred tiers read it).
fp_new = patch(fp_orig, "'census', (select jsonb_build_array(count(*), max(vintage)) from public.exchange_market_fundamentals_cells))",
               "'census', (select jsonb_build_array(count(*), max(vintage)) from public.exchange_market_fundamentals_cells),\n"
               "    'owners', (select jsonb_build_array(count(*), max(last_observed_at)) from comp_private.comp_properties))")
# 4. run_unit dispatches 'i:' units to the inferred runner (one line, before any other work).
run_new = patch(run_orig, "  perform set_config('work_mem', '128MB', true);\n",
                "  perform set_config('work_mem', '128MB', true);\n"
                "  if v_kind = 'i' then return public.mi_infer_run_unit(p_build, p_unit, p_as_of); end if;\n")

# The tier rule. ONE definition; the unit test evaluates this exact text against classifyOwner().
TIER_CASE = """case
    when not p_corp and p_resident then 'no_signal'
    when p_corp and (p_oos or p_stack >= 2) then 'strong'
    when p_stack >= 3 and p_oos then 'strong'
    when p_stack >= 3 then 'likely'
    when p_trust and not p_corp then 'trust_estate'
    when p_corp then 'likely'
    when p_oos and p_stack = 2 then 'likely'
    when p_oos then 'absentee_only'
    else 'no_signal'
  end"""

TIERS = ['strong', 'likely', 'trust_estate', 'absentee_only', 'no_signal']
val_cols = ',\n  '.join(f'v_{t}_known integer not null, v_{t}_inv integer not null' for t in TIERS)
val_sel = ',\n            '.join(
    f"count(*) filter (where x.lk and x.buyer_known and x.tier = '{t}')::int as v_{t}_known, "
    f"count(*) filter (where x.lk and x.buyer_known and x.tier = '{t}' and x.is_investor)::int as v_{t}_inv" for t in TIERS)
val_names = ', '.join(f'v_{t}_known, v_{t}_inv' for t in TIERS)
val_sums = ',\n           '.join(f'sum(a.v_{t}_known) filter (where a.band <= p.maxband), sum(a.v_{t}_inv) filter (where a.band <= p.maxband)' for t in TIERS)
val_json = ',\n        '.join(f"'{t}', jsonb_build_object('recorded_investor', r.v_{t}_inv, 'recorded_other', r.v_{t}_known - r.v_{t}_inv)" for t in TIERS)

mig = f"""-- =============================================================================
-- Market Intelligence: INFERRED INVESTOR (owner-based), an extension of the market summary.
-- STATUS: PROPOSED — NOT APPLIED. GENERATED by apps/api/scripts/market-intel-make-inferred-migration.py;
-- do not edit by hand. Pretest: PROPOSED_{STAMP}_pretest.sql · Rollback: PROPOSED_{STAMP}_rollback.sql
-- Evidence (2026-10-05, read-only, prod): ~/.claude/jobs/c39b0175/tmp/market-intel/INFERRED_INVESTOR_EVIDENCE.txt
--   linked 598,841 of 665,288 sales (90.0%); validation on 36,343 linked sales that record a buyer:
--   precision 87.1%, recall 80.7% for strong+likely (unchanged by tier@2, which only moves 9,537 stack-only
--   individual/trust sales from strong to likely); trust 23.1%, absentee-only 3.3%, no signal 2.7%.
--   tier@2 counts: strong 95,776 · likely 60,997 · trust 1,881 · absentee-only 12,643 · no signal 427,544.
--   Pretest 2026-10-07 09:00Z: link slices took 17-56 s (hash slices, per-row index probes into the
--   516 MB comp_properties heap, ~1 cold random read per sale, and the lateral CASE inlined so the
--   transfer probe ran up to 5x per sale). v2 (this file): contiguous property_id range slices, one
--   ordered range scan per source + merge/hash joins, owner columns from a covering index (pre-step).
--   Measured 2026-10-07 on a 108,831-sale range with the existing indexes: 2.6 s cold; per-row rule
--   vs set-based rule on 5,948 sales: 0 differences (link reason and resident flag).
--   SOURCE DRIFT 10-05 -> 10-07 (build 1 665,288 -> build 2 665,245 sales, -43; legitimate): mv_map_market_sales
--   keeps a rolling 5-year window (event_date >= CURRENT_DATE - 5 years at refresh). Its 10-06 refresh moved
--   the first sale 2021-10-04 -> 2021-10-06: -37 sales (exactly the 37 canonical deeds dated 2021-10-04/05,
--   still present in comp_canonical_transactions). The other -6 are single sales gone from the corpus between
--   refreshes (2022-09 55404, 2023-01 33426, 2026-05 55108 + 73117, 2026-06 85032 + 91335; e.g. canonical
--   transaction 1509452, 91335, $2.2M, no longer exists). No additions. Recorded investors 13,183 -> 13,180
--   (2 aged out + txn 1509452). The 10-05 tier counts are unaffected (the pretest reproduced them exactly).
--   Note: the nightly ticks run with statement_timeout = '30s' (cron mi_rollup_tick_a/b), so the v1 17-56 s
--   link slices would have been cancelled in production; v2 targets < 8 s per linking unit.
-- APPLY PLAN (owner approval required; nothing here is applied):
--   0. PRE-STEP: PROPOSED_{STAMP}_pre_index.sql (CREATE INDEX CONCURRENTLY; execute_sql, NOT apply_migration,
--      CONCURRENTLY cannot run inside a transaction). The pretest refuses to run without it.
--   1. Outside 05:00-08:59 / 09:15-11:59 UTC: run the _pretest (SET statement_timeout = '300s'); expect
--      'pretest ok' with per-unit ms and a PASS / SOFT FAIL / HARD FAIL per unit. Any unit >= {UNIT_LIMIT_MS} ms:
--      'pretest FAILED (HARD ...)'. A linking unit (i:clusters, i:bounds, i:link:*) at {LINK_PASS_MS}-{UNIT_LIMIT_MS} ms:
--      'pretest SOFT FAIL — do not apply'. Only 'pretest ok' permits the apply.
--      National matrix ≈ the numbers above.
--   2. Apply this file (MCP apply_migration) outside the windows; no cron change (same 75 ticks).
--   3. The fingerprint now includes owner snapshots, so the next nightly tick starts build 2 with {59 + LINK_SLICES} units
--      (~ +3 min DB time). Until it is ready, MI keeps serving build 1; inferred metrics read 'unavailable'.
--   4. Verify (read-only) once the new build is ready: PROPOSED_{STAMP}_verify.sql — asserts recorded
--      counts equal build 2's and reports nation + top markets against the 10-05 snapshot;
--      GET op=status → inferred_investor.available = true.
--      Index evidence: PROPOSED_{STAMP}_plan_proof.sql (EXPLAIN ANALYZE BUFFERS, before and after step 0).
--   5. Rollback: the _rollback file (restores the applied functions and view byte for byte).
-- =============================================================================
--
-- WHY. Recorded investor purchases need a deed that names the buyer (~6% of sales). For the
-- other sales the property's CURRENT owner of record is known. Brief §48: an LLC owner alone
-- does not make an investor purchase. So this is a SEPARATE metric, tiered, with its evidence,
-- and validated against the sales that DO name a buyer. It never changes investor_count.
--
-- ONE MAPPING PER BUILD: the base tables (comp_properties, comp_canonical_transactions,
--   comp_property_contacts, mv_map_market_sales) are read ONLY by i:clusters (mailing stacks), i:bounds
--   (slice bounds) and the bulk-joined i:link slices, which write the compact per-sale mapping
--   public.mi_sale_owner_link (property -> latest sale -> current-owner eligibility -> tier). i:stacks,
--   every i:g:<level> unit and i:validate read only that mapping (+ mi_zip_geo / the cluster table);
--   no geography unit re-traverses a base table.
-- RULES (mirrored in apps/api/src/lib/domain/market-intelligence/mi-inferred-investor.js):
--   LINK mi_owner_link@1: a sale inherits today's owner only if it is the property's most recent
--     sale, no canonical transfer exists > 45 days after it (closer events are the same
--     transaction's other recordings), and the owner snapshot was observed ≥ 30 days after it
--     (an earlier snapshot can still show the seller).
--   TIER mi_owner_tier@2 (public.mi_owner_tier): strong · likely · trust_estate · absentee_only ·
--     no_signal. Inferred investor = strong + likely.
--   STACK: properties whose owner receives the tax bill at the same normalised mailing address
--     (comp_properties.owner_mailing_identity_key_v1, a keyed hash). NOT proof of one legal owner.
--
-- OBJECTS (all new except the four patched below; service_role only, RLS on, no policies):
--   comp_private.mi_owner_mail_cluster  per build: mailing key → stack id + size (keys stay in comp_private)
--   public.mi_sale_owner_link           per build (current build only, intermediate): one row per sale
--   public.mi_geo_period_inferred       per build: geography × period × asset inferred counts + validation
--   public.mi_owner_stack               per build: stacks ≥ 3 with a linked sale (company label candidate)
--   public.mi_owner_stack_activity      per build: the linked sales in those stacks (for top stacks)
--   public.mi_owner_tier(...)           the tier rule
--   public.mi_infer_run_unit(...)       the 'i:' units
-- PATCHED (exact insertions into the applied text; the rollback restores the originals):
--   mi_rollup_sales_v      + property_id (last column)
--   mi_rollup_units()      + {11 + LINK_SLICES} 'i:' units ({59 + LINK_SLICES} units; the nightly window has 75 ticks)
--   mi_rollup_fingerprint()+ owner snapshot (count, max observed) so an owner refresh rebuilds
--   mi_rollup_run_unit()   + one dispatch line for 'i:' units
-- ISOLATION: an 'i:' unit that fails on its RETRY is recorded in notes.inferred_errors and skipped;
--   the core build still completes and the API shows the inferred metric as unavailable for that build.
-- =============================================================================

create table if not exists comp_private.mi_owner_mail_cluster (
  build_id  bigint not null references public.mi_rollup_builds (build_id) on delete cascade,
  mail_key  text not null,
  stack_id  integer not null,
  props_n   integer not null,
  corp_n    integer not null,
  oos_n     integer not null,
  trust_n   integer not null,
  primary key (build_id, mail_key)
);
create index if not exists mi_owner_mail_cluster_stack on comp_private.mi_owner_mail_cluster (build_id, stack_id);

create table if not exists public.mi_sale_owner_link (
  build_id    bigint not null references public.mi_rollup_builds (build_id) on delete cascade,
  comp_id     text not null,
  sold_on     date not null,
  state       text not null,
  zip         text,
  city_key    text,
  asset       text not null,
  is_mf       boolean not null,
  buyer_known boolean not null,
  is_investor boolean not null,
  buyer       text,              -- the MV's company buyer, kept only for sales inside a stack (label evidence)
  link        text not null check (link in ('linked', 'no_property', 'not_latest_sale', 'later_transfer', 'no_owner_record', 'owner_snapshot_before_sale')),
  tier        text check (tier in ('strong', 'likely', 'trust_estate', 'absentee_only', 'no_signal')),
  corp        boolean,
  trust       boolean,
  oos         boolean,
  resident    boolean,
  stack_n     integer,
  stack_id    integer,
  primary key (build_id, comp_id)
);
create index if not exists mi_sale_owner_link_stack on public.mi_sale_owner_link (build_id, stack_id) where stack_id is not null;

create table if not exists public.mi_geo_period_inferred (
  build_id    bigint not null references public.mi_rollup_builds (build_id) on delete cascade,
  geo_level   text not null,
  geo_key     text not null,
  period      text not null,
  asset       text not null,
  sale_count     integer not null,
  linked_count   integer not null,
  strong_n       integer not null,
  likely_n       integer not null,
  trust_n        integer not null,
  absentee_n     integer not null,
  no_signal_n    integer not null,
  stack3_n       integer not null,
  {val_cols},
  primary key (build_id, geo_level, period, asset, geo_key)
);

create table if not exists public.mi_owner_stack (
  build_id  bigint not null references public.mi_rollup_builds (build_id) on delete cascade,
  stack_id  integer not null,
  props_n   integer not null,
  corp_n    integer not null,
  oos_n     integer not null,
  trust_n   integer not null,
  linked_n  integer not null,
  named_n   integer not null,
  label     text,
  label_n   integer not null,
  primary key (build_id, stack_id)
);

create table if not exists public.mi_owner_stack_activity (
  build_id  bigint not null references public.mi_rollup_builds (build_id) on delete cascade,
  comp_id   text not null,
  stack_id  integer not null,
  sold_on   date not null,
  zip       text,
  state     text not null,
  city_key  text,
  asset     text not null,
  primary key (build_id, comp_id)
);

do $grants$
declare t text;
begin
  foreach t in array array['public.mi_sale_owner_link', 'public.mi_geo_period_inferred', 'public.mi_owner_stack', 'public.mi_owner_stack_activity', 'comp_private.mi_owner_mail_cluster'] loop
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from public, anon, authenticated', t);
    execute format('grant select on %s to service_role', t);
  end loop;
end
$grants$;

{view_new}revoke all on public.mi_rollup_sales_v from public, anon, authenticated;
grant select on public.mi_rollup_sales_v to service_role;

-- The tier rule (mi_owner_tier@2). Inputs are non-null: callers coalesce unknown to false / 1.
create or replace function public.mi_owner_tier(p_corp boolean, p_trust boolean, p_oos boolean, p_stack integer, p_resident boolean)
returns text language sql immutable as $$
  select {TIER_CASE}
$$;

create or replace function public.mi_infer_run_unit(p_build bigint, p_unit text, p_as_of date)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := split_part(p_unit, ':', 2);
  v_arg text := split_part(p_unit, ':', 3);
  v_key text;
  v_rows bigint := 0;
  v_n bigint;
  v_attempts integer;
  v_keep bigint;
  v_bounds jsonb;
  v_lo text;
  v_hi text;
  v_rng text;
  v_having text := '((grouping(x.asset) = 0 and x.asset in (''sfr'', ''mf_2_4'', ''mf_5_plus'', ''land'', ''commercial''))
                     or (grouping(x.asset) = 1 and grouping(x.is_mf) = 0 and x.is_mf)
                     or (grouping(x.asset) = 1 and grouping(x.is_mf) = 1))';
  v_asset text := 'case when grouping(x.asset) = 0 then x.asset when grouping(x.is_mf) = 0 then ''mf'' else ''all'' end';
begin
  select attempts into v_attempts from public.mi_rollup_builds where build_id = p_build;
  -- a failed inferred unit earlier in this build: skip the rest of the inferred chain (cleanup still runs)
  if v_kind <> 'cleanup' and exists (select 1 from public.mi_rollup_builds where build_id = p_build and notes ? 'inferred_errors') then
    return 0;
  end if;
  begin
    if v_kind = 'clusters' then
      insert into comp_private.mi_owner_mail_cluster (build_id, mail_key, stack_id, props_n, corp_n, oos_n, trust_n)
      select p_build, k, (row_number() over (order by n desc, k))::int, n, corp, oos, trust
        from (select cp.owner_mailing_identity_key_v1 as k, count(*)::int as n,
                     count(*) filter (where cp.is_corporate_owner)::int as corp, count(*) filter (where cp.out_of_state_owner)::int as oos,
                     count(*) filter (where cp.is_trust)::int as trust
                from comp_private.comp_properties cp
               where cp.owner_mailing_identity_key_v1 is not null
               group by 1 having count(*) >= 2) c;
      get diagnostics v_rows = row_count;
      analyze comp_private.mi_owner_mail_cluster;

    elsif v_kind = 'bounds' then
      -- the link slices: {LINK_SLICES} contiguous property_id ranges of equal sale count, fixed for this build
      -- (the ranges partition all text values, so every sale lands in exactly one slice). One index-only
      -- pass over mv_map_market_sales_property_id (~0.9 s measured).
      update public.mi_rollup_builds b set notes = b.notes || jsonb_build_object('inferred_link_bounds', (
        select to_jsonb(percentile_disc(array[{BOUND_FRACTIONS}]::float8[]) within group (order by m.property_id))
          from public.mv_map_market_sales m where m.property_id is not null))
       where b.build_id = p_build;
      get diagnostics v_rows = row_count;

    elsif v_kind = 'link' then
      -- One slice of the properties as a CONTIGUOUS property_id range (bounds fixed per build by
      -- i:bounds in notes.inferred_link_bounds). All sales of a property land in the same slice, so
      -- "most recent sale" is decided over the property's whole history. Set-based: each source is
      -- read once, as an ordered range scan of its property_id index (owner columns from the covering
      -- index comp_properties_mi_owner_cover, the pre-step), then merge/hash joined. Identical to the
      -- per-row rule: "a transfer > 45 days after the sale exists" is "the property's latest transfer
      -- is > 45 days after the sale"; resident is "some contact is a resident likely owner".
      select b.notes -> 'inferred_link_bounds' into v_bounds from public.mi_rollup_builds b where b.build_id = p_build;
      if v_bounds is null or jsonb_array_length(v_bounds) <> {LINK_SLICES - 1} then
        raise exception 'mi_infer: no link bounds for build % (i:bounds sets them)', p_build;
      end if;
      v_lo := case when v_arg::int > 0 then v_bounds ->> (v_arg::int - 1) else '' end;  -- '' sorts before every text
      v_hi := case when v_arg::int < {LINK_SLICES - 1} then v_bounds ->> v_arg::int end;
      v_rng := '@ >= ' || quote_literal(v_lo) || coalesce(' and @ < ' || quote_literal(v_hi), '');
      execute format($q$
        insert into public.mi_sale_owner_link (build_id, comp_id, sold_on, state, zip, city_key, asset, is_mf, buyer_known, is_investor, buyer,
                                               link, tier, corp, trust, oos, resident, stack_n, stack_id)
        with s as materialized (
          select v.comp_id, v.sold_on, v.state, v.zip, v.city_key, v.asset, v.is_mf, v.buyer_known, v.is_investor, v.buyer, v.property_id,
                 v.sold_on = max(v.sold_on) over (partition by v.property_id) as latest
            from public.mi_rollup_sales_v v
           where %1$s
        ), tx as (
          select t.primary_property_id as property_id, max(t.event_date) as last_event
            from comp_private.comp_canonical_transactions t where %2$s group by 1
        ), pc as (
          select c.property_id, bool_or(c.resident and c.likely_owner) as resident
            from comp_private.comp_property_contacts c where %3$s group by 1
        ), j as (
          select s.*, cp.is_corporate_owner, cp.is_trust, cp.out_of_state_owner, cp.owner_mailing_identity_key_v1 as mail_key,
                 c.props_n, c.stack_id, coalesce(pc.resident, false) as resident_any,
                 case
                   when s.property_id is null then 'no_property'
                   when not s.latest then 'not_latest_sale'
                   when tx.last_event > s.sold_on + 45 then 'later_transfer'
                   when cp.property_id is null or cp.last_observed_at is null then 'no_owner_record'
                   when cp.last_observed_at::date - s.sold_on < 30 then 'owner_snapshot_before_sale'
                   else 'linked' end as link
            from s
            left join comp_private.comp_properties cp on cp.property_id = s.property_id and %4$s
            left join tx on tx.property_id = s.property_id
            left join pc on pc.property_id = s.property_id
            left join comp_private.mi_owner_mail_cluster c on c.build_id = $1 and c.mail_key = cp.owner_mailing_identity_key_v1
        )
        select $1, j.comp_id, j.sold_on, j.state, j.zip, j.city_key, j.asset, j.is_mf, j.buyer_known, j.is_investor,
               case when j.stack_id is not null then j.buyer end,
               j.link,
               case when j.link = 'linked' then public.mi_owner_tier(coalesce(j.is_corporate_owner, false), coalesce(j.is_trust, false),
                 coalesce(j.out_of_state_owner, false), coalesce(j.props_n, 1), j.resident_any) end,
               j.is_corporate_owner, j.is_trust, j.out_of_state_owner, case when j.link = 'linked' then j.resident_any end,
               case when j.mail_key is not null then coalesce(j.props_n, 1) end, j.stack_id
          from j
      $q$, case when v_arg::int = 0 then format('(v.property_id is null or %s)', replace(v_rng, '@', 'v.property_id'))
                else replace(v_rng, '@', 'v.property_id') end,
           replace(v_rng, '@', 't.primary_property_id'), replace(v_rng, '@', 'c.property_id'), replace(v_rng, '@', 'cp.property_id'))
      using p_build;
      get diagnostics v_rows = row_count;

    elsif v_kind = 'stacks' then
      insert into public.mi_owner_stack (build_id, stack_id, props_n, corp_n, oos_n, trust_n, linked_n, named_n, label, label_n)
      select p_build, x.stack_id, c.props_n, c.corp_n, c.oos_n, c.trust_n, x.linked_n, x.named_n, nm.buyer, coalesce(nm.n, 0)
        from (select l.stack_id, count(*)::int as linked_n, count(*) filter (where l.buyer is not null)::int as named_n
                from public.mi_sale_owner_link l
               where l.build_id = p_build and l.link = 'linked' and l.stack_n >= 3
               group by l.stack_id) x
        join comp_private.mi_owner_mail_cluster c on c.build_id = p_build and c.stack_id = x.stack_id
        left join lateral (select l.buyer, count(*)::int as n from public.mi_sale_owner_link l
                            where l.build_id = p_build and l.stack_id = x.stack_id and l.link = 'linked' and l.buyer is not null
                            group by l.buyer order by count(*) desc, l.buyer limit 1) nm on true;
      get diagnostics v_n = row_count; v_rows := v_n;
      insert into public.mi_owner_stack_activity (build_id, comp_id, stack_id, sold_on, zip, state, city_key, asset)
      select p_build, l.comp_id, l.stack_id, l.sold_on, l.zip, l.state, l.city_key, l.asset
        from public.mi_sale_owner_link l
       where l.build_id = p_build and l.link = 'linked' and l.stack_n >= 3;
      get diagnostics v_n = row_count; v_rows := v_rows + v_n;

    elsif v_kind = 'g' then
      v_key := public.mi_rollup_level_key(v_arg);
      if v_key is null then raise exception 'mi_infer: unknown level in unit %', p_unit; end if;
      -- Periods are nested windows ending at the as-of, so each sale is counted once in its
      -- narrowest band and every period sums the bands it contains.
      execute format($q$
        insert into public.mi_geo_period_inferred (build_id, geo_level, geo_key, period, asset, sale_count, linked_count,
          strong_n, likely_n, trust_n, absentee_n, no_signal_n, stack3_n, {val_names})
        with x0 as (
          select %1$s as k, s.asset, s.is_mf, s.buyer_known, s.is_investor, s.tier, s.stack_n, (s.link = 'linked') as lk,
                 case when s.sold_on > $3::date - 30 then 1 when s.sold_on > $3::date - 90 then 2 when s.sold_on > $3::date - 182 then 3
                      when s.sold_on > $3::date - 365 then 4 when s.sold_on > $3::date - 1095 then 5 else 6 end as band
            from public.mi_sale_owner_link s
            left join public.mi_zip_geo g on g.build_id = $1 and g.zip = s.zip
           where s.build_id = $1
        ), a as (
          select x.k, %2$s as asset, x.band, count(*)::int as n, count(*) filter (where x.lk)::int as linked,
            count(*) filter (where x.lk and x.tier = 'strong')::int as strong_n, count(*) filter (where x.lk and x.tier = 'likely')::int as likely_n,
            count(*) filter (where x.lk and x.tier = 'trust_estate')::int as trust_n, count(*) filter (where x.lk and x.tier = 'absentee_only')::int as absentee_n,
            count(*) filter (where x.lk and x.tier = 'no_signal')::int as no_signal_n, count(*) filter (where x.lk and x.stack_n >= 3)::int as stack3_n,
            {val_sel}
            from x0 x where x.k is not null
           group by grouping sets ((x.k, x.asset, x.band), (x.k, x.band), (x.k, x.is_mf, x.band))
          having %3$s
        )
        select $1, $2, a.k, p.period, a.asset,
           sum(a.n) filter (where a.band <= p.maxband), sum(a.linked) filter (where a.band <= p.maxband),
           sum(a.strong_n) filter (where a.band <= p.maxband), sum(a.likely_n) filter (where a.band <= p.maxband),
           sum(a.trust_n) filter (where a.band <= p.maxband), sum(a.absentee_n) filter (where a.band <= p.maxband),
           sum(a.no_signal_n) filter (where a.band <= p.maxband), sum(a.stack3_n) filter (where a.band <= p.maxband),
           {val_sums}
          from a cross join (values ('30d', 1), ('90d', 2), ('6m', 3), ('1y', 4), ('3y', 5), ('all', 6)) as p(period, maxband)
         group by a.k, p.period, a.asset
        having coalesce(sum(a.n) filter (where a.band <= p.maxband), 0) > 0
      $q$, v_key, v_asset, v_having) using p_build, v_arg, p_as_of;
      get diagnostics v_rows = row_count;

    elsif v_kind = 'validate' then
      -- the build's published validation: the national, all-time, all-asset matrix
      update public.mi_rollup_builds b set notes = b.notes || jsonb_build_object('inferred_investor', jsonb_build_object(
        'link_rule', 'mi_owner_link@1', 'tier_rule', 'mi_owner_tier@2',
        'sales', r.sale_count, 'linked', r.linked_count,
        'tiers', jsonb_build_object('strong', r.strong_n, 'likely', r.likely_n, 'trust_estate', r.trust_n, 'absentee_only', r.absentee_n, 'no_signal', r.no_signal_n),
        'matrix', jsonb_build_object(
        {val_json}),
        'stacks', (select count(*) from public.mi_owner_stack s where s.build_id = p_build)))
        from public.mi_geo_period_inferred r
       where b.build_id = p_build and r.build_id = p_build and r.geo_level = 'nation' and r.geo_key = 'US' and r.period = 'all' and r.asset = 'all';
      get diagnostics v_rows = row_count;
      if v_rows = 0 then raise exception 'mi_infer: no national row to validate'; end if;

    elsif v_kind = 'cleanup' then
      -- the per-sale link rows and mailing keys are intermediates: keep them for the current build only;
      -- served tables follow the core rule (current + previous ready build).
      delete from public.mi_sale_owner_link where build_id <> p_build;
      get diagnostics v_n = row_count; v_rows := v_n;
      delete from comp_private.mi_owner_mail_cluster where build_id <> p_build;
      get diagnostics v_n = row_count; v_rows := v_rows + v_n;
      select max(build_id) into v_keep from public.mi_rollup_builds where status = 'superseded';
      delete from public.mi_geo_period_inferred where build_id in (select r.build_id from public.mi_rollup_builds r where r.build_id <> p_build and (r.build_id < coalesce(v_keep, 0) or r.status = 'failed'));
      get diagnostics v_n = row_count; v_rows := v_rows + v_n;
      delete from public.mi_owner_stack where build_id in (select r.build_id from public.mi_rollup_builds r where r.build_id <> p_build and (r.build_id < coalesce(v_keep, 0) or r.status = 'failed'));
      get diagnostics v_n = row_count; v_rows := v_rows + v_n;
      delete from public.mi_owner_stack_activity where build_id in (select r.build_id from public.mi_rollup_builds r where r.build_id <> p_build and (r.build_id < coalesce(v_keep, 0) or r.status = 'failed'));
      get diagnostics v_n = row_count; v_rows := v_rows + v_n;

    else
      raise exception 'mi_infer: unknown unit %', p_unit;
    end if;
    return v_rows;
  exception when query_canceled or others then
    -- first failure: re-raise, the tick records it and retries next tick. On the retry, record
    -- and skip: the inferred chain must never fail the core build.
    if coalesce(v_attempts, 0) = 0 or v_kind = 'cleanup' then raise; end if;
    update public.mi_rollup_builds set notes = notes || jsonb_build_object('inferred_errors', jsonb_build_object(p_unit, left(sqlerrm, 300)))
     where build_id = p_build;
    return 0;
  end;
end
$$;

{units_new}
{fp_new}
{run_new}
do $fn_grants$
declare f text;
begin
  foreach f in array array['mi_owner_tier(boolean, boolean, boolean, integer, boolean)', 'mi_infer_run_unit(bigint, text, date)',
                           'mi_rollup_units()', 'mi_rollup_fingerprint()', 'mi_rollup_run_unit(bigint, text, date)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$fn_grants$;

comment on table public.mi_geo_period_inferred is
  'Market Intelligence INFERRED investor (owner-based, mi_owner_link@1 + mi_owner_tier@2): geography x period x asset. Separate from recorded investor purchases (mi_geo_period_rollup.investor_count); never add them.';
"""

assert '$mig$' not in mig

rollback = f"""-- ROLLBACK for PROPOSED_{STAMP}.sql. GENERATED; do not edit by hand.
-- Restores the applied summary functions and view byte for byte (from 20261004150000_market_intel_geo_rollup.sql)
-- and drops every inferred object. The core summary tables and their builds are untouched.
-- A build started under the extension still lists 'i:' units: mark it failed first so the next
-- tick starts a clean core build:
update public.mi_rollup_builds set status = 'failed', last_error = 'inferred extension rolled back', finished_at = now(), updated_at = now()
 where status = 'building' and units @> array['i:clusters'];
update public.mi_rollup_builds set cursor = cardinality(units)
 where status = 'ready' and cursor < cardinality(units) and units @> array['i:clusters'];
update public.mi_rollup_builds set notes = notes - 'inferred_investor' - 'inferred_errors' - 'inferred_link_bounds' where notes ?| array['inferred_investor', 'inferred_errors', 'inferred_link_bounds'];

{run_orig}
{fp_orig}
{units_orig}
drop function if exists public.mi_infer_run_unit(bigint, text, date);
drop function if exists public.mi_owner_tier(boolean, boolean, boolean, integer, boolean);
drop table if exists public.mi_owner_stack_activity;
drop table if exists public.mi_owner_stack;
drop table if exists public.mi_geo_period_inferred;
drop table if exists public.mi_sale_owner_link;
drop table if exists comp_private.mi_owner_mail_cluster;
-- property_id cannot be removed by create or replace view: drop and re-create the original.
drop view if exists public.mi_rollup_sales_v;
{view_orig}revoke all on public.mi_rollup_sales_v from public, anon, authenticated;
grant select on public.mi_rollup_sales_v to service_role;
do $fn_grants$
declare f text;
begin
  foreach f in array array['mi_rollup_units()', 'mi_rollup_fingerprint()', 'mi_rollup_run_unit(bigint, text, date)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$fn_grants$;
"""

pretest = f"""-- PRETEST for PROPOSED_{STAMP}.sql. GENERATED by apps/api/scripts/market-intel-make-inferred-migration.py.
-- Rollback-only: every change is undone by the RAISE at the end. Expected result:
--   ERROR:  pretest ok: ...      and NO schema change afterwards.
-- Run OUTSIDE 05:00-08:59, 09:15-11:59 UTC with:  SET statement_timeout = '300s';
-- Requires the pre-step index (PROPOSED_{STAMP}_pre_index.sql) to exist and be valid.
-- It runs the full inferred chain against the live ready build's id space in a scratch build:
-- clusters, the {LINK_SLICES} link slices, stacks, all six geography units, validate and cleanup (~40-60 s).
-- What it proves: the DDL and the patches apply over the live objects; every inferred unit runs;
-- each unit's time is reported and gated (linking units PASS < {LINK_PASS_MS} ms, SOFT FAIL below {UNIT_LIMIT_MS} ms;
-- every unit HARD FAIL at >= {UNIT_LIMIT_MS} ms). Only a message starting 'pretest ok' permits the apply. The national
-- validation matrix is produced.
DO $pretest$
DECLARE
  b bigint;
  n bigint;
  t0 timestamptz;
  ms text := '';
  hard text := '';
  soft text := '';
  verdict text;
  u_ms bigint;
  u text;
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = to_regclass('comp_private.comp_properties_mi_owner_cover') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'pretest FAILED: apply the pre-step PROPOSED_{STAMP}_pre_index.sql first (comp_private.comp_properties_mi_owner_cover missing or invalid)';
  END IF;
  EXECUTE $mig${mig}$mig$;

  INSERT INTO public.mi_rollup_builds (fingerprint, source_as_of, source_first, source_rows, units, status)
  SELECT fingerprint, source_as_of, source_first, source_rows, public.mi_rollup_units(), 'building'
    FROM public.mi_rollup_builds WHERE status = 'ready' ORDER BY build_id DESC LIMIT 1
  RETURNING build_id INTO b;
  IF b IS NULL THEN RAISE EXCEPTION 'pretest FAILED: no ready build to copy'; END IF;
  INSERT INTO public.mi_zip_geo SELECT b, zip, state, city_key, county_key, county_name, county_via, market_key, sales_n, min_lat, max_lat, min_lng, max_lng
    FROM public.mi_zip_geo WHERE build_id = (SELECT max(build_id) FROM public.mi_rollup_builds WHERE status = 'ready');

  FOREACH u IN ARRAY array['i:clusters', 'i:bounds', {LINK_UNITS_SQL}, 'i:stacks', 'i:g:nation', 'i:g:state', 'i:g:market', 'i:g:county', 'i:g:city', 'i:g:zip', 'i:validate', 'i:cleanup'] LOOP
    t0 := clock_timestamp();
    n := public.mi_rollup_run_unit(b, u, (SELECT source_as_of FROM public.mi_rollup_builds WHERE build_id = b));
    u_ms := floor(extract(epoch from clock_timestamp() - t0) * 1000)::bigint;
    -- gates: every unit HARD FAIL at >= {UNIT_LIMIT_MS} ms; ownership-linking units (i:clusters, i:bounds, i:link:*)
    -- PASS only below {LINK_PASS_MS} ms, {LINK_PASS_MS}-{UNIT_LIMIT_MS} ms is a SOFT FAIL (do not apply).
    IF u_ms >= {UNIT_LIMIT_MS} THEN
      hard := hard || format('%s %s ms; ', u, u_ms);
      ms := ms || format('%s=%s rows/%s ms HARD FAIL; ', u, n, u_ms);
    ELSIF (u IN ('i:clusters', 'i:bounds') OR u LIKE 'i:link:%') AND u_ms >= {LINK_PASS_MS} THEN
      soft := soft || format('%s %s ms; ', u, u_ms);
      ms := ms || format('%s=%s rows/%s ms SOFT FAIL; ', u, n, u_ms);
    ELSE
      ms := ms || format('%s=%s rows/%s ms PASS; ', u, n, u_ms);
    END IF;
  END LOOP;
  IF (SELECT notes ? 'inferred_errors' FROM public.mi_rollup_builds WHERE build_id = b) THEN
    RAISE EXCEPTION 'pretest FAILED: inferred unit error % · %', (SELECT notes -> 'inferred_errors' FROM public.mi_rollup_builds WHERE build_id = b), ms;
  END IF;
  IF hard <> '' THEN
    RAISE EXCEPTION 'pretest FAILED (HARD, unit >= {UNIT_LIMIT_MS} ms): % · all: %', hard, ms;
  END IF;

  SELECT count(*) INTO n FROM public.mi_sale_owner_link WHERE build_id = b;
  IF n <> (SELECT source_rows FROM public.mi_rollup_builds WHERE build_id = b) THEN
    RAISE EXCEPTION 'pretest FAILED: % link rows for % sales', n, (SELECT source_rows FROM public.mi_rollup_builds WHERE build_id = b);
  END IF;
  SELECT linked_count, strong_n, likely_n, trust_n, sale_count INTO r FROM public.mi_geo_period_inferred
   WHERE build_id = b AND geo_level = 'nation' AND period = 'all' AND asset = 'all';
  -- a SOFT FAIL still reports the numbers, but its first words say do not apply
  verdict := CASE WHEN soft <> '' THEN format('pretest SOFT FAIL — do not apply (linking unit(s) {LINK_PASS_MS}-{UNIT_LIMIT_MS} ms: %s)', soft) ELSE 'pretest ok' END;
  RAISE EXCEPTION '%: build % · sales % · linked % · strong % · likely % · trust % · % · validation %',
    verdict, b, r.sale_count, r.linked_count, r.strong_n, r.likely_n, r.trust_n, ms,
    (SELECT notes -> 'inferred_investor' -> 'matrix' FROM public.mi_rollup_builds WHERE build_id = b);
END
$pretest$;
"""


# 10-05 validation snapshot (INFERRED_INVESTOR_EVIDENCE.txt; tier@2 counts), compared by the verify script
SNAP_NATION = [
    ('sales', 665288), ('linked', 598841), ('strong', 95776), ('likely', 60997), ('trust_estate', 1881),
    ('absentee_only', 12643), ('no_signal', 427544), ('buyer_known', 52766), ('recorded_investor', 13183),
    ('reason:linked', 598841), ('reason:not_latest_sale', 14387), ('reason:later_transfer', 1),
    ('reason:no_owner_record', 24410), ('reason:owner_snapshot_before_sale', 27649), ('reason:no_property', 0),
]
SNAP_MATRIX = [('strong', 2256, 340), ('likely', 2853, 416), ('trust_estate', 431, 1436), ('absentee_only', 35, 1041), ('no_signal', 752, 26783)]
# markets, 1y: (slug, sales, buyer_known, linked, inferred_share) — the evidence used the JS market assignment, so INFO only
SNAP_MARKETS = [
    ('houston-tx', 74440, 6295, 69418, 0.279), ('dallas-tx', 56744, 3244, 53039, 0.307), ('los-angeles-ca', 51334, 6998, 47805, 0.241),
    ('miami-fl', 49408, 194, 47826, 0.28), ('atlanta-ga', 32822, 77, 31879, 0.35), ('minneapolis-mn', 24074, 2967, 21980, 0.152),
    ('orlando-fl', 20221, 27, 19306, 0.248), ('inland-empire-ca', 19098, 4407, 18060, 0.129), ('tampa-fl', 19093, 74, 18024, 0.204),
    ('st-louis-mo', 18843, 98, 16872, 0.389), ('jacksonville-fl', 17815, 74, 16934, 0.298), ('indianapolis-in', 14740, 79, 13981, 0.393),
    ('sacramento-ca', 14366, 1713, 13348, 0.145), ('phoenix-az', 8818, 7081, 6324, 0.155), ('charlotte-nc', 8108, 28, 7722, 0.27),
]
snap_nation_sql = ', '.join(f"('{k}', {v})" for k, v in SNAP_NATION)
snap_matrix_sql = ', '.join(f"('{t}', {a}, {b})" for t, a, b in SNAP_MATRIX)
snap_markets_sql = ', '.join(f"('{m}', {a}, {b}, {c}, {d})" for m, a, b, c, d in SNAP_MARKETS)


verify_sql = f"""-- POST-APPLY VERIFICATION for PROPOSED_{STAMP}.sql. GENERATED by apps/api/scripts/market-intel-make-inferred-migration.py.
-- READ-ONLY. Run after the first build with the extension is READY (notes ? 'inferred_investor'), outside
-- 05:00-08:59 / 09:15-11:59 UTC, with SET statement_timeout = '60s'.
-- Statement 1 (assertion): recorded investor_count (and sale_count / buyer_known_count, period and month
--   rollups) of the new build equal build 2's, row for row. RAISEs 'verify FAILED' on any difference,
--   'verify INCONCLUSIVE' if the source fingerprint moved between build 2 and the new build (then the
--   recorded numbers may legitimately differ; re-run the comparison against the build sharing its source).
-- Statement 2 (report): nation — eligible sales, linked latest sales, strong / likely inferred, unresolved by
--   reason, recorded buyer coverage, inferred coverage, the validation matrix — and the top 15 markets (1y),
--   each against the 10-05 validation snapshot. status: PASS (|delta| <= max(50, 0.1%)), CHECK (look at it),
--   INFO (markets: the snapshot used the JS market assignment, so they are context, not a gate).
DO $verify$
DECLARE
  b bigint;
  f2 jsonb;
  fb jsonb;
  n2 bigint;
  n bigint;
  m bigint;
BEGIN
  SELECT build_id, fingerprint - 'owners' INTO b, fb FROM public.mi_rollup_builds
   WHERE status = 'ready' AND notes ? 'inferred_investor' ORDER BY build_id DESC LIMIT 1;
  IF b IS NULL THEN RAISE EXCEPTION 'verify FAILED: no ready build carries notes.inferred_investor yet'; END IF;
  SELECT fingerprint INTO f2 FROM public.mi_rollup_builds WHERE build_id = 2;
  SELECT count(*) INTO n2 FROM public.mi_geo_period_rollup WHERE build_id = 2;
  IF f2 IS NULL OR n2 = 0 THEN RAISE EXCEPTION 'verify FAILED: build 2 rollup rows are gone (cleanup keeps current + previous ready build)'; END IF;
  IF fb IS DISTINCT FROM f2 THEN
    RAISE EXCEPTION 'verify INCONCLUSIVE: source changed between build 2 and build % (build 2 % · build % %)', b, f2, b, fb;
  END IF;
  SELECT count(*) INTO n FROM
    (SELECT geo_level, geo_key, period, asset, sale_count, investor_count, buyer_known_count FROM public.mi_geo_period_rollup WHERE build_id = 2) x
    FULL JOIN (SELECT geo_level, geo_key, period, asset, sale_count, investor_count, buyer_known_count FROM public.mi_geo_period_rollup WHERE build_id = b) y
    USING (geo_level, geo_key, period, asset)
   WHERE x.investor_count IS DISTINCT FROM y.investor_count OR x.sale_count IS DISTINCT FROM y.sale_count
      OR x.buyer_known_count IS DISTINCT FROM y.buyer_known_count;
  SELECT count(*) INTO m FROM
    (SELECT geo_level, geo_key, asset, month, sales, investor, buyer_known FROM public.mi_geo_month_rollup WHERE build_id = 2) x
    FULL JOIN (SELECT geo_level, geo_key, asset, month, sales, investor, buyer_known FROM public.mi_geo_month_rollup WHERE build_id = b) y
    USING (geo_level, geo_key, asset, month)
   WHERE x.investor IS DISTINCT FROM y.investor OR x.sales IS DISTINCT FROM y.sales OR x.buyer_known IS DISTINCT FROM y.buyer_known;
  IF n + m > 0 THEN
    RAISE EXCEPTION 'verify FAILED: recorded counts differ from build 2 in % period rows and % month rows (build %)', n, m, b;
  END IF;
END
$verify$;

with bld as (
  select build_id as b, notes -> 'inferred_investor' as ii from public.mi_rollup_builds
   where status = 'ready' and notes ? 'inferred_investor' order by build_id desc limit 1
), inf as (
  select r.* from public.mi_geo_period_inferred r, bld
   where r.build_id = bld.b and r.geo_level = 'nation' and r.geo_key = 'US' and r.period = 'all' and r.asset = 'all'
), rec as (
  select r.* from public.mi_geo_period_rollup r, bld
   where r.build_id = bld.b and r.geo_level = 'nation' and r.geo_key = 'US' and r.period = 'all' and r.asset = 'all'
), reasons as (
  select 'reason:' || l.link as k, count(*)::bigint as v from public.mi_sale_owner_link l, bld where l.build_id = bld.b group by l.link
), nation(k, v) as (
  select 'sales', inf.sale_count::bigint from inf union all
  select 'linked', inf.linked_count from inf union all
  select 'strong', inf.strong_n from inf union all
  select 'likely', inf.likely_n from inf union all
  select 'trust_estate', inf.trust_n from inf union all
  select 'absentee_only', inf.absentee_n from inf union all
  select 'no_signal', inf.no_signal_n from inf union all
  select 'buyer_known', rec.buyer_known_count from rec union all
  select 'recorded_investor', rec.investor_count from rec union all
  select s.k, coalesce(r.v, 0) from (values ('reason:linked'), ('reason:not_latest_sale'), ('reason:later_transfer'), ('reason:no_owner_record'),
         ('reason:owner_snapshot_before_sale'), ('reason:no_property')) s(k) left join reasons r using (k)
), snap(k, v) as (values {snap_nation_sql}),
snapm(tier, inv, other) as (values {snap_matrix_sql}),
snapk(slug, sales, buyer_known, linked, inferred_share) as (values {snap_markets_sql})
select 1 as ord, 'nation' as section, n.k as metric, n.v::numeric as value, s.v::numeric as snapshot_10_05, (n.v - s.v)::numeric as delta,
       case when abs(n.v - s.v) <= greatest(50, 0.001 * s.v) then 'PASS' else 'CHECK' end as status
  from nation n join snap s using (k)
union all
select 2, 'nation', x.metric, x.value, x.snap, round(x.value - x.snap, 4), case when abs(x.value - x.snap) <= 0.002 then 'PASS' else 'CHECK' end
  from (select 'recorded_buyer_coverage' as metric, round(rec.buyer_known_count::numeric / nullif(rec.sale_count, 0), 4) as value, round(52766 / 665288.0, 4) as snap from rec
        union all select 'inferred_coverage (linked / sales)', round(inf.linked_count::numeric / nullif(inf.sale_count, 0), 4), round(598841 / 665288.0, 4) from inf
        union all select 'inferred_share (strong+likely / linked)', round((inf.strong_n + inf.likely_n)::numeric / nullif(inf.linked_count, 0), 4), round((95776 + 60997) / 598841.0, 4) from inf) x
union all
select 3, 'validation', m.tier || ' · ' || x.col, x.value, x.snap, x.value - x.snap,
       case when abs(x.value - x.snap) <= greatest(25, 0.01 * x.snap) then 'PASS' else 'CHECK' end
  from snapm m cross join bld
  cross join lateral (values ('recorded_investor', (bld.ii -> 'matrix' -> m.tier ->> 'recorded_investor')::numeric, m.inv::numeric),
                             ('recorded_other', (bld.ii -> 'matrix' -> m.tier ->> 'recorded_other')::numeric, m.other::numeric)) x(col, value, snap)
union all
select 4, 'market 1y · ' || k.slug, x.metric, x.value, x.snap, round(x.value - x.snap, 4), 'INFO'
  from snapk k
  left join public.mi_geo_period_inferred i on i.build_id = (select b from bld) and i.geo_level = 'market' and i.geo_key = k.slug and i.period = '1y' and i.asset = 'all'
  left join public.mi_geo_period_rollup r on r.build_id = (select b from bld) and r.geo_level = 'market' and r.geo_key = k.slug and r.period = '1y' and r.asset = 'all'
  cross join lateral (values
    ('sales', r.sale_count::numeric, k.sales::numeric),
    ('recorded_buyer_coverage', round(r.buyer_known_count::numeric / nullif(r.sale_count, 0), 4), round(k.buyer_known::numeric / k.sales, 4)),
    ('recorded_investor_share (of buyer_known)', round(r.investor_count::numeric / nullif(r.buyer_known_count, 0), 4), null::numeric),
    ('inferred_coverage (linked / sales)', round(i.linked_count::numeric / nullif(i.sale_count, 0), 4), round(k.linked::numeric / k.sales, 4)),
    ('inferred_share (strong+likely / linked)', round((i.strong_n + i.likely_n)::numeric / nullif(i.linked_count, 0), 4), k.inferred_share::numeric)) x(metric, value, snap)
order by 1, 2, 3;
"""


plan_proof = f"""-- PLAN PROOF for the pre-step index (PROPOSED_{STAMP}_pre_index.sql). GENERATED; READ-ONLY.
-- Run outside 05:00-08:59 / 09:15-11:59 UTC with SET statement_timeout = '30s', once BEFORE and once AFTER
-- the pre-step. It is one i:link slice's join on a ~1/64 property_id sub-range (owner columns included),
-- against mv_map_market_sales directly (the view gains property_id only with the migration).
-- Expect BEFORE: comp_properties via "Index Scan using comp_properties_property_id_key" with shared read
--   ~= 1 heap page per sale (2026-10-07 09:08Z per-row form: read=12,971 for 10,165 lookups, 13.7 s).
-- Expect AFTER: "Index Only Scan using comp_properties_mi_owner_cover", Heap Fetches ~0, reads ~1/100 per sale.
-- Transfers already use comp_canon_tx_property_idx index-only (Heap Fetches 0) and contacts are 12 MB:
-- neither needs a new index, so none is proposed.
explain (analyze, buffers, timing off)
with s as materialized (
  select v.comp_id, v.property_id, v.sold_on, v.sold_on = max(v.sold_on) over (partition by v.property_id) as latest
    from public.mv_map_market_sales v
   where v.sold_on is not null and v.property_id >= '2166291597' and v.property_id < '2168000000'
), tx as (
  select t.primary_property_id as property_id, max(t.event_date) as last_event from comp_private.comp_canonical_transactions t
   where t.primary_property_id >= '2166291597' and t.primary_property_id < '2168000000' group by 1
), pc as (
  select c.property_id, bool_or(c.resident and c.likely_owner) as resident from comp_private.comp_property_contacts c
   where c.property_id >= '2166291597' and c.property_id < '2168000000' group by 1
)
select count(*) as sales,
       count(*) filter (where s.latest and not coalesce(tx.last_event > s.sold_on + 45, false)
                          and cp.last_observed_at::date - s.sold_on >= 30) as linked,
       count(*) filter (where cp.is_corporate_owner) as corp, count(*) filter (where cp.is_trust) as trust,
       count(*) filter (where cp.out_of_state_owner) as oos, count(cp.owner_mailing_identity_key_v1) as mail_key,
       count(*) filter (where pc.resident) as resident
  from s
  left join comp_private.comp_properties cp on cp.property_id = s.property_id and cp.property_id >= '2166291597' and cp.property_id < '2168000000'
  left join tx on tx.property_id = s.property_id
  left join pc on pc.property_id = s.property_id;
"""

pre_index = f"""-- PRE-STEP for PROPOSED_{STAMP}.sql. GENERATED by apps/api/scripts/market-intel-make-inferred-migration.py.
-- STATUS: PROPOSED — NOT APPLIED. Apply FIRST, before the pretest and the migration.
-- Run as ONE statement through execute_sql (or psql), NOT apply_migration: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. Outside 05:00-08:59 / 09:15-11:59 UTC. Builds without
-- blocking writes (two passes over the 516 MB heap; expected ~1-3 min, ~70 MB on disk).
-- WHY: the i:link slices need six owner columns of the sale's property. Read from the heap that is
-- one cold random 8 kB page per sale (shared_buffers 512 MB < heap 516 MB), which made a slice
-- 17-56 s. This covering index serves them as an ordered index-only range scan (the heap is
-- all-visible; it is static between owner-snapshot loads).
-- If a CONCURRENTLY build fails it leaves an INVALID index: drop it (below) and re-run.
-- ROLLBACK (after the migration's rollback): drop index concurrently if exists comp_private.comp_properties_mi_owner_cover;
create index concurrently if not exists comp_properties_mi_owner_cover
  on comp_private.comp_properties (property_id)
  include (last_observed_at, is_corporate_owner, is_trust, out_of_state_owner, owner_mailing_identity_key_v1);
"""

(root / f'PROPOSED_{STAMP}_pre_index.sql').write_text(pre_index)
(root / f'PROPOSED_{STAMP}_verify.sql').write_text(verify_sql)
(root / f'PROPOSED_{STAMP}_plan_proof.sql').write_text(plan_proof)
(root / f'PROPOSED_{STAMP}.sql').write_text(mig)
(root / f'PROPOSED_{STAMP}_rollback.sql').write_text(rollback)
(root / f'PROPOSED_{STAMP}_pretest.sql').write_text(pretest)
print('written', STAMP)
