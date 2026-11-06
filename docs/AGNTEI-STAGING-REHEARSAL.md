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

## Production-schema run, 2026-11-06 (evidence `~/agntei-staging/evidence-prod/`)

The owner's schema-only dump (`prod-schema-20261106-0139.dump`, 4.5 MB, 6,400 archive entries, 493 tables in 23 schemas, no
table data, verified by `verify-schema-dump.py`) restored into the stand-ins: 500 tables, 1,277 functions, 126 triggers,
247 policies. Six archive entries do not restore and are recorded: the platform's own event triggers (`pgrst_ddl_watch`,
`pgrst_drop_watch`, `issue_pg_net_access`, `issue_pg_graphql_access`, `issue_pg_cron_access`, `issue_graphql_placeholder`),
whose functions live in the excluded `extensions` schema. The ACL pass reports 15 entries for PostGIS 3.3 functions that
3.5 no longer ships (`lockrow`, `unlockrows`, `enablelongtransactions`, ...), harmless.

| Step | Result |
|---|---|
| review (before) | 4 applied (`durable_run_locks`, `agent_s3_persistence`, `agent_research_ro`, `intel_runtime`), 24 pending, 0 superseded, no drift, order intact. Identical to the read-only review of production itself the same morning. |
| apply | 24 links in 55.5 s through `apply-one` (pretest read-only, one transaction, read back). Hot links under the production-shaped workload (two connections, 0 errors): `action_gateway_t34` 3.6 s, max statement 2.95 s, max lock wait 2.87 s on `seller_offers`; `record_sync` 4.0 s, max statement 3.23 s, max lock wait 3.14 s on `inbox_thread_state` / `acquisition_opportunities` / `seller_offers`; the other four hot links 0 ms lock wait, statements under 35 ms. |
| probes | 9 of 11 production write shapes ok, 0 failed, 2 gated off (below) |
| gateway | the real `leadcommand-action-mcp` booted against the migrated production schema (boot self-check passed, 401 without a credential); `grants.mjs --apply` 0; credential minted; MCP initialize 200, tools/list 3 |
| isolation | pg_net requests 0, cron jobs 0, 599 rows created by the workload and probes, 0 reached sent, send switch false, no provider variable, loopback only |
| rollback | physical recovery 6.6 s, fingerprint identical; logical `pg_restore` into the stand-ins: identical after normalising (28 restore errors, the platform entries above) |
| reapply | 24 links in 34.6 s, fingerprint equal to the first apply |

### What the production schema taught the chain (all committed with this run)

1. **Chain order reconciled to production.** Production carries `agent_research_ro` and `intel_runtime` without
   `payload_clean_opaque_ids`, which the manifest listed before them; its header requires only `agent_s3_persistence`.
   `chain.mjs` now places it after `intel_runtime`; the manifest was regenerated; the chain tests pass (7/7). Without this the
   reviewer reported a broken order and `apply-one` refused, on staging and on production alike.
2. **Link 20 read "partial 2/232".** Its two egress functions (`lc_reachable_egress_indirect`, `lc_egress_platform_allowlists`)
   are already live in production, byte-identical, from the reader migration `PROPOSED_20261019150000_lc_mcp_reader`. The
   reviewer now names them as pre-existing (`PRE_EXISTING_BODIES`) and reads the link as absent; the link re-creates them with
   `CREATE OR REPLACE`.
3. **Link 6's pretest wrote.** `runtime_kind_limits_event_budget_pretest.sql` reproduced its defect with an UPDATE, which the
   launch's read-only pretest refuses (`25006`). The pretest now skips the reproduction under a read-only transaction with a
   notice; the migration test runner still reproduces it. The only pending pretest with a write.
4. **Rows the applied links seeded.** A schema-only dump carries no rows, but the pending pretests read the singletons the
   applied links inserted (`agent.runtime_limits` row 1, and the chain's bodies read `store_head`, `retention_policy`,
   `research_limits`, the LeadCommand org row). The seed inserts them at the migrations' defaults.
5. **Two more stand-ins.** `auth.users` and `auth.role()` (13 foreign keys and 2 policies in `public` depend on them), and
   `supabase_functions.http_request()` with its `hooks` table, because production's `message_events` carries the Database
   Webhook trigger `message_events_to_podio_sync` (a POST to the Vercel app on insert). The dump restores that trigger
   **disabled**, exactly as production has it (`tgenabled = D`), so no request is recorded on staging either.
6. **The three previously undecidable write checks, decided.** `acquisition_opportunities` archive and unarchive: production's
   code names `archived_*` only after `lead-visibility-gate.js` finds the columns; they come from
   `PROPOSED_20261005120000_lead_visibility`, which is not applied in production and is outside the chain. Absent before and
   after the chain: gated off on staging exactly as in production, reported as such. The `seller_offers` insert probe was
   dropped: no production code path inserts `seller_offers` (release/cloudflare-production reads them only; rows come through
   the chain's gateway offer path, covered by its own tests).

Not proven here, unchanged: production data volume; production's own workers; anything about sending.
