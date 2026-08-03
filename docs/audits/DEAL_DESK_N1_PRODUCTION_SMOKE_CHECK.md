# N.1 — read-only production observation

**Target:** https://ops.leadcommand.ai/inbox (production, live operator data)
**Deployed build:** `rei-automation-dashboard` production, from `main` @ `eeee5bd8`
(which contains N.1's `6fcfde73`)
**Date:** 2026-08-03
**Mode:** **Read-only observation.** Navigation and instrumentation only.

> **This is an observation, not a verification suite.** It confirms the deployed build
> behaves correctly on real data for the paths that can be exercised without writing.
> It deliberately does **not** exercise any mutation, so it says nothing about whether
> mutations work — that is exactly what N.2 addresses.

---

## Write safety

Selecting a thread in Deal Desk fires a read-mark `PATCH /api/cockpit/inbox/thread-state`.
That is a write, and writes were forbidden for this check. Rather than skip the selection
paths, a **client-side read-only guard** was installed before any interaction: `fetch` and
`XMLHttpRequest` were wrapped to reject every non-`GET`/`HEAD` request in the browser and
record it. The guard can only make the session more read-only; it cannot cause a write.

**Writes attempted and blocked — none reached the server:**

| Method | Endpoint | Trigger |
|---|---|---|
| `PATCH` | `/api/cockpit/inbox/thread-state` | thread selection (read-mark) |
| `POST` | `maps.googleapis.com/$rpc/…SingleImageSearch` ×2 | Street View tile lookup |

`allowedGets: 21` at that point — reads proceeded normally.

The guard was removed at the end by reloading the page; `window.__RO_GUARD__` is gone and
`window.fetch` is native again, verified, so no operator session can be silently blocked.

**No production data was created, updated or deleted. No message was sent. No automation,
campaign, scrape, queue run or live proof was triggered.**

---

## Results

| # | Check | Result |
|---|---|---|
| 1 | Dashboard loads | ✅ |
| 2 | Deal Desk route loads | ✅ `/inbox` renders the Deal Desk preset |
| 3 | Inbox list renders | ✅ live counts: Priority 154, New Replies 164, Needs Review 17, Waiting 0, All Threads 9,356 |
| 4 | Selected conversation renders | ✅ full message history, state bar, active-prospect card, composer |
| 5 | Switching threads does not blank the workspace | ✅ (see 6 — sampled continuously) |
| 6 | Bucket switching shows no transient global no-selection state | ✅ **0 of 31 samples** over a 29.3s span covering three bucket switches (Priority → New Replies → Needs Review) showed the global empty state |
| 7 | Containers do not remount unnecessarily | ✅ no full-workspace remount observed; panels updated in place |
| 8 | No duplicate conversation/participant requests | ✅ `thread-messages` 4, `thread-hydration` 4, `property-participants` 4 across 4 effective selections — **1 per resource per selection** |
| 9 | No unexpected console errors | ✅ none |
| 10 | No unexpected 5xx from simple reads | ✅ **39/39 measurable API responses were 200**, zero 5xx |
| 11 | Property / Street View behaviour recorded | Observed, not repaired — `/maps/api/streetview` requested ×2; Street View panel rendered. Belongs to N.5. |
| 12 | Unsupported read-route warning not triggered | ✅ not triggered — the selected threads had writable canonical phone routes, and the read-mark was blocked client-side before dispatch |

### N.1 fixes confirmed on production data

- **DD-017 (workspace blanking) is fixed in production.** Zero global-empty-state samples
  across three bucket switches on a 9,356-thread inbox.
- **The single-key-shape fix holds.** Deal Intelligence was fetched under exactly one key
  shape — `/api/cockpit/deal-intelligence/thread/%2B12529085640` (the canonical phone) —
  with no composite `ct:…` variant alongside it.

---

## Findings recorded (not repaired here)

### 1. Two surfaces disagree about operational status — live

For the same selected thread, simultaneously:

| Surface | Stage | Status |
|---|---|---|
| Conversation state bar | `S1 Ownership Check` | **`New Reply`** |
| Deal Intelligence → Deal Pipeline | `S1 Ownership Check` | **`Not Contacted`** |

Stage agrees; **status does not**. Both surfaces render a dropdown caret, i.e. both are
writable. This is the N.2 duplicate-writer defect (DD-006) observed directly in
production, and it is the clearest possible justification for consolidating to one writer
with one shared state.

### 2. Deal Intelligence is fetched 5× for a single thread

`/api/cockpit/deal-intelligence/thread/%2B12529085640` was requested **5 times** for one
selection. N.1 removed the *two-key-shape* duplication; the remaining duplicate fetches
come from separate panels each requesting the dossier independently. Belongs to **N.7**.

### 3. No auto-select on first page load

On a cold load, the workspace shows "Select a thread to open the conversation" until the
operator clicks a row or switches bucket. Auto-select fires correctly on bucket
transitions (verified — a thread was selected automatically in Needs Review), but not on
initial mount, because initial mount is not a bucket *transition* in the N.1 reducer.

Assessment: **behaviour change, not a defect that impairs use.** The prior implementation
auto-opened the first thread after a 400 ms timer. Whether a cold load should auto-open a
conversation is a product decision; it is recorded here rather than silently changed.

---

## Verdict

**No severe regression. Deal Desk is usable in production and the N.1 fixes are working on
real data.** N.2 may proceed.
