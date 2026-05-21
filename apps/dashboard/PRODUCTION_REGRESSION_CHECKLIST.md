# PRODUCTION REGRESSION CHECKLIST
Generated: 2026-05-18 — SMS Production Auditor

Status key: PASS / FAIL / UNKNOWN

---

## Command Map

| Item | Status | Notes |
|------|--------|-------|
| Seller pins toggle default ON | FAIL | `defaultSellerPinLayers.sellerPins = false` (InboxCommandMap.tsx:373). Toggle is OFF on every fresh load. |
| Uncontacted seller pins visible | FAIL | TWO compounding failures: (1) `sellerPins` defaults false; (2) RPC `get_command_map_seller_pins` drops all `not_contacted` pins when `zoom_level < 9` because every uncontacted pin has `render_priority = 10`, which is below the `>= 45` threshold in the zoom-gate filter. All 109,203 uncontacted pins are invisible unless user is already zoomed to city level AND has manually toggled the seller pins checkbox. |
| Live activity visible on map | PASS | Live activity rail and event feed load from inbox_thread_state; not gated by the seller pin toggle. |
| Census overlay works | FAIL | `census_geo_metrics` table has 0 rows. `loadNationwideCensusOverlay` queries this table, finds nothing, and returns `message: 'Nationwide Census overlay data not available in this viewport yet.'` The error message is displayed in the UI at InboxCommandMap.tsx:5412. |
| Click seller pin opens card | FAIL (partial) | For sellers with an existing thread: card opens via `setActiveThreadPopup` and `onSelectThreadIdRef.current?.(matchedThread.id)`. For uncontacted sellers (no matchedThread): `setActiveThreadPopup(null)` is called, which immediately destroys the thread popup; no fallback card or detail panel is shown. The user sees nothing. (InboxCommandMap.tsx:3842–3847) |
| Open Conversation from pin | FAIL | For uncontacted sellers the `onSelectThreadIdRef` callback is never called — there is no thread ID to pass. `handleSelect` in InboxPage requires a thread ID to set `activeContext`. The Conversation View has no fallback path for a propertyId-only context. |

---

## Inbox / Conversation

| Item | Status | Notes |
|------|--------|-------|
| Selected thread opens correctly | PASS | `handleSelect(id)` → `setActiveContext` → `setSelectedThreadKey` chain is intact. |
| Uncontacted seller no-thread state handled | FAIL | No "No SMS thread yet" UI for uncontacted sellers clicked from the map. The click silently sets `selectedPinId = propertyId` with no visible response in the Conversation view. |
| Latest messages display | PASS | `deduped_message_events` view is populated and the timeline query is functional. |
| Missing event warnings display | UNKNOWN | No dedicated UI for missing `message_events` rows on orphaned sent queue rows. The runner bug (Gemini) leaves `send_queue` rows sent with no linked `message_events` row; these orphans do not surface as warnings in the UI. |

---

## Queue View

| Item | Status | Notes |
|------|--------|-------|
| Sent rows missing events visible | FAIL | The queue view shows rows by `queue_status`, but there is no indicator when a sent row has no matching `message_events` record. The integrity gap is invisible in the UI. |
| Filters work | PASS | Queue filter controls are functional. |
| Refresh works | PASS | Queue refresh endpoint is functional. |

---

## Pipeline

| Item | Status | Notes |
|------|--------|-------|
| Status includes Message Sent | PASS | Pipeline stage classification includes sent/delivered states. |
| Grouping works | PASS | Pipeline grouping by stage is functional. |
| Selected card syncs activeContext | PASS | `onActivateThread` → `buildContextFromThread` → `setActiveContext` is wired. |

---

## List View

| Item | Status | Notes |
|------|--------|-------|
| Filters/sort work | PASS | List filter and sort controls are functional. |
| Row click syncs activeContext | PASS | `onSelect={handleSelect}` is wired. |

---

## Calendar

| Item | Status | Notes |
|------|--------|-------|
| Scheduled sends/follow-ups visible | PASS | Calendar data loads from `send_queue` scheduled rows. |
| Seller mode / global mode works | PASS | Calendar mode toggle is functional. |

---

## Live Activity

| Item | Status | Notes |
|------|--------|-------|
| Events show on map rail | PASS | `commandMapLiveActivity.ts` feeds live events from `inbox_thread_state`. |
| Clicking cards navigates correctly | PASS | `onSelectActivity` → `handleActivityNavigation` → `setActiveContext` is wired. |

---

## Suppression Integrity

| Item | Status | Notes |
|------|--------|-------|
| All suppressed rows have valid suppression reason | FAIL | 4 rows suppressed with benign or null intent. Detail below. |
| No suppressed rows with zero messages | FAIL | 1 row (`feed:e5befbbf4d4bc959bd9b2a7bd5a3f213185fb7e9`) is suppressed with 0 message_events, status='waiting', stage='ownership_check', last_intent=NULL. This is a phantom row. |

---

## Suppression False Positives — Exact Row IDs

These 4 rows are suppressed but have no valid suppression reason:

| thread_key | last_intent | status | stage | updated_at |
|------------|-------------|--------|-------|------------|
| `phone:+17865144771` | `not_interested` | suppressed | dead | 2026-05-16 13:42:43 UTC |
| `phone:+13103168080` | `unclear` | suppressed | dead | 2026-05-16 13:42:18 UTC |
| `phone:+19188526264` | `unclear` | suppressed | dead | 2026-05-15 05:32:22 UTC |
| `feed:e5befbbf4d4bc959bd9b2a7bd5a3f213185fb7e9` | NULL | waiting | ownership_check | 2026-05-07 10:55:17 UTC |

Note: `not_interested` and `unclear` are NOT valid suppression triggers per spec. The first three were set by `rebuild-thread-state.ts` based on `sms_eligible = false` on the linked prospect record. If that is intentional (no-SMS prospect = suppressed), the intent field should be updated to `opt_out` to match. If it is not intentional, `is_suppressed` should be cleared.

The fourth (`feed:...`) is a phantom: it has no messages at all, is marked suppressed, but has `status = waiting`. This is a data ghost — it should be deleted or at minimum have `is_suppressed` cleared.

---

## Summary Counts (as of 2026-05-18)

- Total `inbox_thread_state` rows: **6,264**
- Total suppressed: **145**
- Suppressed with correct intent: **141**
- Suppressed with benign/null intent (false positive candidates): **4**
- Suppressed with zero messages (phantom row): **1**
- Total seller pins in `v_command_map_seller_pin_feed`: **116,225**
- Uncontacted pins (`seller_state = not_contacted`): **109,203** (94% of all pins)
- Uncontacted pins that survive the RPC zoom-gate at zoom < 9: **0**
- `census_geo_metrics` rows: **0**
