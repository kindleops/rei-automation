# Credential safety for tooling (rc-8.5.21-c)

Owner directive, 2026-10-16:

> Stop relying on a recreated `/tmp/.dburl` as the default development access pattern.
> Use dedicated database-role-enforced read-only credentials for diagnostics. A read-only SQL statement or transaction setting is not an adequate replacement for least-privilege credentials.
> Never allow testing or migration tooling to silently derive writable production credentials from local API environment files.
> Preserve the disposable-database test boundary.

Owner decision, same day: no single broad read-only role. Each diagnostic names a **purpose**, and each purpose has its own least-privilege credential.

## The one loader: `scripts/lib/prod-db-credentials.mjs`

Tooling reaches a production database through this module only. It has two doors.

### Read-only diagnostics

```js
import { loadReadOnly, openReadOnlyPool, resolveReadOnlyUrl } from '<repo>/scripts/lib/prod-db-credentials.mjs'
const client = await loadReadOnly('ops_diag')                      // one verified connection
const pool = await openReadOnlyPool({ purpose: 'entity_graph', max: 4 })
const { url } = await resolveReadOnlyUrl({ purpose: 'ops_diag' })  // verified, for a child psql
```

```sh
node scripts/lib/prod-db-credentials.mjs verify-readonly ops_diag
node scripts/lib/prod-db-credentials.mjs psql ops_diag -f apps/api/scripts/verify-name-guards.sql
```

| Purpose | Credential file variable | Used by | BYPASSRLS allowed |
|---|---|---|---|
| `ops_diag` | `LC_RO_OPS_DIAG_DB_URL_FILE` | queue, inbox, sender routing, follow-up, autopilot and safety diagnostics (r10-safety, sender-routing, hotfix-848 plan, reply quality, rc71 verify, health SQL) | no |
| `entity_graph` | `LC_RO_ENTITY_GRAPH_DB_URL_FILE` | Entity Graph probes, fixtures, captures, facts verification, backfill `--dry-run` | no |
| `market_intel` | `LC_RO_MARKET_INTEL_DB_URL_FILE` | the Market Intelligence perf harness | no |
| `seller_intel` | `LC_RO_SELLER_INTEL_DB_URL_FILE` | seller-schema propagation report, scoring ranking comparison | no |
| `research_agent` | `LC_RO_RESEARCH_AGENT_DB_URL_FILE` | the read-only research agent local end-to-end proof | no |

The purpose list (`READONLY_PURPOSES`) is frozen in code. A new purpose, or allowing BYPASSRLS for one, is a reviewed code change. An unknown or missing purpose is refused, so there is no default role.

**Where the URL comes from.** Only from the purpose's file: an absolute path to a regular file you own, mode `0600` or `0400`, holding exactly one `postgres://` URL. The loader refuses:
- an inline URL (in the `…_FILE` variable, or in the matching `LC_RO_<PURPOSE>_DB_URL` variable);
- a relative path;
- a group- or world-readable file, or one owned by someone else;
- any dotenv file (`.env*`), whether named directly or reached through a symlink;
- `/tmp/.dburl`.

It never reads `apps/api/.env*`, `SUPABASE_DB_URL`, `DATABASE_URL`, `SUPABASE_URL_NO_POOL` or the service-role key.

**What is verified at connect time, before any other statement.** The checks use the database's own privilege system. No session setting is involved.
- `current_user`, and every role it can `SET ROLE` to, must not be superuser, `CREATEROLE`, `CREATEDB` or `REPLICATION`.
- None of those roles may hold `BYPASSRLS`. The one exception is the login role itself, and only when its purpose is allowlisted for BYPASSRLS (none is today). A role reachable through `SET ROLE` may never hold it.
- `has_table_privilege(role, t, 'INSERT,UPDATE,DELETE,TRUNCATE')` must be false for every sentinel: `public.send_queue`, `public.sms_templates`, `public.system_control`, and `agent.runtime_limits` when it exists. If a required sentinel is missing, the role cannot be verified, and that also counts as a refusal.
- No reachable role may have `CREATE` on schema `public`.

A writable credential is refused even if the caller would have used `BEGIN READ ONLY`. After verification the loader also sets `default_transaction_read_only = on` and a `statement_timeout`, as defense in depth.

`scripts/lib/pg-readonly-rest.mjs` is a supabase-js-shaped, select-only query builder over a verified purpose connection. The sender-routing scripts use it so their `sb.from(...).select(...).eq(...)` call sites stay the same while running as the read-only role instead of the service-role key.

### Production writes

```js
import { connectProdWrite } from '<repo>/scripts/lib/prod-db-credentials.mjs'
const db = await connectProdWrite({ purpose: 'what this write does' })
```

```sh
node scripts/lib/prod-db-credentials.mjs psql-write --prod-write=<approval-ref> -f <file.sql>
```

A write connection needs **all** of the following:
1. an explicit `--prod-write=<approval-ref>` argument. Generic values such as `yes`, `true` or `1` are refused.
2. `LC_PROD_WRITE_DB_URL_FILE`, which follows the same file rules as above.
3. an interactive TTY on both stdin and stderr. Pipes, agents and `CI=…` are refused.
4. the operator typing the approval ref back at the prompt. The prompt shows the target without the password.

The approval ref is logged with the target and the role. Nothing on the write path is derived from env files.

## The scan: `scripts/db/scan-credential-derivation.mjs` (CI)

It runs next to `scan-test-prod-targets.mjs` in `.github/workflows/cloudflare-staging.yml` and `.github/workflows/agent-s3-persistence.yml`. It covers every tracked script (`scripts/**`, `apps/*/scripts/**`, root `*.mjs/js/sh/py`), test, fixture and migration-test harness, plus each `package.json` script entry. It fails on any of these rules:

