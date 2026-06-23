# Duplicate Ownership Report — REI Automation Platform

**Audit Date:** 2026-06-13  
**Total duplicates found:** 47  
**Critical:** 12 | High: 18 | Medium: 11 | Low: 6

---

## A. Duplicate API Logic

### 1. Send-Now Routes (3 implementations) — CRITICAL

Three separate API routes perform "send message now" with different auth and handlers:

| Route | Auth | Handler | Risk |
|-------|------|---------|------|
| `/cockpit/inbox/send-now` | ensureMutationAuth | `runInboxAction({ action: 'send-now' })` | CRITICAL |
| `/internal/inbox/send-now` | requireOpsDashboardAuth | `createInboxSendNowQueueRow()` + different validation | CRITICAL |
| `/internal/outbound/send-now` | handleSendNowRequestData | `handleSendNowRequestData()` generic | HIGH |

**Problem:** Callers don't know which path to use. Business logic diverges silently.

---

### 2. Auto-Enqueue Routes (2 implementations) — CRITICAL

Both routes call the same function with no clear consumer distinction:

| Route | Auth | Function Called |
|-------|------|----------------|
| `/cockpit/queue/auto-enqueue` | ensureMutationAuth | `runSupabaseCandidateFeeder()` |
| `/internal/outbound/auto-enqueue` | requireCronOrEngineAuth | `runSupabaseCandidateFeeder()` |

**Problem:** If both are triggered (UI + cron), candidates double-queue.

---

### 3. Queue Run Routes (2 implementations, asymmetric) — HIGH

| Route | HTTP Methods | Entry Function |
|-------|-------------|----------------|
| `/cockpit/queue/run` | POST only | `runSendQueue()` |
| `/internal/queue/run` | GET + POST | `handleQueueRunRequest()` → `runSendQueue()` |

**Problem:** Two entry points for the same function. Cron triggering cockpit route fails (no GET support).

---

### 4. Queue Retry Routes (2 implementations) — HIGH

| Route | Auth | Scope | Function |
|-------|------|-------|---------|
| `/cockpit/queue/retry` | ensureMutationAuth | Single item | `runQueueAction()` |
| `/internal/queue/retry` | requireCronOrEngineAuth | Batch | `runRetryRunner()` |

**Problem:** Naming identical, scope totally different. Confusing to callers.

---

### 5. Queue Status Routes (2 implementations, different data) — HIGH

| Route | Auth | Returns |
|-------|------|--------|
| `/cockpit/queue/status` | ensureMutationAuth | Enriched status via `getCockpitQueueStatus()` |
| `/internal/queue/status` | requireInternalSecret | Raw COUNT from Supabase |

**Problem:** Same resource, two different data shapes. Frontend cannot safely switch.

---

### 6. Live Inbox Routes (2 implementations) — HIGH

| Route | Auth | Behavior |
|-------|------|---------|
| `/cockpit/inbox/live` | ensureMutationAuth | Full response: counts + delivery state |
| `/internal/dashboard/inbox/live` | requireOpsDashboardAuth | Simplified: no counts, no delivery |

**Problem:** Partial duplication. Frontend could accidentally call the degraded path.

---

### 7. Inbox Thread State Routes (2 implementations) — HIGH

| Route | Auth | Function |
|-------|------|---------|
| `/cockpit/inbox/thread-state` | ensureMutationAuth | `patchThreadStateSafe()` via cockpit-service |
| `/internal/dashboard/inbox/thread-state` | requireOpsDashboardAuth | Separate implementation |

**Problem:** Two routes patching the same table (`inbox_thread_state`) with potentially different validation.

---

### 8. Thread Namespace Confusion (2 hierarchies) — HIGH

| Path | Capability |
|------|-----------|
| `/cockpit/threads/*` | List, PATCH, sync thread state |
| `/cockpit/inbox/threads/*` | Same operations, nested under inbox |

**Problem:** Identical resource, two URL hierarchies. No documented canonical path. CORS headers only on the inbox version.

---

### 9. Workflow System Duplication (2 complete systems) — CRITICAL

