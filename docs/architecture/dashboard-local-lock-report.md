# Dashboard Local Lock Report (Phase 4.5)

Date: 2026-05-20
Scope: `/Users/ryankindle/rei-automation/apps/dashboard`

## Local Run Status
- Attempted `npm --workspace apps/dashboard run dev` on default port 5173: blocked because port already in use.
- Started dashboard locally on alternate port: `npm --workspace apps/dashboard run dev -- --port 4173`.

## Pages Audited
- Home / Cockpit Overview: `/`
- Inbox: `/inbox`
- Queue: `/queue`
- Pipeline: Inbox embedded pipeline workspace (`InboxPipelineView`)
- List: Inbox list/table workspace (`InboxConversationTable`)
- Map / Command Map: Inbox map workspace (`InboxCommandMap`), plus `/acquisition/map`
- Settings: `/settings`
- Command Center / Command Palette: global command overlay + inbox command palette

## View-by-View Findings

### 1) Home / Cockpit Overview
- Data source:
  - `loadHome()` in `src/modules/home/home.adapter.ts`
  - Supabase read model when available via `fetchHomeDashboardSnapshot()`
  - static fallback model when unavailable
- Loading state: route-level loading handled by `CommandCenterApp` route loader state.
- Empty state: widget library empty state exists.
- Error state: adapter catches errors and falls back; route-level error UI exists.
- Backend/supabase path:
  - read-only Supabase + static fallback
  - no backend mutation calls
- Actions:
  - UI/navigation/layout actions work locally
  - no queue/sms mutation paths here
- Fake success:
  - none identified
- Safe fix applied:
  - static health label changed from `Queue Runner: Live` to `Queue Runner: Guarded` to avoid implying live automation.

### 2) Inbox
- Data source:
  - inbox model from `src/lib/data/inboxData.ts` and `src/lib/data/inboxWorkflowData.ts`
  - read-heavy Supabase selectors for threads/messages/context
  - backend mutations via `backendClient`
- Loading state: explicit loading spinners/skeleton state in `InboxPage`.
- Empty state: thread/table/map empty states present.
- Error state:
  - notification surface on failures
  - `liveFetchError` propagated to UI components
- Backend/supabase path:
  - mutations: backendClient cockpit endpoints
  - reads: Supabase read-only + live inbox fetch
- Actions status:
  - working (backend-routed): queue reply, send now, schedule reply, auto-reply queue, approve/cancel/retry/hold/reschedule/retry-routing, thread-state patch
  - intentionally blocked/stubbed: queue run/safe batch/reconcile/cancel-stale/retry-failed bulk commands show `BACKEND_ENDPOINT_NOT_READY`
- Fake success:
  - no fake success path found by proof script
- Safe fixes applied:
  - removed old internal live inbox fetch endpoint usage.
  - `fetchLiveInbox()` now calls `${VITE_BACKEND_API_URL}/api/cockpit/inbox/live` and normalizes cockpit envelope (`diagnostics`).

### 3) Queue
- Data source:
  - `loadQueue()` in `src/modules/queue/queue.adapter.ts`
  - prefers `fetchQueueModel()` read data
  - falls back to generated mock queue model if read fails
- Loading state: explicit loading spinner
- Empty state: explicit empty rows/cards/messages
- Error state: toast notifications on fetch/action failure
- Backend/supabase path:
  - read-only Supabase for queue listing
  - queue actions through backendClient cockpit endpoints
- Actions status:
  - item-level actions backend-routed and error surfaced
  - no direct dashboard mutation writes
- Fake success:
  - no fake success path identified
- Safe fix applied:
  - stale env constant alignment in queue model (`VITE_BACKEND_API_URL` used for proxy mode indicator).

### 4) Pipeline (Inbox Workspace)
- Data source: same inbox source model; derived workflow state.
- Loading/empty/error: inherited from inbox page model and components.
- Mutations: routed through backendClient thread/queue actions only.
- Status: operational for cockpit display; relies on backend readiness for mutation effects.

### 5) List (Inbox Workspace)
- Data source: inbox thread list from normalized inbox model.
- Loading/empty/error: present in table/list UI.
- Mutations: via inbox workflow actions (backendClient).
- Status: operational for cockpit read + operator actions.

### 6) Map / Command Map
- Data source:
  - inbox command map data loaders and read-only aggregation feeds
  - live map enrichment via read paths
- Loading/empty/error: base style loading pill, map empty/filtered-empty messaging.
- Mutations: no direct map mutation path.
- Status: operational for display and filtering.

### 7) Settings
- Data source: local browser settings store.
- Loading/empty/error: minimal; safe fallback behavior around speech voices.
- Mutations: local settings only; no backend writes.
- Status: operational.

### 8) Command Center / Command Palette
- Data source: route/context command registries and local command providers.
- Loading/empty/error: command search empty-state present.
- Mutations: command execution dispatches existing app actions; no direct DB writes.
- Status: operational.

## Working
- Dashboard compiles and serves locally.
- Inbox/Queue action wiring is locked to backendClient cockpit actions.
- Error surfaces are visible for backend failures.
- Boundary audit and dashboard wiring proof pass.

## Broken / Risky
- Live dashboard fetch path still depends on legacy read endpoint model parity:
  - `src/modules/dashboard/live/live-dashboard.fetcher.ts` calls `/api/internal/dashboard/nexus` (read-only, legacy endpoint name).
  - This is not a cockpit endpoint and should be replaced by backend parity endpoint in a later API phase.

## Intentionally Disabled
- Queue command-center bulk ops in inbox are intentionally blocked with `BACKEND_ENDPOINT_NOT_READY` when no parity endpoint exists.
- No dashboard direct mutation fallback is present.

## Backend Endpoints Required
Currently wired cockpit endpoints:
- `GET /api/cockpit/health`
- `GET /api/cockpit/queue/status`
- `GET /api/cockpit/inbox/live`
- `POST /api/cockpit/queue/approve`
- `POST /api/cockpit/queue/cancel`
- `POST /api/cockpit/queue/retry`
- `POST /api/cockpit/queue/hold`
- `POST /api/cockpit/queue/reschedule`
- `POST /api/cockpit/queue/retry-routing`
- `POST /api/cockpit/inbox/queue-reply`
- `POST /api/cockpit/inbox/send-now`
- `POST /api/cockpit/inbox/schedule-reply`
- `POST /api/cockpit/inbox/auto-reply`
- `PATCH /api/cockpit/inbox/thread-state`

Still needed for full parity (current UI features):
- A cockpit replacement for legacy live dashboard dataset endpoint (currently `/api/internal/dashboard/nexus`, read-only).
- Cockpit replacements for advanced underwriting/copilot reads now using `/api/internal/offers/underwrite` in inbox intelligence/copilot views.

## UI Bugs
- None critical introduced by cockpit lock changes.
- Default dev port conflict (5173 already in use) requires alternate port locally.

## Data Mapping Bugs / Risks
- Live dashboard expects a specific model envelope; if backend response diverges, it degrades to mock model.
- Inbox thread normalization still includes broad fallback derivation for display identifiers; operational writes remain backend-routed.

## Actions That Must Remain Blocked
- Any direct dashboard mutation to `send_queue`, `message_events`, `inbox_thread_state`.
- Queue live/bulk operational endpoints without explicit cockpit parity.
- SMS send logic, classification logic, template rendering logic in dashboard runtime.
