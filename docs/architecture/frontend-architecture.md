# Frontend Architecture — REI Automation Dashboard

**Audit Date:** 2026-06-13  
**App:** `apps/dashboard` (Vite + React + TypeScript)  
**Deployment Target:** ops.leadcommand.ai

---

## A. Route Graph

```mermaid
graph TD
    App["App.tsx\n(AuthProvider + RequireAuth)"]
    CCA["CommandCenterApp.tsx\n(Master Orchestrator)"]
    Router["router.ts\n(History API)"]
    Routes["routes.tsx\n(15 primary routes)"]

    App --> CCA
    CCA --> Router
    Router --> Routes

    Routes --> V_INBOX["/ → InboxView"]
    Routes --> V_CONV["/:thread_key → ConversationView"]
    Routes --> V_MAP["/map → InboxCommandMap"]
    Routes --> V_QUEUE["/queue → QueueView"]
    Routes --> V_PIPELINE["/pipeline → PipelineView"]
    Routes --> V_ANALYTICS["/analytics → KpiIntelligencePage"]
    Routes --> V_CALENDAR["/calendar → CalendarView"]
    Routes --> V_CAMPAIGN["/campaign-command → CampaignsPage"]
    Routes --> V_EMAIL["/email-command → EmailCommandCenter"]
    Routes --> V_WORKFLOW["/workflow-studio → WorkflowStudioV2"]
    Routes --> V_WORKFLOW2["/workflow-studio/v2 → WorkflowStudioV2"]
    Routes --> V_BUYER["/buyer-match → BuyerMatchView"]
    Routes --> V_INTEL["/deal-intelligence → PropertyIntelligenceApp"]
    Routes --> V_COMP["/comp-intelligence → InboxView variant"]
    Routes --> V_CLOSING["/closing-desk → ClosingDeskView"]

    CCA --> THEME["Theme System\n(13 modes)"]
    CCA --> CMDPAL["⌘K GlobalCommandOverlay"]
    CCA --> COPILOT["⌘J CopilotShell"]
    CCA --> BRIEFING["⌘. Briefing Panel"]
    CCA --> NAV["Single-key nav\n(I/C/D/O/B/Q/P/L/M/A/K/G/E/W)"]
```

---

## B. Component Dependency Graph

### Inbox (`/`)

```mermaid
graph TD
    InboxView --> InboxPage
    InboxPage --> NexusTopBar
    InboxPage --> InboxSidebar
    InboxPage --> InboxConversationTable
    InboxPage --> ChatThread
    InboxPage --> InboxKpiDashboard
    InboxPage --> QueueCommandCenter
    InboxPage --> BuyerMatchWorkspace
    InboxPage --> InboxActivityPanel
    InboxPage --> MetricsWarRoom
    InboxPage --> NexusNotificationCenter
    InboxPage --> InboxCommandPalette
    InboxPage --> InboxSchedulePanel
    InboxPage --> InboxUtilityDrawer
    InboxPage --> CommandView

    InboxConversationTable --> InboxThreadRow
    InboxConversationTable --> InboxStatusTabs
    InboxConversationTable --> AdvancedFiltersPopover
    InboxConversationTable --> InboxThreadActions

    ChatThread --> Composer
    Composer --> TemplatePicker
    Composer --> ComposerTranslationBar
    Composer --> TemplatePopover

    InboxSidebar --> InboxStatusTabs

    InboxActivityPanel --> ActivityFeedCard
    InboxActivityPanel --> ActivityTimeline
    ActivityTimeline --> ActivityTimelineGroup
    ActivityTimeline --> ActivityEventRow
    ActivityEventRow --> ActivityEventDetails

    QueueCommandCenter --> QueueHealthPanel
    QueueCommandCenter --> QueueFailureTaxonomy
    QueueCommandCenter --> QueueRowInspector
    QueueCommandCenter --> QueueActionsBar
    QueueCommandCenter --> QueuePipelineBar
    QueueCommandCenter --> RecentQueueEvents
    QueueCommandCenter --> MarketLoadPanel
    QueueCommandCenter --> RoutingCoveragePanel
    QueueCommandCenter --> TemplateCoveragePanel
    QueueCommandCenter --> SenderNumberHealthPanel

    InboxPage -.->|"ai-command-center.ts\n(13 intel scores)"| AIC["ThreadCommandIntel"]
    InboxPage -.->|"autonomy-engine.ts\n(market model)"| AUE["AutonomousEngineModel"]
    InboxPage -.->|"inbox-store.ts\n(reducer)"| STORE["InboxState"]
```

