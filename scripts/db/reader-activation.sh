#!/bin/bash
# LeadCommand: apply the READ-ONLY reader links 1–5 to production, the owner's authorization of 2026-10-30.
#
#   Links, in this order only (docs/PI-MIGRATION-REHEARSAL.md §1):
#     1 PROPOSED_20261019150000_lc_mcp_reader          2 PROPOSED_20261026120000_lc_mcp_conversation_intel
#     3 PROPOSED_20261026150000_lc_mcp_corpus_census   4 PROPOSED_20261027130000_lc_mcp_acquisition_reads
#     5 PROPOSED_20261030120000_lc_mcp_full_history
#   Never links 6–9 (the sending family). Nothing here enables SMS.
#
# Run it on the operator machine, from a checkout of preserve/agntei-agent-texts-unreviewed:
#   PROD_ADMIN_URL      the production admin connection string, set in the environment by the owner (never printed,
#                       never written to a file by this script)
#   EXPECTED_DB_HOST    the production host the owner expects (compared with the URL's host before anything runs)
#   BACKUP_CONFIRMED    the timestamp of the platform backup / PITR point the owner confirmed (recorded, not checked)
#   OUT                 where the evidence goes (default ./reader-activation-<UTC timestamp>)
#   MODE=preflight      read-only checks only (the default); MODE=apply runs the preflight, then links 1–5
#
# It stops at the first unexpected result. Each link runs in one transaction (ON_ERROR_STOP), so a failed link leaves
# nothing of itself; links already applied stay, and their rollbacks (§5, reverse order) are printed.
set -u
here=$(cd "$(dirname "$0")/../.." && pwd); M=$here/supabase/migrations; MODE=${MODE:-preflight}
OUT=${OUT:-$PWD/reader-activation-$(date -u +%Y%m%dT%H%M%SZ)}; mkdir -p "$OUT"; chmod 700 "$OUT"
LINKS=(PROPOSED_20261019150000_lc_mcp_reader PROPOSED_20261026120000_lc_mcp_conversation_intel PROPOSED_20261026150000_lc_mcp_corpus_census PROPOSED_20261027130000_lc_mcp_acquisition_reads PROPOSED_20261030120000_lc_mcp_full_history)
# the reviewed files (LeadCommand bc94ff83); a different file is refused
SHA=(31a2afb415793ef6 037bedb92904fe56 91e43d634d7c3d52 10ec163f8d82df7c 435dfb8629782461)
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$OUT/activation.log"; }
die() { log "STOP: $*"; applied_rollbacks; exit 1; }
APPLIED=()
applied_rollbacks() { [ ${#APPLIED[@]} -eq 0 ] && return; log "links applied so far: ${APPLIED[*]}"; log "to undo them, in this order (each in one transaction, then compare the §4.2 counts):"; for ((i=${#APPLIED[@]}-1; i>=0; i--)); do log "  psql \"\$PROD_ADMIN_URL\" --single-transaction -v ON_ERROR_STOP=1 -f $M/${APPLIED[$i]}_rollback.sql"; done; }
[ -n "${PROD_ADMIN_URL:-}" ] || die "PROD_ADMIN_URL is not set (the owner sets it in this shell; it is never printed)"
[ -n "${EXPECTED_DB_HOST:-}" ] || die "EXPECTED_DB_HOST is not set"
host=$(python3 -c 'import os,urllib.parse as u;print(u.urlparse(os.environ["PROD_ADMIN_URL"]).hostname or "")')
[ "$host" = "$EXPECTED_DB_HOST" ] || die "the connection's host ($host) is not EXPECTED_DB_HOST ($EXPECTED_DB_HOST)"
P() { psql "$PROD_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
RO() { PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_ADMIN_URL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

log "mode $MODE; host $host; checkout $(git -C "$here" rev-parse --short HEAD); backup confirmed: ${BACKUP_CONFIRMED:-(not given)}"
# ---- 0. the files are the reviewed ones --------------------------------------------------------------------------------
for i in "${!LINKS[@]}"; do f=$M/${LINKS[$i]}.sql; [ -f "$f" ] || die "missing $f"
  s=$(sha256sum "$f" | cut -c1-16); [ "$s" = "${SHA[$i]}" ] || die "${LINKS[$i]}: sha256 $s is not the reviewed ${SHA[$i]}"
  [ -f "$M/${LINKS[$i]}_rollback.sql" ] || die "missing rollback for ${LINKS[$i]}"; done
log "files: the five reviewed links and their rollbacks are present"
# ---- 1. read-only preflight (a read-only session: nothing can be written) ---------------------------------------------
RO -c "select current_database(), current_user, version()" > "$OUT/identity.txt" || die "cannot connect read-only"
log "identity: $(tr '\n' ' ' < "$OUT/identity.txt" | cut -c1-160)"
[ "$(RO -c "select count(*) from pg_roles where rolname = 'lc_mcp_reader'")" = "0" ] || die "role lc_mcp_reader already exists: inspect it (its attributes and grants) before going on"
pre=$(RO -c "select string_agg(f, ', ') from unnest(array['public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_corpus_census(text)','public.lc_mcp_lead_screen(text,integer,text,text)','public.lc_mcp_thread_contact_eligibility(uuid)','public.lc_mcp_reader_self_check(text[],text[],name)']) f where to_regprocedure(f) is not null")
[ -z "$pre" ] || die "functions these links create already exist in production: $pre"
# the two egress helpers link 1 also defines: if production has them (from the action_gateway link), record who may
# execute them now, because link 1 replaces them and revokes EXECUTE from public, anon, authenticated and service_role
RO -c "select p.oid::regprocedure, coalesce(p.proacl::text, '(default)') from pg_proc p where p.oid in (to_regprocedure('public.lc_reachable_egress_indirect(oid)'), to_regprocedure('public.lc_egress_platform_allowlists()'))" > "$OUT/egress-helpers-before.txt"
if [ -s "$OUT/egress-helpers-before.txt" ] && grep -qE 'service_role=X|authenticated=X|anon=X|=X/' "$OUT/egress-helpers-before.txt" && [ "${ACK_EGRESS_HELPER_REVOKE:-}" != "1" ]; then
  die "the egress helpers exist with EXECUTE for other roles ($(tr '\n' ' ' < "$OUT/egress-helpers-before.txt")); link 1 would revoke it. Confirm nothing calls them, then re-run with ACK_EGRESS_HELPER_REVOKE=1"
fi
# baseline: the roles, the schema, and the row count of every relation the reader may read (plus §4.2's)
RO -c "select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles order by 1" > "$OUT/roles-before.txt"
# pg_dump must match the server's major version (PG_DUMP overrides; /usr/lib/postgresql/<major>/bin is tried first)
major=$(RO -c "select current_setting('server_version_num')::int / 10000")
PG_DUMP=${PG_DUMP:-$( [ -x /usr/lib/postgresql/$major/bin/pg_dump ] && echo /usr/lib/postgresql/$major/bin/pg_dump || command -v pg_dump )}
"$PG_DUMP" --schema-only --no-owner --schema=public "$PROD_ADMIN_URL" 2>"$OUT/pg_dump.err" | grep -vE '^(--|\\(un)?restrict )' > "$OUT/schema-before.sql"
[ -s "$OUT/schema-before.sql" ] || die "schema dump refused ($(head -2 "$OUT/pg_dump.err" | tr '\n' ' ')): use a pg_dump of server major version $major (set PG_DUMP)"
rels=$(grep -oE "rels text\[\] := array\[[^]]*\]" "$M/${LINKS[0]}.sql" | grep -oE "'[a-z_0-9]+'" | tr -d "'" | sort -u)
counts() { for t in $rels inbox_thread_state messages message_events send_queue system_control idempotency_ledger ai_generated_messages; do
  if [ "$(RO -c "select to_regclass('public.$t') is not null")" = "t" ]; then n=$(RO -c "select count(*) from public.$t" 2>/dev/null || echo error); else n=absent; fi
  printf '%s\t%s\n' "$t" "$n"; done | sort -u; }
counts > "$OUT/counts-before.tsv"; log "baseline: $(wc -l < "$OUT/counts-before.tsv") relations counted; roles and schema recorded"
grep -q $'\terror$' "$OUT/counts-before.tsv" && die "a baseline count failed (see counts-before.tsv)"
[ "$MODE" = "apply" ] || { log "preflight passed (read-only). Re-run with MODE=apply to apply links 1–5."; exit 0; }
[ -n "${BACKUP_CONFIRMED:-}" ] || die "BACKUP_CONFIRMED is not set: confirm the platform backup / PITR point first (§4.1)"
# ---- 2. apply links 1–5, in order, one transaction each ---------------------------------------------------------------
for l in "${LINKS[@]}"; do t0=$(date +%s%3N)
  P --single-transaction -f "$M/$l.sql" > "$OUT/$l.log" 2>&1 || { tail -5 "$OUT/$l.log" | tee -a "$OUT/activation.log"; die "$l failed (rolled back as one transaction)"; }
  APPLIED+=("$l"); log "applied $l ($(( $(date +%s%3N) - t0 )) ms)"; done
# ---- 3. validation (§7), read-only enforcement, unchanged data ---------------------------------------------------------
v=$(RO -F ' ' -c "select r.rolcanlogin = false and r.rolbypassrls = false and r.rolsuper = false,
  has_function_privilege('lc_mcp_reader','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','EXECUTE'),
  has_function_privilege('lc_mcp_reader','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','EXECUTE'),
  has_function_privilege('lc_mcp_reader','public.lc_mcp_corpus_census(text)','EXECUTE'),
  has_function_privilege('lc_mcp_reader','public.lc_mcp_thread_contact_eligibility(uuid)','EXECUTE'),
  not has_function_privilege('anon','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','EXECUTE'),
  pg_get_functiondef('public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)'::regprocedure) ~ '36500'
  from pg_roles r where r.rolname = 'lc_mcp_reader'")
log "validation (role safe, worklist, conversation, census, acquisition reads, no anon, full history): $v"
[ "$v" = "t t t t t t t" ] || die "a validation check is false"
w=$(RO -c "select count(*) from information_schema.role_table_grants where grantee = 'lc_mcp_reader' and privilege_type <> 'SELECT'")
[ "$w" = "0" ] || die "lc_mcp_reader holds $w non-SELECT table privileges"
# the reader's own write attempt must be refused (inside a transaction that is rolled back either way)
probe=$(printf '%s\n' "$rels" | head -1)
if P -c "begin; set local role lc_mcp_reader; delete from public.$probe where false; rollback;" > "$OUT/write-probe.txt" 2>&1; then die "the reader could run DELETE on public.$probe"; fi
grep -q 'permission denied' "$OUT/write-probe.txt" || die "the write probe failed for another reason: $(head -2 "$OUT/write-probe.txt")"
log "read-only enforcement: no non-SELECT grant; a DELETE as lc_mcp_reader is refused (permission denied)"
page=$(RO -c "begin; set local role lc_mcp_reader; select (w->>'total') || ' total, ' || jsonb_array_length(w->'rows') || ' rows' from public.lc_mcp_conversation_worklist('recent_inbound', 0, null, null, null, 25) w; rollback;" | grep -v '^$' | head -1)
log "all-history page as lc_mcp_reader: $page"
counts > "$OUT/counts-after.tsv"
diff "$OUT/counts-before.tsv" "$OUT/counts-after.tsv" > "$OUT/counts-diff.txt" || die "row counts changed (counts-diff.txt): investigate before anything else"
log "data unchanged: every counted relation has the same row count before and after"
RO -c "select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles order by 1" > "$OUT/roles-after.txt"
diff "$OUT/roles-before.txt" "$OUT/roles-after.txt" | grep -E '^[<>]' | grep -v 'lc_mcp_reader' && die "roles other than lc_mcp_reader changed"
log "DONE: links 1–5 applied and validated. Next: mint the reader token (docs/LEADCOMMAND-MCP-1.0.md §4.2) into a 0600 file and start the reader (runbook Phase 2)."
