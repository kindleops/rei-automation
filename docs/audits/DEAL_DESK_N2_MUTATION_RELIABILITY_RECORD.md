# N.2 — Manual Control and Mutation Reliability — Implementation Record

**Companion to:** [`DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md`](./DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md)
and [`DEAL_DESK_N1_IMPLEMENTATION_RECORD.md`](./DEAL_DESK_N1_IMPLEMENTATION_RECORD.md)
**Branch:** `fix/deal-desk-manual-control-mutations`
**Base:** `eeee5bd8` (`origin/main`)
**Date:** 2026-08-03

## Baseline note

N.1 is merged (`6fcfde73`) and **deployed to production** at `ops.leadcommand.ai`. That
deployment was not pre-authorized; see
[`docs/incidents/2026-08-03-unauthorized-dashboard-production-deploy.md`](../incidents/2026-08-03-unauthorized-dashboard-production-deploy.md).
Merging this branch to `main` will likewise deploy the dashboard to production and must
not happen without explicit production authorization.

Base selection: `origin/main` had advanced from `6fcfde73` to `eeee5bd8` (PR #63, backend
final completion) before this lane started. Verified safe to build on:
- PR #63 changes **zero** `apps/dashboard/**` files.
- It does not touch `patch-universal-lead-state.js`, `universal-lead-state-registry.js`,
  `cockpit-service.js`, or `lead-state/patch/route.js` — the entire N.2 mutation contract.
- Its only inbox-adjacent change is `resolve-inbox-state-from-classification.js` (+38
  lines), an inbound-classification path that belongs to N.3.

---

## Part 3 — Automation-state schema contract (resolved read-only)

Resolved by inspecting migrations, the canonical view definitions, the server write path,
the server response contract, the frontend row adapter, and the display resolver. **No
schema or data was mutated, and no production database was queried.**

### The headline finding: the automation control persists nothing

The audit recorded this as DD-011, "automation state is fabricated client-side and its
write target is never read back." The truth is worse and more specific. The loop is broken
at **three** independent points:

**1. The write silently discards the value.**

```
ThreadStateBar.tsx:373   persist({ autopilot_mode: next })
  → normalizePatchToCanonical()   registry.js:468 — passthrough allowlist keeps the key
  → patchUniversalLeadState()
  → buildRowPatch()               patch-universal-lead-state.js:150-244
                                  ** NO branch for autopilot_mode / automation_state /
                                     automation_status — the key is dropped **
  → upsert({ thread_key, updated_at })
  → returns { ok: true, row }
```

`buildRowPatch` has 45 `rowPatch.*` assignments and not one is an automation field.
A pause/resume therefore writes **only `updated_at`**, returns `ok: true`, and the UI shows
success. Every automation change made from Deal Desk since this path was introduced has
been a no-op reported as a success.

**2. The response cannot carry it back.** The upsert selects back
`UNIVERSAL_LEAD_STATE_PATCH_FIELDS`, which does not include any automation field — so even
after N.2 adds the write, the authoritative response must be widened or reconciliation is
impossible.

**3. The read ignores the server value and fabricates one.** The canonical view does expose
an automation value, but `toWorkflowThread` discards it:

```ts
// inbox.adapter.ts:550
automationState: (t.threadIsArchived || t.threadIsSuppressed ? 'completed' : 'active')
```

and `resolveAutopilotMode` (`status-visuals.ts:478-488`) then reads that fabricated
`automationState`. So the control displays a value derived from archive/suppression flags
and never from any persisted automation state.

### Column inventory