### Queue (`/queue`)

```mermaid
graph TD
    QueueView --> SendQueueDashboard
    SendQueueDashboard --> QueueHealthPanel
    SendQueueDashboard --> QueueFailureTaxonomy
    SendQueueDashboard --> QueueActionsBar
    SendQueueDashboard --> MarketLoadPanel
    SendQueueDashboard --> RoutingCoveragePanel
    SendQueueDashboard --> TemplateCoveragePanel
    SendQueueDashboard --> SenderNumberHealthPanel
    SendQueueDashboard --> RecentQueueEvents

    QueueView -.->|"queueData.ts"| API_QUEUE["/cockpit/queue/*"]
```

### Campaign Command (`/campaign-command`)

```mermaid
graph TD
    CampaignsPage --> CampaignList
    CampaignsPage --> CampaignBuilder
    CampaignsPage --> CampaignPacingControls
    CampaignsPage -.->|"fetchQueueModel.ts"| API_CAMP["/cockpit/campaigns/*"]
```

### Workflow Studio (`/workflow-studio`)

```mermaid
graph TD
    WorkflowStudioV2 --> WorkflowCanvas
    WorkflowStudioV2 --> WorkflowSidebar
    WorkflowStudioV2 --> WorkflowCommandPalette
    WorkflowStudioV2 --> WorkflowHealthPanel
    WorkflowStudioV2 --> WorkflowSimulation
    WorkflowStudioV2 -.->|API| API_WF["/cockpit/workflows/*"]
```

### Map (`/map`)

```mermaid
graph TD
    InboxCommandMap --> MapLibreCanvas
    InboxCommandMap --> SellerIntelligenceCard
    InboxCommandMap --> MapIntelligenceCards
    InboxCommandMap -.->|"commandMapData.ts"| API_MAP["/internal/dashboard/ops/map"]
    InboxCommandMap -.->|"rpc: get_command_map_seller_pins"| SUPABASE_DIRECT["Supabase Direct\n⚠️ Frontend RPC"]
```

---

## C. CSS Ownership Graph

### Inbox Surface

```mermaid
graph LR
    InboxPage --> IP1["inbox-premium.css\n(PRIMARY: layout, threads,\nsidebar, topbar, compose)"]
    InboxPage --> IP2["inbox-rebuild-v2.css\n(v2 refactor overrides)"]
    InboxPage --> IP3["inbox-universal.css\n(shared utilities)"]
    InboxPage --> IP4["inbox-density-25.css\n(compact mode)"]
    InboxPage --> IP5["inbox-polish.css\n(refinement pass)"]

    InboxKpiDashboard --> KPI["kpi-dashboard.css"]
    MetricsWarRoom --> MWR["metrics-war-room.css"]
    ChatThread --> CR["conversation-redesign.css"]
    QueueCommandCenter --> QO["queue-ops.css\n(module-level)"]
    SendQueueDashboard --> SQD["send-queue-dashboard.css"]
    SendQueueDashboard --> QP["queue-premium.css\n⚠️ views/queue/ DUPLICATE"]
    NexusNotificationCenter --> NH["notification-hud.css"]
    BuyerMatchWorkspace --> BMW["buyer-match-workspace.css"]
    AICopilotPanel --> CP["copilot.css"]
```

**Ownership conflict:** `queue-ops.css` (modules/inbox/) AND `queue-premium.css` (views/queue/) both style queue surfaces.

### Global / Theme Surface

```mermaid
graph LR
    HTML["html[data-nexus-theme]"] --> NT["nexus-theme.css\n(PRIMARY: all --nx-* vars,\n13 theme palettes)"]
    HTML --> NTC["nexus-theme-contract.css\n(fallbacks)"]
    HTML --> LTP["light-theme-premium.css\n(light overrides)"]
    HTML --> NGS["nx-glass-system.css\n(glass morphism,\nmenus, modals, toasts)"]
    HTML --> NUF["nx-ui-foundation-final.css\n(buttons, inputs, cards)"]
    HTML --> MR["mobile-responsive.css\n(breakpoints)"]
```

