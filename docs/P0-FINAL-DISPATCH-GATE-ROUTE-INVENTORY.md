# P0 final dispatch gate: production send-route inventory (2026-11-23)

Base: `c6bc61d0` (the production build on `release/cloudflare-production`).
Scope: founder P0 items 1, 2, 5, 6 and 9 on the LeadCommand production line.
Nothing in this change sends a message. Nothing has been deployed.

## Round 2 (gate `final_dispatch_gate_v2`): what changed

Sentry review task_783e03da (CHANGES REQUESTED on `ea46238b`) had three blocking items. Here is how each is handled.

1. **The historical check no longer depends on markers.** The migration `apps/api/supabase/migrations/PROPOSED_20261123190000_p0_send_queue_status_history_and_authority_events.sql` adds two append-only tables. Database triggers write them, so no application path, reconcile pass or hand-written `UPDATE` can skip them:
   - `send_queue_status_history` records every insert and every `queue_status` change on `send_queue`.
   - `send_authority_events` records every change to a freeze or brake key in `system_control`: `queue_emergency_stop_at`, `queue_emergency_stop_active`, `global_send_shutdown_at`, `queue_processor_mode`, `queue_execution_mode`, `campaign_mode`, `outbound_sms_enabled` and `queue_runner_enabled`. It also holds one **floor event**, written when the migration is applied.

   At send time, the gate reads the row **fresh** from `send_queue`, plus its status history and the latest authority event. It never uses the caller's copy of the row. The row is **historical** if any of these is true:
   - `created_at` is missing.
   - The row is older than 24 hours.
   - It was created before the P0 floor (`2026-11-23T00:00Z`).
   - It was created at or before the latest freeze or brake event.
   - It has no status history.
   - Its history contains any status outside the fresh set (`draft`, `pending`, `pending_send`, `queued`, `scheduled`, `ready`, `approved`, `approval`, `processing`, `sending`, `claimed`, `in_flight`, `dispatching`). That covers `paused_global_lock`, `paused_invalid_queue_row`, `failed`, `held`, `expired`, `cancelled`, every `paused_*` and `blocked_*`, review and quarantine.
   - The seller replied after the row was written.

   Metadata markers still count, but nothing depends on them. A historical row needs a valid owner release. If any history read fails, the row is refused. Cockpit approve, retry, retry-routing and reschedule use the same trigger history.
2. **The dashboard app's queue routes are fenced.** See "Dashboard app routes" below.
3. **The owner release can be reached and cannot be forged.**
   - **The route:** `POST /api/cockpit/queue/owner-release` (`apps/api/src/app/api/cockpit/queue/owner-release/route.js`). Before this change, no HTTP route reached the owner-release action at all.
   - **Authentication:** the request must carry the Worker-attached `x-ops-dashboard-secret` header (header path only, no cookie). It must also carry the Worker-stamped, session-verified `x-ops-user-id`, and that user must be in `OPS_ALLOWED_USER_IDS`, which the route re-checks itself. An empty allowlist authorizes nobody.
   - **The actor is the logged-in user.** Body fields that name a person are ignored.
   - **The signature:** the release is an HMAC-SHA256, made with a server secret, over the row id, actor user id, time, reason, destination and a SHA-256 hash of the message body (`owner-release-signature.js`).
   - **The audit event:** the same signed record is written first as a `QUEUE_OWNER_RELEASE` audit event in `automation_events`.
   - **What the gate checks:** the signature against the row as it is now, and that the matching audit event exists (same dedupe key, row, actor, time and signature). A bulk SQL write of `metadata.reauthorization` cannot produce either. A signature copied from another row, another recipient or an edited message fails.
   - **When a release stops counting:** after 24 hours, or when any of these comes after it: a non-fresh status (even one flipped back by hand), a freeze or brake event, a hold marker, or a seller reply.
   - **The key:** `QUEUE_OWNER_RELEASE_SECRET` if it is set. Otherwise a key derived from `CRON_SECRET`, which the production Worker already forwards to the container. No key means no release can be signed and none verifies.

Also fixed:
- `live-textgrid.js` now runs the full `evaluateFinalDispatchGate` (path `manual`, operator action id = run id): brake state now, identity, suppression, thread and holds. Before, it ran only the release preview.
- The manual bridge's row is re-read fresh by the gate. The code was fixed, and the comment now says so.
- The campaign-resume hold pages through every row (keyset by id, 500 per page). The 10,000 cap is gone, and a page that cannot be read refuses the resume.
- The claim token must equal the fresh row's `lock_token`. It must also pass `queue_verify_dispatch_authorization`, the atomic claim's own verifier.

