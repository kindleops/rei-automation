# agntei release gate (2026-11-05)

Branch `review/agntei-production-reconciliation`.

All runs were in a cloud container on disposable PostgreSQL 17. None used production data, production credentials or a real provider.

The method for telling a baseline failure from a release regression:
1. Every file that failed on the reconciled branch was run again, unchanged, on production `c5a7104f` and on the gateway branch `a77c739f`.
2. A failure that repeats identically on the gateway branch, and whose file is absent from production, belongs to the gateway lineage.
3. Anything else counts as a release regression.

## LeadCommand

| Suite | Reconciled branch |
|---|---|
| Critical suite, full (1,011 files, `tests/critical/*.test.mjs`, concurrency 3) | 13,206 tests: 13,186 pass, 13 skipped, 7 fail |
| After the 4 corrections (re-run of every failing file) | 3 fail, all baseline (below) |
| Action Gateway package (`mcp/leadcommand-action-mcp`) | 33 pass, 1 skipped, 1 fail (baseline) |
| Reader package (`mcp/leadcommand-mcp`) | 169 pass, 4 skipped |
| Migration chain on PostgreSQL 17 (`agntei-launch-chain-pg.test.mjs`) | 7 / 7, including production with Package A applied |
| Migration-test runner, one cluster test run as an unprivileged user | PASS; the cluster is removed afterwards |

**Reconciled versus the baselines, for every file that failed.**

| File | Reconciled | Gateway `a77c739f` | Production `c5a7104f` |
|---|---|---|---|
| `agent-capabilities.test.mjs` | 2 fail (catalog count, routes) | the same 2 fail | file not present |
| `conversation-ai-canonical-runtime-contract.test.mjs` | 1 fail (an R1 engine importer) | the same 1 fails | file not present |
| `asking-price-question-guard.test.mjs` | pass after correction | pass | pass |
| `cloudflare-cron-scope.test.mjs` | pass after correction | pass | pass |
| `rc-8.5.21-born-off.test.mjs` | pass after correction | pass | file not present |
| Action Gateway link #32 end-to-end | 1 fail | the same 1 fails | file not present |

The four corrections are gateway tests that asserted the opposite of a production decision the reconciliation keeps:
- the hotfix's operator principal;
- shadow mode never forwarded into the container;
- `manual_send_mode` born off;
- the owner's $200 research ceiling.

They are in commit `7bbaafc1` and listed in `docs/AGNTEI-PRODUCTION-RECONCILIATION.md`.

**Release regressions: none.**

Not re-run in full here:
- The full critical suite on production and on the gateway branch. The gateway branch's last full run (`b36e9552`, the previous pass) was 13,112 pass, 13 skipped and 3 fail, the same three baseline failures.
- Production has no reconciliation-specific tests to compare beyond the files above.

## Safety suites inside the critical run (all pass on the reconciled branch)

| Area | Tests |
|---|---|
| Campaign and SMS dispatch safety | `manual-send-authority-hotfix`, `manual-inbox-emergency-stop-enforced`, `canonical-send-authority`, `buyer-outreach-authority`, `outbound-contract-invariants-8521-pg`, the template scope tests |
| Holds and opt-out | `automation-hold-containment`, `automation-hold-gate`, `automation-hold-one-authority`, the reply-classification and stop-request tests |
| Role permissions and the service gateway | `action-gateway-service-principal-pg`, `agntei-launch-chain-pg` (grants), the Action Gateway package |
| CRM read-after-write | `record-sync-pg`, the Action Gateway T2 tests |
| Package A (production's research runtime) | `research-package-a` (no path to the send stack), `research-package-a-arming-pg`, `research-usage-budget` |

## agntei (`agntei-world-builder`)

| Suite | Result | Baseline failures |
|---|---|---|
| Engine, full (189 files) | 1,736 pass, 1 skipped, 2 fail | `workforce49` (2). There are also 2 unhandled "database is not open" errors at teardown, known from the previous pass. |
| Server, full (13 files) | 87 pass, 2 skipped, 3 fail | `org-chart.server`, `r391`, `service.test`: the same three as the previous pass. `agreements24` failed once on a port collision with the concurrent LeadCommand suite, then passed 2 / 2 twice on its own. |

Specific areas:
- **Browser-session lock across workers** (DealMachine lease, 4 processes) and **DocuSign to Clara** (stand-in): both are in the engine suite and pass.
- **Mobile (phone Home):** `exec-home.server.test.ts` passes 3 / 3.
- **Test temp lifecycle:** `isolation/test-tmp.test.ts` passes 4 / 4.
