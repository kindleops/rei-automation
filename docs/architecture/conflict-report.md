# Conflict Report — REI Automation Platform

**Audit Date:** 2026-06-13  
**Total conflicts:** 35  
**Critical:** 8 | High: 14 | Medium: 9 | Low: 4

---

## Format

Each entry shows:
- **Source** — the file/system initiating the conflict
- **Target** — the file/system being overridden or duplicated
- **Reason** — what the conflict is
- **Severity** — CRITICAL / HIGH / MEDIUM / LOW

---

## API Conflicts

### CF-001 — cockpit/inbox/send-now overrides internal/inbox/send-now
- **Source:** `/cockpit/inbox/send-now/route.js` → `runInboxAction()`
- **Target:** `/internal/inbox/send-now/route.js` → `createInboxSendNowQueueRow()`
- **Reason:** Two routes perform the same operation (queue a manual inbox send) with different validation paths. The cockpit route validates against thread flags; the internal route validates against phone availability. A message could pass one and fail the other.
- **Severity:** CRITICAL

---

### CF-002 — cockpit/queue/auto-enqueue duplicates internal/outbound/auto-enqueue
- **Source:** `/cockpit/queue/auto-enqueue/route.js`
- **Target:** `/internal/outbound/auto-enqueue/route.js`
- **Reason:** Both call `runSupabaseCandidateFeeder()` with identical safety controls. If both are triggered within the same window (UI user + cron), candidates are double-queued.
- **Severity:** CRITICAL

---

### CF-003 — /workflows/* conflicts with /cockpit/workflows/*
- **Source:** `/workflows/[id]/route.js` (v2 definition-service)
- **Target:** `/cockpit/workflows/[id]/route.js` (v1 workflow-service)
- **Reason:** Two parallel workflow execution systems coexist. v1 uses `workflows` table; v2 uses `workflow_definitions`. Frontend workflow studio may be talking to v1 while automation engine uses v2, creating invisible split execution.
- **Severity:** CRITICAL

---

### CF-004 — /cockpit/threads conflicts with /cockpit/inbox/threads
- **Source:** `/cockpit/threads/[thread_key]/route.js`
- **Target:** `/cockpit/inbox/threads/[thread_key]/route.js`
- **Reason:** Identical resource at two URL hierarchies. The inbox version adds CORS headers; the non-inbox version doesn't. Frontend callers must use the correct one or lose CORS support.
- **Severity:** HIGH

---

### CF-005 — cockpit/inbox/thread-state conflicts with internal/dashboard/inbox/thread-state
- **Source:** `/cockpit/inbox/thread-state/route.js`
- **Target:** `/internal/dashboard/inbox/thread-state/route.js`
- **Reason:** Both PATCH `inbox_thread_state` via different implementations with different auth. Field whitelists may diverge over time.
- **Severity:** HIGH

---

### CF-006 — cockpit/inbox/live conflicts with internal/dashboard/inbox/live
- **Source:** `/cockpit/inbox/live/route.js` (full response)
- **Target:** `/internal/dashboard/inbox/live/route.js` (degraded response)
- **Reason:** Callers of the internal route receive a subset of data (no counts, no delivery). If the internal route is accidentally used by the UI, features silently degrade.
- **Severity:** HIGH

---

### CF-007 — internal/outbound/send-now is a third send-now path
- **Source:** `/internal/outbound/send-now/route.js`
- **Target:** Two existing send-now routes (CF-001)
- **Reason:** Three routes for the same action. The outbound version uses a generic handler and accepts GET+POST, the others are POST-only. Adds confusion for integrators.
- **Severity:** HIGH

---

### CF-008 — internal/email/queue/run conflicts with cockpit/queue/run
- **Source:** `/internal/email/queue/run/route.js`
- **Target:** `/cockpit/queue/run/route.js`
- **Reason:** The generic queue runner processes email items. If the email-specific runner also fires, email queue items are processed twice.
- **Severity:** MEDIUM

---

## Backend Service Conflicts

### CF-009 — queueAutoReply bypasses execute-autonomous-reply
- **Source:** `lib/automation/queueAutoReply.js`
- **Target:** `lib/domain/seller-flow/execute-autonomous-reply.js`
- **Reason:** Both services can fire for the same thread event, causing double-queued replies. No coordination mechanism between them.
- **Severity:** CRITICAL

---

### CF-010 — execute-autonomous-reply bypasses send-now-service validation
- **Source:** `lib/domain/seller-flow/execute-autonomous-reply.js`
- **Target:** `lib/domain/inbox/send-now-service.js`
- **Reason:** Autonomous replies insert into `send_queue` directly without going through `send-now-service`. Thread flag checks (paused_review, quarantine) in send-now-service are skipped.
- **Severity:** CRITICAL

---

