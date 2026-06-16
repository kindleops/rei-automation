# System Risk Report — REI Automation Platform

**Audit Date:** 2026-06-13  
**Risk methodology:** Blast radius × likelihood × reversibility

---

## CRITICAL RISKS (Address Before Any Feature Work)

### RISK-001 — Frontend anon key has direct access to sensitive operational tables
**Severity:** CRITICAL  
**Blast radius:** Entire database  
**Files:** 44 frontend data files, `lib/supabaseClient.ts`

The dashboard uses Supabase anon key to query `send_queue`, `message_events`, `sms_suppression_list`, `phones`, `phone_numbers`, `properties`, `owners`, `master_owners`, `conversation_threads`, and 30+ more tables. If the anon key is extracted from the browser bundle, any external party can read all operational data without authentication.

**No RLS evidence found for sensitive tables.**

Immediate risk: data breach. Secondary risk: write operations (realtime patches, RPCs) on sensitive tables from client context.

---

### RISK-002 — Three send-now routes with diverging validation
**Severity:** CRITICAL  
**Blast radius:** All manual inbox sends  
**Files:** cockpit/inbox/send-now, internal/inbox/send-now, internal/outbound/send-now

Three separate code paths send a message from the inbox. Each has different validation (phone checks, thread flag checks, feature flag checks). A compliance-required check present in one path may be absent in another. A bad actor with internal route access can send messages that the cockpit route would reject.

---

### RISK-003 — Auto-enqueue double-execution risk
**Severity:** CRITICAL  
**Blast radius:** All outbound queuing  
**Files:** cockpit/queue/auto-enqueue, internal/outbound/auto-enqueue

Both routes call `runSupabaseCandidateFeeder()` with no coordination lock. If a cron and a UI user trigger simultaneously, the same candidates are queued twice. Duplicate SMS sends to real contacts.

---

### RISK-004 — Autonomous reply bypasses thread safety checks
**Severity:** CRITICAL  
**Blast radius:** All auto-reply-eligible threads  
**Files:** `execute-autonomous-reply.js`, `send-now-service.js`

Auto-replies insert directly into `send_queue` without calling `send-now-service`. The paused_review and quarantine checks in send-now-service are bypassed. A quarantined thread can receive autonomous replies.

---

