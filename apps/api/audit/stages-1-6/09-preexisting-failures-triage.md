# §08 Pass 2 — Triage: Pre-existing inbox-live / send-queue / message-event failures

**Status:** triage only — no inbox-live / send-queue / message-event files edited in this pass.
**Branch:** `feature/canonical-intent-safety-policy` (Pass 1, commit `110cf9a`). This branch
contains `main`'s inbox-live/send-queue/message-event code **unchanged**, so it is a valid
vantage point for triage.

## Current failure set

Run (critical harness, `--test-concurrency=1`) of the historically-failing files yields
**10 failures across 3 files**:

| File | Failing tests |
|---|---|
| `tests/critical/message-event-schema.test.mjs` | `writeOutboundSuccessMessageEvent payload includes auto_reply_status and auto_reply_queue_id`; `... sets auto_reply_status=sent for auto_reply type rows`; `... payload does not contain podio_sync_status (relies on DB default)` |
| `tests/critical/queue-run-revision-limit.test.mjs` | `runSendQueue skips revision-capped queue items and continues later work`; `... succeeds when later items are healthy after revision-limit skips`; `... skips first item at process phase and processes second item` |
| `tests/critical/inbox-live-v2-service.test.mjs` + `inbox-state-transition-matrix.test.mjs` + `communications-state-machine.test.mjs` | `live inbox exposes cursor pagination, filters, keyword matches, and map pins`; `visible thread rows floor stale zero count rows`; `count/list equality for waiting bucket`; `outbound sent → Waiting` |

> The foundation pass observed 8; the set is now 10 because `main` advanced
> (`53d0fa9` "stabilize dev supervisor… inbox Waiting counts", `8c97bab` "isolate Vite").

---

## Group A — message-event payload (3 failures)

**Failing file:** `apps/api/tests/critical/message-event-schema.test.mjs` (lines ~73, ~92, ~?).
**Production files involved:** `apps/api/src/lib/supabase/sms-engine.js`
(`writeOutboundSuccessMessageEvent` ~L1450–1575, `buildSuccessMessageEvent`, and
`syncClassifiedInboxThreadState` ~L2920).

**Root cause (primary):** the upsert payload is built by
`buildSuccessMessageEvent(row, send_result, options)`, which **no longer emits
`auto_reply_status` / `auto_reply_queue_id`** (grep of the function range finds neither).
The test asserts both are present (and `auto_reply_status === "sent"` for auto_reply-type
rows) → `actual: false/undefined`. This is a payload-builder feature gap/regression, not a
test bug.

**Root cause (secondary, noise):** the inbox-live work wired
`syncClassifiedInboxThreadState(...)` into the success branch of
`writeOutboundSuccessMessageEvent`. That helper issues
`supabase.from("inbox_thread_state").select("*").eq("thread_key", …).maybeSingle()`.
The test's `makeUpsertSupabase` mock supports the `message_events` upsert but **not** that
select/eq/maybeSingle chain → logged `TypeError: supabase.from(...).select(...).eq is not a
function` ("FAILED TO SYNC CLASSIFIED THREAD STATE ON OUTBOUND SUCCESS"). The **passing**
sibling test (`returns the upserted event row on success`) sidesteps this by injecting
`upsertInboxThreadState: async () => ({ ok: true })`; the failing tests do not.

**Recommended fix (owner: message-event / sms-engine stream):**
1. Restore `auto_reply_status` and `auto_reply_queue_id` enrichment in
   `buildSuccessMessageEvent` for auto_reply-type rows (and confirm `podio_sync_status` is
   intentionally omitted so it relies on the DB default).
2. Either make `syncClassifiedInboxThreadState` injectable/skippable in
   `writeOutboundSuccessMessageEvent`, or extend `makeUpsertSupabase` in the test to support
   the `inbox_thread_state.select().eq().maybeSingle()` chain (return `{ data: null }`), or
   pass the `upsertInboxThreadState` override (matching the passing sibling test).

---

## Group B — queue revision-skip continuation (3 failures)

**Failing file:** `apps/api/tests/critical/queue-run-revision-limit.test.mjs` (L26–120).
**Production file involved:** the `runSendQueue` implementation under
`apps/api/src/lib/domain/queue/` (queue-run-request / retry-send-queue path).