## Deploy order (required)

The brake (`queue_emergency_stop_at`) stays set throughout.

1. **Apply the migration** `PROPOSED_20261123190000_p0_send_queue_status_history_and_authority_events.sql`. This needs operator approval. It installs the triggers and writes the floor event. From then on, every row that already exists is historical.
2. **Deploy the API build** that contains `final_dispatch_gate_v2`.
3. **Set the signing key.** Set `QUEUE_OWNER_RELEASE_SECRET` as a Worker secret and add it to the container allowlist in `infra/cloudflare/worker/index.ts`. That is an infra edit outside this change. Until then, the key derived from `CRON_SECRET` is used.
4. **Verify live** before anyone touches the brake:
   - `SELECT count(*) FROM send_queue_status_history` grows as rows change.
   - `send_authority_events` has the floor row.
   - A dry-run owner release returns `ok`.
5. Only then may anyone touch the brake.

**What happens if the order is wrong:**
- **Code before migration:** the gate cannot read the tables and refuses every automated send (`final_gate_row_history_unreadable`). This is safe.
- **Migration before code:** the old code ignores the tables, and the brake is still set, so nothing sends.
- **Brake lifted immediately after deploy:** the lift writes a newer authority event. Every row created before it, including every row from before the deploy (the floor), is historical and needs a signed, audited, per-row owner release. Lifting the brake releases nothing.
- **Trigger rollback:** new rows have no insert history and are refused. A rollback stops sending; it never widens it.

## Dashboard app routes (`apps/dashboard/api/internal/queue/*`)

| Route | What it did | Now |
|---|---|---|
| `retry-failed.ts` | `failed` → `queued` with the service role; only the `NEXUS_ALLOW_BACKEND_MUTATION` guard | **fenced**: `INTERNAL_API_SECRET` auth, then 410, no client created |
| `reprocess-paused.ts` | `paused_invalid_queue_row` → `queued`; **no authentication** | **fenced** (same) |
| `reconcile.ts` | rewrote statuses with the service role | **fenced** |
| `run.ts`, `run-safe-batch.ts` → `runner.ts` | dashboard runner wrote `sent` state, `message_events`, `inbox_thread_state` | **fenced**; `runQueueBatch` also refuses before creating a client |
| `build-outbound.ts`, `build-followups.ts`, `build-replies.ts` | inserted `send_queue` rows outside the backend enqueue restrictions | **fenced** |
| `cancel-stale-followups.ts` | wrote `send_queue` with the browser client and no auth | **fenced** |

The shared fence is `apps/dashboard/api/_lib/queueRouteFence.ts`. Its `_` prefix means Vercel never deploys it as a function. `utils.ts` and `templateSelection.ts` are helper modules with no handler, so they are not routes.

**Are they deployed?**
- **Production, `ops.leadcommand.ai`:** no. `infra/cloudflare/wrangler.production.jsonc` serves `apps/dashboard/dist` as static assets only. The Worker sends every `/api/*` request to the `apps/api` container (`infra/cloudflare/worker/index.ts`, `fetch`), so these files are never served there.
- **Vercel:** a Vercel project rooted at `apps/dashboard` (`apps/dashboard/vercel.json`, framework `vite`) builds the `api/` folder as serverless functions. Its rewrites do not cover `/api/internal/queue/*`, so these handlers **would be live on any such deployment**. CORS still lists `nexus-dashboard.vercel.app`. Whether that Vercel project is still deployed cannot be determined from the repository. The fence makes the answer irrelevant.
- **None of them is needed.** Each has a gated apps/api equivalent: `/api/internal/queue/run`, `/api/internal/queue/reconcile`, `/api/internal/campaigns/feed`, `/api/cockpit/queue/cancel-stale-followups` and `/api/cockpit/queue/owner-release`. This project's boundary rule already says queue mutations run from the backend.

**apps/api routes that re-arm rows:** `/api/cockpit/queue/retry-failed` (`runRetryRunner`) and `/api/internal/queue/retry` can still change a failed row's status. They cannot make it sendable, because `failed` in the status history makes the row historical and the gate refuses it without a signed owner release. `/api/cockpit/queue/reprocess-paused` already answers 501 and writes nothing.

## The one gate

`apps/api/src/lib/domain/queue/final-dispatch-gate.js#evaluateFinalDispatchGate`

