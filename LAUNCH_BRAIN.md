# LAUNCH_BRAIN.md — AGENT OPERATING LAW & STABILIZATION CONTRACT

## 1. GOLDEN RULE
No agent may modify code until it states:
- current branch
- task lane
- allowed files
- forbidden files
- proof plan

## 2. TASK LANES
Define lanes:
- **ROUTING_VIEW_RESTORE**
  - Allowed: `routes.tsx`, `App.tsx`, entry point files.
  - Forbidden: Data adapters, backend API, CSS.
- **CSS_UI_ONLY**
  - Allowed: Imported CSS files, UI components.
  - Forbidden: Data adapters, backend routing, business logic.
- **DATA_ADAPTER_ONLY**
  - Allowed: `*.adapter.ts`, context files, frontend data layers.
  - Forbidden: UI view files (`*.tsx`), CSS files, backend core.
- **BACKEND_API_ONLY**
  - Allowed: Backend routes, controllers, DB queries.
  - Forbidden: UI view files, frontend CSS, frontend routing.
- **INBOX_CONTRACT_ONLY**
  - Allowed: Inbox specific types, `inbox.adapter.ts`.
  - Forbidden: UI layers, CSS.
- **PROOF_ONLY**
  - Allowed: Test files, scripts, markdown docs.
  - Forbidden: App code, CSS, data logic.

## 3. VIEW RESTORE CHECKLIST
For every view, track the following:

- **Inbox**
  - Active Component: `InboxPage.tsx`
  - Route/View Key: `/inbox`
  - Status: Stable
  - Recovery Source Branch: `integration/launch-baseline` (to be verified)
  - Proof Required: Component mounts, data hydrates, inbox items render.

- **Conversations**
  - Active Component: `ChatThread.tsx` / `Composer.tsx`
  - Route/View Key: Nested under inbox or `/sms_thread`
  - Status: Needs Verification
  - Recovery Source Branch: TBD
  - Proof Required: Messages display, composer allows typing.

- **Deal Intelligence**
  - Active Component: `IntelligencePanel.tsx`
  - Route/View Key: `deal_intelligence`
  - Status: Needs Verification
  - Recovery Source Branch: TBD
  - Proof Required: Displays property & seller info properly normalized.

- **Campaign Command**
  - Active Component: `InboxCampaignView.tsx` / `CampaignsPage.tsx`
  - Route/View Key: `/campaigns`
  - Status: Needs Verification
  - Recovery Source Branch: TBD
  - Proof Required: Campaign data renders, dispatch functions accessible.

- **Buyer Match**
  - Active Component: `BuyerMatchWorkspace.tsx` / `BuyerIntelPage.tsx`
  - Route/View Key: `/buyer`
  - Status: Potential route/render issue
  - Recovery Source Branch: TBD
  - Proof Required: Component renders without overriding split-view context.

- **Comp Intelligence**
  - Active Component: `CompIntelligenceWorkspace.tsx`
  - Route/View Key: `comp_intelligence` (Missing standalone route)
  - Status: Missing Route
  - Recovery Source Branch: TBD
  - Proof Required: Accessible via route or active workspace tab.

- **KPI / Analytics**
  - Active Component: `MetricsWarRoom.tsx` / `KpiIntelligencePage.tsx`
  - Route/View Key: `/dashboard/kpis`
  - Status: Discrepancy between embedded and standalone
  - Recovery Source Branch: TBD
  - Proof Required: Consistent KPI numbers display.

- **Workflow Studio**
  - Active Component: `WorkflowStudio.tsx`
  - Route/View Key: `/workflows`
  - Status: Missing backend hydration/hookup
  - Recovery Source Branch: TBD
  - Proof Required: Renders with data payload.

- **Queue**
  - Active Component: `SendQueueDashboard.tsx` / `QueuePage.tsx`
  - Route/View Key: `/queue`
  - Status: Stable (to be verified)
  - Recovery Source Branch: TBD
  - Proof Required: Queue items load and display correct statuses.

- **Map**
  - Active Component: `InboxCommandMap.tsx` / `AcquisitionMapApp.tsx`
  - Route/View Key: `command_map`
  - Status: Stable (to be verified)
  - Recovery Source Branch: TBD
  - Proof Required: Map pins render, glass CSS applies correctly.

## 4. CSS LAW
- CSS edits must go only into imported CSS files.
- Agents must prove the CSS file is imported before editing.
- Orphaned CSS may not be edited unless first imported intentionally.
- No new glass CSS systems.
- If liquid glass exists in map CSS, reference/reuse that style pattern instead of inventing a new one.

## 5. DATA LAW
- Backend payload can change only through data adapters.
- UI components must not be rewritten to chase payload shape.
- Deal Intelligence must use one normalized view model.
- Property is truth.
- Master owner attaches to property.
- Prospects attach to master owner.
- Phones attach to prospect.
- No duplicate property threads.

## 6. GIT LAW
- No giant mixed commits.
- One task lane per commit.
- Commit message must include lane.
- Never merge WIP directly to main.
- Main receives only proven integration commits.
- `.claude/` must never be committed.

