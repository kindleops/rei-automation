#!/usr/bin/env python3
"""Read-only dry run of the PROPOSED Market Intelligence rollup SQL.

Turns one build unit of the migration into a plain SELECT (no DDL, no writes):
the view body becomes a CTE, mi_zip_geo becomes an empty CTE (fine for nation/state/
city/zip levels), and the plpgsql format()/USING placeholders are substituted.
Usage: market-intel-rollup-dryrun.py <level> <period|month> <as_of> [geo_key] [--explain]
"""
import re, sys, pathlib
mig = pathlib.Path(__file__).resolve().parents[3] / 'supabase/migrations/PROPOSED_20261004150000_market_intel_geo_rollup.sql'
s = mig.read_text()
level, period, as_of = sys.argv[1], sys.argv[2], sys.argv[3]
key = sys.argv[4] if len(sys.argv) > 4 and not sys.argv[4].startswith('--') else None
explain = '--explain' in sys.argv
view = s[s.index('create or replace view public.mi_rollup_sales_v as') + len('create or replace view public.mi_rollup_sales_v as'):s.index(';\nrevoke all on public.mi_rollup_sales_v')]
amap = re.search(r"insert into public.mi_asset_type_map \(raw_type, base_class\) values(.*?)on conflict", s, re.S).group(1)
view = view.replace('public.mi_asset_type_map', 'amap')
having = re.search(r"v_having text := '(.*?)';\n", s, re.S).group(1).replace("''", "'")
asset = re.search(r"v_asset text := '(.*?)';\n", s, re.S).group(1).replace("''", "'")
keys = {'nation': "'US'::text", 'state': 's.state', 'city': 's.city_key', 'zip': 's.zip', 'market': 'g.market_key', 'county': 'g.county_key'}
if period == 'prepare':
    a = s.index('insert into public.mi_zip_geo (build_id')
    a = s.index('with zs as', a)
    b = s.index('get diagnostics', a)
    sel = s[a:b].rstrip().rstrip(';').replace('public.mi_rollup_sales_v', 'v').replace('p_build', '1')
    sql = ("set work_mem='128MB';\n" + ('explain (analyze, timing off) ' if explain else '')
           + f"with amap(raw_type, base_class) as (values {amap}),\n v as ({view})\n"
           + "select count(*) as zips, count(*) filter (where sales_n > 0) as sales_zips, sum(sales_n) as sales,"
           + " count(county_key) filter (where sales_n > 0) as with_county, count(*) filter (where county_via = 'parcel_majority' and sales_n > 0) as parcel_county,"
           + " count(market_key) filter (where sales_n > 0) as with_market, sum(sales_n) filter (where county_key is not null) as sales_with_county,"
           + " sum(sales_n) filter (where market_key is not null) as sales_with_market"
           + f" from ({sel.replace('select 1, z.zip', 'select 1 as build_id, z.zip', 1)}) z (build_id, zip, state, city_key, county_key, county_name, county_via, market_key, sales_n, min_lat, max_lat, min_lng, max_lng);")
    print(sql); sys.exit(0)
bodies = re.findall(r"execute format\(\$q\$(.*?)\$q\$", s, re.S)
body = bodies[1] if period == 'month' else bodies[0]
body = body[body.index('select $1, $2'):]
days = {'30d': '30', '90d': '90', '6m': '182', '1y': '365', '3y': '1095', 'all': 'null', 'month': 'null'}[period]
for a, b in (('%1$s', keys[level]), ('%2$s', asset), ('%3$s', having), ('$1', '1'), ('$2', f"'{level}'"), ('$3', f"'{period}'"), ('$4', f"'{as_of}'"), ('$5', days)):
    body = body.replace(a, b)
body = body.replace('public.mi_rollup_sales_v', 'v').replace('public.mi_zip_geo', 'g0')
if key:
    body = body.replace('where x.k is not null', f"where x.k = '{key}'")
sql = ("set work_mem='128MB';\n" + ('explain (analyze, timing off, buffers) ' if explain else '')
       + f"with amap(raw_type, base_class) as (values {amap}),\n v as ({view}),\n"
       + " g0 as (select null::bigint as build_id, null::text as zip, null::text as market_key, null::text as county_key where false)\n"
       + body.rstrip().rstrip(';') + ';')
print(sql)
