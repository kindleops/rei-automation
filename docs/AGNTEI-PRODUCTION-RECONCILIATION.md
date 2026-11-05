# agntei: production reconciliation of the service gateway (2026-11-05)

Branch `review/agntei-production-reconciliation`. It is a merge of `feat/agntei-service-gateway` (`a77c739f`) into `release/cloudflare-production` (`c5a7104f`), with production as the first parent.

- Heads were re-checked on the remote before the merge.
- Nothing here is deployed.
- `release/cloudflare-production` is unchanged.

## 1. What had to be reconciled

| | Production | Gateway branch |
|---|---|---|
| Commits since the shared base `6ecbae6b` (2026-10-14) | 9 | 333 |
| Files changed since the base | 188 | 1,349 |
| Migration files added | 39 | 230 |

None of production's 9 commits exists on the gateway branch, not even as an equivalent patch. They are:
- the P0 send-authority hotfix (`c5a7104f`);
- the template, classification and auto-reply fixes of 10-22/23;
- Package A, the non-contacting research runtime (`4362dcfa`, `6ff4a24a`), which is a restricted back-port of rc-8.5.21 code that the gateway branch carries in full.

**Why a reviewed merge and not a selective port.**
- The Action Gateway is a separate local process, but its import closure is 744 files, 729 of them from `apps/api/src`. It runs LeadCommand's own domain and send code.
- 238 of those files differ from production, and they depend on the rc-8.5.21 lineage (conversation AI, holds, negotiation, follow-ups). A "minimal" port would carry most of the branch anyway, without its tests.
- The gateway that will run on the Mac must run production's send-authority hotfix. So the integration is one reviewed merge with production as the authority, and every conflict was decided against the newest production code.

## 2. The 33 conflicts and how each was resolved

"Gateway" means `a77c739f`; "production" means `c5a7104f`.