Every seller-visible SMS reaches TextGrid (`providers/textgrid.js#sendTextgridSMS`) through the canonical seam, `communications/canonical-communication-dispatch.js#executeSellerCommunicationAttempt`. The seam calls `evaluateRuntimeAuthority` on every attempt, immediately before it allocates the attempt and calls the provider. It refuses with `runtime_authority_unavailable` if no runtime authority is wired.

The seam has exactly two bridges, and a test ratchet holds that to two. Both answer `evaluateRuntimeAuthority` with the shared gate:

| Bridge | Gate call site |
|---|---|
| `communications/dispatch-seller-queue-row.js` (path `queue`) | `evaluateRuntimeAuthority` → `evaluateFinalDispatchGate({ path: 'queue', row, to, thread_key, claim_token, contact_window, in_session_reply, operator_attended })` |
| `communications/dispatch-manual-operator-send.js` (path `manual`) | `evaluateRuntimeAuthority` → `evaluateFinalDispatchGate({ path: 'manual', row, to, thread_key, operator_action_id })` |

Checks, in precedence order. The first refusal is the verdict, and all refusals are returned for audit.

1. **Execution authorization (brake state now):** the canonical send authority (automation) or the manual-send authority (an operator principal). A refusal ends the check with no live reads.
2. **Row status:** `paused_operator_review` and the other review spellings, quarantine, `held`, `paused_*`, `blocked_*` and terminal statuses never dispatch.
3. **No automatic reactivation:** a row with hold history needs a fresh per-row reauthorization. Hold history includes brake hold or expiry, `held_through_send_brake`, conversational cap release or review, sender-continuity hold or release, a delivery-retry clone, stale-expiration recovery, a campaign-resume hold, `reauthorization_required`, `dispatch_hold`, `held_at` or `paused_reason`. The only accepted reauthorization is `metadata.reauthorization`, written by the Cockpit owner release. It must be bound to this row id, name an actor and a reason, and be no more than 24 hours old. It is invalid if a hold or a seller inbound came after it.
4. **Contact identity:** `thread_key` must equal the destination E.164. A manual send must name its thread.
5. **Duplicate-send identity:** a queue row must carry the atomic claim's lock token, and a manual send needs an `operator_action_id`. The seam's attempt allocation is the atomic second half.
6. **Opt-out and hard suppression:** live reads of `sms_suppression_list` and `automation_suppressions`. A read failure refuses automated and manual sends alike.
7. **Archive and terminal status:** archived thread, suppressed or opted-out thread, terminal status or contactability (wrong number, DNC and the like), legal hold, repair or rehab hold.
8. **Paused review and quarantine on the thread:** paused review blocks automation only, because an operator may answer a thread in review. Quarantine blocks every sender.
9. **Automation holds:** any active hold blocks automation. For manual sends only legal, repair, permanent, precautionary and unreadable holds block, so the operator can still resolve an ownership-attribution hold by hand.
10. **Campaign state:** the row's campaign must be live now. An unreadable campaign refuses.
11. **Quiet hours in the recipient's zone:** applies to automation, where an unknown zone holds and an outside-window send refuses. An in-session reply may go outside the window but never on an unknown zone. Manual and fresh operator-attended inbox sends are not window-held.
12. **Sender continuity:** the existing final check, run inside the gate. When it is the only refusal, its own reason is kept, so the runner still makes a visible hold.

**Test runtime:** the live-fact reads (6, 7, 9 and 10) follow the `enqueue-contact-restrictions.js` precedent. Production (`NODE_ENV !== 'test'`) always reads. Under `NODE_ENV=test` with a fake client they are skipped unless a suite enforces them with `__setFinalDispatchGateModeForTests('enforce')`, as the P0 suite does. Checks 1–5 and 12 run in every runtime.

## Every distinct production send route