| System | Routes | Service | Table |
|--------|--------|---------|-------|
| Legacy v1 | `/cockpit/workflows/*` | workflow-service | `workflows` |
| Current v2 | `/workflows/*` | definition-service | `workflow_definitions` |

**Problem:** Both systems are live. No documented migration path. Different data models, different callers.

---

### 10. Queue Reconcile Routes (2 implementations) — MEDIUM

| Route | Auth |
|-------|------|
| `/cockpit/queue/reconcile` | ensureMutationAuth (manual) |
| `/internal/queue/reconcile` | requireCronOrEngineAuth (automated) |

---

### 11. Email Queue Route vs Generic Queue Route — MEDIUM

| Route | Scope |
|-------|-------|
| `/internal/email/queue/run` | Email queue only |
| `/cockpit/queue/run` | Generic queue (SMS + email) |

**Problem:** Email may be processed twice if both fire.

---

## B. Duplicate Backend Service Logic

### 12. Auto-Reply Logic (3 implementations) — CRITICAL

| Service | Location | Path |
|---------|----------|------|
| `queueAutoReply.js` | automation/ | Automation rule → queue |
| `execute-autonomous-reply.js` | seller-flow/ | Seller reply → queue |
| `resolve-seller-auto-reply-plan.js` | seller-flow/ | Reply planning → execute-autonomous-reply |

All three ultimately INSERT into `send_queue`. No single canonical auto-reply path.

---

### 13. Context Loading (4 implementations) — HIGH

| Service | Scope |
|---------|-------|
| `load-context.js` | Basic context load |
| `load-context-with-fallback.js` | Retry wrapper around #1 |
| `thread-context-service.js` | Inbox-specific thread context |
| `enrich-message-event-context.js` | Post-event enrichment |

Unclear which to call from new code. Four diverging implementations of the same concept.

---

### 14. Follow-Up Scheduling (2 implementations) — HIGH

| Service | Domain | Trigger |
|---------|--------|---------|
| `no-reply-followup-scheduler.js` | acquisition | No response to initial outreach |
| `seller-followup-scheduler.js` | seller-flow | No response in active conversation |

Identical scheduling pattern (scheduled `send_queue` INSERT). Copy-paste logic.

---

### 15. Queue Message Insertion (2 services) — HIGH

| Service | Context |
|---------|---------|
| `queue-outbound-message.js` | Generic outbound flow |
| `campaign-automation-service.js` | Campaign-specific |

Both INSERT into `send_queue` with potentially different field validation.

---

### 16. Thread State Management (2 services) — MEDIUM

| Service | Operation |
|---------|-----------|
| `resolveInboxThreadState.js` | READ state from multiple sources |
| `cockpit-service.js::patchThreadStateSafe()` | WRITE whitelisted state fields |

Conceptually the same service (InboxThreadState), split across two files in different layers.

---

### 17. Reply Validation (2 services) — MEDIUM

| Service | Context |
|---------|---------|
| `reply-sms-safety-checks.js` | Discord bot context |
| `queue-control-safety.js` | Queue runtime |

Different code, overlapping validation rules (phone checks, compliance, rate limits).

---

## C. Duplicate Frontend Ownership

### 18. Queue CSS (2 owners) — HIGH

| File | Location | Claims |
|------|----------|--------|
| `queue-ops.css` | modules/inbox/ | Queue operations styling |
| `queue-premium.css` | views/queue/ | Queue view styling |

Same component (`QueueCommandCenter`) styled from two separate CSS files.

---

### 19. Copilot CSS (2 owners) — MEDIUM

| File | Location | Claims |
|------|----------|--------|
| `copilot.css` | modules/inbox/ | Copilot panel (inbox context) |
| `copilot-v2.css` | modules/copilot/ | Copilot interface (module context) |

`CopilotShell` receives styles from the copilot module; when rendered inside inbox it also picks up inbox copilot styles.

---

### 20. KPI / War Room CSS (2 owners) — MEDIUM

| File | Claims |
|------|--------|
| `kpi-dashboard.css` | KPI cards and numbers |
| `metrics-war-room.css` | Ops tiled panels and status indicators |

Both target the same panel surface (`MetricsWarRoom`/`InboxKpiDashboard`) with overlapping card styles.