### CF-011 — campaign-automation-service bypasses queue-outbound-message
- **Source:** `lib/domain/campaigns/campaign-automation-service.js`
- **Target:** `lib/flows/queue-outbound-message.js`
- **Reason:** Campaign sends bypass the canonical outbound flow. Business rules (rate limiting, suppression check ordering) may differ between the two paths.
- **Severity:** HIGH

---

### CF-012 — no-reply-followup-scheduler and seller-followup-scheduler duplicate each other
- **Source:** `lib/domain/acquisition/no-reply-followup-scheduler.js`
- **Target:** `lib/domain/seller-flow/seller-followup-scheduler.js`
- **Reason:** Identical scheduling logic (INSERT scheduled send_queue row). Timing rules and escalation paths are duplicated in two files that will drift.
- **Severity:** HIGH

---

### CF-013 — load-context-with-fallback bypasses load-context
- **Source:** `lib/domain/context/load-context-with-fallback.js`
- **Target:** `lib/domain/context/load-context.js`
- **Reason:** The fallback wrapper adds retry logic but may mask errors that should propagate. Code that calls the fallback version may silently tolerate degraded context.
- **Severity:** MEDIUM

---

### CF-014 — patchThreadStateSafe and resolveInboxThreadState are split across layers
- **Source:** `lib/cockpit/cockpit-service.js::patchThreadStateSafe()`
- **Target:** `lib/domain/inbox/resolveInboxThreadState.js`
- **Reason:** Write (cockpit) and read (domain) for the same state object are in different service layers. No single InboxThreadStateService owns the contract.
- **Severity:** MEDIUM

---

### CF-015 — sms-engine.js overlaps with run-send-queue.js
- **Source:** `lib/supabase/sms-engine.js`
- **Target:** `lib/domain/queue/run-send-queue.js`
- **Reason:** Both handle queue state transitions. sms-engine is supposed to be low-level (Supabase primitives) but contains high-level orchestration logic (event writing, finalization). Responsibility boundary is unclear.
- **Severity:** HIGH

---

## Database / Supabase Conflicts

### CF-016 — Frontend reads send_queue directly, bypassing API
- **Source:** `apps/dashboard/src/lib/data/queueData.ts` (52+ references)
- **Target:** `/cockpit/queue/status` API route
- **Reason:** Frontend holds its own view of queue state from Supabase. Backend mutations via 24 services may not match the frontend's stale local read. State synchronization entirely depends on realtime subscriptions.
- **Severity:** CRITICAL

---

### CF-017 — Frontend reads message_events directly, bypassing API
- **Source:** `apps/dashboard/src/lib/data/inboxData.ts`
- **Target:** `/cockpit/inbox/thread-messages` API route
- **Reason:** Frontend reads the raw event log. The API route applies normalization and access control. Frontend gets unnormalized data.
- **Severity:** CRITICAL

---

### CF-018 — Frontend reads sms_suppression_list directly
- **Source:** `apps/dashboard/src/lib/data/propertyData.ts`
- **Target:** `lib/domain/compliance/compliance-handler.js`
- **Reason:** Suppression checks are a compliance boundary. They must run server-side where all suppression types (phone-level, carrier-level, opt-out-level) can be unified. Frontend reading the table directly can show a false "not suppressed" if some suppression types aren't in that table.
- **Severity:** CRITICAL

---

### CF-019 — Frontend calls get_buyers_for_property RPC directly
- **Source:** `apps/dashboard/src/views/buyer-match/data/buyerMatchData.ts`
- **Target:** `/cockpit/buyer-match/property/[id]/candidates` API route
- **Reason:** The API route applies business logic (score filtering, DNC checks) before returning candidates. The frontend RPC call bypasses this and returns raw results.
- **Severity:** HIGH

---

### CF-020 — Frontend calls get_command_map_seller_pins RPC directly
- **Source:** `apps/dashboard/src/lib/data/commandMapData.ts`
- **Target:** `/internal/dashboard/ops/map` API route
- **Reason:** Raw seller pin data (addresses, phone presence, stage) exposed to anon key via RPC. The API route would filter by operator permissions.
- **Severity:** HIGH

---

### CF-021 — Frontend reads phones/phone_numbers directly
- **Source:** `apps/dashboard/src/lib/data/inboxData.ts`, `textgridRouting.ts`
- **Target:** Backend routing services
- **Reason:** TextGrid routing logic running client-side. Phone number inventory (carrier, status, active/inactive) is sensitive operational data that should not be exposed to anon key.
- **Severity:** HIGH

---

### CF-022 — Frontend reads properties table directly
- **Source:** `apps/dashboard/src/lib/data/propertyData.ts`, `acquisitionData.ts`
- **Target:** `/cockpit/properties/[id]` API routes
- **Reason:** Property records include sensitive seller data. Frontend reads without the enrichment, access control, and field filtering applied by the API.
- **Severity:** HIGH

---

## CSS / Theme Conflicts

