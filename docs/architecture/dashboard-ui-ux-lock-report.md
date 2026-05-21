# PHASE 4.5B-0E — Clean Nexus Information Architecture

Date: 2026-05-20

## Final Workspace Menu Structure
Root:
- Pinned Workspaces
- Views
- Theme
- Accent Palette
- Manage

Pinned Workspaces:
1. Deal Desk — Inbox · Conversation · Deal Intelligence
2. Command Center — Status · Queue · Inbox · Incidents
3. Comping — Comps · Map · Offer Stack
4. Buyer Match Desk — Buyers · Deal Intelligence · Conversation
5. Pipeline Flow — Stages · Calendar · Tasks
6. Queue Control — Scheduled · Failed · Blocked
7. Market Command — Map · Markets · Routing
8. Closing Desk — Offers · Contracts · Title
9. Ops Monitor — Analytics · Activity · Alerts

## Final Views List
Only major layout views are in the Views submenu:
- Inbox
- Conversation
- Deal Intelligence
- Comp Intelligence
- Buyer Match
- Queue
- Pipeline
- Calendar
- Map
- Analytics
- Closing Desk

## Combined View Mapping
- Analytics now acts as parent view for:
  - Templates
  - Agents
  - Markets
  - Campaign analytics
  - Delivery analytics
  - Reply analytics
  - Opt-out analytics
  - Routing performance
- Comp Intelligence includes mapped section scaffolds for:
  - Comps
  - ARV
  - Repairs
  - Offer stack
  - Underwriting
  - Creative structure
- Closing Desk includes mapped section scaffolds for:
  - Offers
  - Contracts
  - Title
  - Escrow
  - Closing timeline
  - Signatures

## Top-Bar Global Menus Added/Reserved
Top-bar now includes or reserves slots for:
- Activity
- Notifications
- Tasks
- Settings
- Profile (avatar menu)

Tasks currently shows a safe "coming soon" notice and does not fake actions.
Settings routes to settings surface (or existing settings behavior) without fake success states.

## Active View Chip Behavior
- Active views are shown as compact chips in the top-bar.
- Clicking a chip removes/collapses that view.
- Guardrail implemented: if one view remains, removal is blocked and shows:
  - "At least one view must stay active."
- Views submenu checkmarks reflect active membership (not just primary view).
- Selecting a view from Views adds/focuses it.
- Active views are persisted per-workspace locally (`nx.inbox.workspace-views-by-key`).
- Reset Layout continues to restore layout defaults.

## Theme/Accent Safety
- No regression to theme/accent system.
- Theme and accent remain real, persisted, and globally visible.
- Map UI chrome remains connected to theme/accent tokens.
- Bottom strip fix remains in place.

## Files Changed

### `/Users/ryankindle/nexus-dashboard`
- `src/modules/inbox/active-context.ts`
- `src/modules/inbox/InboxPage.tsx`
- `src/modules/inbox/components/NexusTopBar.tsx`
- `src/modules/inbox/inbox-polish.css`

### `/Users/ryankindle/rei-automation/apps/dashboard`
- `src/modules/inbox/active-context.ts`
- `src/modules/inbox/InboxPage.tsx`
- `src/modules/inbox/components/NexusTopBar.tsx`
- `src/modules/inbox/inbox-polish.css`

## Build / Proof Results

### `/Users/ryankindle/nexus-dashboard`
- `npm run build` ✅ pass

### `/Users/ryankindle/rei-automation`
- `npm run build:dashboard` ✅ pass
- `npm run build:safe` ✅ pass
- `npm run boundary:audit` ✅ pass
- `node scripts/proof/dashboard-cockpit-wiring-proof.mjs` ✅ pass

## Remaining Blockers
- Some requested composite modules are currently scaffolded inside parent views (analytics/comp/closing) and still need full backend/data integration.
- Existing screenshot-based UI proofs that target old selectors may need selector updates for the new IA/menu structure.

## Phase 4.5B-0F — Nexus Top Bar + KPI Popover Cleanup

### Top Bar Structure Changes
- Reworked the header into compact OS-style left/center/right zones.
- Left: Nexus mark + `NEXUS / Dashboard`, KPI chip, compact workspace selector, and restored compact view-width control (`25%/50%/75%/100%`).
- Center: global search/command bar remains centered with `CMD+K` hint.
- Right: compact status pill, tasks menu, activity menu, notifications, and avatar-only profile trigger.
- Removed top-bar active view chips from global header.

### Active Views Location
- Active view chips are now shown inside Workspace > Views context (within workspace submenu), not in global header.
- Existing behavior retained: click chip removes view, one-view minimum guard remains, and views menu checkmarks still represent active state.

