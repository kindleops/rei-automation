#!/bin/bash
# reader family, one database, cumulative and interleaved as the manifest's setups are:
# each link's emulation, then pretest -> apply -> posttest; validate; rollback 5 -> 1 with rollback posttests;
# compare the catalog with a second database holding the same emulations and no link.
set -u
B=/usr/lib/postgresql/17/bin; D=/tmp/lc-mt-pi/chain; R=/home/user/lc-hg; M=$R/supabase/migrations; E=$R/mcp/leadcommand-mcp/migrations/test
rm -rf $D; mkdir -p $D; $B/initdb -D $D/data -U postgres -A trust >/dev/null || exit 1
$B/pg_ctl -D $D/data -o "-p 54399 -k $D -c listen_addresses=''" -l $D/log -w start >/dev/null || exit 1
P="$B/psql -h $D -p 54399 -U postgres -X -q -v ON_ERROR_STOP=1"
$P -c "create database chain" postgres; $P -c "create database base" postgres
run() { local t0=$(date +%s%3N); if $P --single-transaction -d $2 -f "$1" >$D/out 2>&1; then echo "ok   [$2] $(basename $1) ($(( $(date +%s%3N)-t0 )) ms)"; else echo "FAIL [$2] $(basename $1)"; tail -4 $D/out | cut -c1-400; FAILED=1; fi; }
fp() { $B/pg_dump -h $D -p 54399 -U postgres -s $1 | grep -vE '^(--|\\(un)?restrict )' | sort | md5sum | cut -c1-16; }
FAILED=0
run $R/apps/api/tests/pg/supabase-shim.sql chain; run $R/apps/api/tests/pg/supabase-shim.sql base
step() { local emu=$1 l=$2; [ -n "$emu" ] && { run $E/$emu chain; run $E/$emu base; }; run $M/${l}_pretest.sql chain; run $M/$l.sql chain; run $M/${l}_posttest.sql chain; }
step lc_mcp_reader_supabase_emulation.sql PROPOSED_20261019150000_lc_mcp_reader
step lc_mcp_conversation_intel_emulation.sql PROPOSED_20261026120000_lc_mcp_conversation_intel
step lc_mcp_corpus_census_emulation.sql PROPOSED_20261026150000_lc_mcp_corpus_census
step lc_mcp_acquisition_reads_emulation.sql PROPOSED_20261027130000_lc_mcp_acquisition_reads
step "" PROPOSED_20261030120000_lc_mcp_full_history
echo "--- validation queries (doc section 7)"
$P -d chain -f /tmp/lc-mt-pi/validate.sql
for l in PROPOSED_20261030120000_lc_mcp_full_history PROPOSED_20261027130000_lc_mcp_acquisition_reads PROPOSED_20261026150000_lc_mcp_corpus_census PROPOSED_20261026120000_lc_mcp_conversation_intel PROPOSED_20261019150000_lc_mcp_reader; do run $M/${l}_rollback.sql chain; run $M/${l}_rollback_posttest.sql chain; done
A=$(fp chain); Bf=$(fp base); echo "catalog after rollback 5..1: $A ; same emulations, no link: $Bf"; [ "$A" = "$Bf" ] && echo "FINGERPRINT RESTORED" || { echo "FINGERPRINT DIFFERS"; diff <($B/pg_dump -h $D -p 54399 -U postgres -s chain | grep -vE '^(--|\\(un)?restrict )' | sort) <($B/pg_dump -h $D -p 54399 -U postgres -s base | grep -vE '^(--|\\(un)?restrict )' | sort) | head -20; }
echo "failures: $FAILED"
$B/pg_ctl -D $D/data stop >/dev/null; echo done
