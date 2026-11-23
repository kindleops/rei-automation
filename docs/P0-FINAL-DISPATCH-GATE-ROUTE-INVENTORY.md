# P0 final dispatch gate: production send-route inventory (2026-11-23)

Base: `c6bc61d0` (the production build on `release/cloudflare-production`).
Scope: founder P0 items 1, 2, 5, 6 and 9 on the LeadCommand production line.
Nothing in this change sends a message. Nothing has been deployed.

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
| 11 | Cockpit owner release (`cockpit/queue` owner-release) | status change → runner (1) | writes `metadata.reauthorization`; the gate expires it | P0 suite: stale approval (fresh, expired, overtaken, forged) |
| 12 | Cockpit `send_one_queue_row` (`cockpit/queue/control`) | `processSendQueue` → runner (1) | queue bridge; the `clear_one_send_window` brake bypass and the fake control plane are removed | P0 suite: route inventory (`send_one_queue_row`) |
| 13 | Internal send-now: `POST /api/internal/outbound/send-now` | `buildAndSendNow` → queue row → runner (1) | queue bridge; GET removed (405); phone and text never logged | `send-now-route.test.mjs`; P0 suite: raw-number dispatch (GET 405) |
| 14 | Inbox manual send: `POST /api/internal/inbox/send-now` | `createInboxSendNowQueueRow` (fail-closed compliance, legal/repair holds) → runner (1) | queue bridge (`operator_attended` for a fresh row) | P0 suite: legal/repair, suppression (contactability); `risk-002-send-now-routes.test.mjs` |
| 15 | Cockpit / map manual send: `POST /api/cockpit/inbox/send-now` (`runInboxAction` `send-now`) | `executeManualInboxSendNow` → `dispatchManualOperatorSend` | manual bridge | P0 suite: manual baseline, archived, suppression failure, raw number, legal/repair; `manual-send-authority-hotfix.test.mjs` |
| 15b | Cockpit inbox `queue-reply`, `schedule-reply`, `auto-reply`, `bulk-follow-up` (`runInboxAction`) | queue row → runner (1) | queue bridge | P0 suite (queue bridge cases) |
| 16 | Discord operator reply: `POST /api/internal/discord/reply-sms` | queue row (operator action) → runner (1) | queue bridge | `s11-crash-race-matrix.test.mjs` (Discord row identity) |
| 17 | Agent text / negotiation offer (`action-gateway-execution.js`, `negotiation-send.js`; built off) | queue row → runner (1) | queue bridge | P0 suite (queue bridge cases) |
| 18 | Live TextGrid verification: `POST /api/internal/verification/live/textgrid` (fenced: env flag + system flag + operator allowlist) | `live-textgrid.js` → `sendTextgridSMS` directly | `evaluateReleaseGate` before the provider (suppression fail-closed, archived/terminal/quarantine/hold), plus the adapter's own shutdown and brake | P0 suite: verification send refuses on an unreadable suppression list |
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

## Known limits

- The brake-history stamp is written by the reconcile pass while the brake is set. A brake set and cleared between two reconcile runs leaves no stamp. Those rows are then judged only by the other checks (row age is not one of them at dispatch). The runner and the cron both run reconcile.
- The PG-only recovery case in `sender-continuity-8521-pg.test.mjs` ("health recovers ⇒ the release re-queues ⇒ exactly ONE send") asserts an automatic re-queue send. The gate now refuses that send, because sender-continuity release is hold history. That case is skipped without `AGENT_PG_TEST_DB_URL` and needs its expectation changed once a PG run is available.
