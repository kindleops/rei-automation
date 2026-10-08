#!/bin/sh
# Apply one SQL file to the isolated staging branch — fail closed.
#
#   STAGING_LINK_DIR=/path/linked/to/branch scripts/staging/apply.sh <file.sql>
#
# Refuses unless ALL hold:
#   1. the link directory points at the staging allowlist ref, not production;
#   2. the database itself answers public.staging_identity() with that ref,
#      environment 'staging' and no production fingerprint (positive identity —
#      production has no such function, so the check cannot pass there);
# then runs the file (never recorded in supabase_migrations, so a branch merge
# can never carry it to production) and logs it in staging_guard.applied.
set -eu
STAGING_REF="eiawfeddmmwwavzlfwia"
PRODUCTION_REFS="lcppdrmrdfblstpcbgpf"
DIR="${STAGING_LINK_DIR:?set STAGING_LINK_DIR to a directory linked to the staging branch}"
FILE="$(cd "$(dirname "${1:?usage: apply.sh <file.sql>}")" && pwd)/$(basename "$1")"

linked="$(cat "$DIR/supabase/.temp/project-ref" 2>/dev/null || true)"
[ "$linked" = "$STAGING_REF" ] || { echo "REFUSED: link dir points at '$linked', not staging $STAGING_REF" >&2; exit 2; }
for p in $PRODUCTION_REFS; do [ "$linked" != "$p" ] || { echo "REFUSED: production ref" >&2; exit 2; }; done

ident="$(supabase db query --linked --workdir "$DIR" -o csv "select project_ref, environment, production_fingerprint from public.staging_identity()" 2>/dev/null | grep -v '^project_ref' | tr -d '\r' | head -1)"
[ "$ident" = "$STAGING_REF,staging,false" ] || { echo "REFUSED: database did not prove staging identity (got '$ident')" >&2; exit 2; }

sha="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"
name="$(basename "$FILE")"
if supabase db query --linked --workdir "$DIR" -f "$FILE" >/tmp/staging-apply.$$ 2>&1; then
  supabase db query --linked --workdir "$DIR" "insert into staging_guard.applied (name, sha256, result) values ('$name', '$sha', 'ok') on conflict (name) do update set sha256 = excluded.sha256, applied_at = now(), result = 'ok'" >/dev/null 2>&1
  echo "APPLIED $name ($sha) to $STAGING_REF"
else
  supabase db query --linked --workdir "$DIR" "insert into staging_guard.applied (name, sha256, result) values ('$name', '$sha', 'failed') on conflict (name) do update set sha256 = excluded.sha256, applied_at = now(), result = 'failed'" >/dev/null 2>&1 || true
  echo "FAILED $name" >&2; grep -iE "error|message" /tmp/staging-apply.$$ | head -5 >&2; rm -f /tmp/staging-apply.$$; exit 1
fi
rm -f /tmp/staging-apply.$$
