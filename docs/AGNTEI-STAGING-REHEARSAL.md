# agntei staging rehearsal (native PostgreSQL 17, no Docker)

Branch `review/agntei-production-reconciliation`. Tool: `scripts/agntei-launch/staging-rehearsal.mjs` (with `scripts/agntei-launch/staging/`).

The rehearsal applies the reviewed 28-link gateway chain on an isolated, loopback-only PostgreSQL 17 that carries production's
schema (a schema-only dump the owner makes, no rows) or the repository's synthetic production-shaped baseline, plus invented
representative records. It measures each link, hammers the six hot tables with production-shaped writes while their links
run, re-issues production's write shapes afterwards, boots the real Action Gateway binary against the migrated schema, then
recovers by restoring the pre-apply backup and applies the chain a second time. Nothing can reach production: the admin URL
must be loopback, the database must be `lc_staging_<tag>`, there is no provider, and the send switch stays off.

## Steps

| Step | What it does | Evidence |
|---|---|---|
| guard | loopback only; `lc_staging_` name; no login-capable Supabase platform role; no `supabase_migrations` schema | every step runs it first |
| create | database from template0; platform stand-ins (below); then `pg_restore --no-owner --no-privileges` of the owner's schema-only dump + its ACL entries, or the synthetic baseline (the chain tests' setup fixtures plus links 1 to 11, which release/cloudflare-production carries byte-identically) | `create.json`, `restore.stderr.log` |
| seed | `staging/seed-representative.sql`: five invented conversations (an active negotiation with an unanswered offer, an overlooked 11-day-old reply, a wrong number, an opt-out, one 400 days old), their properties, phones, suppression rows, two campaigns, an offer, three opportunities, the org owner row; switches off | `seed.json` |
| snapshot | `pg_dump -Fc` of the whole staging database, a physical copy (`<db>_snap`, via `CREATE DATABASE ... TEMPLATE`) and the schema fingerprint (run-migration-test's) | `before.dump`, `fingerprint.before.txt` |
| review | the launch's own read-only review (`review-chain.mjs`) | `review.json` |
| apply | every pending link through the launch's own `apply-one.mjs` (pretest read-only, one transaction, read back), timed; on each hot link a workload (`staging/workload.mjs`, two connections issuing production's write shapes on send_queue, inbox_thread_state, seller_offers, acquisition_opportunities, campaigns) runs throughout and lock waits are sampled every 100 ms | `apply.json`, `workload.apply.*.json`, `fingerprint.after.txt` |
| probes | production's write shapes (`staging/prod-write-probes.mjs`, from release/cloudflare-production c5a7104f) after the chain; side-effect tables counted before and after each | `probes.json` |
| gateway | PostgREST on the staging database, the real `bin/leadcommand-action-mcp.mjs` as the LaunchAgent runs it (boot self-check, 401 without a credential), `grants.mjs --apply`, `mint-service-credential.mjs`, MCP initialize + tools/list with the minted credential | `gateway/`, `gateway.json` |
| rollback | recovery two ways: (A) physical, the database replaced by the snapshot copy (`CREATE DATABASE ... TEMPLATE`, what the platform's point-in-time restore does), fingerprint must be identical; (B) logical, `pg_restore` of `before.dump` into a fresh database inside the stand-ins, its drift reported as a finding about that method (the platform's default privileges re-grant the API roles on restored public objects the chain had revoked; pg_restore does not replay explicit revokes) | `rollback.json` |
| reapply | the chain again; the fingerprint must equal the first apply | `reapply.json` |
| report | `REPORT.md` with the table above filled in, per-link timings, probe results and the dispatch-isolation checks | `REPORT.md`, `isolation.json` |

```
node scripts/agntei-launch/staging-rehearsal.mjs <step|all> --admin-url postgres://postgres@127.0.0.1:54317/postgres \
  --db lc_staging_<tag> --out ~/agntei-staging/evidence-<tag> --pg-bin ~/agntei-staging/pg17-dist/bin \
  --postgrest ~/agntei-staging/postgrest/postgrest [--synthetic | --schema-dump <file>] [--replace]
```

## Platform stand-ins (staging deviations, all recorded in `create.json`)

The gateway migration (link 20) carries a self-check that pins production's platform exactly: PostGIS 3.3.7 in `public`
owned by `supabase_admin` (its dynamic-SQL management functions are allowlisted only then), and `pg_net` as an extension
owned by `supabase_admin` whose every object, the schema included, is a member with the platform's exact grants. A vanilla
server fails those pins, so staging reproduces them:

- `supabase_admin` (NOLOGIN superuser) and `supabase_functions_admin` (NOLOGIN) exist; the guard accepts them because they cannot log in.
- PostGIS is created by `supabase_admin` in `public`. Postgres.app ships 3.5.x; the catalog version label is set to 3.3.7 so the pinned allowlist is exercised. The 3.5-only overload `postgis_extensions_upgrade(text)` is not executable by PUBLIC. Functions and grants are real.
- `pg_net` is a stand-in extension (`staging/pg_net-stand-in`, installed into the server's `share/postgresql/extension` by the tool, never onto a real pg_net): the pinned object inventory and grants; it records every call in `net.http_request_queue` and sends nothing.
- `pg_cron` and `supabase_vault` are stand-ins that run and store nothing; not executable by PUBLIC.
- `auth` is the test shim (`apps/api/tests/pg/supabase-shim.sql`); `extensions` holds pgcrypto, uuid-ossp, pg_trgm, pg_stat_statements with USAGE for the API roles only.
- Default privileges are the platform's (`IN SCHEMA public` only, to anon / authenticated / service_role), not the test shim's every-schema ones, so a logical restore re-creates the ACLs the chain left.
- `graphql_public.graphql` is a stand-in for pg_graphql that answers "Unknown field" for every query (production's pg_graphql does not reflect `net`); the gateway's boot exposure probe needs that answer.

Rollback and re-apply compare fingerprints as line sets with CHECK-constraint parentheses normalised: `pg_get_constraintdef`
re-prints nested AND expressions with fewer parentheses after a dump / restore round trip (cosmetic, verified by diff).

## What it proves and what it does not

Proves: the chain applies in order on this schema; how long each link takes; what a concurrent production-shaped workload
saw on the hot tables (errors by SQLSTATE, max statement time, max lock wait); that production's write shapes still succeed
afterwards; that the real gateway binary boots and answers the MCP handshake against the migrated schema with a credential
minted the production way; that recovery is a timed, fingerprint-identical restore; that a second apply is identical; that
nothing left the database (no pg_net request recorded, no cron job run, no row sent, send switch false, no provider variable).

Does not prove: production data volume (schema only, or invented rows); production's web workers themselves (the workload
is a stand-in for their write shapes); anything about sending.