### RISK-005 — Two workflow systems both live in production
**Severity:** CRITICAL  
**Blast radius:** All workflow automation  
**Files:** /cockpit/workflows/*, /workflows/*, workflow-service, definition-service

v1 (`workflows` table, workflow-service) and v2 (`workflow_definitions`, definition-service) coexist. WorkflowStudioV2 frontend route exists but which API it actually calls is unclear. Workflows built via the UI may be persisted in v1 while the automation engine executes from v2 — invisible failure.

---

### RISK-006 — Frontend reads sms_suppression_list directly
**Severity:** CRITICAL  
**Blast radius:** Compliance / legal  
**Files:** `propertyData.ts`, `compliance-handler.js`

Suppression checks are a legal compliance boundary (TCPA). The frontend reads the suppression table directly with the anon key. Backend compliance handler aggregates suppression from multiple sources (phone-level, carrier-level, opt-out). Frontend sees only one source. A property could show as "not suppressed" in the UI while the backend would suppress it.

---

### RISK-007 — send_queue has no distributed lock across 24 services
**Severity:** CRITICAL  
**Blast radius:** All SMS delivery  
**Files:** 24 backend services + 52 frontend references

55+ backend references to `send_queue` with no evidence of a distributed coordination mechanism beyond the `claim_queue_jobs` RPC. Race conditions between `campaign-automation-service`, `execute-autonomous-reply`, `queueAutoReply`, `delivery-retry-engine`, and `seller-followup-scheduler` can cause duplicate sends, status overwrites, and phantom queue items.

---

### RISK-008 — WorkflowStudio v1/v2 split: workflows built may never execute
**Severity:** CRITICAL  
**Blast radius:** All operator-created workflows  
**Files:** /cockpit/workflows/*, /workflows/*

If the frontend sends workflow save requests to v1 (cockpit/workflows) but the execution engine reads from v2 (workflow_definitions), workflows created by operators are stored but never run. This is a silent data loss pattern.

---

## HIGH RISKS

### RISK-009 — message_events read directly from frontend
**Severity:** HIGH  
**Blast radius:** Thread history display  
**Files:** `inboxData.ts`  
Backend API (`/cockpit/inbox/thread-messages`) normalizes and access-controls event history. Frontend reads raw events, gets unnormalized data, and may display messages from blocked/cancelled sends as if they were delivered.

---

### RISK-010 — Three auto-reply service paths can cause double-sends
**Severity:** HIGH  
**Blast radius:** Auto-reply threads  
**Files:** `queueAutoReply.js`, `execute-autonomous-reply.js`, `resolve-seller-auto-reply-plan.js`  
Multiple entry points for autonomous reply with no deduplication guard.

---

### RISK-011 — get_buyers_for_property RPC bypasses business logic
**Severity:** HIGH  
**Blast radius:** Buyer match display  
**Files:** `buyerMatchData.ts`, `/cockpit/buyer-match/property/[id]/candidates`  
API route applies DNC checks and score filters. Direct RPC call returns raw candidate list including DNC buyers.

---

### RISK-012 — phones/phone_numbers exposed to anon key
**Severity:** HIGH  
**Blast radius:** Sender infrastructure  
**Files:** `inboxData.ts`, `textgridRouting.ts`  
Active sending numbers, carrier data, and routing assignments accessible via browser. An attacker could map the SMS infrastructure.

---

### RISK-013 — CSS override chain depends on import order in InboxPage.tsx
**Severity:** HIGH  
**Blast radius:** Entire inbox UI  
**Files:** InboxPage.tsx, 13 inbox CSS files  
If any CSS file is imported in the wrong order (e.g., a developer adds an import above inbox-polish.css), visual overrides break silently with no error.

---

### RISK-014 — queue-ops.css and queue-premium.css produce context-dependent QueueCommandCenter appearance
**Severity:** HIGH  
**Blast radius:** Queue UI consistency  
**Files:** `modules/inbox/queue-ops.css`, `views/queue/queue-premium.css`  
Same component renders differently based on which route it's mounted under. Bugs reported from one view may not reproduce in another.

---

### RISK-015 — Thread state written from 3 separate service paths
**Severity:** HIGH  
**Blast radius:** Thread state integrity  
**Files:** cockpit-service, automation-actions, sms-engine  
No single writer for `inbox_thread_state`. Three services UPSERT directly with different field sets. Last-write-wins with no conflict detection.

---

### RISK-016 — Context loading uses 4 different implementations
**Severity:** HIGH  
**Blast radius:** Automation accuracy  
**Files:** load-context.js, load-context-with-fallback.js, thread-context-service.js, enrich-message-event-context.js  
Different automation paths load different amounts of context. An automation triggered via path A may have access to data that path B doesn't, producing inconsistent decisions for the same thread.

---

### RISK-017 — campaign-automation-service bypasses canonical outbound flow
**Severity:** HIGH  
**Blast radius:** Campaign sends  
**Files:** `campaign-automation-service.js`, `queue-outbound-message.js`  
Rate limiting, suppression ordering, and compliance checks in the canonical outbound flow may not be present in the campaign service path.

---

### RISK-018 — /cockpit/threads and /cockpit/inbox/threads are both production endpoints
**Severity:** HIGH  
**Blast radius:** Thread CORS  
**Files:** Both thread route groups  
CORS headers only on inbox namespace. API clients using the cockpit/threads route get silent CORS failures on cross-origin requests.

---

### RISK-019 — ai-command-center and autonomy-engine compute scores independently
**Severity:** HIGH  
**Blast radius:** AI-driven recommendations  
**Files:** `ai-command-center.ts`, `autonomy-engine.ts`  
Two scoring systems with no shared contract. A thread scored as low-risk in ai-command-center could be flagged high-risk in autonomy-engine aggregates if the scoring logic drifts.

---

### RISK-020 — Theme token defined in 4 places (nexus-theme, contract, light-premium, foundation)
**Severity:** HIGH  
**Blast radius:** Visual consistency across 13 themes  
**Files:** 4 CSS files  
When light-theme-premium overrides nexus-theme light tokens, any theme that derives from light (satellite, terrain) may inherit wrong values.

---

## MEDIUM RISKS

### RISK-021 — Workflow v1 routes still accessible (/cockpit/workflows/*)
**Severity:** MEDIUM — Migration path unclear

### RISK-022 — master_owners exposed to frontend (anon key)
**Severity:** MEDIUM — Seller contact data visible

### RISK-023 — textgridRouting.ts runs carrier routing logic client-side
**Severity:** MEDIUM — Routing decisions depend on phone data that should be backend-only

### RISK-024 — inbox-rebuild-v2.css partially overrides inbox-premium.css
**Severity:** MEDIUM — Only some components were refactored; patchwork visual output

### RISK-025 — No-reply and seller follow-up schedulers will drift
**Severity:** MEDIUM — Bug fixed in one must be manually replicated to the other

### RISK-026 — copilot.css and copilot-v2.css specificity race
**Severity:** MEDIUM — Copilot appearance unstable across mounting contexts

### RISK-027 — WorkflowStudioV2 accessible from 2 routes with different loaders
**Severity:** MEDIUM — Bookmarked v2 URL may behave differently from v1 URL

### RISK-028 — Migration history broken (per existing memory)
**Severity:** MEDIUM — 50% of tables never created in migration chain; prod state unknown

### RISK-029 — Reply validation logic split across discord context and queue context
**Severity:** MEDIUM — Compliance checks can diverge between Discord bot and queue runner

### RISK-030 — KPI views (14 performance views) exposed to anon key
**Severity:** MEDIUM — Business performance data accessible without auth

---

## LOW RISKS

### RISK-031 — realtime.ts manages subscriptions without central lifecycle
**Severity:** LOW — Subscription leaks possible on route unmount

### RISK-032 — gemini-service.ts (Google Gemini) in lib/underwriting/
**Severity:** LOW — Second AI provider dependency undocumented in main architecture

### RISK-033 — exec_sql RPC exists in production
**Severity:** LOW — Raw SQL execution RPC. If callable from a compromised internal route, full DB read/write.

### RISK-034 — dev/* routes exist in production app
**Severity:** LOW — `/api/dev/env-check`, `/api/dev/force-send`, `/api/dev/send-test` — development utilities in production codebase

---

## Risk Heatmap

```
                    LIKELIHOOD
                  Low    Medium    High
          ┌────────────────────────────┐
CRITICAL  │ R005   R007    R001,R003  │
          │ R008   R004    R002,R006  │
          ├────────────────────────────┤
HIGH      │ R019   R015,   R009,R010  │
          │ R020   R016    R012,R013  │
          │        R017    R014,R018  │
          │        R011               │
          ├────────────────────────────┤
MEDIUM    │ R027   R023    R022,R025  │
          │ R028   R024    R029,R030  │
          │        R026               │
          ├────────────────────────────┤
LOW       │ R031   R032    R033,R034  │
          └────────────────────────────┘
```

---

## Top 10 Immediate Actions

| Priority | Risk | Action |
|----------|------|--------|
| 1 | RISK-001 | Audit all frontend Supabase queries; add RLS policies or migrate to API routes |
| 2 | RISK-007 | Add `claim_queue_jobs` RPC gate to all send_queue INSERT paths |
| 3 | RISK-003 | Add idempotency key to `runSupabaseCandidateFeeder` to prevent double-queue |
| 4 | RISK-004 | Route all auto-reply sends through `send-now-service` safety checks |
| 5 | RISK-005 | Document and choose canonical workflow system; deprecate the other |
| 6 | RISK-006 | Add server-side suppression gate before any send_queue INSERT |
| 7 | RISK-002 | Choose single canonical send-now path; redirect others |
| 8 | RISK-010 | Add per-thread reply deduplication guard in send_queue |
| 9 | RISK-018 | Consolidate cockpit/threads into cockpit/inbox/threads |
| 10 | RISK-013 | Document and enforce CSS import order in InboxPage.tsx |
