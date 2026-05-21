# Architecture Boundary Report — nexus-dashboard
Generated: 2026-05-19

## Hard Boundary

| System | Role |
|---|---|
| `real-estate-automation` | Backend source of truth — queue engine, SMS, classification, templates, suppression |
| `nexus-dashboard` | Frontend cockpit — read-only display, proxy buttons to backend APIs |

---

## 1. Safe Frontend Display (no action needed)

| File / Directory | Status |
|---|---|
| `src/modules/dashboard/` | Safe — display only |
| `src/modules/queue/queue.adapter.ts` | Safe — reads queue data, references `sendEngine: 'real-estate-automation'` correctly |
| `src/modules/inbox/InboxCommandMap.tsx` | Safe — display + action buttons; mutations go through existing data layer |
| `src/modules/properties/`, `src/modules/markets/` | Safe — read-only display |
| `src/lib/data/templateData.ts` | Safe — read-only template fetch and render |
| `src/lib/data/propertyData.ts` | Safe — reads only |
| `src/lib/data/textgridRouting.ts` | Safe — read-only routing lookup |
| `scripts/proof/*.mjs` (check/dump/verify scripts) | Safe — read-only Supabase queries |
| `scripts/check-*.mjs`, `scripts/dump-*.mjs` | Safe — read-only ops tools |
| `supabase/migrations/` | Safe — schema definitions, not data mutations |

---

## 2. Backend Mutation / Business Logic — Should Migrate to real-estate-automation

### API Internal (All guarded with `NEXUS_ALLOW_BACKEND_MUTATION` check)

| File | Problem | Action Taken |
|---|---|---|
| `api/internal/queue/build-outbound.ts` | Inserts to `send_queue`, template selection, dedup, suppression, sender routing | **GUARDED** |
| `api/internal/queue/build-followups.ts` | Inserts to `send_queue` for follow-ups | **GUARDED** |
| `api/internal/queue/build-replies.ts` | Inserts to `send_queue` for replies | **GUARDED** |
| `api/internal/queue/runner.ts` | Marks `send_queue` rows as `sent`, inserts `message_events`, updates `inbox_thread_state` | **GUARDED** |
| `api/internal/queue/run.ts` | HTTP handler for runner (has proxy to backend but also runs locally) | Already has proxy logic |
| `api/internal/queue/run-safe-batch.ts` | HTTP handler for safe runner | **GUARDED** |
| `api/internal/queue/cancel-stale-followups.ts` | Cancels `send_queue` rows | **GUARDED** |
| `api/internal/queue/reconcile.ts` | Reconciliation mutations | **GUARDED** |
| `api/internal/queue/reprocess-paused.ts` | Reprocesses paused queue rows | **GUARDED** |
| `api/internal/queue/retry-failed.ts` | Retries failed queue rows | **GUARDED** |
| `api/internal/queue/templateSelection.ts` | Template selection business logic | Should move to backend |
| `api/internal/queue/utils.ts` | Suppression gate, dedup, repeat-contact check, message rendering | Should move to backend |
| `api/internal/inbox/rebuild-thread-state.ts` | Reads events + rebuilds `inbox_thread_state` | **GUARDED** |
| `api/internal/messages/reclassify-history.ts` | Updates `message_events` intent/stage classification | **GUARDED** |

### Scripts — Dangerous Mutation Scripts

| File | Problem | Action Taken |
|---|---|---|
| `scripts/patch-feeder.mjs` | **DIRECTLY MODIFIES SOURCE FILES in ../real-estate-automation** | **GUARDED** + quarantined |
| `scripts/patch-feeder-v2.mjs` | Same as above | **GUARDED** + quarantined |
| `scripts/proof/run-real-feeder-test.ts` | Invokes real-estate-automation feeder live | **GUARDED** + quarantined |
| `scripts/ops/incident-batch-freeze.mjs` | Pauses `send_queue` rows with service role key | **GUARDED** |
| `scripts/ops/repair-thread-keys.mjs` | Updates `inbox_thread_state` | **GUARDED** |
| `scripts/ops/repair-thread-keys-historical.mjs` | Updates `message_events` + `inbox_thread_state` | **GUARDED** |
| `scripts/ops/rebuild-inbox-thread-state.mjs` | Updates `inbox_thread_state` | **GUARDED** |
| `scripts/ops/repair-paused-queue-rows.mjs` | Updates `send_queue` | **GUARDED** |
| `scripts/ops/backfill-paused-manual-send-routing.mjs` | Updates `send_queue` | **GUARDED** |
| `scripts/ops/run-backfill.mjs` | Calls reclassify-history API (backend mutation) | **GUARDED** |
| `scripts/ops/proof-feeder-dryrun.mjs` | Imports and calls real-estate-automation feeder directly | **GUARDED** |
| `scripts/update_seller_pins_rpc.mjs` | Supabase RPC mutations (in untracked files) | Needs audit |

