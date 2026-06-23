# Ownership Rules — REI Automation Platform

**Audit Date:** 2026-06-13  
**Status:** Recommended guardrails based on architectural audit  
**Enforcement:** Code review gate; document in CLAUDE.md and PR templates

---

## Core Principle

Every system has exactly one owner. The owner is the single source of truth for that system's state, API, and behavior. All other code consumes the owner's interface — it never bypasses it.

---

## 1. Inbox

**Owner:** `lib/domain/inbox/` + `/cockpit/inbox/*` API routes

**Rules:**
- Thread state is READ and WRITTEN exclusively through `lib/domain/inbox/` services
- `patchThreadStateSafe()` in cockpit-service is the only allowed write path for operator state changes
- `send-now-service.js` is the only allowed INSERT path into `send_queue` for manual inbox sends
- Autonomous replies MUST call `send-now-service.js` — no direct `send_queue` INSERTs from autonomous paths
- No code outside `lib/domain/inbox/` reads `inbox_thread_state` directly from Supabase

**Forbidden:**
- `execute-autonomous-reply.js` writing to `send_queue` without going through `send-now-service`
- `internal/inbox/send-now` and `internal/outbound/send-now` — both must be deprecated in favor of `/cockpit/inbox/send-now`
- Frontend reading `message_events` directly (use `/cockpit/inbox/thread-messages`)

---

## 2. Send Queue

**Owner:** `lib/domain/queue/` — specifically `build-send-queue-item.js` + `validate-send-queue-item.js` + `run-send-queue.js`

**Rules:**
- All `send_queue` INSERTs MUST go through `build-send-queue-item.js` + `validate-send-queue-item.js`
- All queue processing MUST go through `run-send-queue.js` (not `sms-engine.js` directly)
- `sms-engine.js` is a low-level primitive — its public interface is one function: `insertSupabaseSendQueueRow()`
- The `claim_queue_jobs` RPC MUST be called atomically before any status mutation
- Frontend MUST NOT write to `send_queue` (read-only if at all; prefer API)

**Forbidden:**
- `campaign-automation-service.js` inserting into `send_queue` directly (must use queue domain layer)
- `queueAutoReply.js` inserting without going through `send-now-service`
- Duplicate run routes: choose `/internal/queue/run` as canonical cron target; `/cockpit/queue/run` for UI triggers

---

## 3. Campaigns

**Owner:** `lib/domain/campaigns/` + `/cockpit/campaigns/*` API routes

**Rules:**
- Campaign state transitions MUST go through `campaign-state-machine.js`
- Campaign execution MUST acquire lock via `campaign_acquire_execution_lock` RPC before any batch insert
- Campaign targets are the output of `build-targets` route — no other code should compute campaign targets ad hoc
- `/internal/campaigns/rebuild-target-graph` is the only cron path for graph refresh

**Forbidden:**
- Triggering `runSupabaseCandidateFeeder()` from both `/cockpit/queue/auto-enqueue` and `/internal/outbound/auto-enqueue` — pick one

---

## 4. Workflow

**Owner:** `/cockpit/workflows/*` API routes + `lib/domain/workflows/workflow-v2/` services

**Rules:**
- v2 (`workflow_definitions`) is the canonical system
- v1 (`workflows` table, workflow-service) is deprecated — no new code should write to it
- WorkflowStudioV2 frontend MUST call `/cockpit/workflows/*` exclusively
- The `/workflows/*` route namespace (legacy v2 API) must be merged into `/cockpit/workflows/*` or documented as an internal-only alias

**Forbidden:**
- New workflow logic in `workflow-service.js` (v1)
- Frontend calling `/workflows/*` routes

---

## 5. Automations

**Owner:** `lib/domain/automation/` + `lib/automation/` (to be merged into one location)

**Rules:**
- `automation-engine.js` is the single entry point for all automation rule evaluation
- `automation-actions.js` is the single executor for automation action dispatch
- Auto-reply is dispatched ONLY through `execute-autonomous-reply.js` → `send-now-service.js`
- `queueAutoReply.js` should be deprecated and its logic merged into `execute-autonomous-reply.js`

**Forbidden:**
- Direct `send_queue` INSERTs from `automation-actions.js` (must go through send-now-service)

---

## 6. Theme

**Owner:** `styles/nexus-theme.css`

**Rules:**
- All `--nx-*` CSS custom properties are defined ONLY in `nexus-theme.css`
- `nexus-theme-contract.css` is read-only and defines NO new tokens — only documents the contract
- `light-theme-premium.css` must be merged into the `[data-nexus-theme="light"]` block in `nexus-theme.css` and then deleted
- `nx-ui-foundation-final.css` must NOT redefine `--nx-*` tokens — only consume them
- Theme selection is set ONLY in `CommandCenterApp.tsx` via `setAttribute('data-nexus-theme', ...)`

**Forbidden:**
- Any new `--nx-*` token defined outside `nexus-theme.css`
- CSS files that hardcode color values instead of consuming `--nx-*` vars