| Rule | Catches |
|---|---|
| `env-file` | `node --env-file`, `dotenv`, `process.loadEnvFile`, a literal `.env` / `.env.local` / `.env.production…` path, `source .env` |
| `db-url-env` | a READ of `SUPABASE_DB_URL`, `SUPABASE_URL_NO_POOL`, `SUPABASE_POOLER_URL`, `DATABASE_URL`, `POSTGRES_URL*`, `DIRECT_URL` or `SUPABASE_DB_PASSWORD` (JS, shell, Python, Deno). Assignments, `||=`, `??=` and `delete` are not reads. |
| `service-role-env` | a READ of `SUPABASE_SERVICE_ROLE_KEY` or any `*SERVICE_ROLE*` variable |
| `dburl-file` | `/tmp/.dburl` |
| `runtime-credential-import` | (scripts only) importing a runtime module that resolves credentials from the ambient env: `src/lib/postgres/resolve-database-url`, `src/lib/postgres/client`, `src/lib/supabase/client` or `src/lib/agent/quick-scan/read-client` |

The only exceptions are the allowlisted rules in `scripts/db/credential-inventory.mjs`, which is the inventory below. **The allowlist is frozen.** Every allowlisted `(path, rule)` pair must appear in `scripts/db/credential-derivation.frozen.txt`, and that file's sha256 is pinned in the scanner. Removing or narrowing an entry (because a script was migrated) passes. Adding a new script, adding a rule to an entry, or editing the baseline fails. New scripts use the loader.

Tests: `apps/api/tests/critical/credential-derivation-scan.test.mjs` (positive and negative cases, the freeze, the doc table, a scratch-repo CLI run) and `apps/api/tests/critical/prod-db-credentials-loader.test.mjs` (the loader).

## Testing boundary (unchanged)

Migration, rollback and pretest SQL runs only on a disposable database (`scripts/db/run-migration-test.mjs`). Fixtures carry no transaction control and no `\i`. The loader tests use the same conventions: `LC_PG_BIN` (a fresh cluster reachable only over a unix socket) or `LC_MIGRATION_TEST_ADMIN_URL` (a loopback CI service container), both checked by `assertDisposableTarget`. They never open a production connection. In the disposable database they create roles of eight writable shapes and show each one is refused: write grants, BYPASSRLS, superuser, `pg_write_all_data`, NOINHERIT plus `SET ROLE`, CREATE on public, TRUNCATE only, and a write on `agent.runtime_limits`. They also create a read-only role, show it is accepted, and show that its writes fail at the database with `42501 permission denied`, even with `default_transaction_read_only = off`.

## Owner steps once the purpose roles are approved

The per-purpose least-privilege roles are being designed separately. This build creates no role. For each approved purpose:

1. Create the role per the approved migration (login, no BYPASSRLS unless that purpose is allowlisted in code, no write grants, no CREATE on public).
2. Store its URL in a file only you can read:
   ```sh
   umask 077
   mkdir -p ~/.config/leadcommand
   printf '%s\n' 'postgresql://<role>:<password>@<pooler-host>:5432/postgres?sslmode=require' > ~/.config/leadcommand/ro-ops-diag.url
   chmod 600 ~/.config/leadcommand/ro-ops-diag.url
   ```
3. Point the purpose variable at it, for example in your shell profile. The variable holds a path, not the URL:
   `export LC_RO_OPS_DIAG_DB_URL_FILE=~/.config/leadcommand/ro-ops-diag.url` (the path must be absolute once expanded)
4. Verify with `node scripts/lib/prod-db-credentials.mjs verify-readonly ops_diag`. It prints the role and target, or the exact reason for refusal.
5. Delete `/tmp/.dburl` and stop recreating it. Keep the `postgres`-role URL out of every diagnostics path. If a write is ever approved, put its URL in a separate 0600 file, point `LC_PROD_WRITE_DB_URL_FILE` at it for that session only, and run the write with `--prod-write=<approval-ref>` at an interactive terminal.

## What remains allowlisted

251 inventory entries still carry allowlisted rules, totalling 382 `(path, rule)` pairs:
- `env-file` 229
- `service-role-env` 103
- `runtime-credential-import` 45
- `db-url-env` 4
- `dburl-file` 1

Most are supabase-js scripts that build a service-role client from `.env.local`. Moving them to a read-only role means moving each one off PostgREST, either onto the loader with `pg-readonly-rest.mjs` (for read-only scripts) or onto `connectProdWrite` (for scripts that write). That work is tracked file by file in the table below.

## Inventory

Classes: **read-only diagnostic** reads production only. **writes production** can change production, through the database, the REST API or a live API route; this is decided conservatively, so any write signal makes a script a writer. **local-only** never reaches production on its own. For legacy entries the class is a heuristic from the code (direct write calls, write-shaped SQL, write HTTP methods, or a write-named purpose). Writes made inside runtime services are not detected, so treat any legacy "read-only diagnostic" entry as unverified until it is migrated.

| Class | Count |
|---|---:|
| read-only diagnostic | 176 |
| writes production | 104 |
| local-only | 14 |

| Class | migrated: loader | migrated: loader (gated write) | partially migrated | partially migrated (gated write) | legacy: allowlisted pending migration | allowlisted: no DB credential derived | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| read-only diagnostic | 35 | 0 | 3 | 0 | 138 | 0 | 176 |
| writes production | 2 | 6 | 0 | 5 | 91 | 0 | 104 |
| local-only | 0 | 0 | 0 | 0 | 0 | 14 | 14 |
| **Total** | 37 | 6 | 3 | 5 | 229 | 14 | 294 |

The table is generated by `node scripts/db/scan-credential-derivation.mjs --inventory-md`. A test fails if this document drifts from `scripts/db/credential-inventory.mjs`.

