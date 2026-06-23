# Critical Suite Failure Manifest

Generated from: `/tmp/canonical-full-critical.log`

## Full-suite summary (pre-repair)

| Metric | Value |
|--------|-------|
| Files | 183 |
| Tests | 2420 |
| Pass | 2048 |
| Fail | 372 |
| Skipped | 0 |
| Duration ms | 5178865.873402 |
| fetch failed log hits (not test count) | 385 |
| Unique failing files parsed | 57 |

> Note: log-level `fetch failed` hits (385) span repeated runtime warnings inside tests; they are reconciled separately from the 372 failing test tally.

## Failing files

### `feed-candidates.test.mjs`

- **Failing tests (73):** runSupabaseCandidateFeeder dry_run returns diagnostics without queue mutation; runSupabaseCandidateFeeder live mode respects limit=1; runSupabaseCandidateFeeder reports routing diagnostics for blocked routing; runSupabaseCandidateFeeder returns structured source unavailable error; evaluateCandidateEligibility allows unknown identity when allow_identity_unknown is true; runSupabaseCandidateFeeder relaxed identity gate can queue identity_unknown rows for testing; runSendQueue dry_run never calls processSendQueueItem; normalizeCandidateRow maps v_sms_ready_contacts columns correctly … +65 more
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/feed-candidates.test.mjs`

### `template-selection-comprehensive.test.mjs`

- **Failing tests (56):** podio: ownership_check first-touch selects correct local template; podio: language match preferred over English fallback; podio: English fallback when target language unavailable; podio: consider_selling selects correct template; podio: ownership_check_follow_up selects follow-up template; podio: offer_reveal_cash selects offer template; podio: mf_confirm_units selects MF template; podio: mf_occupancy selects correct template … +48 more
- **First error signature:** AssertionError [ERR_ASSERTION]: should have at least one candidate
- **Domain owner:** Templates / Language
- **Production module:** template resolver + sms_templates (Supabase)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/template-selection-comprehensive.test.mjs`

### `discord-targeting-console.test.mjs`

- **Failing tests (26):** /target scan returns deferred response (type 5); /target scan calls feeder with dry_run=true even if omitted; /target scan never sends SMS — dry_run is always forced to true; /campaign create upserts campaign with normalised key and returns embed; /campaign inspect returns campaign details embed; /campaign scale updates daily_cap and returns scale embed for Owner; /campaign scale daily_cap > 100 returns approval embed for SMS Ops; /territory map returns onboarding embed when no campaigns exist … +18 more
- **First error signature:** AssertionError [ERR_ASSERTION]: type 5 = deferred
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-targeting-console.test.mjs`

### `discord-command-center.test.mjs`

- **Failing tests (24):** /templates audit reads sms_templates and builds embed; /mission status does not crash when optional tables throw; /feeder scan returns deferred response type 5; /launch preflight returns type 4 with a preflight embed; /hotleads returns a cinematic response with hot lead embed; /queue cockpit returns a queue cockpit embed; /templates audit paginates and reports full 2500-row inventory; /email cockpit returns deferred response type 5 … +16 more
- **First error signature:** AssertionError [ERR_ASSERTION]: response has embeds
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-command-center.test.mjs`

### `replay-handlers.test.mjs`

- **Failing tests (15):** replay-inbound accepts message_body/from_number/to_number and returns dry-run safety response; replay-inbound accepts aliases body/message/from/to and normalizes fields; replay-inbound does not fail when lifecycle CSV is missing and logs replay.template_csv_missing; replay-inbound pipeline failures do not leak INTERNAL_API_SECRET; replay wrong number suppresses auto-reply, resolves no template, and stays terminal; replay rendered_message_text is sanitized before returning output; replay offer request without verified ownership gates back to ownership_check; replay tenant response without verified ownership does not auto-reply … +7 more
- **First error signature:** TypeError [Error]: __setReplayInboundTestDeps is not a function
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/replay-handlers.test.mjs`

### `queue-run-finalization.test.mjs`

- **Failing tests (13):** outside contact window claimed row does not remain sending; missing seller name is paused before claim and never becomes sending; candidate_snapshot.phone_first_name is used for preclaim eligibility when seller_first_name is missing; malformed row with null selected_template_id and candidate_snapshot becomes paused_invalid_queue_row; manual inbox row with missing body still pauses invalid; manual inbox row with missing to/from still pauses invalid; provider exception claimed row does not remain sending; batch of 25 claimed rows leaves zero rows in sending … +5 more
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-run-finalization.test.mjs`

