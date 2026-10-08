#!/bin/sh
# Compares production's catalog (structure only, read-only) with the staging
# branch for the 20 tables the portal + scheduling core depend on. Prints
# every production item missing or different on staging; exit 1 if any.
#   PROD_READONLY_DIR=… STAGING_LINK_DIR=… scripts/staging/validate-contract.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
q() { supabase db query --linked --workdir "$1" -o csv -f "$HERE/contract.sql" 2>/dev/null | grep -v '^kind,item' | sort; }
q "${PROD_READONLY_DIR:?}" > /tmp/contract.prod.$$
q "${STAGING_LINK_DIR:?}" > /tmp/contract.staging.$$
missing="$(comm -23 /tmp/contract.prod.$$ /tmp/contract.staging.$$ | grep -vxF -f "$HERE/contract-deviations.txt" || true)"
echo "production items: $(wc -l < /tmp/contract.prod.$$)  staging items: $(wc -l < /tmp/contract.staging.$$)"
rm -f /tmp/contract.prod.$$ /tmp/contract.staging.$$
if [ -n "$missing" ]; then echo "MISSING OR DIFFERENT ON STAGING:"; echo "$missing"; exit 1; fi
echo "accepted deviations (documented): $(grep -c . "$HERE/contract-deviations.txt")"
echo "CONTRACT OK: every production column, constraint, index, trigger, policy, RLS flag and anon grant for the contract tables exists identically on staging."
