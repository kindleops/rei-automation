# rc-8.5.21: turn dispatch and recovery (blind-eval D1–D4)

## What changed

| Defect | Fix |
|---|---|
| D1. AI rows were written with `max_retries 0`, so the runner's pre-claim gate paused every one (`paused_max_retries`) | R3 writes `max_retries 1`. The row is dispatchable exactly once, and any failure is final. The runner never retries an ambiguous accept (`retry_permitted` requires a provably retryable class), and AI rows have no template id, so they can never rotate. |
| D2. A crash between the `ai_generated_messages` record and the `send_queue` insert lost the reply. The turn said "dispatched". | On retry, R3 treats a record WITHOUT its queue row as unfinished. It completes the enqueue with the record's exact text: body hash checked, same `ai_message_id`, and the crashed attempt's seller-day and global slots completed rather than taken twice. Only a record whose row exists is `already_enqueued`. An unreadable record or row means retry. Tested with a real SIGKILL (`conversation-ai-8521-e2e-pg.test.mjs`). |
| D3. R3 holds were recorded as "dispatched", with no operator item | The turn's dispatch outcome comes from the R3 status (`dispatchOutcomeOf`): enqueued / already_enqueued → `dispatched`; deferred → `deferred`; no_response / suppressed / stale_inbound → `not_sent`; anything else → `held`. A hold first raises ONE `agent.ops_work_item` (scope `conversation`, kind `escalation`, dedupe `conversation:turn_held:<turn>`) through the lease-bound `agent.ops_work_item_sync` (PROPOSED_20261017122000). Only then is it recorded as `held`. If the item cannot be written, the lease is released and the job retries, so a hold is never silent. |
| D4. A frozen worker orphaned the turn unless the born-disabled sweep was on | `conversation_reply_turn_claim` now reports `retry_after_ms` when another worker holds a LIVE claim (DB clock). The engine throws `DEFERRED_LIVE_CLAIM`, and the runtime reschedules the job at lease end + jitter, bounded by `max_attempts` (then dead letter, which the supervisor counts). After expiry the rescheduled job claims and decides. |

## D4 choice: recovery does not depend on the turn sweep

Recovery of a claimed, decided or dispatching turn is **lease expiry + runtime retry** of the turn's
own job:

- **live claim** → `DEFERRED_LIVE_CLAIM`;
- **live dispatch lease** → `DEFERRED_LIVE_DISPATCH`;
- **expired** → claim, or `conversation_reply_turn_dispatch_claim`.

A worker that dies holding a runtime lease is reaped. Its job retries and reaches one of these paths.

The `conversation-turn-sweep` schedule stays born-disabled and optional. It covers only a LOST
ENQUEUE, i.e. a turn whose job row never existed. It is not needed for a frozen or crashed worker.
Proven without the sweep in `conversation-ai-turn-dispatch-lease-pg.test.mjs` (D4) and
`conversation-ai-8521-runtime-matrix.test.mjs` (D4).
