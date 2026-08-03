# N.1 — State and Hydration Stabilization — Implementation Record

**Companion to:** [`DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md`](./DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md)
**Branch:** `fix/deal-desk-state-hydration-foundation`
**Base:** `c83488d1` (`main`, PR #62 merge commit)
**Date:** 2026-08-02

This record documents what N.1 changed. It does **not** amend the audit's observed
findings — everything the audit reported was true of the audited tree, and the sections
below say only which of those findings this lane closed and which remain open.

Nothing was deployed. No migration was applied. No production data was read or written.
No campaign, scrape, send, automation or live proof was started.

---

## 1. N.1 findings addressed

| Audit finding | Status after this lane |
|---|---|
| **DD-018** — selected thread has eight writable representations | **Closed.** One reducer-owned selection; the rest derived, read-only, or deleted. |
| **DD-017** — bucket switch clears the selection and blanks the panels | **Closed.** Bucket transitions are list-local; the hydrated workspace stays on screen. |
| **DD-024** — thread hydration is sequential despite claiming to be parallel | **Closed.** All four primary fetches start in one tick. |
| **DD-003** — reads and writes resolve thread identity differently | **Closed for the read/selection/hydration paths and for the read-mark write.** The remaining mutation call sites now receive a structured reference, but rollback and error surfacing are N.2. |
| §I.1 — `selectedRef.current = selected` assigned during render | **Closed.** Moved to a layout effect. |
| §C.1 — participants fetch has no cancellation token on the response commit | **Closed.** Bound to the shared request guard with real cancellation. |
| §J — good data wiped by an unresolved request | **Closed for the selection/bucket path.** A refresh or failure no longer erases valid data. The eleven loading treatments themselves are N.8. |

---

## 2. Canonical selection model

`apps/dashboard/src/domain/inbox/deal-desk-selection.ts`

```ts
interface DealDeskSelection {
  threadId: string                          // opaque row identity; never phone-validated
  threadReference: CanonicalThreadReference  // the only identity panels may consume
  propertyId: string | null
  prospectId: string | null
  ownerId: string | null
  canonicalPhone: string | null
  inboxBucket: string                        // explicit, separate from thread identity
  selectionVersion: number                   // monotonic; bumps only on identity change
}
```

Missing identities stay explicit `null`. No field is ever derived from another: a phone
never becomes a property id, an owner display name never becomes a prospect id.

`selectionVersion` increments **only** when the selected conversation actually changes —
never on a data refresh — so a poll cannot invalidate in-flight hydration.

### Reconciliation policy (the reducer is the whole policy)

| Event | Behaviour |
|---|---|
| `SELECT_THREAD` (operator) | Always wins. Re-selecting the same thread does not bump the version. |
| `BUCKET_REQUESTED` | Marks the **list** loading. Does not touch the selection. |
| `LIST_RESOLVED`, selection present in rows | Preserve identity and version; refresh derived fields only. |
| `LIST_RESOLVED`, bucket transition, selection absent | Auto-select first eligible **exactly once** per transition. |
| `LIST_RESOLVED`, bucket transition, rows empty | Confirmed empty state — and only then is the selection cleared. |
| `LIST_RESOLVED`, operator selected during the transition | Auto-select stands down; the click is newer information than the response. |
| `LIST_RESOLVED`, same-bucket refresh, selection absent | **Documented successor policy:** keep the selection and its hydrated workspace, flag `selectionOutOfView`. A row changing category is not proof the conversation is unavailable, and advancing silently would swap the workspace out from under an operator mid-draft. |
| `ROWS_PATCHED` (poll / realtime / append) | Never changes which thread is selected. |

---

## 3. Canonical thread-reference contract

`apps/dashboard/src/domain/inbox/canonical-thread-reference.ts` (pure, dependency-free)
`apps/dashboard/src/domain/inbox/deal-desk-thread-reference.ts` (app binding)

```ts
interface CanonicalThreadReference {
  threadId: string
  canonicalE164: string | null
  conversationId: string | null
  selectionKey: string                       // the one key every panel derives from
  source: 'conversation_id' | 'thread_id' | 'canonical_e164'
  writable: boolean
  reason?: 'no_canonical_phone' | 'phone_not_server_writable'
}
```

**Before:** reads used `resolveCanonicalThreadStateKey` (phone-first, falling back to any
identity); writes used `toThreadKey = thread.threadKey || thread.id || owner:prop:phone`.
Two resolvers, one table, different answers (DD-003).

**After:** one resolver. Guarantees, each covered by a test:

- phone normalization happens in exactly one function;
- a UUID or a composite (`ct:…`, `property:…`) is never fed through phone validation —
  its digit run cannot be reinterpreted as a phone;
- a missing writable contact route returns a typed failure, never a fabricated phone and
  never a fallback to an unrelated identifier;
- `selectionKey` is byte-compatible with the pre-existing message-cache key
  (`conversationThreadId || threadKey || id`), so warm caches keep hitting;
- `resolveThreadRouteKey` gives thread-scoped GET routes one identifier, so a
  conversation is never fetched twice under two key shapes.

The app binding injects the repository's existing composite conversation-id builder rather
than reimplementing it — this contract is a replacement for the scattered resolvers, not a
sixth implementation.

---

## 4. Duplicate state sources removed

| Removed | Replacement |
|---|---|
| `useState selectedId` | Derived from `selection.threadId` |
| `useState selectedThreadKey` | Derived from `selection.threadReference.selectionKey` |
| `selectedThreadFallbackRef` | Last-known-thread map inside `useDealDeskSelection` |
| `layoutState.selectedThreadId` writes (7 sites) | Deleted — the field was never read anywhere in the dashboard |
| `selected → setSelectedId/setSelectedThreadKey` self-sync effect | Deleted — nothing left to sync |
| `threadByKey` map (conversation id + threadKey + id → row) | `threadBySelectionKey`, keyed by the one canonical key |
| `selectedThreadKeySnapshot` / `selectedIdSnapshot` | Deleted — existed to make two representations usable in dep arrays |
| Selection-from-bare-`threadKey` in 4 external-context paths | Anchors only when it resolves to a real thread |

`activeContext`, `previewContext` and `universalEntityContext` remain, but as **routing**
context only: they say which entity the workspace is pointed at and anchor a selection
through `selectFromExternalContext`. They no longer independently decide what is selected.

---

## 5. Request-race protection

`apps/dashboard/src/domain/inbox/selection-request-guard.ts`

Every selection-triggered request gets a token bound to `(selectionKey, selectionVersion)`
plus a per-resource generation. A response may commit only if `accept(token)` returns
true. Superseding also **aborts** the previous request, so the work is cancelled rather
than merely discarded.

Wired at both paths the audit named:
- the four primary hydration fetches (one shared `conversation` slot);
- the participants fetch — §C.1's "no cancellation token on the response commit".

Covered: A→B before A resolves · A→B→A · property after thread · intelligence after
selection change · failed secondary after core success · realtime for a non-selected
thread · poll after a bucket change.

---

## 6. Hydration and caching

`hydration-state.ts` — `HydrationState<T>` with `idle | loading | ready | refreshing |
error`. The invariant, enforced by the transitions rather than by call sites: **a load, a
refresh or a failure never erases data that was already valid.** Only an explicit reset
does, and that is reserved for an explicit selection clear.

`deal-desk-resource-cache.ts` — one cache per resource, keyed by that resource's own
identity: conversation by selection key, property by property id, prospect by prospect id
(or phone, in a distinct namespace), intelligence by property + analysis version, media by
property + media ref. A null identity yields a null key, not an empty-string bucket.

Consequences, each tested: switching threads on the same property is a property-cache hit;
an intelligence failure cannot evict the conversation; a media failure cannot erase
property facts.

---

## 7. Composer continuity

`composer-draft-store.ts` — drafts keyed by canonical thread id, restored on an
intentional selection change. Nothing in the selection or hydration path sends or discards
a draft; `clear` is called only after a successful send or an explicit discard.

Before, `draftText` was one string for the whole workspace, so unsent text written for
thread A stayed in the box after moving to thread B.

---

## 8. Runtime verification

`apps/dashboard/tests/ui/deal-desk-selection-continuity.spec.ts`, evidence at
`apps/dashboard/proof/deal-desk-selection/runtime-evidence.json`.

Deal Desk has no fixture/mock data source and no dev auth bypass, so a live run would have
required production Supabase credentials. Those were deliberately not used. Instead the
real built app runs against a local stub origin with every inbox route and the Supabase
auth endpoints served from synthetic fixtures; requests to `*.supabase.co`,
`*.vercel.app` and `*.textgrid.com` are aborted so a leak fails the run rather than
passing silently.

| Check | Result |
|---|---|
| 7 selections (5 rapid) — only the latest stays active | ✅ |
| Requests per selection | 7 conversation, 7 participants — **1 each, no duplicates** |
| Stale responses refused / requests aborted | **7 / 12** |
| Workspace remounts across 7 selections + 3 bucket switches | **1** |
| Conversation remounts | **1** |
| Deal Intelligence remounts | **1** |
| Global empty workspace during bucket transitions (12 samples) | **false in all 12** |
| Composer draft after a list refresh | preserved |
| Delayed Intelligence response after selection changed | did not re-point the workspace |
| Console errors | **0** |

### Two defects the runtime pass found

1. **Stale rejections were never counted.** `buildIsStillSelected` short-circuits on the
   effect's local `cancelled` flag before calling its key resolver, so a superseded
   response never reached the guard. The first pass reported `staleRejections: 0`
   alongside `abortedRequests: 6` — the protection worked, the measurement was blind. The
   settle path now consults the guard first and publishes at settle time.
2. **The same conversation was fetched under two key shapes** (a regression introduced
   earlier in this lane). Routing the orchestrator's dossier fetch through the canonical
   contract made it send the composite key while `useDealIntelligenceDossier` still sent
   the phone. Both now use `resolveThreadRouteKey`.

---

## 9. Before / after

| Measure | Before (audited) | After |
|---|---|---|
| Writable selected-thread sources | 8 | **1** |
| Thread-key resolvers | 2 (divergent) | **1** |
| Primary hydration | messages awaited, then 3 in parallel | **4 in one tick** |
| Bucket switch | selection nulled → panels blank → auto-select → re-hydrate | **list-local; selection and panels preserved** |
| Uncancelled selection-triggered fetches | participants, valuation-snapshot, read-mark | **participants and read-mark closed; valuation-snapshot is N.5** |
| `react-hooks/refs` lint errors in the three Deal Desk files | 91 | **2** |
| Total lint findings in those files | 415 | **322** |

Lint totals are per-rule at or below baseline; no rule regressed.

---

## 10. Tests

| Suite | File | Count |
|---|---|---|
| Thread-reference contract | `tests/unit/canonical-thread-reference.test.ts` | 24 |
| Selection state machine | `tests/unit/deal-desk-selection.test.ts` | 17 |
| Hydration / guard / caches / drafts | `tests/unit/deal-desk-hydration.test.ts` | 29 |
| Selection + hydration continuity (integration) | `tests/unit/deal-desk-selection-continuity.test.ts` | 24 |
| Pre-existing regression suites (unchanged, still green) | `thread-selection-cache`, `inbox-boot-read` | 10 |
| **Total** | | **104** |

Run with `npx tsx --test apps/dashboard/tests/unit/<file>` — the repository's unit
convention is `node:test`, not vitest (vitest is not installed).

The integration suite drives the same modules `InboxPage` runs. The repository has no
jsdom or React Testing Library dependency, so component-level assertions are expressed
against the state machine that owns the behaviour, with browser-level confirmation in the
Playwright spec. **This is a real limitation** — see §12.

---

## 11. Remaining N.2 dependencies

N.2 (Manual Control and Mutation Repair) can begin. What it inherits:

- **Ready:** one thread-key resolver (`resolveDealDeskWritableThreadKey`) that returns a
  typed failure instead of a key the server will reject, and a stable selection identity
  to attach optimistic patches and rollbacks to.
- **Still open, and N.2's to fix:**
  - `revertOptimisticPatch` does not exist; `handleWorkflowMutation` still returns on
    `!ok` without touching `optimisticPatches` (DD-004).
  - Success toasts are still emitted before `ok === true`.
  - `SellerStage` / `InboxStatus` are still in the mutation path; the `normalize*`
    functions still fall back instead of failing (DD-002).
  - `resumeAutomation` still writes an unmapped `automationState` (DD-005).
  - `autopilot_mode` is still not projected into the row contract (DD-011).
  - Both `IntelligencePanel` `WorkflowControl` variants are still writers (DD-006).
  - Mutation call sites still use `toLegacyThreadJoinKey` for the `operator_thread_state`
    join. That is a join key, not a mutation identifier, and was deliberately left alone.

Other lanes: N.3 (counts/lifecycle), N.4 (identity/contact path), N.5 (Street View — the
valuation-snapshot fetch is still uncancelled), N.6 (pagination — `hasMore` is still
structurally dead), N.7, N.8 are untouched.

---

## 11b. Code review (PR #64)

CodeRabbit's full review produced **13 findings. All 13 were valid and all are fixed**
in `457713ec`; every thread is resolved. Three are worth recording because they change
what this document previously claimed.

| Finding | Why it mattered |
|---|---|
| `stats.aborted` counted settled requests | `accept` never released the controller, so `abortSlot` incremented on no-op aborts of already-settled controllers. The originally reported **12 aborts was inflated**. Fixed and the evidence file regenerated. |
| Google Maps was never intercepted | The first run made **29 live requests to `maps.googleapis.com` carrying the real API key**, which contradicted this document's own "no live data" claim. Maps/gstatic are now stubbed, and the spec asserts every observed Maps request was answered locally (29/29 intercepted, 0 escaped). |
| Seller Automation thread key | A **regression introduced by this lane**: `handleOpenSellerAutomation` was changed to send the Deal Desk selection key, which can be a composite `ct:…`. Seller Automation applies it as `thread_id=eq.<value>`, which a composite can never satisfy. Now uses `resolveThreadRouteKey`. |

The other ten: `LIST_FAILED` stale-bucket guard; `external_context` selections protected
during a transition; `ROWS_PATCHED` clearing a stuck `selectionOutOfView`; stale closure
reads in the hydration effect; participants loading flag stuck on the early-return path;
`guard.abortAll()` on unmount; read-mark failures surfaced to the operator rather than
DEV-only; `reconcileList` no longer running its O(n) identity pass on every poll; and the
pure-vs-binding resolver misuse in **both** `useDealIntelligenceDossier` and
`thread-select-orchestrator` (the second was not flagged — found while fixing the first).

Test count rose 104 → **113**.

## 12. Known limitations

1. **No component-level DOM tests.** No jsdom/RTL in the repository. Integration coverage
   is state-machine-level plus a real-browser Playwright run. Adding RTL would be a
   dependency change beyond this lane.
2. **Runtime verification is fixture-backed, not production-backed.** Deliberate: a live
   run needs production Supabase credentials. Latency, live count/list divergence and
   real data shapes remain unverified — the same limitation the audit itself recorded.
3. **Deal Intelligence is still fetched more than once per thread** (3–6 requests per
   thread in the trace) by different panels. This lane removed the *two-key-shape*
   duplication; collapsing the remaining duplicate fetches belongs to N.7.
4. **Read-mark now fails loudly instead of silently.** A thread with no dialable phone no
   longer fires a request the server would reject, and now shows the operator a warning
   ("This conversation has no writable canonical phone route.") rather than the DEV-only
   log it had at first review. The thread still will not mark as read — making that
   *succeed* requires the N.2 mutation work.
5. **`selectionOutOfView` is set but has no UI affordance yet.** The state is correct and
   tested; rendering a "not in this view" control is an N.8 presentation concern.
6. `apps/dashboard/.env.local` is written for local verification only and is gitignored.
   It points at local stub origins and contains no credential.