### Status Pill Behavior
- Replaced `LIVE` / warning combination with a single compact status pill.
- Pill label now resolves to `Validation Mode`, `Automation Off`, or `Queue On` based on queue command mode.
- Added compact status detail popover with explicit capability rows and a link to detailed queue panel.
- Where backend flags are not directly exposed, labels show safe derived state or `Unavailable` (no fake success).

### KPI Popover Improvements
- Reduced KPI popover width and enforced viewport-safe bounds (`max-height: 70vh`, internal scroll).
- Removed cutoff behavior by constraining size and tightening internal spacing.
- Added subtle accent-driven glow treatment during live updates via existing KPI live/update state classes.

### Tasks Dropdown Behavior
- Added compact Tasks dropdown menu:
  - Manual Review
  - Follow-ups
  - Failed Sends
  - Needs Decision
  - Closing Tasks
  - System Tasks
- Items intentionally show `Count unavailable` when counts are not wired.

### Profile Menu Cleanup
- Avatar trigger is now circle-only (`RK`) with no dropdown arrow.
- Moved settings-oriented entries into profile menu:
  - Profile
  - Settings
  - Workspace Settings
  - Theme Settings
  - Keyboard Shortcuts
  - Diagnostics
  - Sign Out (Not Ready)

### Responsive Notes
- Added top bar shell overrides for narrower breakpoints.
- Hidden lower-priority controls first on smaller widths (e.g., width selector at <=1024px).
- Workspace drawer fallback remains for compact screens.

### Files Changed (Phase 0F)

#### `/Users/ryankindle/nexus-dashboard`
- `src/modules/inbox/components/NexusTopBar.tsx`
- `src/modules/inbox/inbox-polish.css`

#### `/Users/ryankindle/rei-automation/apps/dashboard`
- `src/modules/inbox/components/NexusTopBar.tsx`
- `src/modules/inbox/inbox-polish.css`

### Build / Proof Results (Phase 0F)

#### `/Users/ryankindle/nexus-dashboard`
- `npm run build` ✅ pass

#### `/Users/ryankindle/rei-automation`
- `npm run build:dashboard` ✅ pass
- `npm run build:safe` ✅ pass
- `npm run boundary:audit` ✅ pass
- `node scripts/proof/dashboard-cockpit-wiring-proof.mjs` ✅ pass

## Phase 4.5B-0H — Minimal Icon-First Top Bar Correction

### Final Top Bar Structure
- Left brand remains: Nexus mark + `NEXUS` + `Dashboard`.
- Left control cluster is now icon-first:
  - KPI: icon + percentage value only (no `Opt-Out Rate` label in header).
  - Workspace: layout icon + compact label (auto-collapses by width) + caret.
  - Queue mode: processor icon + status dot + caret (no `Validation Mode`/`Queue Off` header text).
- Center search stays in a stable centered grid column.
- Right cluster is icon-only triggers: Tasks, Activity, Notifications, RK avatar.

### KPI Behavior
- Header KPI control now displays percentage-only value.
- Removed KPI label text from top bar.
- Border tone remains status-driven (`good/warning/critical`).
- Live micro-indicator is now compact and non-wordy (`•`) rather than `LIVE` text.
- KPI popover remains compact and viewport-aware from prior phase.

### Workspace Control Behavior
- Removed top-bar layout percentage control (including `75%`) from header.
- Layout percentage moved into `Workspace > Manage > Layout Size`.
- Workspace selector remains compact and icon-first; label truncates/hides at narrower widths.

### Queue Mode Control Behavior
- Replaced wordy status pill with icon/dot/caret control.
- Dot semantics:
  - healthy: green
  - warning: yellow
  - critical: red
  - unknown/off: gray
- Detailed state remains in dropdown (`Queue Processor`) with safety fields and statuses.

### Tasks / Activity / Profile Cleanup
- Tasks trigger is icon-only; dropdown keeps required task list without fake counts.
- Activity trigger is icon-only; dropdown includes open action plus clean empty-state note.
- Notifications remains bell-only with badge.
- Profile remains RK circle-only, no arrow.

### Command Bar Centering
- Top bar grid updated to fixed/minmax left-right clusters and a stable center column.
- Search bar remains visually centered while controls expand/collapse.

### Files Changed (Phase 0H)
- `/Users/ryankindle/nexus-dashboard/src/modules/inbox/components/NexusTopBar.tsx`
- `/Users/ryankindle/nexus-dashboard/src/modules/inbox/components/InboxKpiOrb.tsx`
- `/Users/ryankindle/nexus-dashboard/src/modules/inbox/inbox-polish.css`
- `/Users/ryankindle/rei-automation/apps/dashboard/src/modules/inbox/components/NexusTopBar.tsx`
- `/Users/ryankindle/rei-automation/apps/dashboard/src/modules/inbox/components/InboxKpiOrb.tsx`
- `/Users/ryankindle/rei-automation/apps/dashboard/src/modules/inbox/inbox-polish.css`