| # | Route or job | Path to the provider | Gate call site | Test covering it |
|---|---|---|---|---|
| 1 | Queue runner: `POST /api/internal/queue/run` (cron), `cockpit/queue/run`, `cockpit/queue/control` `run_queue` | `run-send-queue.js` → `process-send-queue.js#processSupabaseQueueItem` → `dispatchSellerQueueRow` | queue bridge | P0 suite: baseline, brake, claim, quiet hours, archive, suppression, concurrent, restart |
| 2 | Inbound auto-reply rows (`inbound_auto_reply:*`, autopilot, AI reply rows) | queue row → runner (1) | queue bridge (`in_session_reply` exemption only for the window, never an unknown zone) | P0 suite: quiet hours (in-session cases) |
| 3 | Follow-ups and nurture (`followup-lifecycle`, `no-reply-followup-scheduler`, `seller-followup-scheduler`, delivery-triggered) | queue row → runner (1) | queue bridge | P0 suite: paused / held / hold-history cases |
| 4 | Campaign feeder (`run-supabase-outbound-feeder`, `enqueue-campaign-target-one`, campaign plan bulk insert) | queue row → runner (1) | queue bridge, plus the campaign-state check | P0 suite: campaign resume (paused campaign refuses, unreadable refuses) |
| 5 | Delivery retry (`delivery-retry-engine.js`) | clone row → runner (1) | queue bridge; the clone is now born `paused_operator_review` | P0 suite: provider retry; `default-acquisition-engine.test.mjs` (clone status) |
| 6 | Lifecycle reconcile (`internal/queue/reconcile`, `cockpit/queue/reconcile`, runner pre-pass, `scripts/queue-emergency-cleanup.js`) | no send; it no longer revives rows | `buildReauthorizationHoldPatch` + `revalidateBeforeDispatch` | P0 suite: global unpause, service restart; `campaign-send-pipeline.test.mjs` |
| 7 | Conversational cap release (runner pre-pass) | no send; qualifying rows go to review | `buildReauthorizationHoldPatch` + `revalidateBeforeDispatch` | `sender-cold-conversational-caps.test.mjs` (held-for-reauthorization and gate-refusal cases) |
| 8 | Campaign resume (`applyCampaignLifecycleAction` resume) | no send; pre-pause rows are held before the status changes | `no-automatic-reactivation.js#holdCampaignRowsForReauthorization` | P0 suite: campaign resume (hold, fail-closed, ordering) |
| 9 | Sender-continuity release (runner pre-pass), stale-expiration recovery (`internal/campaigns/recover-stale-expired`), lease redispatch | queue row → runner (1) | queue bridge: their markers are hold history, so a fresh owner release is required (lease redispatch of a provably unsent in-flight row is not a hold; it is re-checked in full) | P0 suite: hold-history refusals |
| 10 | Cockpit approve / retry / retry-routing / reschedule (`cockpit/queue/*`) | status change → runner (1) | `cockpit-service.js#runQueueAction`: review holds are releasable only by owner release, historical rows are refused, then the shared `evaluateReleaseGate`; at dispatch, the queue bridge | P0 suite: stale approval (old row, hold history, seller replied past, `paused_operator_review`, retry-failed) |
| 11 | Cockpit owner release: `POST /api/cockpit/queue/owner-release` (new in round 2; before it, nothing reached this action) | status change → runner (1) | session user as actor; signed `metadata.reauthorization` plus a `QUEUE_OWNER_RELEASE` audit event; the gate verifies both and expires it | P0 suite: stale approval; round-2 suite: forged release (unsigned, random or copied signature, edited body, no audit), overtaken release, route actor |
| 12 | Cockpit `send_one_queue_row` (`cockpit/queue/control`) | `processSendQueue` → runner (1) | queue bridge; the `clear_one_send_window` brake bypass and the fake control plane are removed | P0 suite: route inventory (`send_one_queue_row`) |
| 13 | Internal send-now: `POST /api/internal/outbound/send-now` | `buildAndSendNow` → queue row → runner (1) | queue bridge; GET removed (405); phone and text never logged | `send-now-route.test.mjs`; P0 suite: raw-number dispatch (GET 405) |
| 14 | Inbox manual send: `POST /api/internal/inbox/send-now` | `createInboxSendNowQueueRow` (fail-closed compliance, legal/repair holds) → runner (1) | queue bridge (`operator_attended` for a fresh row) | P0 suite: legal/repair, suppression (contactability); `risk-002-send-now-routes.test.mjs` |
| 15 | Cockpit / map manual send: `POST /api/cockpit/inbox/send-now` (`runInboxAction` `send-now`) | `executeManualInboxSendNow` → `dispatchManualOperatorSend` | manual bridge | P0 suite: manual baseline, archived, suppression failure, raw number, legal/repair; `manual-send-authority-hotfix.test.mjs` |
| 15b | Cockpit inbox `queue-reply`, `schedule-reply`, `auto-reply`, `bulk-follow-up` (`runInboxAction`) | queue row → runner (1) | queue bridge | P0 suite (queue bridge cases) |
| 16 | Discord operator reply: `POST /api/internal/discord/reply-sms` | queue row (operator action) → runner (1) | queue bridge | `s11-crash-race-matrix.test.mjs` (Discord row identity) |
| 17 | Agent text / negotiation offer (`action-gateway-execution.js`, `negotiation-send.js`; built off) | queue row → runner (1) | queue bridge | P0 suite (queue bridge cases) |
| 18 | Live TextGrid verification: `POST /api/internal/verification/live/textgrid` (fenced: env flag + system flag + operator allowlist) | `live-textgrid.js` → `sendTextgridSMS` directly | the full `evaluateFinalDispatchGate` (path `manual`; brake now, identity, operator action id, suppression fail-closed, thread, holds) before the provider, plus the adapter's own shutdown and brake | P0 suite: unreadable suppression; round-2 suite: active brake refuses |
| 19 | `GET /api/dev/force-send` | `sendTextgridSMS` directly | none; returns 404 in production (`NODE_ENV`/`VERCEL_ENV`), unchanged | `seller-send-source-inventory.test.mjs` (TEST_ONLY) |

