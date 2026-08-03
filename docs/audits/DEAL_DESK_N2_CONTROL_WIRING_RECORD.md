# N.2 — Deal Desk control wiring: what changed, what is proven, what is not

Branch `fix/deal-desk-manual-control-mutations` (PR #65, draft).
This record covers the **wiring** lane. The earlier foundation record
(`DEAL_DESK_N2_MUTATION_RELIABILITY_RECORD.md`) covers the vocabularies, the mutation
state machine and the schema contract that this lane consumes.

---

## 1. The automation schema contract, as implemented

| Concept | Column | Frontend name | Written by an operator? |
| --- | --- | --- | --- |
| Operator automation mode | `inbox_thread_state.automation_state` | `autopilot_mode` (view alias) | **Yes** — the only mode write target |
| Queue / execution status | `inbox_thread_state.automation_status` | `queue_status` | No — read-only, displayed beside the mode |
| Manual control lock | `inbox_thread_state.manual_stage_lock` | — | Yes, coupled to `human_controlled` |

`autopilot_mode` is a projection of `public.canonical_inbox_threads`, not a column.
`ThreadStateBar` used to `persist({ autopilot_mode: next })`; `buildRowPatch` had no branch
for it, so every automation write was accepted and silently dropped.

### Persisted values, and where each was located

No value below was invented. Each is already read or written by this repository:

| Frontend mode | Persisted `automation_state` | Located at |
| --- | --- | --- |
| `active` | `running` | `sms-engine.js:3686` writes it on every classified inbound sync; `resolve-seller-auto-reply-plan.js:318` assumes it as the default |
| `paused` | `paused` | `resolve-seller-auto-reply-plan.js:322` → `{ suppress: true, reason: "manual_pause" }` |
| `human_controlled` | `manual` | same branch, same line |

`review_required`, `disabled` and `completed` are canonical modes with **no** located
`automation_state` value. They are therefore not serializable at all, which is the
mechanical reason an operator control cannot write them — on top of the `operatorSelectable`
guard.

An empty or null `automation_state` reads as `active`, because that is what the backend
itself does (`automation_state || "running"`). Displaying it as anything else would tell the
operator a thread is halted when it is not.

**The hydrated view's `COALESCE(automation_status, automation_state, 'active')` is treated
as a legacy read projection only.** No write path falls back from `automation_state` to
`automation_status`, and `deal-desk-automation-contract.test.ts` asserts a row that is
`running` in one dimension and `paused` in the other reads as `active`.

---

## 2. Canonical writers, before and after

"Writer" here means a code path that could independently issue a mutation for that field
**and** hold its own in-flight/optimistic state.

| Field | Before | After | Where the single owner lives |
| --- | --- | --- | --- |
| `lifecycle_stage` | 3 (`ThreadStateBar.useOptimisticField`, `DealIntelligenceCommandRow.useOptimisticField`, `InboxPage.optimisticPatches` → `updateThreadStage`) | **1** | `deal-desk-control-contract.ts` + `DealDeskControlsProvider` |
| `operational_status` | 4 (the three above + `DealIntelligenceHeaderActions` snooze/unsnooze) | **1** | same |
| `lead_temperature` | 3 (`ThreadStateBar`, `DealIntelligenceTemperatureBadge`, `InboxPage` → `markThreadHot`) | **1** | same |
| automation mode | 2, both broken (`ThreadStateBar` wrote `autopilot_mode`, dropped server-side; `pauseAutomation` wrote `operational_status: 'paused'` — the wrong dimension — and `resumeAutomation` mapped to nothing, producing an empty patch the server rejected) | **1** | same |
| `is_read` | 1, never rolled back (`InboxPage.optimisticPatches` → `markThreadRead/Unread`) | **1** | same |

Other surfaces now render the shared handles or a read-only mirror:

* `IntelligencePanel.WorkflowControl` — read-only mirror (`onStatusChange`/`onStageChange` props deleted from the whole chain)
* `IntelligencePanel.SellerCommandCard` — read-only mirror (same)
* `DealIntelligenceCommandRow` — renders the canonical handles
* `DealIntelligenceTemperatureBadge` — renders the canonical handle; display-only when the provider names a different conversation
* Thread rows / context menus / quick actions / command palette — `useCanonicalThreadWriter`, which routes to the open conversation's handle when it matches and otherwise through the same shared writer

`tests/unit/deal-desk-writer-ownership.test.ts` enforces this **structurally**: it scans
`src/` and fails if a second `useDealDeskThreadControls` call site appears, if a Deal Desk
file names a canonical field in a patch outside the contract, if a removed legacy writer is
re-imported, or if `useOptimisticField` returns.

---

## 3. Defects found and fixed while wiring

Four were found by the gates themselves, not by inspection.

1. **`describeServerRefusal` leaked through the prototype chain.** `MAP[key]` returned the
   `Object` *function* for `'constructor'`, typed as a string, and that value would have
   been rendered into the operator-facing error surface. Same defect class the foundation
   review fixed in the vocabularies. Found by a new unit test.
2. **`automation_state` was missing from the client-side patch allowlist.** The dashboard's
   own `normalizePatchToCanonical` stripped it, `persistUniversalLeadState` returned
   "No allowed universal lead state fields in patch", and **no request was ever sent** — the
   control showed a generic save failure with nothing on the wire to explain it. Found by
   the browser run; the component tests missed it because they stub the transport above
   that layer.
3. **The dropdown was unusable with a real mouse.** The outside-click handler listened on
   `mousedown` and closed the portal menu for any target outside the trigger button — and
   an option *is* outside it. The option unmounted before its `click` could fire. Found by
   the browser run; `fireEvent.click` alone dispatches no `mousedown`, so component tests
   could not see it. Now covered by an explicit mousedown→mouseup→click test.
4. **A rollback discarded an earlier confirmed value.** A success followed by a failure on
   the same field fell back to the pre-success row, so the operator saw a value the database
   no longer held. The rollback target is now the last server-confirmed value, and it retires
   as soon as the authoritative row changes.

Two more were fixed as part of the wiring:

5. **`toWorkflowThread` fabricated `automationState`** as `archived||suppressed ? 'completed' : 'active'`,
   reporting "Automation Active" for every non-archived thread regardless of its real state.
   It now derives from the stored column, with the old heuristic kept only as the no-data
   fallback.
6. **Releasing a manual lock never worked.** `DealIntelligenceHeaderActions` sent the locks
   in `meta` with an empty patch; `buildRowPatch` read `meta.manual_stage_lock` only inside
   its `lifecycle_stage` branch, so the request carried no allowed field and the server
   refused it. The locks now travel in the patch body, and `buildRowPatch` accepts them
   standalone.

---

## 4. Server changes (apps/api) — and why they are not deployed by this PR

`automation_state` had no server write path at all. Three additive changes:

* `universal-lead-state-registry.js` — `automation_state` added to
  `UNIVERSAL_LEAD_STATE_PATCH_FIELDS` (which is also the `.select()` list, so the client can
  confirm from the authoritative row), plus a strict `normalizeAutomationState` that drops an
  unrecognised value rather than coercing it.
* `patch-universal-lead-state.js` — persists `automation_state`, audits it, accepts
  standalone `manual_stage_lock` / `manual_temperature_lock`, and refuses a resume
  (`running`) on a suppressed or terminal record. The guard is evaluated against the
  **result** of the patch, so lifting suppression and resuming in one call still works.
* No `automation_state_source` mirror is written — unlike stage/status/temperature there is
  no such column, and inventing one would fail the upsert. Provenance lives in the audit
  event.

**No migration is required.** `automation_state`, `automation_status` and
`manual_stage_lock` already exist on `public.inbox_thread_state`.

> **Deployment consequence, stated plainly:** merging PR #65 deploys
> `rei-automation-dashboard`. It does **not** deploy `apps/api`. Until the API is deployed
> separately, an operator automation-mode write will reach the *currently deployed* route,
> which has no `automation_state` branch — the request will be refused as
> `no_allowed_patch_fields` and the control will roll back and show a save failure. That is
> honest failure rather than silent success, but automation mode will not actually persist
> until the API ships. Stage, status, temperature and read/unread need no API change and
> work against the deployed route today.

---

## 5. Gates — actual exit codes

Captured by `scratchpad/gates.sh`, which records each process's own exit code. No
unconditional echoes.

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| unit: canonical thread reference | `npx tsx --test tests/unit/canonical-thread-reference.test.ts` | 0 | 26/26 |
| unit: deal desk hydration | `… deal-desk-hydration.test.ts` | 0 | 31/31 |
| unit: mutation vocabularies | `… deal-desk-mutation-vocabularies.test.ts` | 0 | 39/39 |
| unit: selection | `… deal-desk-selection.test.ts` | 0 | 22/22 |
| unit: selection continuity | `… deal-desk-selection-continuity.test.ts` | 0 | 21/21 |
| unit: automation + control contract (new) | `… deal-desk-automation-contract.test.ts` | 0 | 46/46 |
| unit: writer ownership (new) | `… deal-desk-writer-ownership.test.ts` | 0 | 8/8 |
| component/integration (new) | `npx tsx --tsconfig tsconfig.app.json --test --experimental-test-module-mocks tests/component/deal-desk-controls.test.tsx` | 0 | 45/45 |
| typecheck | `npx tsc -b` | 0 | — |
| build | `npm run build` | 0 | — |
| lint (N.2 modules) | `npx eslint <12 files>` | 0 | 0 problems |
| api: automation patch (new) | `node --test tests/critical/lead-state-automation-patch.test.mjs` | 0 | 18/18 |
| api: lead-state registry | `node --test tests/critical/universal-lead-state-registry.test.mjs` | 0 | 5/5 |
| browser verification | `npx playwright test tests/ui/deal-desk-control-mutations.spec.ts` | 0 | 1/1, 20 evidence steps |

Dashboard totals: **238 unit + component tests**. API: **23**.

### What the browser run proves, and what it does not

Evidence: `apps/dashboard/proof/deal-desk-control-mutations/evidence.json` — 20 recorded
steps with redacted request/response pairs, remount deltas and the console-error list.

Proven: all 22 requested scenarios, against a real Chromium against a real production
build, with every request body asserted. `remountDeltas` = `{conversation: 0,
deal_intelligence: 0, workspace: 0}`. `consoleErrors` = `[]`. Every phone number in the
evidence is masked.

**Not** proven:
* The stubbed server is a fixture, not the real API. It proves the *client* sends the right
  body and reacts correctly to each response shape. It does not prove the deployed API
  behaves as the API tests say it does.
* Service workers were blocked for the run (`test.use({ serviceWorkers: 'block' })`). Without
  that, requests served through the SW bypass `page.route` entirely — which is how the
  PostgREST reads were escaping interception before. The `postgrestHits > 0` assertion is
  the standing check that interception is real.
* The run used an isolated `--mode fixture` build whose env points every origin at
  `127.0.0.1:4173`. The fixture env file was deleted afterwards; `dist-fixture` is
  gitignored.

---

## 6. Known remaining risk

1. **Automation persistence needs an `apps/api` deploy.** See §4.
2. **`INBOX_LIST_COLUMNS` does not select `lifecycle_stage`, `operational_status`,
   `lead_temperature` or `manual_stage_lock`.** They reach a thread only via a realtime
   `inbox_thread_state` patch or a dossier fetch. The control contract reads legacy source
   columns as a fallback — always through the strict resolver, so a wrong-dimension value
   surfaces as "unsupported" rather than being coerced — but the canonical columns being
   absent from the list query is a read-contract gap for **N.3**.
3. **Writers outside the Deal Desk surface still touch these fields** as documented coupled
   transitions of other actions: `inboxWorkflowData.suppressThread` (stage + status +
   contactability), `unarchiveThread` (status), `persistUniversalLeadState.snoozeThread`
   (status), and `views/pipeline/hooks/usePipelineOpportunities` (stage, a different view).
   None holds Deal Desk optimistic state, and the ownership test scopes its assertion to
   `src/modules/inbox/**` and `src/modules/deal-intelligence/**` for exactly this reason.
4. **`handleWorkflowMutation` still renders `result.errorMessage` verbatim** for the actions
   it still owns (archive, star, pin, snooze, suppress, retry). That string embeds the
   request URL, and the thread key in that URL is the seller's phone number. The canonical
   control fields no longer go through it; the remaining actions do.
5. **Component tests stub `patchLeadStateFromView`.** They prove the contract and the state
   machine, not the transport. Two of the four defects above lived below that seam and were
   only caught in the browser.

---

## 7. Deployment boundary

PR #65 is **not merged** and N.2 is **not deployed**. No migration was written or applied.
No production row was read or written by this lane — the browser verification ran entirely
against local fixtures with `*.supabase.co`, `*.vercel.app` and `*.textgrid.com` aborted at
the route layer.
