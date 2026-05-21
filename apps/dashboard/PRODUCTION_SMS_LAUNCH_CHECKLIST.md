# NEXUS SMS Production Launch Checklist

**Last audited:** 2026-05-18  
**Auditor:** SMS Production Auditor (Claude)  
**Project:** real-estate-automation / lcppdrmrdfblstpcbgpf

---

## Current Production State (as of 2026-05-18)

### send_queue status distribution
| Status | Count |
|---|---|
| sent | 5,456 |
| delivered | 1,130 |
| cancelled | 624 |
| failed | 371 |
| blocked | 337 |
| paused_name_missing | 172 |
| paused_duplicate | 28 |
| paused_invalid_queue_row | 26 |
| scheduled | 10 |
| paused_global_lock | 9 |
| paused_max_retries | 3 |

### message_events distribution
| Direction | Delivery Status | Count |
|---|---|---|
| outbound | sent | 3,571 |
| outbound | delivered | 3,082 |
| outbound | queued | 887 |
| inbound | null | 814 |
| outbound | failed | 559 |
| outbound | null | 209 |

### inbox_thread_state
| Metric | Count |
|---|---|
| Total rows | 6,261 |
| Thread keys in message_events | 6,089 |
| Stale states (no events) | 172 |
| Event thread_keys with no state | 0 |

---

## Current Blockers

### BLOCKER 1 — 7 Orphaned Sent Queue Rows (CRITICAL)
**Severity:** HIGH  
**Description:** 7 send_queue rows have `queue_status='sent'` but NO linked `message_events` record. These messages were dispatched but are invisible to the inbox, Command Map, and Live Activity.

**Root cause:** `runner.ts` (line ~384) inserts `message_events` using column names that do not exist in the production schema:

| Column used in runner.ts | Actual column in production |
|---|---|
| `body` | `message_body` |
| `thread_id` | `thread_key` (thread_id does not exist) |
| `status` | `delivery_status` |
| `phone` | `to_phone_number` |

Supabase silently ignores unknown columns on insert. The rows either fail silently or create near-empty records that don't satisfy the `queue_id` join.

**Additionally:** All 7 orphaned rows have `thread_key = null` on the `send_queue` row itself, which means even after backfilling `message_events`, they still won't appear in inbox threads unless `thread_key` is also patched.

**Orphaned queue IDs (6 real sends + 1 test):**
```
a12b9f4a-55a7-4be7-b8ac-340620f74bea  (Las Vegas, NV)  sent 2026-05-18
5836d0e5-096e-4745-9f02-284ce9e1b7ed  (Houston, TX)    sent 2026-05-18
61d9d3d3-52b3-4b37-8029-64779cb8d953  (Atlanta, GA)    sent 2026-05-18
579b5331-5ea7-4212-a1c3-d5f61ef681d7  (Charlotte, NC)  sent 2026-05-18
f9de2a13-9d70-4613-85d7-e6209b42fbb2  (Detroit, MI)    sent 2026-05-18
b9b8d48e-83f9-44d8-ba6c-4d33e3e81fb0  (Charlotte, NC)  sent 2026-05-18
5a93762f-8e2d-4d48-8e97-2da48cf3922c  (test artifact)  sent 2026-05-13
```

**Fix (data side):** Run backfill repair script (see Repair Commands below).  
**Fix (code side):** `[HANDOFF TO GEMINI]` — fix the `message_events` insert in `api/internal/queue/runner.ts` around line 384. See Gemini Handoff section.

---

### BLOCKER 2 — 172 Stale Thread States with Blank Stage (MODERATE)
**Severity:** MODERATE  
**Description:** 172 `inbox_thread_state` rows have no corresponding `message_events` and have `stage = ''` (blank string). These were pre-created during the May 13 Indianapolis queue build. They produce ghost threads in the inbox and break the `inbox_threads_hydrated` view filter.

**Root cause:** Thread states were bulk-inserted from the queue builder before any messages were sent. When those queue rows were cancelled/blocked, no events ever arrived.