### `queue-run-selection.test.mjs`

- **Failing tests (10):** runSendQueue selects a Queued row whose scheduled_for_utc is in the past; runSendQueue excludes a Queued row whose scheduled_for_utc is in the future; runSendQueue selects a Queued row with no scheduled_for_utc (treated as immediately due); runSendQueue passes a due Queued row through to the send branch and records sent_count; runSendQueue logs queue.run_item_failed_soft when processSendQueueItem returns ok=false; runSendQueue fails soft on an unexpected queue item crash, marks the item failed, and continues; runSendQueue processes the due row and excludes the future row from a mixed batch; runSendQueue counts claim conflicts as duplicate_locked skips without failing the batch … +2 more
- **First error signature:** AssertionError [ERR_ASSERTION]: one row should enter the send branch
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** stale harness
- **Proposed repair:** Replace Podio-era deps with loadRunnableSendQueueRows / Supabase mocks via shared queue harness.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-run-selection.test.mjs`

### `discord-alerts.test.mjs`

- **Failing tests (8):** sendCriticalAlert formats Discord embed payload correctly; sendCriticalAlert strips fields with forbidden names (secrets); sendCriticalAlert routes to DISCORD_CRITICAL_ALERTS_WEBHOOK_URL; sendHotLeadAlert routes to DISCORD_HOT_LEADS_WEBHOOK_URL; sendSystemErrorAlert routes to DISCORD_SENTRY_ERRORS_WEBHOOK_URL; writeOutboundFailureMessageEvent fires Discord critical alert; syncSupabaseMessageEventsToPodio row failure fires Discord critical alert; captureRouteException fires Discord system-error alert when Sentry is available
- **First error signature:** AssertionError [ERR_ASSERTION]: fetch should be called once
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-alerts.test.mjs`

### `discord-replay-and-wires-command-center.test.mjs`

- **Failing tests (8):** /wires cockpit returns deferred response (type 5); /replay inbound sends message_body/from_number/to_number/dry_run payload to backend; /replay inbound backend failure edits Discord response cleanly without leaking INTERNAL_API_SECRET; /wires forecast does not timeout — returns deferred (type 5); /wires reconcile does not timeout — returns deferred (type 5); wire handler with table-missing error still returns deferred — no uncaught throw; async handler failure edits original response with sanitized error embed; no raw 'schema cache' DB error leaks into Discord response
- **First error signature:** AssertionError [ERR_ASSERTION]: cockpit must return type 5 deferred
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-replay-and-wires-command-center.test.mjs`

### `inbound-autopilot-verification.test.mjs`

- **Failing tests (8):** stage: ownership_confirmed at ownership_check → consider_selling; stage: ownership_confirmed at non-ownership stage → confirm_basics; stage: asks_offer → asking_price; use_case: ownership_confirmed at ownership_check → consider_selling; use_case: info_request at ownership_check → info_source_explanation; suppression: opt_out not suppressed when system_only is true; full plan: ownership_confirmed at ownership_check resolves correctly; stage map: all ownership_check transitions are deterministic
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbound-autopilot-verification.test.mjs`

### `inbound-offer-routing-integration.test.mjs`

