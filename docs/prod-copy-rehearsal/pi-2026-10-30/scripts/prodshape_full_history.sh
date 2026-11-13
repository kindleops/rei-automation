B=/usr/lib/postgresql/17/bin; M=/home/user/lc-hg/supabase/migrations; L=PROPOSED_20261030120000_lc_mcp_full_history
P="$B/psql -h /tmp/lc-mt-pi/pc -p 54398 -U postgres -X -q -v ON_ERROR_STOP=1 -d lc_prodcopy_synth_pi"
fp() { $B/pg_dump -h /tmp/lc-mt-pi/pc -p 54398 -U postgres -s lc_prodcopy_synth_pi | grep -vE '^(--|\\(un)?restrict )' | sort | md5sum | cut -c1-16; }
run() { local t0=$(date +%s%3N); if $P --single-transaction -f "$1" >/tmp/lc-mt-pi/pc/o 2>&1; then echo "ok   $2 ($(( $(date +%s%3N)-t0 )) ms)"; else echo "FAIL $2"; tail -3 /tmp/lc-mt-pi/pc/o | cut -c1-400; fi; }
echo "--- section 7 gateway validation on the copy, before link 5"; $P -f /tmp/lc-mt-pi/gw-validate.sql
PRE=$(fp); echo "fingerprint before link 5: $PRE"
run $M/${L}_pretest.sql "pretest"; [ "$(fp)" = "$PRE" ] && echo "ok   pretest left no trace"
run $M/$L.sql "APPLY full_history"
run $M/${L}_posttest.sql "posttest (written for the runner's seeds)"
echo "--- section 7 reader validation on the copy (all nine applied)"; $P -f /tmp/lc-mt-pi/validate.sql
$P -f /tmp/lc-mt-pi/gw-validate.sql
run $M/${L}_rollback.sql "ROLLBACK full_history"; run $M/${L}_rollback_posttest.sql "rollback posttest"
POST=$(fp); echo "fingerprint after rollback: $POST"; [ "$PRE" = "$POST" ] && echo "ok   FINGERPRINT RESTORED" || echo "FINGERPRINT DIFFERS"
run $M/${L}_pretest.sql "re-apply pretest"; run $M/$L.sql "RE-APPLY full_history"; $P -f /tmp/lc-mt-pi/validate.sql | sed -n 3p
