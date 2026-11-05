cd /home/user/lc-hg
export PATH=/opt/node22/bin:$PATH LC_PG_BIN=/usr/lib/postgresql/17/bin
R="node scripts/db/prod-copy-rehearsal.mjs"
A="--admin-url postgresql://postgres@/postgres?host=/tmp/lc-mt-pi/pc&port=54398 --db lc_prodcopy_synth_pi --out /tmp/lc-mt-pi/pc/ev"
for s in guard "validate-backup --file /tmp/lc-mt-pi/pc/synthetic.dump" "restore --file /tmp/lc-mt-pi/pc/synthetic.dump" prereqs migrate census; do
  $R $s $A > /tmp/lc-mt-pi/pc/ev/out.txt 2>&1; rc=$?; echo "== $s -> exit $rc"; tail -3 /tmp/lc-mt-pi/pc/ev/out.txt | cut -c1-300
  [ $rc -ne 0 ] && break
done