- **Failing tests (8):** how much would you pay + SFH snapshot queues offer_reveal_cash and includes snapshot id; offer message does not create Podio Offer immediately; sent offer path still defers Offer creation to the post-send sync hook path; 8 units routes to underwriting and never queues cash offer; seller finance routes to underwriting and never queues cash offer; no snapshot + property known queues condition clarifier; no snapshot + no property routes manual review with no auto-send; wrong number and stop still suppress and bypass offer route
- **First error signature:** { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND placeholder.supabase.co (ENOTFOUND)\nError: getaddrinfo ENOTFOUND placeholder.supabase.co\n    at GetAddrInfoReqWrap.onlookup
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** environment isolation defect
- **Proposed repair:** Enforce critical-test-environment network guard; inject mock Supabase via deps.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbound-offer-routing-integration.test.mjs`

### `inbound-stage-lifecycle.test.mjs`

- **Failing tests (8):** inbound webhook passes create_brain_if_missing: true to loadContext; inbound webhook creates the brain only after Stage 1 owner confirmation and still defers pipeline creation; inbound webhook allows pipeline creation only after Stage 2 offer-interest confirmation; inbound webhook defaults to delayed autopilot and still posts Discord control card; inbound webhook skips delayed queue and marks manual review when autopilot is disabled; inbound webhook still posts Discord review card when classification degrades; discord post failure does not block delayed autopilot queueing; idempotent replay does not duplicate autopilot queue or Discord card
- **First error signature:** see log tail
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbound-stage-lifecycle.test.mjs`

### `inbox-live-v2-service.test.mjs`

- **Failing tests (8):** latest outbound message appears at the top of the inbox and duplicate-property threads stay single-row; latest inbound message appears at the top of the inbox when it is the newest thread activity; live inbox rows preserve latest delivery fields; send event inserted into message_events becomes the latest thread row; thread messages try all strict identities and keep the full selected timeline; counts come from the same canonical v2 source and match filter results; visible thread rows floor stale zero count rows; initial boot fallback returns threads without exact-counting v_inbox_enriched and marks counts degraded
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Inbox / Cockpit
- **Production module:** inbox live / cockpit routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbox-live-v2-service.test.mjs`

### `queue-run-route.test.mjs`

- **Failing tests (8):** handleQueueRunRequest calls runSendQueue and emits route_enter, before_run, after_run logs; handleQueueRunRequest emits queue_run.early_return warn when runSendQueue returns skipped=true; handleQueueRunRequest returns 200 and logs first failure details when the batch is partial; handleQueueRunRequest allows when QUEUE_ENGINE_SHARED_SECRET is set and x-queue-engine-secret header is valid; handleQueueRunRequest falls back to system_control queue_engine_shared_secret when env is unset; handleQueueRunRequest POST body dry_run:false sends live and response dry_run is false; handleQueueRunRequest POST with no dry_run field defaults to false; handleQueueRunRequest converts Podio cooldown errors into a safe skipped response
- **First error signature:** AssertionError [ERR_ASSERTION]: runSendQueue must be called once
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-run-route.test.mjs`

### `classification-regression.test.mjs`

- **Failing tests (7):** proof 7: duplicate communication enqueue does not create a second queue row; should classify "Sold it 10 yrs ago" as wrong_number; should classify "Sold it last week for $80,000!" as wrong_number; should classify "This is not Shirley..." as wrong_number; should classify "No It sold" as wrong_number; should classify "No la Mia es 2711 Degen Dr. Bonita CA 91902" as wrong_number; should classify "esa. Casa. llanoesmia" as wrong_number
- **First error signature:** {"timestamp":"2026-06-23T01:26:15.251Z","level":"WARN","event":"system_control.fetch_error","env":"test","meta":{"key":"discord_alerts_enabled","message":"TypeError: fetch failed"}}
- **Domain owner:** Inbound Classification
- **Production module:** seller-response classification pipeline
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** environment isolation defect
- **Proposed repair:** Enforce critical-test-environment network guard; inject mock Supabase via deps.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/classification-regression.test.mjs`

### `podio-retry-template-cache.test.mjs`

- **Failing tests (7):** template loader no longer requires category filters when same-use-case templates exist; template loader accepts legacy stage labels as metadata and templates without spam risk values; template loader prefers active Podio templates over local fallbacks; template loader prefers exact-use-case Podio templates over local templates instead of stage-only fallback; template loader falls back to agent-free Stage 1 local templates when agent metadata is missing; template loader resolves Stage 1 fallback even when property category metadata is missing; agent-free Stage 1 fallback renders and builds a queue item when property metadata is missing
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Templates / Language
- **Production module:** template resolver + sms_templates (Supabase)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/podio-retry-template-cache.test.mjs`

### `discord-daily-briefing.test.mjs`

- **Failing tests (6):** /briefing today defers immediately (type 5); /briefing yesterday defers immediately (type 5); /briefing week defers immediately (type 5); /briefing market defers immediately (type 5); /briefing agent defers immediately (type 5); no raw Supabase/Podio errors leak into Discord response
- **First error signature:** AssertionError [ERR_ASSERTION]: type must be 5 (deferred)
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-daily-briefing.test.mjs`

### `inbound-failure-idempotency.test.mjs`

- **Failing tests (5):** message_event_create failure marks idempotency record as failed; conversation_resolution failure degrades to manual review and completes idempotency record; prospect_resolution failure marks idempotency record as failed; market_resolution failure marks idempotency record as failed; successful inbound processing marks idempotency record as completed (not failed)
- **First error signature:** { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND placeholder.supabase.co (ENOTFOUND)\nError: getaddrinfo ENOTFOUND placeholder.supabase.co\n    at GetAddrInfoReqWrap.onlookup
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** environment isolation defect
- **Proposed repair:** Enforce critical-test-environment network guard; inject mock Supabase via deps.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbound-failure-idempotency.test.mjs`

### `queue-batch-dedup.test.mjs`

- **Failing tests (5):** runSendQueue: duplicate owner+phone+touch in batch — only first item is sent; runSendQueue: same owner+phone but different touch numbers — both dispatched; runSendQueue: different owners sharing a phone+touch — both dispatched; runSendQueue: item missing owner/phone ids is not filtered by dedup; runSendQueue: three identical touch duplicates — first sent, two suppressed
- **First error signature:** AssertionError [ERR_ASSERTION]: Only one item should be dispatched
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** stale harness
- **Proposed repair:** Replace Podio-era deps with loadRunnableSendQueueRows / Supabase mocks via shared queue harness.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-batch-dedup.test.mjs`

### `queue-run-revision-limit.test.mjs`

- **Failing tests (5):** runSendQueue skips revision-capped queue items and continues later work; runSendQueue succeeds when resolveSystemAlert throws revision-limit after a clean batch; runSendQueue onLocked path succeeds even when alert write throws revision-limit; runSendQueue skips first item at claim phase and processes second item; queue run route returns success when run summary contains revision-limit skips
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-run-revision-limit.test.mjs`

### `risk-003-feeder-lock.test.mjs`

- **Failing tests (5):** RISK-003: concurrent second caller returns feeder_already_running immediately; RISK-003: lock is released after normal completion; RISK-003: lock is released after error in _runFeeder; RISK-003: feeder_already_running result has zero counts; RISK-003: injectable lock allows full test isolation (no shared module state leaked)
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/risk-003-feeder-lock.test.mjs`

### `seller-auto-reply-plan.test.mjs`

- **Failing tests (5):** "Yes" after ownership_check -> consider_selling / S2; "I do" after ownership_check -> consider_selling; "How much?" -> asking_price, not offer reveal; "$200k" -> asking_price_value -> confirm_basics/condition_probe, not duplicate; auto reply plan resolves intent and use_case for ownership reply (unit — no db)
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/seller-auto-reply-plan.test.mjs`

### `discord-interactions.test.mjs`

- **Failing tests (4):** routeDiscordInteraction: user without Tech Ops gets denied for /queue run; routeDiscordInteraction: SMS Ops cannot /lock release; routeDiscordInteraction: feeder limit > 25 with Tech Ops creates approval buttons; routeDiscordInteraction: reject button returns UPDATE_MESSAGE with rejection text
- **First error signature:** AssertionError [ERR_ASSERTION]: content must indicate denial
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-interactions.test.mjs`

### `queue-run-lock.test.mjs`

- **Failing tests (4):** runSendQueue emits queue.run_skipped_lock_active with full lock metadata when lock is already held; runSendQueue enters executeRun and emits queue.run_started when lock is cleared; runSendQueue bypasses withRunLock entirely and enters executeRun when dry_run=true; runSendQueue skips safely when Podio cooldown is active
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-run-lock.test.mjs`

### `risk-010-auto-reply-dedup.test.mjs`

- **Failing tests (4):** RISK-010: paused_review thread → gate blocks before enqueue; RISK-010: phone_suppressed → gate blocks before enqueue; RISK-010: queueAutoReply.js imports canSend from send-now-service; RISK-010: execute-autonomous-reply.js imports canSend from send-now-service
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/risk-010-auto-reply-dedup.test.mjs`

### `default-acquisition-engine.test.mjs`

- **Failing tests (3):** delivery webhook runs acquisition handling only for marked queue rows; disabled acquisition controls also block already-scheduled queue rows; offer runtime control gates every legacy inbound offer mutation path
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/default-acquisition-engine.test.mjs`

### `discord-ops-notifications.test.mjs`

- **Failing tests (2):** approval:campaign_scale button resolves approval and returns success embed; approval:campaign_scale button denied for non-owner, non-sms_ops member
- **First error signature:** AssertionError [ERR_ASSERTION]: response should be update_message (type 7)
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-ops-notifications.test.mjs`

### `email-layer-brevo-discord.test.mjs`

- **Failing tests (2):** processEmailQueue dry_run=true does not invoke Brevo; processEmailQueue dry_run=false calls Brevo and updates queue row
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/email-layer-brevo-discord.test.mjs`

### `queue-reconcile.test.mjs`

- **Failing tests (2):** queue reconcile skips safely when Podio cooldown is active; queue reconcile skips safely when Podio backpressure is active
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/queue-reconcile.test.mjs`

### `supabase-queue.test.mjs`

- **Failing tests (2):** should create send_queue row with all required fields; should create auto-reply queue row with source_event_id
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/supabase-queue.test.mjs`

### `template-truthfulness.test.mjs`

- **Failing tests (2):** reengagement fallback ladder fires when evidence exists and primary use_case has no alias; reengagement fallback ladder fires when seller has replied (last_inbound_message set)
- **First error signature:** AssertionError [ERR_ASSERTION]: reengagement must be chosen via the fallback ladder with evidence
- **Domain owner:** Templates / Language
- **Production module:** template resolver + sms_templates (Supabase)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/template-truthfulness.test.mjs`

### `feed-master-owners-route.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/feed-master-owners-route.test.mjs`

### `risk-002-send-now-routes.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/risk-002-send-now-routes.test.mjs`

### `risk-006-suppression-read.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/risk-006-suppression-read.test.mjs`

### `supabase-sms-runtime.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/supabase-sms-runtime.test.mjs`

### `textgrid-inbound-body-extraction.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Provider / TextGrid
- **Production module:** handle-textgrid-inbound.js / webhook routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/textgrid-inbound-body-extraction.test.mjs`

### `textgrid-inbound-discord-alert.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Provider / TextGrid
- **Production module:** handle-textgrid-inbound.js / webhook routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/textgrid-inbound-discord-alert.test.mjs`

### `textgrid-webhook-signature.test.mjs`

- **Failing tests (1):** [FILE_LEVEL_FAILURE]
- **First error signature:** see log tail
- **Domain owner:** Provider / TextGrid
- **Production module:** handle-textgrid-inbound.js / webhook routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/textgrid-webhook-signature.test.mjs`

### `dashboard-ops-service.test.mjs`

- **Failing tests (1):** live inbox exposes cursor pagination, filters, keyword matches, and map pins
- **First error signature:** AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/dashboard-ops-service.test.mjs`

### `deal-intelligence-dossier.test.mjs`

- **Failing tests (1):** buildDealIntelligenceDossier returns canonical sections
- **First error signature:** TypeError [Error]: supabase.from(...).select(...).eq(...).limit is not a function
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** stale fixture
- **Proposed repair:** Refresh fixtures to Supabase sms_templates canonical source; reset module caches between files.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/deal-intelligence-dossier.test.mjs`

### `discord-ops-os.test.mjs`

- **Failing tests (1):** unsupported action responds gracefully
- **First error signature:** AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Action not wired yet/i. Input:
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-ops-os.test.mjs`

### `discord-sms-reply.test.mjs`

- **Failing tests (1):** wrong number creates suppression and does not queue outbound reply
- **First error signature:** TypeError [Error]: supabase.from(...).update is not a function
- **Domain owner:** Discord Integrations
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** stale fixture
- **Proposed repair:** Refresh fixtures to Supabase sms_templates canonical source; reset module caches between files.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/discord-sms-reply.test.mjs`

### `first-touch-template-selection.test.mjs`

- **Failing tests (1):** null or mismatched variant_group metadata does not block a valid Touch 1 template
- **First error signature:** AssertionError [ERR_ASSERTION]: null variant_group must always be permitted
- **Domain owner:** Templates / Language
- **Production module:** template resolver + sms_templates (Supabase)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/first-touch-template-selection.test.mjs`

### `inbox-bucket-counting.test.mjs`

- **Failing tests (1):** getLiveInbox returns canonical counts including dead
- **First error signature:** TypeError [Error]: supabase.from(...).select(...).in is not a function
- **Domain owner:** Inbox / Cockpit
- **Production module:** inbox live / cockpit routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** stale fixture
- **Proposed repair:** Refresh fixtures to Supabase sms_templates canonical source; reset module caches between files.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbox-bucket-counting.test.mjs`

### `inbox-compact-row-regression.test.mjs`

- **Failing tests (1):** live inbox service reads canonical v2 sources
- **First error signature:** AssertionError [ERR_ASSERTION]: The input did not match the regular expression /const THREAD_SOURCE = "v_inbox_threads_live_v2";/. Input:
- **Domain owner:** Inbox / Cockpit
- **Production module:** inbox live / cockpit routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/inbox-compact-row-regression.test.mjs`

### `message-event-webhook-compat.test.mjs`

- **Failing tests (1):** outbound message event writes the canonical seller event row and links it to the brain
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Provider / Webhooks
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/message-event-webhook-compat.test.mjs`

### `message-events-noise-prevention.test.mjs`

- **Failing tests (1):** inbound webhook rehydrates the same seller event after late brain creation
- **First error signature:** { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND placeholder.supabase.co (ENOTFOUND)\nError: getaddrinfo ENOTFOUND placeholder.supabase.co\n    at GetAddrInfoReqWrap.onlookup
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** environment isolation defect
- **Proposed repair:** Enforce critical-test-environment network guard; inject mock Supabase via deps.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/message-events-noise-prevention.test.mjs`

### `no-reply-follow-up-recovery.test.mjs`

- **Failing tests (1):** no-reply recovery resumes from outbound metadata instead of restarting at stage 1
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/no-reply-follow-up-recovery.test.mjs`

### `posthog-analytics.test.mjs`

- **Failing tests (1):** logInboundMessageEvent fires inbound_sms_logged
- **First error signature:** see log tail
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/posthog-analytics.test.mjs`

### `property-context-source.test.mjs`

- **Failing tests (1):** evaluateTemplatePlaceholders returns ok=false and missing_required_placeholders when property_address empty
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected property_city to be missing
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/property-context-source.test.mjs`

### `property-hydration-feeder.test.mjs`

- **Failing tests (1):** hydratePropertyForCandidate returns ok:false when no master_owner_id
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/property-hydration-feeder.test.mjs`

### `seller-flow-auto-queue.test.mjs`

- **Failing tests (1):** seller-stage replies after stage 1 can send outside quiet hours with latency only
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/seller-flow-auto-queue.test.mjs`

### `template-follow-up-resolution.test.mjs`

- **Failing tests (1):** followUpUseCaseForStage maps asking_price → asking_price_follow_up
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Templates / Language
- **Production module:** template resolver + sms_templates (Supabase)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/template-follow-up-resolution.test.mjs`

### `textgrid-inbound-normalization.test.mjs`

- **Failing tests (1):** inbound handler accepts raw Twilio/TextGrid payload and logs inbound event
- **First error signature:** { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND placeholder.supabase.co (ENOTFOUND)\nError: getaddrinfo ENOTFOUND placeholder.supabase.co\n    at GetAddrInfoReqWrap.onlookup
- **Domain owner:** Provider / TextGrid
- **Production module:** handle-textgrid-inbound.js / webhook routes
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** environment isolation defect
- **Proposed repair:** Enforce critical-test-environment network guard; inject mock Supabase via deps.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/textgrid-inbound-normalization.test.mjs`

### `touch-one-queue-integrity.test.mjs`

- **Failing tests (1):** loadTemplateCandidates throws NO_STAGE_1_TEMPLATE_FOUND when Podio returns templates but none pass Touch 1 truth filters
- **First error signature:** AssertionError [ERR_ASSERTION]: Missing expected rejection.
- **Domain owner:** Outbound Queue / SMS Engine
- **Production module:** run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/touch-one-queue-integrity.test.mjs`

### `universal-deal-dossier-service.test.mjs`

- **Failing tests (1):** getUniversalDealDossier handles contact_threads object instead of array safely
- **First error signature:** TypeError [Error]: supabase.from(...).select(...).eq(...).limit is not a function
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** stale fixture
- **Proposed repair:** Refresh fixtures to Supabase sms_templates canonical source; reset module caches between files.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/universal-deal-dossier-service.test.mjs`

### `wfv2-runtime-proof.test.mjs`

- **Failing tests (1):** proof 7: duplicate communication enqueue does not create a second queue row
- **First error signature:** AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
- **Domain owner:** Core Platform
- **Production module:** see test imports
- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)
- **Canonical contract:** Supabase `loadRunnableSendQueueRows`, `sms_templates`, injected deps, network guard
- **Classification:** unresolved
- **Proposed repair:** Triage individually after cluster gates; do not batch-classify.
- **Targeted command:** `cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/wfv2-runtime-proof.test.mjs`