**Fix:** Run `rebuild-thread-state-from-events.mjs --apply --gap-a-only` to set stage to `'needs_response'` on all 172 rows.

---

### BLOCKER 3 — 23 Outbound message_events with null thread_key (MODERATE)
**Severity:** MODERATE  
**Description:** 23 outbound `message_events` rows have `thread_key = null`. These events are linked to `send_queue` rows (all have `queue_id`) but cannot be joined to `inbox_thread_state` or appear in any thread view.

**Root cause:** Same runner.ts schema mismatch — `thread_id` (wrong) was used instead of `thread_key`.

**Fix (data side):** Derive `thread_key = to_phone_number|from_phone_number` and patch these rows. This is covered by the backfill repair script.  
**Fix (code side):** `[HANDOFF TO GEMINI]` — see Gemini Handoff section.

---

### BLOCKER 4 — inbox_activity_events Table May Not Exist
**Severity:** LOW  
**Description:** `inboxActivityData.ts` calls `supabase.from('inbox_activity_events')` but no migration for this table exists in `supabase/migrations/`. If the table is missing, all activity logging silently fails.

**Fix:** `[HANDOFF TO GEMINI]` — create migration for `inbox_activity_events` table or confirm it was created outside of version-controlled migrations.

---

## Completed / Verified

- [x] send_queue → message_events `queue_id` FK linkage working for 8,307 outbound events
- [x] All event `thread_keys` have a corresponding `inbox_thread_state` row (0 missing states for threads that have events)
- [x] RLS policies on all three tables are correct (select/insert/update open for service role)
- [x] `inbox_threads_hydrated` view is accessible
- [x] `inbox_command_center_v` view is accessible
- [x] `inbox_category_counts` view is accessible
- [x] Queue runner guards (suppression, rate limits, dedup, phone validation) are functional
- [x] Routing tier system operational (routing_tier, routing_reason columns populated)
- [x] 10 `scheduled` rows ready for next send batch

---

## Pre-Send Checklist (run before every batch)

- [ ] **Run proof scripts** — all 4 must exit 0 before sending
  ```bash
  node scripts/proof/production-sms-health.mjs
  node scripts/proof/queue-event-linkage.mjs
  node scripts/proof/thread-state-sync.mjs
  node scripts/proof/live-activity-sync.mjs
  ```
- [ ] **Verify scheduled row count** — confirm rows are due
  ```bash
  # Expected: ≥1 row with scheduled_for_utc ≤ now
  ```
- [ ] **Confirm SUPABASE_SERVICE_ROLE_KEY is set** — live runs require it
- [ ] **Confirm no global lock is active** — check `paused_global_lock` count in queue
- [ ] **Dry run the batch first**
  ```bash
  curl -X POST /api/internal/queue/run -d '{"dry_run": true, "limit": 10}'
  ```
- [ ] **Review dry-run output** — `would_send_count` matches expectation, no routing failures
- [ ] **Check Sentry error rate** — no new unresolved queue/inbox errors in last 24h
- [ ] **Verify DB connection count is within limits**

---

## Proof Commands (exact CLI)

```bash
# Full health check — exit 0 = clean
node scripts/proof/production-sms-health.mjs

# Orphaned sent rows + schema mismatch check
node scripts/proof/queue-event-linkage.mjs --verbose

# Thread state chain verification
node scripts/proof/thread-state-sync.mjs

# Live Activity / Command Map data chain
node scripts/proof/live-activity-sync.mjs
```

---

## Repair Commands (dry-run first, then apply)

### Repair 1: Backfill 7 orphaned sent rows
```bash
# Step 1: Dry run — review what will be inserted
node scripts/repair/backfill-sent-message-events.mjs

# Step 2: Apply (requires SUPABASE_SERVICE_ROLE_KEY)
node scripts/repair/backfill-sent-message-events.mjs --apply

# Step 3: Skip the test artifact row, only repair real sends
node scripts/repair/backfill-sent-message-events.mjs --apply --skip-test-rows
```