| # | Script | Class | Status | Allowlisted rules | Note |
|---|---|---|---|---|---|
| 1 | `apps/api/package.json#scripts.audit:identity` | read-only diagnostic | legacy: allowlisted pending migration | env-file | npm script "audit:identity": node --env-file=.env.local (the runtime then derives the service-role client from it) |
| 2 | `apps/api/package.json#scripts.proof:identity` | read-only diagnostic | legacy: allowlisted pending migration | env-file | npm script "proof:identity": node --env-file=.env.local (the runtime then derives the service-role client from it) |
| 3 | `apps/api/package.json#scripts.proof:template-coverage` | read-only diagnostic | legacy: allowlisted pending migration | env-file | npm script "proof:template-coverage": node --env-file=.env.local (the runtime then derives the service-role client from it) |
| 4 | `apps/api/scripts/acquisition-brain-shadow-replay.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 5 | `apps/api/scripts/agent/intel2-live-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 6 | `apps/api/scripts/agent/research-local-e2e.mjs` | read-only diagnostic | partially migrated | env-file | DB via openReadOnlyPool (was AGENT_E2E_DB_URL_FILE=/tmp/.dburl.ro); still reads ANTHROPIC_API_KEY from AGENT_E2E_KEY_ENV_FILE (an API key, not a DB credential) |
| 7 | `apps/api/scripts/audit_auto_reply_plan.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 8 | `apps/api/scripts/audit_launch_batch_001.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 9 | `apps/api/scripts/audit_templates.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 10 | `apps/api/scripts/audit-identity-mismatches.js` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 11 | `apps/api/scripts/audit-inbox-fields.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 12 | `apps/api/scripts/audit/map-filter-field-population.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 13 | `apps/api/scripts/auto_reply_dry_run.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 14 | `apps/api/scripts/check-offer-stage-metadata.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 15 | `apps/api/scripts/check-production-health.sql` | read-only diagnostic | migrated: loader | — | usage now: node ../../scripts/lib/prod-db-credentials.mjs psql -f … (was psql $DATABASE_URL) |
| 16 | `apps/api/scripts/check-schema.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 17 | `apps/api/scripts/comps-current-sales-v2-shadow.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, db-url-env, service-role-env, runtime-credential-import | loads a dotenv file; reads the service-role key; reads a DB URL env var; imports a runtime credential module; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 18 | `apps/api/scripts/comps-valuation-pool-shadow.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, db-url-env, service-role-env, runtime-credential-import | loads a dotenv file; reads the service-role key; reads a DB URL env var; imports a runtime credential module; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 19 | `apps/api/scripts/entity-graph-fixtures.mjs` | read-only diagnostic | migrated: loader | — | resolveReadOnlyUrl() (role verified) feeds its read-only pool; was /tmp/.dburl |
| 20 | `apps/api/scripts/intelligence/baselines/build-first-touch-snapshot.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 21 | `apps/api/scripts/intelligence/baselines/extract-first-touch.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env, runtime-credential-import | loads a dotenv file; reads the service-role key; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 22 | `apps/api/scripts/intelligence/baselines/extract-graph-extras.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 23 | `apps/api/scripts/intelligence/baselines/extract-market-sales.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 24 | `apps/api/scripts/intelligence/baselines/lib/rest-reader.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 25 | `apps/api/scripts/market-intel-perf.mjs` | read-only diagnostic | migrated: loader | — | openReadOnlyPool; was /tmp/.dburl |
| 26 | `apps/api/scripts/measure/rc71-d8-template-governance-holds.mjs` | read-only diagnostic | legacy: allowlisted pending migration | service-role-env | reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 27 | `apps/api/scripts/ops/autopilot-v2-audit.mjs` | read-only diagnostic | migrated: loader | — | was /tmp/.dburl (--db-url-file) |
| 28 | `apps/api/scripts/ops/hotfix-848/persona-pending-dryrun.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (usage comment updated) |
| 29 | `apps/api/scripts/ops/inbound-replay-harness.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 30 | `apps/api/scripts/ops/internal-proof-status.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 31 | `apps/api/scripts/ops/no-response-followup-dry-run.mjs` | read-only diagnostic | migrated: loader | — | was /tmp/.dburl (--db-url-file) |
| 32 | `apps/api/scripts/ops/no-response-followup-smoke.mjs` | read-only diagnostic | migrated: loader | — | was DATABASE_URL |
| 33 | `apps/api/scripts/ops/r10-safety/_ro-db.mjs` | read-only diagnostic | migrated: loader | — | shared helper: connectReadOnly() = connectReadOnlyDiagnostics(); DATABASE_URL no longer read |
| 34 | `apps/api/scripts/ops/r10-safety/active-campaign-reconcile.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (connectReadOnlyDiagnostics) |
| 35 | `apps/api/scripts/ops/r10-safety/campaign-safety-check.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (connectReadOnlyDiagnostics) |
| 36 | `apps/api/scripts/ops/r10-safety/reconcile-suppressed-queue.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (connectReadOnlyDiagnostics) |
| 37 | `apps/api/scripts/ops/r10-safety/resume-drain-dryrun.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (connectReadOnlyDiagnostics) |
| 38 | `apps/api/scripts/ops/r10-safety/send-time-guard-impact.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (connectReadOnlyDiagnostics) |
| 39 | `apps/api/scripts/ops/r10-safety/verify-missed-optouts.mjs` | read-only diagnostic | migrated: loader | — | via _ro-db.mjs (connectReadOnlyDiagnostics) |
| 40 | `apps/api/scripts/ops/reply-quality-report.mjs` | read-only diagnostic | migrated: loader | — | was SUPABASE_DB_URL / DATABASE_URL / --db-url-file |
| 41 | `apps/api/scripts/ops/scoring-ranking-comparison.mjs` | read-only diagnostic | migrated: loader | — | was --env-file=.env.local + SUPABASE_DB_URL |
| 42 | `apps/api/scripts/ops/seller-autopilot-v2-gen-matrix.mjs` | read-only diagnostic | migrated: loader | — | was /tmp/.dburl |
| 43 | `apps/api/scripts/ops/seller-intelligence-propagation-report.mjs` | read-only diagnostic | migrated: loader | — | was SUPABASE_DB_URL / DATABASE_URL |
| 44 | `apps/api/scripts/ops/seller-silence-audit.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 45 | `apps/api/scripts/ops/sender-routing/_readonly.mjs` | read-only diagnostic | migrated: loader | — | shared helper: supabase-js-shaped read-only builder (scripts/lib/pg-readonly-rest.mjs) over the verified read-only role; service-role key and .env.local no longer used |
| 46 | `apps/api/scripts/ops/sender-routing/activate-number.mjs` | read-only diagnostic | migrated: loader | — | via _readonly.mjs (read-only builder over the verified role); TextGrid GET only with explicitly passed env |
| 47 | `apps/api/scripts/ops/sender-routing/activation-dry-run.mjs` | read-only diagnostic | migrated: loader | — | via _readonly.mjs (read-only builder over the verified role); TextGrid GET only with explicitly passed env |
| 48 | `apps/api/scripts/ops/sender-routing/coverage-sql-parity.mjs` | read-only diagnostic | migrated: loader | — | parity SELECT via the loader psql door (--run-sql replaces --dburl-file) |
| 49 | `apps/api/scripts/ops/sender-routing/dry-run.mjs` | read-only diagnostic | migrated: loader | — | via _readonly.mjs (read-only builder over the verified role); TextGrid GET only with explicitly passed env |
| 50 | `apps/api/scripts/ops/sender-routing/inbound-proof.mjs` | read-only diagnostic | migrated: loader | — | via _readonly.mjs (read-only builder over the verified role); TextGrid GET only with explicitly passed env |
| 51 | `apps/api/scripts/ops/sender-routing/inventory-reconcile.mjs` | read-only diagnostic | migrated: loader | — | via _readonly.mjs (read-only builder over the verified role); TextGrid GET only with explicitly passed env |
| 52 | `apps/api/scripts/preview-frozen-five.mjs` | read-only diagnostic | legacy: allowlisted pending migration | service-role-env | reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 53 | `apps/api/scripts/preview-inbox-counts-parity.mjs` | read-only diagnostic | migrated: loader | — | was SUPABASE_DB_URL / DATABASE_URL |
| 54 | `apps/api/scripts/proof_property_matching.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 55 | `apps/api/scripts/proof_suppression.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 56 | `apps/api/scripts/proof/analytics-lab-reconcile.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 57 | `apps/api/scripts/proof/analytics-war-room-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | service-role-env | reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 58 | `apps/api/scripts/proof/auto-reply-proof-v2.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 59 | `apps/api/scripts/proof/calendar-nexus-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | service-role-env | reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 60 | `apps/api/scripts/proof/inbox-filter-options-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 61 | `apps/api/scripts/proof/map-filter-accounting-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 62 | `apps/api/scripts/proof/map-filter-prospect-link-integrity.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 63 | `apps/api/scripts/proof/master-filters-pipeline-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 64 | `apps/api/scripts/proof/pipeline-overview-profile.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 65 | `apps/api/scripts/proof/shadow-fact-conversation-memory.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 66 | `apps/api/scripts/proof/template-catalog-inventory-readonly.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 67 | `apps/api/scripts/proof/template-coverage-audit.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 68 | `apps/api/scripts/proof/workflow-observatory-fixtures.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 69 | `apps/api/scripts/proof/workflow-observatory-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 70 | `apps/api/scripts/proof/workflow-studio-4-fixtures.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 71 | `apps/api/scripts/release-validation/queue-row-diagnostic.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 72 | `apps/api/scripts/repair/inbox-round9-reclassify-20261007.mjs` | read-only diagnostic | migrated: loader | — | dry run that emits PROPOSED SQL; was DATABASE_URL |
| 73 | `apps/api/scripts/repairs/rc71-repair-verify.mjs` | read-only diagnostic | migrated: loader | — | was --env-file=.env.local + runtime resolveDatabaseUrl() |
| 74 | `apps/api/scripts/sandbox_auto_reply.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 75 | `apps/api/scripts/validate_auto_reply_batch.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 76 | `apps/api/scripts/verify_mismatch_fixes.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 77 | `apps/api/scripts/verify-name-guards.sql` | read-only diagnostic | migrated: loader | — | usage now: the loader psql door (was psql $DATABASE_URL) |
| 78 | `apps/api/scripts/verify-real-endpoint.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 79 | `apps/dashboard/scripts/check-thread-state.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 80 | `apps/dashboard/scripts/check-view.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 81 | `apps/dashboard/scripts/dump_template_view.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 82 | `apps/dashboard/scripts/dump_view_def.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 83 | `apps/dashboard/scripts/dump-cols.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 84 | `apps/dashboard/scripts/dump-inbox-v.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 85 | `apps/dashboard/scripts/dump-thread-fs.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 86 | `apps/dashboard/scripts/dump-thread.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 87 | `apps/dashboard/scripts/fetch_deduped_view.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 88 | `apps/dashboard/scripts/fetch_inbox.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 89 | `apps/dashboard/scripts/ops/proof-feeder-dryrun.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 90 | `apps/dashboard/scripts/proof-classifier.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 91 | `apps/dashboard/scripts/proof-inbox.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 92 | `apps/dashboard/scripts/proof-routing.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 93 | `apps/dashboard/scripts/proof-thread-counts.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 94 | `apps/dashboard/scripts/proof/all-inbound-visibility.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 95 | `apps/dashboard/scripts/proof/automation-buckets.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 96 | `apps/dashboard/scripts/proof/command-map-seller-pin-hydration.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 97 | `apps/dashboard/scripts/proof/comp-intelligence-lake-worth-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 98 | `apps/dashboard/scripts/proof/debug-cecilia.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 99 | `apps/dashboard/scripts/proof/desktop/eg-overview-capture.mjs` | read-only diagnostic | migrated: loader | — | openReadOnlyPool; was DATABASE_URL or /tmp/.dburl |
| 100 | `apps/dashboard/scripts/proof/desktop/eg-universe-composer-capture.mjs` | read-only diagnostic | migrated: loader | — | was DATABASE_URL or /tmp/.dburl |
| 101 | `apps/dashboard/scripts/proof/desktop/eg86-capture.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 102 | `apps/dashboard/scripts/proof/dossier-hydration-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 103 | `apps/dashboard/scripts/proof/est-queue-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 104 | `apps/dashboard/scripts/proof/inbox-integrity.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; 2 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 105 | `apps/dashboard/scripts/proof/inbox-perf-verification.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 106 | `apps/dashboard/scripts/proof/inbox-performance-benchmark.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 107 | `apps/dashboard/scripts/proof/inbox-proof-warmup.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 108 | `apps/dashboard/scripts/proof/inbox-thread-session-proof.ts` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 109 | `apps/dashboard/scripts/proof/inbox-ui-integrity.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 110 | `apps/dashboard/scripts/proof/inbox-view-parity.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 111 | `apps/dashboard/scripts/proof/lead-context-hydration.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 112 | `apps/dashboard/scripts/proof/live-activity-sync.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 113 | `apps/dashboard/scripts/proof/map-ownership-resolver-smoke.ts` | read-only diagnostic | legacy: allowlisted pending migration | service-role-env | reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 114 | `apps/dashboard/scripts/proof/map-production-diagnostic.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 115 | `apps/dashboard/scripts/proof/mobile/analytics-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 116 | `apps/dashboard/scripts/proof/mobile/buyer-match-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 117 | `apps/dashboard/scripts/proof/mobile/calendar-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 118 | `apps/dashboard/scripts/proof/mobile/campaign-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 119 | `apps/dashboard/scripts/proof/mobile/closing-desk-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 120 | `apps/dashboard/scripts/proof/mobile/email-command-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 121 | `apps/dashboard/scripts/proof/mobile/pipeline-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 122 | `apps/dashboard/scripts/proof/mobile/shell-notifications-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 123 | `apps/dashboard/scripts/proof/mobile/workflow-realtime-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 124 | `apps/dashboard/scripts/proof/mobile/workflow-studio-mobile-qa.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 125 | `apps/dashboard/scripts/proof/number-performance.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 126 | `apps/dashboard/scripts/proof/operator-dossier-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 127 | `apps/dashboard/scripts/proof/ops-surface-smoke.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 128 | `apps/dashboard/scripts/proof/ownership-template-pool-audit.ts` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 129 | `apps/dashboard/scripts/proof/performance-attribution.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 130 | `apps/dashboard/scripts/proof/pipeline-stage-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 131 | `apps/dashboard/scripts/proof/production-sms-health.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 132 | `apps/dashboard/scripts/proof/queue-command-center-integrity.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 133 | `apps/dashboard/scripts/proof/queue-event-linkage.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 134 | `apps/dashboard/scripts/proof/queue-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 135 | `apps/dashboard/scripts/proof/queue-recovery.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 136 | `apps/dashboard/scripts/proof/queue-truth-reconcile.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 137 | `apps/dashboard/scripts/proof/queue-v4-pagination.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 138 | `apps/dashboard/scripts/proof/queue-views-comprehensive.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 139 | `apps/dashboard/scripts/proof/smart-inboxes.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 140 | `apps/dashboard/scripts/proof/template-performance.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 141 | `apps/dashboard/scripts/proof/test-auto-reply.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 142 | `apps/dashboard/scripts/proof/thread-state-sync.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 143 | `apps/dashboard/scripts/proof/thread-timeline-completeness.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 144 | `apps/dashboard/scripts/quarantine/run-real-feeder-test.ts` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 145 | `apps/dashboard/scripts/test-browser-ready.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 146 | `apps/dashboard/scripts/test-inbox-full.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 147 | `apps/dashboard/scripts/test-supabase.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 148 | `apps/dashboard/scripts/verify_inbox_sorting.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 149 | `apps/dashboard/scripts/verify_inbox_sorting.ts` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 150 | `proof_canonical_sql.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 151 | `repro_performance.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 152 | `scripts/entity-graph/eg-facts-postdeploy-proof.mjs` | read-only diagnostic | partially migrated | env-file | SQL half via connectReadOnlyDiagnostics (was /tmp/.dburl); API half still reads anon + service key from --env-dir apps/*/.env.local: legacy, allowlisted pending migration |
| 153 | `scripts/entity-graph/eg-property-facts-verify.sql` | read-only diagnostic | migrated: loader | — | usage now: the loader psql door (was psql "$(cat /tmp/.dburl)") |
| 154 | `scripts/entity-graph/facts-parity-probe.mjs` | read-only diagnostic | partially migrated | runtime-credential-import | the runtime pool (getPgPool) is handed the role-verified read-only URL from resolveReadOnlyUrl(); was /tmp/.dburl |
| 155 | `scripts/entity-graph/overview-parity-probe.mjs` | read-only diagnostic | migrated: loader | — | openReadOnlyPool; was DATABASE_URL or /tmp/.dburl |
| 156 | `scripts/entity-graph/profile-overview-fields.mjs` | read-only diagnostic | migrated: loader | — | was DATABASE_URL or /tmp/.dburl |
| 157 | `scripts/entity-graph/snapshot-eg-property-facts-types.mjs` | read-only diagnostic | migrated: loader | — | was DATABASE_URL or /tmp/.dburl |
| 158 | `scripts/proof/campaign-lifecycle-truth-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 159 | `scripts/proof/campaign-proof-utils.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 160 | `scripts/proof/classification-automation-decision-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 161 | `scripts/proof/cockpit-health-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 162 | `scripts/proof/comp-intelligence-production-verify.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 163 | `scripts/proof/inbound-classification-auto-reply-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 164 | `scripts/proof/inbox-25-thread-validation.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 165 | `scripts/proof/inbox-50-thread-validation.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 166 | `scripts/proof/inbox-api-json-contract-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 167 | `scripts/proof/inbox-live-message-merge-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 168 | `scripts/proof/inbox-live-v2-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import, env-file | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 169 | `scripts/proof/inbox-thread-hydration-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file | loads a dotenv file; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 170 | `scripts/proof/manual-inbox-send-queue-emergency-bypass-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 171 | `scripts/proof/pipeline-nexus-functional-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 172 | `scripts/proof/pipeline-universal-reconciliation-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | runtime-credential-import, env-file | loads a dotenv file; imports a runtime credential module; 1 rpc() call(s), no direct write call found (rpc calls present) — heuristic: writes made inside runtime services are not detected |
| 173 | `scripts/proof/sms-automation-readiness-audit.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 174 | `scripts/proof/sms-retry-safety-proof.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 175 | `scripts/proof/textgrid-failure-normalization-audit.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 176 | `scripts/release-validation/queue-row-diagnostic.mjs` | read-only diagnostic | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; no direct write call found — heuristic: writes made inside runtime services are not detected |
| 177 | `apps/api/package.json#scripts.proof:auto-reply-v2` | writes production | legacy: allowlisted pending migration | env-file | npm script "proof:auto-reply-v2": node --env-file=.env.local (the runtime then derives the service-role client from it); drives the auto-reply proof v2 |
| 178 | `apps/api/scripts/agent/s3-quick-scan-demo.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 supabase-js insert/update/upsert/delete call(s), 3 POST/PATCH/DELETE HTTP call(s) |
| 179 | `apps/api/scripts/backfill_outreach_launch_001.mjs` | writes production | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 2 supabase-js insert/update/upsert/delete call(s) |
| 180 | `apps/api/scripts/backfill-inbox-hydration.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 181 | `apps/api/scripts/backfill-inbox-messages.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 3 supabase-js insert/update/upsert/delete call(s) |
| 182 | `apps/api/scripts/backfill-inbox-thread-state.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 183 | `apps/api/scripts/backfill-phone-names-to-supabase.mjs` | writes production | legacy: allowlisted pending migration | service-role-env | reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s), 2 POST/PATCH/DELETE HTTP call(s) |
| 184 | `apps/api/scripts/capture-seller-autopilot-evidence.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 3 POST/PATCH/DELETE HTTP call(s) |
| 185 | `apps/api/scripts/cleanup-blank-greeting-rows.sql` | writes production | migrated: loader (gated write) | — | usage now: prod-db-credentials.mjs psql-write --prod-write=<ref> (was psql $DATABASE_URL) |
| 186 | `apps/api/scripts/cleanup-send-queue-system-control.sql` | writes production | migrated: loader (gated write) | — | usage now: psql-write --prod-write=<ref> (was psql $DATABASE_URL) |
| 187 | `apps/api/scripts/intelligence/comps/backtest.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 2 supabase-js insert/update/upsert/delete call(s) |
| 188 | `apps/api/scripts/intelligence/comps/build-comp-snapshot.mjs` | writes production | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 2 supabase-js insert/update/upsert/delete call(s), 1 rpc() call(s) |
| 189 | `apps/api/scripts/intelligence/comps/build-north-minneapolis-fixture.mjs` | writes production | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 1 supabase-js insert/update/upsert/delete call(s) |
| 190 | `apps/api/scripts/intelligence/transactions/build-comps-v1.mjs` | writes production | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 1 supabase-js insert/update/upsert/delete call(s), 1 rpc() call(s) |
| 191 | `apps/api/scripts/ops/canary-cert.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 3 supabase-js insert/update/upsert/delete call(s), 1 POST/PATCH/DELETE HTTP call(s) |
| 192 | `apps/api/scripts/ops/hotfix-848/persona-pending-repair.mjs` | writes production | migrated: loader (gated write) | — | plan via _ro-db.mjs; --apply opens connectProdWrite (--prod-write=<ref> + LC_PROD_WRITE_DB_URL_FILE + TTY); was DATABASE_URL |
| 193 | `apps/api/scripts/ops/inbound-full-replay.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s), 1 write-shaped SQL statement(s) |
| 194 | `apps/api/scripts/ops/internal-proof-runbook.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 3 supabase-js insert/update/upsert/delete call(s), 1 POST/PATCH/DELETE HTTP call(s), 2 rpc() call(s) |
| 195 | `apps/api/scripts/ops/scoring-backfill.mjs` | writes production | legacy: allowlisted pending migration | env-file, db-url-env | loads a dotenv file; reads a DB URL env var; 1 POST/PATCH/DELETE HTTP call(s), 2 rpc() call(s) |
| 196 | `apps/api/scripts/proof/archive-duplicate-workflows-preview.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 write-shaped SQL statement(s) |
| 197 | `apps/api/scripts/proof/auto-reply-live-replay.mjs` | writes production | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; name/purpose is a write operation (classified conservatively) |
| 198 | `apps/api/scripts/proof/canary-stage1-followup-gap.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; name/purpose is a write operation (classified conservatively) |
| 199 | `apps/api/scripts/proof/durable-state-hosted-proof.mjs` | writes production | legacy: allowlisted pending migration | service-role-env | reads the service-role key; 2 POST/PATCH/DELETE HTTP call(s) |
| 200 | `apps/api/scripts/proof/email-send-safety-proof.mjs` | writes production | legacy: allowlisted pending migration | service-role-env | reads the service-role key; 16 supabase-js insert/update/upsert/delete call(s) |
| 201 | `apps/api/scripts/proof/execute-backfill.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s), 1 write-shaped SQL statement(s), 1 rpc() call(s) |
| 202 | `apps/api/scripts/proof/inbox-backfill.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 rpc() call(s), name/purpose is a write operation (classified conservatively) |
| 203 | `apps/api/scripts/proof/live-seller-intelligence-canary.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; name/purpose is a write operation (classified conservatively) |
| 204 | `apps/api/scripts/proof/live-shadow-authority-canary.mjs` | writes production | legacy: allowlisted pending migration | service-role-env | reads the service-role key; name/purpose is a write operation (classified conservatively) |
| 205 | `apps/api/scripts/proof/map-filter-pr2-gate.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env, runtime-credential-import | loads a dotenv file; reads the service-role key; imports a runtime credential module; 2 write-shaped SQL statement(s), 1 POST/PATCH/DELETE HTTP call(s) |
| 206 | `apps/api/scripts/proof/outbound-incident-reconciliation-audit.mjs` | writes production | legacy: allowlisted pending migration | service-role-env | reads the service-role key; 3 write-shaped SQL statement(s) |
| 207 | `apps/api/scripts/proof/post-thread-key-repair-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 rpc() call(s), name/purpose is a write operation (classified conservatively) |
| 208 | `apps/api/scripts/proof/template-metadata-cleanup-preview.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; name/purpose is a write operation (classified conservatively) |
| 209 | `apps/api/scripts/proof/workflow-runtime-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 14 supabase-js insert/update/upsert/delete call(s) |
| 210 | `apps/api/scripts/rebuild-inbox-from-message-events.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 211 | `apps/api/scripts/reconcile-universal-lead-state.mjs` | writes production | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; 1 supabase-js insert/update/upsert/delete call(s) |
| 212 | `apps/api/scripts/repair-inbox-buckets-from-canonical-state.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 213 | `apps/api/scripts/repair-inbox-thread-state-targeted.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 write-shaped SQL statement(s) |
| 214 | `apps/api/scripts/repair-not-interested-nurture.mjs` | writes production | partially migrated (gated write) | env-file, service-role-env | atomic --apply connection (openRepairPgClient) now only via connectProdWrite (was runtime resolveDatabaseUrl from .env.local); the supabase-js service-role client from dotenv .env.local remains: legacy, allowlisted pending migration |
| 215 | `apps/api/scripts/repair-sms-corrupted-manual-sends.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 4 supabase-js insert/update/upsert/delete call(s) |
| 216 | `apps/api/scripts/repair/optout-sweep-20261006.mjs` | writes production | migrated: loader | — | read-only replay via the loader (was DATABASE_URL / --db-url-file); --apply writes through the runtime client with the operator-supplied service env (unchanged) |
| 217 | `apps/api/scripts/repairs/20261001_contract_seller_unsuppress.mjs` | writes production | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; name/purpose is a write operation (classified conservatively) |
| 218 | `apps/api/scripts/repairs/20261001_new_replies_cleanup.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env, runtime-credential-import | loads a dotenv file; reads the service-role key; imports a runtime credential module; 1 supabase-js insert/update/upsert/delete call(s) |
| 219 | `apps/api/scripts/repairs/20261001_restore_explicit_ask_273312064.mjs` | writes production | legacy: allowlisted pending migration | runtime-credential-import | imports a runtime credential module; 2 supabase-js insert/update/upsert/delete call(s) |
| 220 | `apps/api/scripts/repairs/20261002_dequincy_option_a_nurture.mjs` | writes production | partially migrated (gated write) | env-file, service-role-env | its atomic write uses openRepairPgClient → connectProdWrite; the service-role REST client from .env.local remains: legacy, allowlisted pending migration |
| 221 | `apps/api/scripts/repairs/eg-field-accuracy-20261010/02_PROPOSED_person_fill_one_field.sql` | writes production | migrated: loader (gated write) | — | PROPOSED fill; usage now psql-write --prod-write=<ref> (was psql $DATABASE_URL) |
| 222 | `apps/api/scripts/repairs/eg-field-accuracy-20261010/03_PROPOSED_person_fill_rollback.sql` | writes production | migrated: loader (gated write) | — | PROPOSED rollback; usage now psql-write --prod-write=<ref> (was psql $DATABASE_URL) |
| 223 | `apps/api/scripts/seed-workflow-studio-production.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; name/purpose is a write operation (classified conservatively) |
| 224 | `apps/api/scripts/split-waiting-cold-threads.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 225 | `apps/api/scripts/sync/map-filter-prospect-links-rebuild.mjs` | writes production | legacy: allowlisted pending migration | env-file, runtime-credential-import | loads a dotenv file; imports a runtime credential module; name/purpose is a write operation (classified conservatively) |
| 226 | `apps/dashboard/scripts/apply-mig-temp.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 rpc() call(s), name/purpose is a write operation (classified conservatively) |
| 227 | `apps/dashboard/scripts/apply-new-migrations.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 rpc() call(s), name/purpose is a write operation (classified conservatively) |
| 228 | `apps/dashboard/scripts/ops/backfill-paused-manual-send-routing.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; name/purpose is a write operation (classified conservatively) |
| 229 | `apps/dashboard/scripts/ops/incident-batch-freeze.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 230 | `apps/dashboard/scripts/ops/rebuild-inbox-thread-state.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 POST/PATCH/DELETE HTTP call(s) |
| 231 | `apps/dashboard/scripts/ops/repair-paused-queue-rows.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 232 | `apps/dashboard/scripts/ops/repair-thread-keys-historical-fast.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 233 | `apps/dashboard/scripts/ops/repair-thread-keys-historical.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 234 | `apps/dashboard/scripts/ops/repair-thread-keys.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 235 | `apps/dashboard/scripts/populate-names.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 supabase-js insert/update/upsert/delete call(s) |
| 236 | `apps/dashboard/scripts/proof/backfill-9-sent-message-events.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 237 | `apps/dashboard/scripts/proof/backfill-send-queue-visibility-fields.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 238 | `apps/dashboard/scripts/proof/backfill-sent-message-event.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 239 | `apps/dashboard/scripts/proof/cecilia-fix-verification.ts` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; name/purpose is a write operation (classified conservatively) |
| 240 | `apps/dashboard/scripts/proof/desktop/agent-s2-capture.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 POST/PATCH/DELETE HTTP call(s) |
| 241 | `apps/dashboard/scripts/proof/final-dry-run-verification.ts` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 POST/PATCH/DELETE HTTP call(s) |
| 242 | `apps/dashboard/scripts/proof/inbox-backfill.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 supabase-js insert/update/upsert/delete call(s) |
| 243 | `apps/dashboard/scripts/proof/inbox-buttons.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 5 supabase-js insert/update/upsert/delete call(s) |
| 244 | `apps/dashboard/scripts/proof/manual-inbox-send-now-schema-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 POST/PATCH/DELETE HTTP call(s) |
| 245 | `apps/dashboard/scripts/proof/mobile/inbox-conversation-scroll-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 5 supabase-js insert/update/upsert/delete call(s) |
| 246 | `apps/dashboard/scripts/proof/mobile/inbox-counter-movement-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 2 supabase-js insert/update/upsert/delete call(s) |
| 247 | `apps/dashboard/scripts/proof/mobile/inbox-keyboard-composer-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 4 supabase-js insert/update/upsert/delete call(s) |
| 248 | `apps/dashboard/scripts/proof/mobile/inbox-realtime-binding-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 supabase-js insert/update/upsert/delete call(s) |
| 249 | `apps/dashboard/scripts/proof/mobile/inbox-realtime-ui-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 supabase-js insert/update/upsert/delete call(s) |
| 250 | `apps/dashboard/scripts/proof/mobile/production-auth-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 4 POST/PATCH/DELETE HTTP call(s) |
| 251 | `apps/dashboard/scripts/proof/routing-resolution-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 252 | `apps/dashboard/scripts/proof/run-backfill.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 253 | `apps/dashboard/scripts/proof/run-real-feeder-test.ts` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; name/purpose is a write operation (classified conservatively) |
| 254 | `apps/dashboard/scripts/proof/test-queue-system.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 5 POST/PATCH/DELETE HTTP call(s) |
| 255 | `apps/dashboard/scripts/repair/backfill-message-event-thread-keys.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 256 | `apps/dashboard/scripts/repair/backfill-sent-message-events.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 257 | `apps/dashboard/scripts/repair/fix-false-suppression.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 258 | `apps/dashboard/scripts/repair/rebuild-thread-state-from-events.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s) |
| 259 | `apps/dashboard/scripts/setup-inbox.mjs` | writes production | legacy: allowlisted pending migration | env-file | loads a dotenv file; 1 supabase-js insert/update/upsert/delete call(s) |
| 260 | `apps/dashboard/scripts/update_seller_pins_rpc.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 write-shaped SQL statement(s), 1 rpc() call(s) |
| 261 | `scripts/entity-graph/backfill-eg-property-facts.mjs` | writes production | migrated: loader (gated write) | — | --dry-run = read-only role; full run = connectProdWrite; was DATABASE_URL or /tmp/.dburl |
| 262 | `scripts/ops/backfill-21610-suppressions.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 263 | `scripts/ops/backfill-campaign-target-graph-filter-columns.mjs` | writes production | partially migrated (gated write) | env-file | DB URL now only via connectProdWrite (was DATABASE_URL / SUPABASE_URL_NO_POOL / SUPABASE_DB_URL from apps/api/.env.local); still loads env files for its batch config flags: legacy, allowlisted pending migration |
| 264 | `scripts/ops/backfill-textgrid-failure-class.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 265 | `scripts/ops/enable-controlled-sms-autopilot.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 266 | `scripts/ops/full-campaign-target-graph-refresh.mjs` | writes production | partially migrated (gated write) | env-file | DB URL now only via connectProdWrite (was DATABASE_URL / SUPABASE_URL_NO_POOL / SUPABASE_DB_URL from env files); still loads env files for config + the cockpit API secret: legacy, allowlisted pending migration |
| 267 | `scripts/proof/auto-reply-guarded-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 9 supabase-js insert/update/upsert/delete call(s) |
| 268 | `scripts/proof/auto-reply-internal-live-send-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 4 supabase-js insert/update/upsert/delete call(s) |
| 269 | `scripts/proof/campaign-dry-run-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 POST/PATCH/DELETE HTTP call(s) |
| 270 | `scripts/proof/campaign-target-graph-staged-refresh-proof.mjs` | writes production | partially migrated (gated write) | env-file | runs refresh batches: DB URL now only via connectProdWrite (was DATABASE_URL… from env files); env files still loaded for config: legacy, allowlisted pending migration |
| 271 | `scripts/proof/cockpit-realtime-live-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 10 supabase-js insert/update/upsert/delete call(s) |
| 272 | `scripts/proof/first-live-batch-preflight.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s), 1 POST/PATCH/DELETE HTTP call(s) |
| 273 | `scripts/proof/first-live-one-row-no-send-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s), 1 POST/PATCH/DELETE HTTP call(s) |
| 274 | `scripts/proof/first-live-one-row-preflight.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 275 | `scripts/proof/la-stale-expiration-watch.sh` | writes production | migrated: loader | — | POSTs /api/internal/queue/run (drives the live queue); its metrics read now goes through the loader psql door (was psql $SUPABASE_DB_URL) |
| 276 | `scripts/proof/production-readiness-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 POST/PATCH/DELETE HTTP call(s) |
| 277 | `scripts/proof/queue-limited-cap-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 3 supabase-js insert/update/upsert/delete call(s), 1 POST/PATCH/DELETE HTTP call(s) |
| 278 | `scripts/proof/queue-limited-session-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 2 supabase-js insert/update/upsert/delete call(s), 1 POST/PATCH/DELETE HTTP call(s) |
| 279 | `scripts/proof/queue-safety-proof.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 4 POST/PATCH/DELETE HTTP call(s) |
| 280 | `scripts/proof/sms-delivery-variance-diagnosis.mjs` | writes production | legacy: allowlisted pending migration | env-file, service-role-env | loads a dotenv file; reads the service-role key; 1 supabase-js insert/update/upsert/delete call(s) |
| 281 | `apps/api/scripts/proof/run-proof.sh` | local-only | allowlisted: no DB credential derived | env-file | wrapper that runs a proof with --env-file=.env.local (inherits the wrapped proof's class) |
| 282 | `apps/api/scripts/refresh-brain-schema.mjs` | local-only | allowlisted: no DB credential derived | env-file | Podio (retired) schema fetch → local generated file; no database |
| 283 | `apps/api/scripts/refresh-message-events-schema.mjs` | local-only | allowlisted: no DB credential derived | env-file | Podio (retired) schema fetch → local generated file; no database |
| 284 | `apps/api/scripts/refresh-send-queue-schema.mjs` | local-only | allowlisted: no DB credential derived | env-file | Podio (retired) schema fetch → local generated file; no database |
| 285 | `apps/api/tests/critical/db-fixture-linter-and-scan.test.mjs` | local-only | allowlisted: no DB credential derived | dburl-file, db-url-env, service-role-env | feeds forbidden strings to scan-test-prod-targets to prove it catches them; never connects |
| 286 | `apps/api/tests/critical/inbound-recovery-signature-gate.test.mjs` | local-only | allowlisted: no DB credential derived | service-role-env | saves/restores SUPABASE_SERVICE_ROLE_KEY around a placeholder; never connects |
| 287 | `apps/dashboard/tests/ui/deal-desk-selection-continuity.spec.ts` | local-only | allowlisted: no DB credential derived | env-file | Playwright UI test against the local dev server; reads .env.local for local login |
| 288 | `apps/dashboard/tests/ui/map-verification-helpers.ts` | local-only | allowlisted: no DB credential derived | env-file | Playwright UI helpers against the local dev server; reads .env.local for local login |
| 289 | `scripts/check-gitignore-generated.mjs` | local-only | allowlisted: no DB credential derived | env-file | names .env.local only as a gitignore pattern; reads nothing |
| 290 | `scripts/dev-all.mjs` | local-only | allowlisted: no DB credential derived | env-file | dev runtime launcher: loads apps/*/.env.local into the LOCAL api/dashboard dev servers it spawns; no database client of its own |
| 291 | `scripts/dev-runtime-doctor.mjs` | local-only | allowlisted: no DB credential derived | env-file | dev runtime health doctor for the local servers |
| 292 | `scripts/proof/build-while-dev-proof.mjs` | local-only | allowlisted: no DB credential derived | env-file | local build-while-dev probe; reads the ops secret for the local dev API |
| 293 | `scripts/proof/monorepo-boundary-audit.mjs` | local-only | allowlisted: no DB credential derived | env-file | file-extension allowlist mentions .env / .env.example; reads no credentials |
| 294 | `scripts/proof/vite-stability-proof.mjs` | local-only | allowlisted: no DB credential derived | env-file | local Vite dev-server stability probe; reads dashboard .env.local for local ports/flags |
