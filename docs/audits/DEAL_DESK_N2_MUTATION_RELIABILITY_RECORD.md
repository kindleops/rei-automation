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
| Manual override | `manual_override` | boolean | `manual_review` (view alias) | `needsReview` (combined w/ confidence) | — | ❌ read-only today |
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
4. **Which field should pause/resume mutate?** `automation_state` (plus a mirror write to
   the `autopilot_mode` column, matching the established `buildRowPatch` convention of
   writing canonical + legacy aliases together). Requires adding the missing branch.
5. **Which field should the dashboard display?** The server-projected `autopilot_mode`
   from the row contract — never the fabricated `automationState`.
6. **Which fields must remain read-only?** `manual_review` / `manual_override`,
   `confidence`, and all `*_source` provenance fields (server-set from `change_source`).
7. **Does resuming automation need to clear a manual lock?** The precedent exists and is
   explicit: `meta.resume_automatic_scoring === true` clears `manual_temperature_lock` and
   resets `temperature_source` to `ai` (`patch-universal-lead-state.js:181-184`). Resume
   should follow the same shape. There is **no equivalent automation lock field** today, so
   resume clears `manual_override` only if the operator explicitly asks.
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

## Status of this lane

See the completion report. This record documents the settled schema contract (Part 3),
which was the prerequisite for the automation repair.