## 7. PROOF LAW
For every fix:
- build proof (e.g. `npm run build`, `tsc`)
- browser proof if UI (verify rendering, layout logs)
- curl/API proof if backend/data (verify hydration)
- route proof if routing (verify navigation)
- grep/import proof if CSS (verify file is imported)
- no-touch confirmation for forbidden layers

## 8. Current Known Problem
`integration/launch-baseline` contains newer local work, but multiple views are old/missing because latest versions likely live across restore branches. Do not rebuild views until branch/source comparison is done.

---

## 9. Branch & Baseline
- **Current Active Branch:** `integration/launch-baseline`
- **Baseline Commit:** `b66fe53aef1b5aa86209d1158e3dbd4806db544d`

## 10. Launch Objective
- Stabilize the Launch Baseline, specifically auditing the View Inventory and stabilizing Property-Centric Inbox Intelligence without regressions.

## 11. Active Dashboard Entrypoint
- `src/app/CommandCenterApp.tsx`

## 12. Active Route Registry
- `src/app/routes.tsx`

## 13. Active Inbox Page/Component Tree
- **Page:** `src/modules/inbox/InboxPage.tsx`
- **Component Tree (Primary Overlays & Views):**
  - `NexusTopBar`
  - `InboxSidebar`
  - `InboxConversationTable`
  - `ChatThread`
  - `Composer`
  - `IntelligencePanel`
  - `CompIntelligenceWorkspace`
  - `BuyerMatchWorkspace`
  - `SendQueueDashboard`
  - `InboxPipelineView`
  - `InboxCalendarView`
  - `MetricsWarRoom`

## 14. Active Topbar/Menu Component
- `NexusTopBar` (in `src/modules/inbox/components/NexusTopBar.tsx`)
- Navigation definitions and global bindings in `src/app/CommandCenterApp.tsx`.

## 15. Active CSS Import Order
Global imports inside `src/main.tsx`:
1. `index.css`
2. `nexus-theme.css`
3. `dossier.css`
4. `home-v2.css`
5. `command-store.css`
6. `acquisition.css`
7. `styles/mobile-responsive.css`
8. `styles/light-theme-premium.css`

Inbox module imports inside `src/modules/inbox/InboxPage.tsx`:
1. `inbox-universal.css`
2. `inbox-premium.css`
3. `inbox-rebuild.css`
4. `inbox-rebuild-v2.css`
5. `inbox-polish.css`
6. `inbox-density-25.css`
7. `buyer-intel-upgrade.css`
8. `copilot/copilot.css`
9. `conversation-redesign.css`

## 16. CSS Authority Files
- `inbox-rebuild-v2.css`
- `inbox-polish.css`
- `conversation-redesign.css`
- `inbox-density-25.css`
- `inbox-premium.css`

## 17. Orphaned/Dead CSS Files (DO NOT EDIT)
- `inbox-premium.css.bak`
- `acquisition-cockpit.css`
- `notification-hud.css`
- `kpi-intelligence.css`
- `nexus-map-pins.css`

## 18. Active Inbox Data Adapter Files
- `src/modules/inbox/inbox.adapter.ts`
- `src/lib/data/inboxWorkflowData.ts`
- `src/lib/data/inboxData.ts`

## 19. Active Backend Inbox Routes
Endpoints in `src/lib/api/backendClient.ts`:
- `/api/cockpit/inbox/live` (Live Inbox)
- `/api/cockpit/inbox/counts` (Inbox Counts)
- `/api/cockpit/inbox/thread-messages` (Thread Message Hydration)
- `/api/cockpit/inbox/thread-dossier` (Thread Intelligence Hydration)
- `/api/cockpit/inbox/threads/:key` (State Mutations)
- Action endpoints: `queue-reply`, `send-now`, `schedule-reply`, `auto-reply`

## 20. Active Thread Hydration Route/Service
- `getThreadMessagesForThread` and `getThreadIntelligence` mapped inside `src/lib/data/inboxData.ts`.

## 21. Deal Intelligence Data/Render Contract
- **Data Contract:** `src/lib/data/dealContext.ts`
- **Render Contract:** `src/modules/inbox/components/IntelligencePanel.tsx`

## 22. Property-Centric Thread Identity Contract
- Uses `mergeSelectedThreadAndDealContext` in `InboxPage.tsx` to deduplicate and merge context by matching `property_id`, `prospect_id`, and exact coordinates.

## 23. Workflow Studio
- **Files:** `src/modules/workflows/WorkflowStudio.tsx`
- **Issue:** The `/workflows` route is defined in `routes.tsx` and linked via bindings, but lacks backend hydration and proper UX hookup.

## 24. Buyer Match
- **Files:** `src/modules/inbox/components/BuyerMatchWorkspace.tsx` and `src/modules/buyer/BuyerIntelPage.tsx`
- **Issue:** May conflict with layout rendering logic or override split-view contexts unexpectedly.

## 25. Comp Intelligence
- **Files:** `src/modules/inbox/components/CompIntelligenceWorkspace.tsx`
- **Issue:** Missing an isolated top-level route in the registry (`routes.tsx`); relies entirely on being rendered inside the inbox workspace.

## 26. KPI/Analytics
- **Files:** `src/modules/inbox/components/MetricsWarRoom.tsx` and `src/modules/kpis/KpiIntelligencePage.tsx`
- **Issue:** Discrepancy between embedded inbox metrics rendering and standalone route rendering.