### Repair 2: Fix 172 stale thread states with blank stage
```bash
# Step 1: Dry run
node scripts/repair/rebuild-thread-state-from-events.mjs --gap-a-only

# Step 2: Apply
node scripts/repair/rebuild-thread-state-from-events.mjs --apply --gap-a-only
```

### Repair 3: Full thread state rebuild (both gaps)
```bash
# Step 1: Dry run both gaps
node scripts/repair/rebuild-thread-state-from-events.mjs

# Step 2: Apply both gaps
node scripts/repair/rebuild-thread-state-from-events.mjs --apply
```

---

## Live Send Sequence

```bash
# 1. Pre-flight proof
node scripts/proof/production-sms-health.mjs || exit 1

# 2. Dry run
curl -X POST https://<host>/api/internal/queue/run \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true, "caps": {"sends_per_run": 50}}'

# 3. Review output — confirm would_send_count, check for routing errors

# 4. Live send
curl -X POST https://<host>/api/internal/queue/run \
  -H "Content-Type: application/json" \
  -d '{"dry_run": false, "caps": {"sends_per_run": 50}}'

# 5. Post-send proof
node scripts/proof/queue-event-linkage.mjs
node scripts/proof/live-activity-sync.mjs
```

---

## Rollback Plan

If a send batch causes unintended sends:

1. **Cancel all queued rows immediately**
   ```sql
   -- Via Supabase dashboard SQL editor (service role required)
   UPDATE public.send_queue
   SET queue_status = 'cancelled', updated_at = now()
   WHERE queue_status IN ('queued', 'scheduled', 'ready')
     AND sent_at IS NULL;
   ```

2. **Block a specific market or number**
   ```sql
   UPDATE public.send_queue
   SET queue_status = 'blocked', blocked_reason = 'manual_operator_hold', updated_at = now()
   WHERE queue_status IN ('queued', 'scheduled')
     AND market = '<MARKET_NAME>';
   ```

3. **Identify and flag opt-outs from inbound replies**
   ```sql
   -- Surface inbound stop/remove/unsubscribe from last hour
   SELECT canonical_e164, message_body, created_at
   FROM public.message_events
   WHERE direction = 'inbound'
     AND created_at > now() - interval '1 hour'
     AND (message_body ILIKE '%stop%' OR message_body ILIKE '%remove%' OR message_body ILIKE '%unsubscribe%');
   ```

---

## Division of Ownership

### Claude (SMS Production Auditor) owns:
- `scripts/proof/` — all proof/integrity scripts
- `scripts/repair/` — all repair/backfill scripts
- `PRODUCTION_SMS_LAUNCH_CHECKLIST.md`
- SQL integrity queries and DB-level gap analysis

### Gemini owns (backend queue/send logic):
- `api/internal/queue/runner.ts` — fix the `message_events` insert (BLOCKER 1)
- `api/internal/queue/run.ts`
- `api/internal/inbox/rebuild-thread-state.ts`
- All queue builder logic (`build-followups.ts`, `build-outbound.ts`, `build-replies.ts`)
- Message event persistence logic after send

### Codex owns (frontend):
- `src/modules/inbox/` — all inbox UI components
- `src/modules/queue/` — all queue view UI
- Command Map view and seller pin components
- Live Activity UI components
- MetricsWarRoom, TextGrid sending flow UI

---

## Gemini Handoff — runner.ts Fix Required

**File:** `api/internal/queue/runner.ts`  
**Location:** Line ~384 (the `supabase.from('message_events').insert(...)` block)

**Current broken insert:**
```typescript
await supabase.from('message_events').insert({
  thread_id: null,          // WRONG — column does not exist
  direction: 'outbound',
  phone: phoneE164,         // WRONG — should be to_phone_number
  from_phone_number: routingResult.from_phone_number,
  to_phone_number: phoneE164,
  body: item.message_body,  // WRONG — should be message_body
  status: 'pending',        // WRONG — should be delivery_status
  created_at: now,
  master_owner_id: item.master_owner_id,
  property_id: item.property_id,
  prospect_id: item.prospect_id,
  queue_id: itemId,
  metadata: { ... },
})
```