### Build / Proof Results (Phase 0H)
- `/Users/ryankindle/nexus-dashboard`: `npm run build` ✅
- `/Users/ryankindle/rei-automation`: `npm run build:dashboard` ✅
- `/Users/ryankindle/rei-automation`: `npm run build:safe` ✅
- `/Users/ryankindle/rei-automation`: `npm run boundary:audit` ✅
- `/Users/ryankindle/rei-automation`: `node scripts/proof/dashboard-cockpit-wiring-proof.mjs` ✅

## Phase 4.5C — Nexus Inbox View Lock-In

### Inbox Width Modes
- Implemented explicit mode mapping for Inbox rail by pane width:
  - `25%` -> `rail25`
  - `50%` -> `review50`
  - `75%` -> `ops75`
  - `100%` -> `full100`
- Mode is now passed from `InboxPage` into `InboxSidebar` (`inboxMode`) instead of stretching one layout.

### Removed Tabs Confirmation
- Removed top `Conversations` / `All Sellers` toggle row from Inbox sidebar header.
- Replaced with operational quick filters and saved-list actions.

### Quick Filters / Saved Lists
- Added quick filter chips:
  - New Replies
  - Needs Review
  - Hot Leads
  - Failed Sends
  - Follow-Up Due
  - Suppressed
  - All Messages
- Added `+ Save Current Filter` and `Manage Lists`.
- Local-only persistence for custom saved filters:
  - storage key: `nx.inbox.local-saved-filters.v1`
- If no saved filters exist, UI shows non-fake empty state (`Saved filters not ready.`).

### Advanced Filters Behavior
- Preserved advanced filters entry point and compacted header/filter controls for operational use.
- Search remains owner/address/phone/APN-focused (`Owner, address, phone, APN...`).
- 25% mode stays compact; larger modes surface additional controls without full-screen takeover.

### Category / List Spacing
- Reduced vertical spacing in queue/category groups and thread stacks for compact operational density.
- Category headers remain count-aligned with active highlighting and expand/collapse behavior intact.

### Message Card / Row Behavior
- Added selectable checkboxes directly on conversation cards.
- Compact mode now trims badge count (2 max) to preserve message preview readability.
- Core priorities remain visible: seller, address, preview, time, stage/status signals.

### Bulk Selection + Actions
- Added multi-select state in Inbox sidebar (`bulkSelectedIds`).
- Added sticky bulk toolbar when one or more conversations are selected.
- Bulk actions shown:
  - Mark Reviewed
  - Change Status
  - Change Stage
  - Schedule Follow-Up
  - Schedule Message
  - Archive
  - Flag Hot
  - Mark Not Interested
  - Suppress
  - Assign Tag
- Backend safety: actions currently report `BACKEND_ENDPOINT_NOT_READY` (no fake success, no direct Supabase mutation).

### 75% / 100% KPI/hero suppression
- In `ops75` and `full100`, sidebar hero/KPI strip is hidden to keep message operations above fold.

### Files Changed (Phase 4.5C)
- `/Users/ryankindle/nexus-dashboard/src/modules/inbox/components/InboxSidebar.tsx`
- `/Users/ryankindle/nexus-dashboard/src/modules/inbox/InboxPage.tsx`
- `/Users/ryankindle/nexus-dashboard/src/modules/inbox/inbox-polish.css`
- `/Users/ryankindle/rei-automation/apps/dashboard/src/modules/inbox/components/InboxSidebar.tsx`
- `/Users/ryankindle/rei-automation/apps/dashboard/src/modules/inbox/InboxPage.tsx`
- `/Users/ryankindle/rei-automation/apps/dashboard/src/modules/inbox/inbox-polish.css`

### Build / Proof Results (Phase 4.5C)
- `/Users/ryankindle/nexus-dashboard`: `npm run build` ✅
- `/Users/ryankindle/rei-automation`: `npm run build:dashboard` ✅
- `/Users/ryankindle/rei-automation`: `npm run build:safe` ✅
- `/Users/ryankindle/rei-automation`: `npm run boundary:audit` ✅
- `/Users/ryankindle/rei-automation`: `node scripts/proof/dashboard-cockpit-wiring-proof.mjs` ✅

### Remaining Blockers
- Bulk actions are UI-safe placeholders until backend endpoints are explicitly wired for batch operations.
- Saved lists are local-only in this phase by design (no cloud persistence).