| Column | Table | Defined by | Status |
|---|---|---|---|
| `autopilot_mode` | `inbox_thread_state` | `20260613000000_canonical_inbox_wiring.sql:25` (`ADD COLUMN IF NOT EXISTS ... text`) | **Exists.** Written by nothing. |
| `automation_state` | `inbox_thread_state` | **No `ADD COLUMN` anywhere in this repo** | **Unconfirmed** — but the current canonical view selects it (see below) |
| `automation_status` | `inbox_thread_state` | `20260508030000_inbox_truth_rebuild.sql:13`, `20260509010000_fix_inbox_truth_layer.sql:96` | Exists. Legacy. |
| `automation_status` | `acquisition_contacts` | `20260612120000_acquisition_contacts.sql:75` | **Different table** — not thread state |
| `automation_state` | `canonical_acquisition_opportunities` | `20260621120000:37` | **Different table** — not thread state |
| `automation_status` | `*_universe_state` | `20260526000000_universal_state_architecture.sql:68` | **Different table** |
| `manual_override` | `inbox_thread_state` | referenced by `20260627120000_universal_lead_state.sql:174,196` and projected as `manual_review` | Exists |
| `manual_stage_lock`, `manual_temperature_lock` | `inbox_thread_state` | in `UNIVERSAL_LEAD_STATE_PATCH_FIELDS`; written by `buildRowPatch` | Exist, writable |
| `stage_source`, `status_source`, `temperature_source`, `disposition_source`, `contactability_source` | `inbox_thread_state` | written by `buildRowPatch` from `meta.change_source` | Exist, writable |

The current canonical read view — `canonical_inbox_threads`
(`20260629120000_canonical_inbox_property_flags.sql:75`, `FROM public.inbox_thread_state ts`)
— projects:

```sql
ts.automation_state AS autopilot_mode,
ts.manual_override  AS manual_review,
```

So the client-facing field named `autopilot_mode` is sourced from the column
`automation_state`, **not** from the column `autopilot_mode`.

### ⚠️ Unresolved: does `inbox_thread_state.automation_state` exist in production?

It is created by no migration in this repository, yet the current canonical view selects
it. Either it was created by a migration outside this repo (consistent with the recorded
repo-vs-production migration divergence), or that view revision was never applied.

**This cannot be settled from the repository, and no production database was queried.**
It is the one open input N.2's automation write needs. Until it is settled, the automation
write is implemented but **gated** — see "Automation" below.

### Contract table

| Concept | Canonical DB field | Accepted values | API field | Frontend field | Legacy aliases | Writable? |
|---|---|---|---|---|---|---|
| Lifecycle stage | `lifecycle_stage` | `LIFECYCLE_STAGE_ORDER` (10) | `lifecycle_stage` | `conversationStage` | `seller_stage`, `stage`, `acquisition_stage` (all written by `buildRowPatch`) | ✅ |
| Operational status | `operational_status` | `OPERATIONAL_STATUS_ORDER` (9) | `operational_status` | `inboxStatus` | `conversation_status`, `status` | ✅ |
| Lead temperature | `lead_temperature` | `LEAD_TEMPERATURE_ORDER` (4) | `lead_temperature` | `priority` / `isHotLead` | `temperature` | ✅ |
| **Automation mode** | **`automation_state`** (view-confirmed; existence unconfirmed) | *no registry exists* | `autopilot_mode` (view alias) | `automationState` (**fabricated**) | `autopilot_mode` (column, unwritten), `automation_status` (legacy) | ❌ **not written by any path today** |
| Manual stage lock | `manual_stage_lock` | boolean | `manual_stage_lock` | — | — | ✅ (via `meta`) |
| Manual override | `manual_override` | boolean | `manual_review` (view alias) | `needsReview` (combined w/ confidence) | — | ❌ read-only — resume must not clear it (see Q7) |
| Read / unread | `is_read` | boolean | `is_read` | `isRead` | `read_at`, `last_read_at` | ✅ |
| Change provenance | `*_source` | `ai\|manual\|system\|autopilot` | `change_source` (meta) | — | — | ✅ |

### The ten questions, answered

1. **Which field is canonical for the current automation operating mode?**
   `inbox_thread_state.automation_state` — it is what the current canonical read view
   exposes to clients as `autopilot_mode`. Its physical existence is unconfirmed (above).
2. **Are `automation_state` and `automation_status` separate concepts or historical aliases?**
   Historical aliases on `inbox_thread_state`. `automation_status` is the older column
   (May 2026 dashboard migrations); `automation_state` is what the June 2026 canonical
   views read. Note `automation_status` is *also* a genuinely separate column on
   `acquisition_contacts`, which is a different table and not thread state — the name
   collision is a trap.