**Root cause:** when an item returns a `queue_item_revision_limit_exceeded` skip
(`final_queue_status: "paused_review"`), `runSendQueue` **halts** rather than continuing to
the next healthy item. The test feeds `[poisoned(514)→revisionSkip, healthy(515)→ok]` and
expects `processed_ids = [514, 515]`, `processed_count: 2`, `sent_count: 1`,
`skipped_count: 1`; actual is `processed_ids = [514]` and `sent_count: 1 !== 2`. So the
runner stops after the first skip instead of skip-and-continue.

**Recommended fix (owner: send-queue / dev-supervisor stream):** in the run loop, treat a
revision-limit skip as `continue` (record the skip result, do not `break`/`return`), so
later healthy items still process. Confirm `skipped_count`/`results[]` shape matches the
test's expected `{ ok:true, skipped:true, queue_item_id, reason, final_queue_status }`.
This is a **behavioral decision** owned by that stream (it changes runner semantics).

---

## Group C — inbox-live service (4 failures)

**Failing files:** `apps/api/tests/critical/inbox-live-v2-service.test.mjs`,
`inbox-state-transition-matrix.test.mjs`, `communications-state-machine.test.mjs`.
**Production files involved:** `apps/api/src/lib/domain/inbox/live-inbox-service.js`
(and inbox state/classification helpers).

**Root cause:** these exercise live-inbox behavior — cursor pagination + filters + keyword
matches + map pins, stale-zero-count flooring of visible rows, Waiting-bucket
count/list equality, and the `outbound sent → Waiting` transition. **`live-inbox-service.js`
currently has uncommitted external WIP in the working tree** (see risk note), so the
failures reflect partially-applied in-flight changes / behavior the stream is actively
stabilizing (cf. `53d0fa9` "…inbox Waiting counts").

**Recommended fix (owner: inbox-live stream):** resolve as part of the in-flight
live-inbox stabilization. Re-run these three suites after that WIP lands; do not fix
in isolation while the source is mid-edit.

---

## Proof these are pre-existing and unrelated to canonical-intent work

1. **Reproduce without this branch's changes:** at `HEAD~1` of the foundation commit
   (`707abe0`, before any coverage-net / canonical-intent code existed), the same files
   fail (40 pass / 6 fail across the sampled set) — documented in
   `FINAL-REPORT.md` §15.
2. **No import coupling:** repo-wide grep shows none of these failing tests import any file
   changed by Pass 1 (`coverage-net/*`, `seller-flow-safety-policy.js`,
   `deterministic-stage-map.js`, `resolve-seller-auto-reply-plan.js`,
   `inbound-dispatcher.js`) — they import `sms-engine.js`, the queue runner, and
   `live-inbox-service.js`.
3. **No source overlap:** Pass 1's commit (`110cf9a`) touches no inbox-live / send-queue /
   message-event source.
4. **Targeted Pass-1 + impacted suites are green:** 202/202 pass on `110cf9a`; the canonical
   coverage matrix is 1,862 rows / 0 missing.

## Owner stream per group

| Group | Owning stream | Tracking commits |
|---|---|---|
| A — message-event payload | message-event / `sms-engine.js` | `d67bac3`, `53d0fa9` |
| B — queue revision-skip | send-queue / dev-supervisor | `53d0fa9` |
| C — inbox-live | inbox-live | `d67bac3`, `53d0fa9`, current uncommitted WIP |

## Risk note — concurrent dirty WIP + external git automation

At triage time the working tree carried **uncommitted modifications** to
`apps/api/src/lib/domain/inbox/live-inbox-service.js`,
`apps/dashboard/src/lib/data/inboxData.ts`, and
`apps/dashboard/src/modules/inbox/inbox.adapter.ts` — active inbox-live WIP not authored by
this pass. In addition, an **external automation repeatedly ran `git stash` + `git checkout`**
("temp for verification checkout") and advanced `main` (`53d0fa9`, `8c97bab`) during the
session, twice wiping the uncommitted working tree. Consequently:

- Fixing Groups A–C now would build on top of half-finished, actively-edited source and is
  likely to **collide** with the owning stream's in-flight changes and the external git
  operations.
- Groups A and B also require **behavioral/feature decisions** (payload contract; runner
  skip-and-continue semantics) that belong to the owning stream's intent.

**Recommendation:** hand these to the owning stream; re-run the three files after the
live-inbox WIP lands. None gate the canonical-intent / Stages 1–6 coverage work.