**Required fix:**
```typescript
const threadKey = asString(hydrated.thread_key || item.thread_key)
  || `${phoneE164}|${routingResult.from_phone_number}`  // derive if missing

await supabase.from('message_events').insert({
  message_event_key:   `queue:${itemId}`,  // required NOT NULL column
  direction:           'outbound',
  event_type:          'sms',
  to_phone_number:     phoneE164,           // correct column
  from_phone_number:   routingResult.from_phone_number,
  message_body:        item.message_body,  // correct column (not 'body')
  delivery_status:     'sent',             // correct column (not 'status')
  thread_key:          threadKey,          // correct column (not 'thread_id')
  queue_id:            itemId,
  master_owner_id:     item.master_owner_id || null,
  property_id:         item.property_id || null,
  prospect_id:         item.prospect_id || null,
  market:              asString(hydrated.market || item.market) || null,
  market_id:           asString(hydrated.market_id || item.market_id) || null,
  textgrid_number_id:  routingResult.textgrid_number_id || null,
  sent_at:             now,
  event_timestamp:     now,
  created_at:          now,
  source_app:          'nexus_queue_runner',
  metadata: {
    source: 'queue_command_center',
    textgrid_number_id: routingResult.textgrid_number_id,
  },
})

// Also ensure thread_key is set on the queue row itself
// (the updatePayload block above should include thread_key derived as above)
```

**Also fix:** The `updatePayload` object in the same runner (around line 327) should set `thread_key` if it is currently null, deriving it as `${phoneE164}|${routingResult.from_phone_number}`.

---

## Sentry Issue Classifications

| Issue | Type | Owner | Status |
|---|---|---|---|
| `message_events` insert fails silently (schema mismatch: `body`, `thread_id`, `status`, `phone`) | Code logic bug | Gemini | OPEN — fix runner.ts |
| Sent queue rows missing `thread_key` (null FK to inbox threads) | Code logic bug | Gemini | OPEN — fix runner.ts updatePayload |
| 172 stale thread states with blank `stage` | Data integrity | Claude (repaired via script) | READY TO REPAIR |
| 7 orphaned sent rows (no message_events) | Data integrity | Claude (repair script ready) | READY TO REPAIR |
| `inbox_activity_events` table may be missing | Schema gap | Gemini | INVESTIGATE |
| HeadersTimeoutError on queue runner | Infrastructure | Gemini | Monitor — likely Vercel function timeout |

---

## Quick Status Query

Run this in the Supabase SQL editor for a snapshot of current integrity:

```sql
SELECT
  'send_queue sent'              AS check_name,
  COUNT(*)                       AS total
FROM public.send_queue WHERE queue_status = 'sent'

UNION ALL

SELECT 'sent with message_events', COUNT(DISTINCT sq.id)
FROM public.send_queue sq
JOIN public.message_events me ON me.queue_id = sq.id
WHERE sq.queue_status = 'sent'

UNION ALL

SELECT 'orphaned sent (no events)', COUNT(*)
FROM public.send_queue sq
LEFT JOIN public.message_events me ON me.queue_id = sq.id
WHERE sq.queue_status = 'sent' AND me.id IS NULL

UNION ALL

SELECT 'message_events total', COUNT(*) FROM public.message_events

UNION ALL

SELECT 'inbox_thread_state total', COUNT(*) FROM public.inbox_thread_state

UNION ALL

SELECT 'stale thread states (no events)', COUNT(*)
FROM public.inbox_thread_state its
LEFT JOIN public.message_events me ON me.thread_key = its.thread_key
WHERE me.id IS NULL

UNION ALL

SELECT 'scheduled queue rows', COUNT(*)
FROM public.send_queue WHERE queue_status = 'scheduled';
```