---

## 7. Notifications

**Owner:** `modules/inbox/notification-hud.css` + `NexusNotificationCenter.tsx`

**Rules:**
- Toast rendering is done exclusively through `NexusNotificationCenter`
- `nx-glass-system.css` defines the glass container primitives; `notification-hud.css` applies them to toasts
- No other component should create toast-like elements with position:fixed

**Forbidden:**
- Components rendering their own notification UI outside the notification center

---

## 8. Command System

**Owner:** `modules/command-center/` → `GlobalCommandOverlay.tsx` + `useGlobalCommandSearch.ts`

**Rules:**
- App-level commands go through the Global Command system (⌘K)
- Inbox-scoped commands (thread actions) go through `InboxCommandPalette.tsx`
- The two systems must NOT share state directly — `useInboxTopSearch.ts` is the allowed bridge and must remain read-only
- New command providers are added to `modules/command-center/providers/`

**Forbidden:**
- Route-level components creating their own command palette

---

## 9. Topbar

**Owner:** `modules/inbox/NexusTopBar.tsx` + `inbox-premium.css` (topbar section)

**Rules:**
- NexusTopBar is the single topbar component for the entire app
- Topbar styles live in the topbar section of `inbox-premium.css`
- No other component renders a top-of-screen navigation bar

---

## 10. Dropdowns / Menus

**Owner:** `styles/nx-glass-system.css` (`.nx-liquid-*` primitives)

**Rules:**
- All dropdowns, context menus, and popovers use `.nx-liquid-menu` or `.nx-liquid-popover` primitives
- No component defines its own dropdown background, border, or shadow
- New menu variants extend the `nx-liquid-*` class set in `nx-glass-system.css`

---

## 11. Supabase Access

**Owner:** Backend API (`apps/api/src/`) is the single Supabase access layer

**Rules:**
- Frontend accesses ALL data through API routes (`/cockpit/*` namespace)
- Frontend Supabase client (`supabaseClient.ts`) is allowed ONLY for:
  - Realtime subscriptions (subscribe to changes, not read data)
  - Auth state management
- All current `supabase.from()` calls in `apps/dashboard/src/lib/data/` must be migrated to API fetch calls
- Frontend RPC calls (`get_buyers_for_property`, `get_command_map_seller_pins`, `get_comp_candidates_for_subject`) must be moved to API routes

**Forbidden:**
- Frontend calling `supabase.from('send_queue')`, `supabase.from('message_events')`, or any table with PII or operational data
- Frontend calling `.rpc()` directly

---

## 12. API Namespace

**Owner definition:**

| Namespace | Owner | Purpose |
|-----------|-------|---------|
| `/cockpit/*` | Frontend UI | Only routes called by `apps/dashboard` |
| `/internal/*` | Automation/cron | Only routes called by crons, background jobs, internal services |
| `/webhooks/*` | External services | Only called by TextGrid, Brevo, DocuSign, Podio |
| `/workflows/*` | DEPRECATED | Migrate all callers to `/cockpit/workflows/*` |
| `/dev/*` | Dev only | Gate behind `NODE_ENV !== 'production'` |

**Rules:**
- No frontend code calls `/internal/*` routes
- No cron calls `/cockpit/*` routes
- Auth middleware must enforce namespace access (ensureMutationAuth on cockpit, requireCronOrEngineAuth on internal)

---

## 13. Inbox CSS

**Owner:** `modules/inbox/inbox-premium.css` is the primary authority

**Import order (InboxPage.tsx — MUST be maintained):**
```
1. index.css              (global resets)
2. nexus-theme.css        (theme tokens)
3. nx-glass-system.css    (glass primitives)
4. nx-ui-foundation-final.css (UI base)
5. inbox-premium.css      (inbox primary)
6. inbox-universal.css    (shared utilities)
7. inbox-polish.css       (final overrides — LAST)
```

**Rules:**
- `inbox-rebuild-v2.css` must be merged into `inbox-premium.css` and deleted
- New inbox styles go into `inbox-premium.css`, not new files
- Queue styles within inbox module: `queue-ops.css` is canonical; `queue-premium.css` in views/ must be deprecated

---

## 14. Context Loading

**Owner:** `lib/domain/context/load-context-with-fallback.js` (most complete implementation)

**Rules:**
- New code always calls `loadContextWithFallback()` — never `loadContext()`, `thread-context-service`, or `enrich-message-event-context` directly
- The three other implementations are migration targets — they should call `loadContextWithFallback` internally until deleted

---

## 15. Follow-Up Scheduling

**Owner:** One unified service (currently split — needs creation)

**Recommended:** Create `lib/domain/queue/schedule-followup.js` that:
- Accepts: `{ threadKey, delayMs, templateId, contextType }`
- Validates suppression, compliance, feature flags
- INSERTs scheduled `send_queue` row

Both `no-reply-followup-scheduler.js` and `seller-followup-scheduler.js` should call this instead of direct `send_queue` INSERT.