---

## 3. Duplicated Logic — Belongs in real-estate-automation

These exist in nexus-dashboard but are copies/shadows of backend logic:

| Logic | Dashboard File | Backend Owner |
|---|---|---|
| Queue suppression gate | `api/internal/queue/utils.ts` → `checkSuppression()` | real-estate-automation |
| Deduplication | `api/internal/queue/utils.ts` → `generateDedupeKey()`, `checkExistingQueue()` | real-estate-automation |
| Repeat contact check | `api/internal/queue/utils.ts` → `checkRepeatContactAndBlacklist()` | real-estate-automation |
| Message rendering | `api/internal/queue/utils.ts` → `renderMessage()` | real-estate-automation |
| Template selection | `api/internal/queue/templateSelection.ts` → `selectWeightedTemplate()` | real-estate-automation |
| Message classification | `api/internal/messages/reclassify-history.ts` → `classifyMessage()` | real-estate-automation |
| Thread state computation | `api/internal/inbox/rebuild-thread-state.ts` → `processThread()` | real-estate-automation |
| Failure taxonomy | `api/internal/queue/utils.ts` → `classifyQueueFailureReason()` | real-estate-automation |
| Sender routing | `src/lib/data/textgridRouting.ts` | real-estate-automation |

---

## 4. Dashboard API Calls — Currently Routing Directly, Should Proxy to Backend

| Feature | Current Behavior | Correct Behavior |
|---|---|---|
| Queue run (live) | `api/internal/queue/run.ts` has proxy logic but falls through locally | Must proxy-only; local runner now guarded |
| Feeder dry-run | Dashboard calls local `build-outbound` | Dashboard should call `backendClient.runFeederDryRun()` |
| Thread state rebuild | Dashboard calls local `rebuild-thread-state` | Dashboard should call backend endpoint |
| Message reclassification | Dashboard calls local `reclassify-history` | Dashboard should call backend endpoint |

---

## 5. Frontend Src — Remaining Backend-Like Mutations (Not Blocked — Needs Migration)

These are inside `src/` and imported by UI components. They cannot be blocked without breaking the UI.
**They need migration to proxy through backend APIs in a future session.**

| File | Mutation | Table(s) |
|---|---|---|
| `src/lib/data/inboxData.ts` | `insert` send_queue, `insert` message_events, `upsert` inbox_thread_state | High volume mutations — 4124 lines |
| `src/lib/data/inboxAutoReply.ts` | `insert` send_queue (auto-reply engine) | Auto-reply logic belongs in backend |
| `src/lib/data/inboxWorkflowData.ts` | `upsert` inbox_thread_state, `update`/`delete` send_queue | Workflow state mutations |
| `src/lib/data/inboxActivityData.ts` | `insert` activity log entries | Lower risk, display-adjacent |

**These are not guarded** because they power current UI flows. The correct migration path:
1. Add backend API endpoints in real-estate-automation for: queue reply, send-now, workflow stage update
2. Replace each direct Supabase mutation in these files with a `backendClient.*` call
3. Show exact backend error if the API fails — never fake success

---

## 6. New Files Created

| File | Purpose |
|---|---|
| `src/lib/api/backendClient.ts` | Single integration point for backend API calls |
| `scripts/quarantine/README.md` | Documents quarantined scripts |
| `scripts/quarantine/patch-feeder.mjs` | Quarantined copy |
| `scripts/quarantine/patch-feeder-v2.mjs` | Quarantined copy |
| `scripts/quarantine/run-real-feeder-test.ts` | Quarantined copy |

---

## 7. Build Status

```
✓ tsc -b passes (no TypeScript errors)
✓ vite build passes (315 modules, 2.08s)
```

---

## 8. Acceptance Checklist

- [x] Dashboard does not mutate production backend data directly (all `api/internal` mutation endpoints guarded)
- [x] Dangerous scripts blocked by `NEXUS_ALLOW_BACKEND_MUTATION` guard
- [x] `patch-feeder*.mjs` (modifies real-estate-automation source files) quarantined and guarded
- [x] `src/lib/api/backendClient.ts` created as single backend integration point
- [x] Build passes
- [ ] `src/lib/data/inboxData.ts`, `inboxAutoReply.ts`, `inboxWorkflowData.ts` mutations migrated to backend APIs (future session — cannot block without breaking UI)
- [ ] `api/internal/queue/templateSelection.ts` and `utils.ts` removed from dashboard after backend exposes equivalent endpoints
