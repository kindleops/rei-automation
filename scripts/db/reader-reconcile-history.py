#!/usr/bin/env python3
"""Fingerprint every historical version of reader link 1's functions, so a production definition that differs from
the reviewed file can be traced to the exact commit that wrote it (scripts/db/reader-reconcile.mjs reads the output).

    python3 scripts/db/reader-reconcile-history.py <psql-url-of-a-disposable-database> > scripts/db/reader-reconcile-expected/link1-history.json

Each function block of each commit's file is created in a throwaway schema-less transaction (check_function_bodies
off, rolled back) and hashed exactly as scripts/db/reader-reconcile.sql hashes production: md5 of pg_get_functiondef
with whitespace collapsed. The disposable database is never committed to.
"""
import json, re, subprocess, sys

url = sys.argv[1]
repo = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
log = subprocess.run(['git', '-C', repo, 'log', '--all', '--format=%H %h %ad', '--date=short', '--name-only', '--', 'supabase/migrations/*lc_mcp_reader*'],
                     capture_output=True, text=True, check=True).stdout
versions = []; cur = None
for line in log.splitlines():
    if re.match(r'^[0-9a-f]{40} ', line): cur = line.split(); continue
    if line.endswith('_lc_mcp_reader.sql') and cur: versions.append((cur[0], cur[1], cur[2], line))
fn_re = re.compile(r'create or replace function (public\.[a-z0-9_]+)\(', re.I)
out = {}
for full, short, date, path in versions:
    src = subprocess.run(['git', '-C', repo, 'show', f'{full}:{path}'], capture_output=True, text=True).stdout
    if not src: continue
    for m in fn_re.finditer(src):
        start = m.start(); tag = re.search(r'\bas\s+(\$[a-z_]*\$)', src[start:], re.I)
        if not tag: continue
        body_start = start + tag.end(); end = src.find(tag.group(1), body_start)
        if end < 0: continue
        semi = src.find(';', end); block = src[start:semi + 1]
        sql = ("begin; set local check_function_bodies = off;\n" + block +
               f"\nselect '{m.group(1)}', p.oid::regprocedure::text, md5(regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g')) "
               f"from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = '{m.group(1).split('.')[1]}';\nrollback;")
        r = subprocess.run(['psql', url, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True)
        for row in r.stdout.splitlines():
            parts = row.split('\t')
            if len(parts) == 3:
                out.setdefault(parts[2], []).append({'function': parts[1], 'commit': short, 'date': date, 'file': path})
json.dump({'note': 'md5 of pg_get_functiondef (whitespace collapsed) of every historical version of reader link 1 functions', 'by_md5': out}, sys.stdout, indent=1)