3. **What does `autopilot_mode` represent?** Two different things, which is the bug. As a
   **column** on `inbox_thread_state` it is a dead field written by nobody. As a
   **client-facing field name** it is the view's alias for `automation_state`.
4. **Which field should pause/resume mutate?** **`automation_state` only.** It is the
   value the canonical read view exposes, and it is the whole round-trip. The physical
   `autopilot_mode` column is populated by nothing today, so mirroring to it would create
   a second unread copy rather than keep an existing reader working. If a legacy reader is
   later found to depend on that column, add the mirror then — and write both in the same
   row patch so they cannot diverge. Requires adding the missing branch either way.
5. **Which field should the dashboard display?** The server-projected `autopilot_mode`
   from the row contract — never the fabricated `automationState`.
6. **Which fields must remain read-only?** `manual_review` / `manual_override`,
   `confidence`, and all `*_source` provenance fields (server-set from `change_source`).
7. **Does resuming automation need to clear a manual lock?** **No — resume must not touch
   `manual_override`.**

   An earlier draft of this record said `manual_override` is read-only *and* that resume
   may clear it on request. That was a contradiction, and resolving it in favour of
   mutability would let a routine resume erase operator state. The contract is:
   `manual_override` stays **read-only on the resume path**.

   The precedent for a lock-clearing flag does exist —
   `meta.resume_automatic_scoring === true` clears `manual_temperature_lock` and resets
   `temperature_source` to `ai` (`patch-universal-lead-state.js:181-184`) — and if clearing
   an automation override is wanted later it should follow that shape: a **separate,
   explicitly-authorized, audited operation**, not a side effect of resume.
8. **Which terminal/suppression states forbid resume?** `BLOCKING_CONTACTABILITY` (which
   sets `is_suppressed`), `contactability_status` ∈ {`opted_out`, `dnc`,
   `provider_blacklisted`, `invalid_number`, `do_not_text`}, and `lifecycle_stage = closed`.
9. **Does the mutation endpoint return the authoritative persisted row?** Partially — it
   returns `row: data`, but `.select(UNIVERSAL_LEAD_STATE_PATCH_FIELDS)` excludes every
   automation field, so automation cannot be reconciled from the response without widening
   that select.
10. **Can N.2 complete without a migration?** **For stage, status, temperature, read/unread
    and provenance: yes** — every column exists and is already written. **For automation:
    only if `inbox_thread_state.automation_state` already exists in production.** If it does
    not, adding it is a migration and requires separate authorization.

---

---

## Canonical vocabularies (delivered)

`apps/dashboard/src/domain/lead-state/canonical-control-vocabularies.ts`

The mutation-path vocabulary. It differs from `universal-lead-state-registry.ts` in one
decisive way: **it never guesses.** An unrecognised value returns
`{ ok: false, reason, input, dimension }` instead of a valid-but-unrelated default. The
registry's lenient `normalize*` helpers remain appropriate on *read* paths, where coercing
a legacy row into something displayable is reasonable; they must not decide what to persist.

| Dimension | Canonical values | Source |
|---|---|---|
| Lifecycle stage | `ownership_confirmation`, `offer_interest`, `asking_price`, `property_condition`, `offer`, `formal_contract`, `disposition`, `under_contract`, `prepared_to_close`, `closed` | existing `LIFECYCLE_STAGE_ORDER` |
| Operational status | `not_contacted`, `scheduled`, `new_reply`, `active_communication`, `waiting_on_seller`, `follow_up_due`, `needs_review`, `snoozed`, `paused` | existing `OPERATIONAL_STATUS_ORDER` |
| Lead temperature | `unscored`, `cold`, `warm`, `hot` | existing `LEAD_TEMPERATURE_ORDER` |
| **Automation mode** | `active`, `paused`, `human_controlled`, `review_required`, `disabled`, `completed` | **new — none existed** |

### Unknown-value policy

