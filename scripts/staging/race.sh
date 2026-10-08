#!/bin/sh
# Multi-connection race on the real staging database. N independent client
# processes, each its own database session, try to book the same final slot
# for one person across two brands; each holds its transaction open for 1 s
# so the sessions genuinely overlap. Exactly one may commit.
#   STAGING_LINK_DIR=… scripts/staging/race.sh [N]
set -eu
DIR="${STAGING_LINK_DIR:?}"; N="${1:-12}"; RUN="race_$(date +%s)"
[ "$(cat "$DIR/supabase/.temp/project-ref")" = "eiawfeddmmwwavzlfwia" ] || { echo "REFUSED: not staging" >&2; exit 2; }
q() { supabase db query --linked --workdir "$DIR" -o csv "$1" 2>&1 | grep -v "new version\|recommend\|Using workdir\|Initialising\|claude-code-hint\|^$" || true; }
ident="$(q "select project_ref||','||environment||','||production_fingerprint from public.staging_identity()" | tail -1 | tr -d '"')"
[ "$ident" = "eiawfeddmmwwavzlfwia,staging,false" ] || { echo "REFUSED: no staging identity ($ident)" >&2; exit 2; }

ids="$(q "with r as (insert into scheduling_resources (display_name, timezone, environment) values ('Race ($RUN)', 'America/New_York', 'test') returning id),
 t as (insert into scheduling_event_types (brand_key, type_key, name, duration_minutes, environment) values ('second_brand_test', '$RUN', 'Race', 30, 'test') returning id)
 select (select id from r)||','||(select id from t)||','||(select id from scheduling_event_types where brand_key='prominent_cash_offer' and type_key='offer_review')" | tail -1 | tr -d '"')"
person="$(echo "$ids" | cut -d, -f1)"; ttype="$(echo "$ids" | cut -d, -f2)"; ptype="$(echo "$ids" | cut -d, -f3)"
start="2031-02-03T15:00:00Z"; end="2031-02-03T15:30:00Z"
mkdir -p "/tmp/$RUN"
i=0
while [ $i -lt "$N" ]; do
  if [ $((i % 2)) -eq 0 ]; then brand=prominent_cash_offer; typ=$ptype; else brand=second_brand_test; typ=$ttype; fi
  ( t0=$(python3 -c 'import time;print(time.time())')
    out="$(q "begin; insert into scheduling_appointments (brand_key, event_type_id, resource_id, start_at, end_at, block_start_at, block_end_at, source, customer) values ('$brand', '$typ', '$person', '$start', '$end', '$start', '$end', '$RUN', '{\"name\":\"racer $i\"}'); select pg_sleep(1); commit; select 'COMMITTED'" )"
    t1=$(python3 -c 'import time;print(time.time())')
    printf '%s|%s|%s\n' "$i" "$(echo "$out" | grep -o 'COMMITTED\|23P01\|exclusion\|conflicting key' | head -1)" "$(python3 -c "print(round($t1-$t0,2))")" > "/tmp/$RUN/$i" ) &
  i=$((i + 1))
done
wait
cat /tmp/$RUN/* | sort -n
committed="$(cat /tmp/$RUN/* | grep -c '|COMMITTED|' || true)"
rejected="$(cat /tmp/$RUN/* | grep -cE '\|(23P01|exclusion|conflicting key)\|' || true)"
live="$(q "select count(*) from scheduling_appointments where source = '$RUN' and status in ('scheduled','confirmed')" | tail -1 | tr -d '"')"
second="$(q "insert into scheduling_appointments (brand_key, event_type_id, resource_id, start_at, end_at, block_start_at, block_end_at, source) values ('second_brand_test', '$ttype', '$person', '2031-02-03T15:10:00Z', '2031-02-03T15:40:00Z', '2031-02-03T15:10:00Z', '2031-02-03T15:40:00Z', '$RUN') returning 'INSERTED'" | grep -o 'INSERTED\|23P01\|exclusion\|conflicting key' | head -1)"
q "delete from scheduling_appointments where source = '$RUN'; delete from scheduling_event_types where id = '$ttype'; delete from scheduling_resources where id = '$person'" >/dev/null
rm -rf "/tmp/$RUN"
echo "sessions=$N committed=$committed rejected_by_constraint=$rejected live_rows=$live late_second_brand_overlap=$second"
[ "$committed" = "1" ] && [ "$live" = "1" ] && [ "$rejected" = "$((N - 1))" ] && [ "$second" != "INSERTED" ] && echo "RACE PASS" || { echo "RACE FAIL"; exit 1; }