| File | Resolution | Why |
|---|---|---|
| `lib/domain/inbox/send-now-service.js` | Both, production first. The hotfix's send-authority metadata is kept, then the gateway's automation-hold check with its audited override. The stripped input becomes `let`, so the override metadata can be added server side. | The hotfix strips client-supplied `operator` and `send_authority`; the stripping is kept. The hold check is the gateway's owner P0 containment; it is kept too. |
| `app/api/cockpit/inbox/send-now/route.js` | Production | The hotfix passes the authenticated operator principal, not a header read in the route. |
| `lib/cockpit/cockpit-service.js` | Production's `operator` argument. The gateway's repeat-asking-price override actor is now `operator.id`, and only for an authenticated principal. | One identity source, the hotfix's. It is stricter than either side alone. |
| `infra/cloudflare/worker/index.ts` | Production (both hunks) | Production forwards Package A's flags and deliberately never forwards `AI_CONVERSATION_SHADOW_ENABLED`, `AGENT_MISSIONS_ENABLED`, `LC_FOLLOWUP_EXECUTION` and others into the container. |
| `lib/domain/classification/classify.js` | Gateway's constants, plus production's `notRightNumber` option on `matchesTrueWrongNumber`. The gateway's property-scoped wrong-person rule passes production's context binding through. | Production's 10-22 fix ("not the right number" binds only as a reply to our ownership question) is kept everywhere it applies. |
| `lib/domain/seller-flow/resolve-inbound-relationship.js` | Both. Production's `NOT_RIGHT_NUMBER_RULE_ID` and classifier check, plus the gateway's "a question about us is not a role claim" filter. | Both are later fixes to the same detector. |
| `lib/agent/missions/{index,property-research-handler,review-digest-handler}.js`, `lib/agent/operations/{index,operations-routes}.js`, `lib/agent/runtime/runtime-service.js`, `lib/agent/runtime/runtime-tick.js`, `lib/ai/operations-runtime-wiring.js`, `lib/domain/holds/automation-hold-core.js`, `lib/domain/conversation-ai/{fact-ledger,stop-request}.js` | Gateway, with production's decisions re-applied. Research handlers import `recordFindings` from `record-findings.js`. `DEFAULT_ORG_ID` comes from `runtime/pg-store.js`. | These are the rc-8.5.21 originals that Package A back-ported (production's own comments say "the rc-8.5.21 merge replaces this file"). Production's later decisions are re-applied on top. |
| `lib/agent/operations/operations-handlers.js` | Gateway, plus production's owner exclusions: owner-excluded rows never enter the recovery sweep or the action center, and the cursor still advances past them. | Owner decisions of 2026-10-14 (Maxwell) and 2026-10-19 (Hartford, CLOSED LOST: never revive). |
| `lib/agent/operations/automation-hold-gate.js` | Gateway's registry port first, then production's fixed exclusions when the registry reports nothing. | The registry stays the one authority (the gateway's agreement test passes). The owner's exclusions still hold where the registry migration is not yet applied. |
| `lib/agent/research/research-usage.js`, `tests/critical/research-usage-budget.test.mjs` | Production | Owner decision of 2026-10-20: research paid ceiling up to $200 hard max (the gateway still has $10). |
| `app/api/internal/agent/runtime/tick/route.js` | Gateway's handler map, plus production's `researchRuntimeHandlers()` spread **last**. | Production's restricted research composition keeps its kinds under its own flags, so no production research job silently stops. The rc-8.5.21 kinds are each behind their own flag (default off) and the DB arming. |
| `tests/critical/agent-research-redteam.test.mjs` | Production | It asserts production's worker forwarding list, which is kept. |
| `tests/critical/agent-capabilities.test.mjs`, `migration-version-uniqueness.test.mjs`, `operations-recovery.test.mjs`, `tests/helpers/pg-supabase.mjs`, `tests/pg/agent-pg-harness.mjs`, `scripts/db/{run-migration-test,scan-duplicate-migration-versions,migration-tests.manifest}.mjs` | Gateway | Later versions of the same tooling and the gateway's capability catalog. Production's Package A manifest is preserved verbatim as `scripts/db/migration-tests.package-a.manifest.mjs`. |
| `tests/critical/{operations-brief-drift,property-research-mission}.test.mjs` | Gateway, plus production's Package A seed drift tests appended | Both seeds exist in the tree; both are checked. |

Reconciliation work outside the conflict markers:
- **`lib/agent/operations/package-a-operations-handlers.js` (new).** This is production's Package A handlers, verbatim. After the merge, production's research composition reached the send stack through the rc-8.5.21 handlers (`operations-handlers.js` → `pipeline-reconciler.js`). Production's test `research-package-a.test.mjs` caught it. Production's composition now uses its own handlers again.
- **The 5 Operations API routes** read their services from `research-runtime-wiring.js`, as in production. They use only the store and membership, so the behaviour is equivalent, and they have no import path to the capability plane.
- **Migration version `20261020120000`** is used by two different `PROPOSED_` files from the parallel lines. It is allowlisted with the evidence. Neither is renamed until the read-only review shows which production carries.

## 3. Tests changed by the reconciliation, and why

| Test | Change |
|---|---|
| `research-package-a.test.mjs` (production) | "No send path", "no writes" and "excluded capabilities" now check **Package A's import graph** instead of whole directories. Before the merge Package A was the whole tree; the rc-8.5.21 modules now share those directories and are not loaded by Package A. The tick-route test asserts Package A is spread last. |
| `reply-classification-affirmative-wrong-number-20261022.test.mjs` (production) | "No" / "No thanks" to the ownership question keep production's routing under `LC_BARE_NO_OWNERSHIP_MODE=not_interested`. By default the owner decision of **2026-10-17** applies: a bare "No" means ownership unverified, never a global suppression, and "that's not me" is a property-scoped denial. **Founder decision: confirm before the reconciled web deploy** (section 6). |
| `migration-version-uniqueness.test.mjs` | Expects the new allowlist entry. |
| `migration-test-cluster-sweep.test.mjs` (new) | Leftover migration-test clusters are swept safely. |
| `agntei-launch-chain-pg.test.mjs` | New: a production state with Package A applied (section 5). |

## 4. Evidence

Disposable PostgreSQL 17, in this container.

| Run | Result |
|---|---|
| 23 critical test files for every area touched, on production `c5a7104f` | 200 / 200 |
| Same, on the gateway `a77c739f` | 228 / 230; 2 fail: `agent-capabilities` (catalog count, routes) |
| Same, on the reconciled branch | 297 / 299; the same 2 fail, identically |
| `research-package-a.test.mjs` | 11 / 11 |
| `agntei-launch-chain-pg.test.mjs` | 7 / 7 |

The full critical suites of all three trees are in `docs/AGNTEI-RELEASE-GATE.md`.

## 5. The migration chain against a production that carries Package A

Package A's `PROPOSED_20261020120000_research_event_budget_ceilings` re-creates `agent.runtime_enqueue_event` with per-kind ceilings. Its own header instructs the rc-8.5.21 integrator never to apply `PROPOSED_20261013161000_conversation_decide_event_budget` afterwards, because that would re-create the literal 0.05 clamp.

The chain from the previous pass included it. Now:
- `review-chain.mjs` reads that link **superseded** wherever Package A's ceiling function is live.
- Package A's function body is a reviewed alternative, not drift.
- `apply-one.mjs` refuses a superseded link.
- Proven on PostgreSQL 17: from a Package A production state, the 17 remaining links apply through `apply-one` in order, and Package A's own posttest passes after the whole chain. The one assertion left out ("creates no `runtime_enqueue_event_at`") checks Package A alone.

The per-migration dossier is `docs/AGNTEI-MIGRATION-DOSSIER.md`, generated by `scripts/agntei-launch/migration-dossier.mjs`.

## 6. Decisions that remain the founder's

1. **Merge into production.** Review and merge `review/agntei-production-reconciliation` into `release/cloudflare-production`, or keep production's web code where it is and run only the gateway from the reconciled branch on the Mac.
2. **Seller routing (only on a reconciled web deploy).** Confirm the owner decisions of 2026-10-17:
   - a bare "No" to the ownership question means ownership unverified;
   - "that's not me" is property-scoped;
   - otherwise set `LC_BARE_NO_OWNERSHIP_MODE=not_interested` for production's routing of "No". "That's not me" has no setting.
3. **Production web code against the chain (R1).** Six gateway links add triggers or constraints on tables production's web code writes: `send_queue`, `inbox_thread_state`, `seller_offers`, `acquisition_opportunities` and `campaigns` (dossier, "Production overlap").
   - **Not proven:** production's web code at `c5a7104f` running against a database that carries them. Production's own PostgreSQL tests build their databases from production's migrations only.
   - **Proven:** the reconciled code with those links, by the reconciled branch's PostgreSQL suites (`docs/AGNTEI-RELEASE-GATE.md`).
   - **The safe options:**
     - deploy the reconciled web code together with the chain; or
     - leave the links that touch these tables unapplied until it is.
4. **Migration apply.** Run the read-only review on production first, then apply each pending link with its own approval (`docs/AGNTEI-LAUNCH-RECONCILIATION.md` R2 to R6).