### CF-023 — inbox-rebuild-v2.css overrides inbox-premium.css
- **Source:** `modules/inbox/inbox-rebuild-v2.css`
- **Target:** `modules/inbox/inbox-premium.css`
- **Reason:** rebuild-v2 was a refactor pass that selectively overrides premium styles. Both files are active. Some classes are defined in both — rebuild-v2 wins due to import order. Parts of premium that weren't refactored remain active alongside rebuild-v2 styles.
- **Severity:** HIGH

---

### CF-024 — inbox-polish.css overrides inbox-universal.css
- **Source:** `modules/inbox/inbox-polish.css` (last import in InboxPage)
- **Target:** `modules/inbox/inbox-universal.css`
- **Reason:** Polish pass was added as final override. If universal adds new utility classes that conflict with polish overrides, universal loses silently.
- **Severity:** MEDIUM

---

### CF-025 — queue-premium.css (views) conflicts with queue-ops.css (modules)
- **Source:** `views/queue/queue-premium.css`
- **Target:** `modules/inbox/queue-ops.css`
- **Reason:** Both files style `QueueCommandCenter`. When the component renders inside InboxPage, queue-ops.css wins. When rendered in QueueView, queue-premium.css wins. Component looks different depending on context.
- **Severity:** HIGH

---

### CF-026 — light-theme-premium.css overrides nexus-theme.css light tokens
- **Source:** `styles/light-theme-premium.css`
- **Target:** `styles/nexus-theme.css` (light theme block)
- **Reason:** Light theme tokens defined twice. Changes to nexus-theme.css light block may be silently overridden by premium. Debugging requires checking both files.
- **Severity:** MEDIUM

---

### CF-027 — nx-ui-foundation-final.css sets tokens also set by nexus-theme.css
- **Source:** `styles/nx-ui-foundation-final.css`
- **Target:** `styles/nexus-theme.css`
- **Reason:** Foundation sets baseline accent/menu token values. If theme switches (e.g., to tactical-blue), foundation's hardcoded values may survive because they're scoped to `:root` without a theme attribute selector.
- **Severity:** MEDIUM

---

### CF-028 — copilot.css (inbox module) conflicts with copilot-v2.css (copilot module)
- **Source:** `modules/inbox/copilot.css`
- **Target:** `modules/copilot/copilot-v2.css`
- **Reason:** When AICopilotPanel renders inside InboxPage, both sheets apply. Specificity determines winner per property. Changes to one may unexpectedly affect the other.
- **Severity:** MEDIUM

---

## Frontend Architecture Conflicts

### CF-029 — GlobalCommandOverlay and InboxCommandPalette share search logic
- **Source:** `modules/command-center/GlobalCommandOverlay.tsx`
- **Target:** `modules/inbox/InboxCommandPalette.tsx`
- **Reason:** `useInboxTopSearch.ts` bridges both systems, creating tight coupling between the app-level command palette and the inbox-scoped one. Changing global search behavior risks breaking inbox search.
- **Severity:** MEDIUM

---

### CF-030 — ai-command-center.ts and autonomy-engine.ts compute overlapping scores
- **Source:** `modules/inbox/ai-command-center.ts`
- **Target:** `modules/inbox/autonomy-engine.ts`
- **Reason:** ai-command-center computes per-thread scores; autonomy-engine consumes threads + uses similar scoring logic for market aggregates. No shared type contract or function. Score computation drift is invisible.
- **Severity:** HIGH

---

### CF-031 — Inbox CSS loads in InboxPage overriding global styles in main.tsx
- **Source:** Inbox CSS files (imported last in `InboxPage.tsx`)
- **Target:** Global CSS (imported in `main.tsx`)
- **Reason:** As documented in memory (inbox-css-cascade), InboxPage must load its sheets last or global styles win. This requires InboxPage to "know" about global load order — a fragile contract.
- **Severity:** HIGH

---

### CF-032 — WorkflowStudioV2 accessible from 2 routes
- **Source:** `/workflow-studio/v2` route
- **Target:** `/workflow-studio` route
- **Reason:** Same component, two routes. Users bookmarking `/workflow-studio` and `/workflow-studio/v2` may get different loader behavior if the routes aren't kept in sync.
- **Severity:** LOW

---

### CF-033 — Backend /workflows/* (v2) and /cockpit/workflows/* (v1) serve same frontend
- **Source:** `WorkflowStudioV2` fetching from unknown endpoint
- **Target:** Both workflow API namespaces
- **Reason:** If the frontend is sending workflow requests to v1 (cockpit) but automations are executing v2 (workflow_definitions), workflows built in the UI may not actually run.
- **Severity:** CRITICAL

---

## Severity Distribution

| Severity | Count |
|----------|-------|
| CRITICAL | 8 |
| HIGH | 14 |
| MEDIUM | 9 |
| LOW | 2 |
| **TOTAL** | **33** |