### Command Palette

```mermaid
graph LR
    GlobalCommandOverlay --> GCC["global-command.css\n(search, results, kb hints)"]
    InboxCommandPalette -.-> IP1_REF["inbox-premium.css\n(inherits palette styles)"]
```

### Copilot

```mermaid
graph LR
    CopilotShell --> CPV2["copilot-v2.css\n(MODULE: copilot-v2)"]
    AICopilotPanel --> CPM["copilot.css\n(MODULE: inbox)"]
```

**Ownership conflict:** `copilot.css` (inbox module) AND `copilot-v2.css` (copilot module) both style copilot surfaces.

### Override Load Order in InboxPage.tsx

```
index.css
→ nexus-theme.css
→ nx-glass-system.css
→ nx-ui-foundation-final.css
→ inbox-premium.css
→ inbox-rebuild-v2.css
→ inbox-universal.css
→ inbox-polish.css           ← last import = final authority
```

---

## D. Theme Graph

```mermaid
graph TD
    THEME_SRC["nexusThemes.ts\n(src/domain/theme/)"]
    THEME_CSS["nexus-theme.css\n(src/styles/)"]
    THEME_CONTRACT["nexus-theme-contract.css"]
    LIGHT["light-theme-premium.css"]

    THEME_SRC -->|"13 theme definitions"| CCA2["CommandCenterApp\nsetAttribute('data-nexus-theme', theme)"]
    THEME_CSS -->|"--nx-* vars"| CONSUMERS

    CCA2 -->|"html[data-nexus-theme=X]"| THEME_CSS
    CCA2 -->|"#nx-inbox-root[data-nexus-theme=X]"| INBOX_THEME["Inbox-scoped theme\n(can differ from global)"]

    CONSUMERS --> InboxPage2["InboxPage (inherits all)"]
    CONSUMERS --> NexusTopBar2["NexusTopBar (inherits all)"]
    CONSUMERS --> NGS2["nx-glass-system.css (glass tokens)"]
    CONSUMERS --> NUF2["nx-ui-foundation-final.css (UI tokens)"]

    THEME_CSS --> T1["dark"]
    THEME_CSS --> T2["light"]
    THEME_CSS --> T3["satellite"]
    THEME_CSS --> T4["terrain"]
    THEME_CSS --> T5["matrix"]
    THEME_CSS --> T6["blueprint"]
    THEME_CSS --> T7["red_ops"]
    THEME_CSS --> T8["night_vision"]
    THEME_CSS --> T9["dark-matter"]
    THEME_CSS --> T10["tactical-blue"]
    THEME_CSS --> T11["carbon-gold"]
    THEME_CSS --> T12["arctic-signal"]
    THEME_CSS --> T13["operator-black / monochrome-ops"]
```

**Duplicate theme ownership:**
- `nexus-theme.css` defines all `--nx-*` tokens
- `nexus-theme-contract.css` redefines fallbacks for the same tokens
- `light-theme-premium.css` overrides light-mode tokens a third time
- `nx-ui-foundation-final.css` also sets baseline accent/menu tokens

---

## E. State Management Systems

| System | Location | Type | Scope |
|--------|----------|------|-------|
| **inbox-store** | `modules/inbox/inbox-store.ts` | Redux-like reducer | Inbox thread/message state |
| **watchlistContext** | `lib/watchlistContext.tsx` | React Context | Watchlist persistence |
| **commandStore** | `data/commandStore.ts` | Static catalog | Command palette items (not reactive) |

No global state manager (no Zustand, no Redux). State is colocated per module.

---

## F. File Counts

| Category | Count |
|----------|-------|
| Views | 16 |
| Modules | 5 (inbox, command-center, copilot, core, properties) |
| CSS files (total) | 37 |
| CSS files targeting inbox | 13 |
| Domain files | 21 |
| Lib/data files | 49 |
| Total dashboard source files | ~420 |