---

### 21. Theme Token Ownership (4 owners) — HIGH

| File | Claims |
|------|--------|
| `nexus-theme.css` | All `--nx-*` tokens (canonical) |
| `nexus-theme-contract.css` | Fallback re-declarations of same tokens |
| `light-theme-premium.css` | Third override of light-mode tokens |
| `nx-ui-foundation-final.css` | Also sets baseline accent/menu tokens |

Four files writing overlapping CSS custom properties. Load order determines winner.

---

### 22. Command System Duplication (2 systems) — MEDIUM

| System | Component | Trigger | Scope |
|--------|-----------|---------|-------|
| Global | `GlobalCommandOverlay.tsx` | ⌘K | App-wide navigation + search |
| Inbox-scoped | `InboxCommandPalette.tsx` | Thread context | Thread actions only |

Both run search logic. `useInboxTopSearch.ts` bridges them but creates coupling.

---

### 23. AI Analysis Duplication (2 engines) — HIGH

| Engine | File | Analyzes | Output |
|--------|------|---------|--------|
| Thread intelligence | `ai-command-center.ts` | Individual thread conversation | 13 scores + recommendations |
| Market autonomy | `autonomy-engine.ts` | All threads + queue | Coverage %, risk %, market snapshots |

Both engines run on the client. Both consume thread data. Outputs overlap (autonomy engine uses ai-command scores as inputs). No shared data contract.

---

### 24. Workflow View Duplication (2 routes to same component) — MEDIUM

Both `/workflow-studio` and `/workflow-studio/v2` render `WorkflowStudioV2`. The v1 route is an alias but still exposes a separate entry point with a separate loader.

---

## D. Duplicate Supabase Access

### 25. send_queue Frontend + Backend (CRITICAL)

| Side | How accessed | Ref count |
|------|-------------|-----------|
| Frontend | `queueData.ts`, `fetchQueueModel.ts`, `inboxData.ts`, 49+ more | 52+ |
| Backend | 24 services directly | 55+ |

Frontend reads queue status by direct Supabase query instead of consuming `/cockpit/queue/status`. Backend mutations happen without knowledge of frontend-held state.

---

### 26. message_events Frontend + Backend (CRITICAL)

| Side | File | Access |
|------|------|--------|
| Frontend | `inboxData.ts` | SELECT message history |
| Backend | 7 domain services | INSERT + SELECT (canonical) |

Frontend bypasses `/cockpit/inbox/thread-messages` API route and reads directly.

---

### 27. properties Table (3 access paths) — HIGH

| Path | Consumers |
|------|----------|
| Frontend direct | `propertyData.ts`, `acquisitionData.ts` |
| Backend API | `/cockpit/properties/[id]/*` routes |
| Backend service | context/, intel/ domain services |

Three access patterns for the same table, no single source of truth for enriched property data.

---

### 28. sms_templates (2 access paths) — MEDIUM

| Path | Consumer |
|------|---------|
| Frontend direct | `templateData.ts` |
| Backend API | workflow/template routes |

---

### 29. sms_suppression_list (2 access paths) — HIGH

| Path | Consumer |
|------|---------|
| Frontend direct | `propertyData.ts` |
| Backend | `compliance-handler.js`, `should-suppress-outreach.js` |

Frontend reads suppression list directly — suppression checks should only run server-side.

---

### 30. phones / phone_numbers (2 access paths) — HIGH

| Path | Consumer |
|------|---------|
| Frontend direct | `inboxData.ts`, `textgridRouting.ts` |
| Backend | routing, sender allocation services |

Phone numbers exposed to anon key. TextGrid routing logic running client-side.

---

## Summary Table

| Category | Count | Critical | High | Medium |
|----------|-------|----------|------|--------|
| Duplicate API routes | 11 | 3 | 5 | 3 |
| Duplicate backend services | 6 | 1 | 3 | 2 |
| Duplicate frontend ownership | 7 | 0 | 4 | 3 |
| Duplicate Supabase access | 6 | 2 | 3 | 1 |
| **TOTAL** | **30** | **6** | **15** | **9** |