Rejected with a typed reason, never coerced:

| Reason | Meaning | Operator message |
|---|---|---|
| `empty` | nothing selected | "No value was selected." |
| `wrong_dimension` | belongs to another dimension | "…is not a lifecycle stage value. Suppression, inbox bucket and delivery states are tracked separately." |
| `unmapped_legacy` | recognisably legacy, no defined equivalent | "…is a legacy value with no current equivalent. It must be remapped before this control can be edited." |
| `unknown` | unrecognised | "…is not a recognised … value." |

### Legacy mappings

Explicit, one deliberate entry each — `LEGACY_STAGE_MAP` (24), `LEGACY_STATUS_MAP` (10),
`LEGACY_TEMPERATURE_MAP` (7), `LEGACY_AUTOMATION_MAP` (14). Notable decisions:

- `mf_suppressed`, `dead_suppressed` → **refused** (`wrong_dimension`). Previously
  `ownership_confirmation` and `closed`. Suppression is a contactability fact.
- `mf_units_confirmed`, `mf_occupancy_requested`, `mf_rent_roll_requested`,
  `mf_gross_rents_requested` → **refused** (`unmapped_legacy`). The canonical ladder has no
  equivalent position, so any mapping would be a fabrication.
- `closed` as a *status* → **refused**. `INBOX_STATUS_TO_OPERATIONAL` collapsed both
  `closed` and `suppressed` onto `paused`, destroying the distinction.

### Resolution precedence

canonical → **suppression guard (absolute)** → explicit legacy mapping → generic dimension
nets → unknown. The suppression guard is the DD-002 invariant and no mapping may override
it. Explicit mappings outrank the generic nets because a declared mapping is a decision
while the net is a heuristic — `dead` is a legitimate legacy stage meaning `closed` even
though `dead` is also a bucket name, and `queued` is a legitimate legacy status meaning
`scheduled` even though `queued` is also a delivery state. The first draft had this
backwards and the tests caught it.

---

## Optimistic state machine (delivered)

`apps/dashboard/src/domain/inbox/deal-desk-mutation-state.ts` — the `revertOptimisticPatch`
DD-004 asks for, which did not exist.

```
idle → pending → confirmed
             └─→ failed  (rolled back)
```

| Guarantee | Mechanism |
|---|---|
| Failure restores the prior authoritative value | `failMutation` returns `{status:'failed', value: previousValue}` |
| No patch outlives its mutation | every terminal transition drops `optimisticValue` |
| Server wins on success | `confirmMutation` adopts `serverValue`, discarding the requested value |
| Rapid changes roll back correctly | `previousValue` is carried forward while pending, not reassigned per commit |
| Superseded responses cannot commit | `mutationId` checked in both `confirmMutation` and `failMutation` |
| Polling/realtime cannot erase intent | `reconcileExternalValue` returns unchanged while pending |

**Rapid-write policy: last write wins, older responses refused**, tracked per field by
`createFieldMutationTracker`. Chosen over queueing because operator intent is a *state*,
not a *sequence* — cold → warm → hot means "hot", and replaying the first two against the
server is slower and visibly wrong. Chosen over compare-and-set because the server exposes
no revision token today.

---

## Status of this lane

**Partial.** The pure, tested core is delivered; no control is wired to it, so this branch
changes no runtime behaviour.

**Delivered:** canonical vocabularies with the suppression invariant, the optimistic
state machine with real rollback, per-field serialization, the schema contract above, the
incident record, the pre-merge production gate, and the read-only production observation.
147 tests pass (34 new; the N.1 regression suites unchanged), typecheck clean, build clean.

**Not delivered:** wiring `ThreadStateBar` and both `IntelligencePanel` `WorkflowControl`
variants to these modules; writer consolidation; the mutation service call layer; the
`buildRowPatch` automation branch and the widened response select; read/unread repair and
unsupported-thread telemetry; browser verification of mutations.

**Blocking input for the automation write:** whether
`inbox_thread_state.automation_state` exists in production (see above). Everything else in
N.2 can proceed without it.