`seller-send-source-inventory.test.mjs` still pins the provider call sites (`process-send-queue.js`, `send-now-service.js`, `live-textgrid.js`, `dev/force-send`) and the set of queue-row creators. A new direct provider call fails that ratchet.

## Behaviour changes an operator will notice

- **Archived threads no longer receive follow-ups or nurture.** This reverses the 2026-10-04/08 owner rule that "archive is visibility only" (`no-response-followup.js:438-440`), as audit build item 3 directs. A manual send to an archived thread is refused too; unarchive first.
- **Lifting the emergency stop no longer releases waiting rows.** Rows that sat through the stop go to `paused_operator_review` with the revalidation verdict recorded. Expired brake rows stay expired.
- **Resuming a campaign holds every row written before the pause.** A drained campaign whose only work was pending rows resumes with nothing to send until an operator releases rows one at a time.
- **Conversational cap release no longer re-queues.** Qualifying rows are held for review and the operator is alerted.
- **Delivery-retry clones are born held.**
- **Cockpit approve, retry, retry-routing and reschedule refuse historical rows:** rows with hold history, rows the seller replied after, or rows older than 24 hours. Use owner release (confirm, actor, reason). Owner release now also works on `paused_operator_review` rows.
- **`send_one_queue_row` cannot cross an active emergency stop.** Only the scoped-canary authorization crosses a brake.
- **A manual send fails closed** when suppression, thread state, message history or holds cannot be read, and when the thread is quarantined or under a legal or repair hold.
- **Automated in-session replies hold on an unknown recipient zone.** Previously they were exempt.

## Round 2 behaviour changes an operator will notice

- **Any row older than 24 hours needs an owner release at send time.** This includes follow-ups and nurture written days ahead, which now stop at the gate (`final_gate_reauthorization_required`) until an owner releases them one at a time. This is what the founder order requires. A follow-up design that writes the row close to its send time would avoid it.
- **Every row that exists when the migration is applied needs an owner release**, and so does every row written before any later brake or freeze change.
- **An in-session auto-reply is refused if the seller sends another message before it goes out.** The seller replied after the row was written.
- **Owner release is a Cockpit route.** It needs a signed-in, allowlisted operator, `confirm: "OWNER_RELEASE"`, `release_ids` naming the row, a reason and `dry_run: false`.

## Known limits

- **Fixed in round 2:** the brake-history stamp no longer matters. A brake set and cleared between reconcile runs is caught by `send_authority_events` and the 24-hour rule.
- The live-fact and history reads follow the existing test-runtime precedent. They always run in production. Under `NODE_ENV=test` with a fake client they are skipped unless a suite enforces them, as both P0 suites do. The signature check runs in every runtime.
- **Not run here:** the round-2 suite (`tests/critical/p0-final-dispatch-gate-round2.test.mjs`) and the updated suites were checked with `node --check` only. The operator runs `test:p0-dispatch-gate` (which now includes the round-2 file and `send-reentry-authority-guards.test.mjs`), `test:send-authority` and the critical suite.
- The PG-only recovery case in `sender-continuity-8521-pg.test.mjs` ("health recovers ⇒ the release re-queues ⇒ exactly ONE send") asserts an automatic re-queue send. The gate now refuses that send, because sender-continuity release is hold history. That case is skipped without `AGENT_PG_TEST_DB_URL` and needs its expectation changed once a PG run is available.
