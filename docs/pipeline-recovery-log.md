# Pipeline Recovery Log

## Phase 0 — Checkpoint

| Field | Value |
|-------|-------|
| Starting HEAD | `4dac4e2dba73296c1a4e6c5245ee3721b3854ff5` |
| Checkpoint commit | `eac11c6` (calendar WIP preserved) |
| Branch | `inbox-live-fix` |
| Workspace | `/Users/ryankindle/rei-automation-inbox-fix` |

### Component map

| Role | Current (pre-recovery) | Stable predecessor (`9410818`) |
|------|------------------------|--------------------------------|
| Entry | `InboxPage.tsx` → `PipelineWorkspace` | Same wiring at stable |
| Board | `PipelineOpportunityBoard.tsx` | `InboxPipelineView.tsx` (lane DnD, full-card `draggable`) |
| Data loader | `usePipelineOpportunities.ts` | Inline fetch in `InboxPipelineView` / early `PipelineWorkspace` |
| Drag-and-drop | Grip-only handle on `PipelineConfigurableCard` | Full `article[draggable]` in `KanbanCard` |
| Inspector | `PipelineCommandPanel` + `PipelineUniversalNav` | `SelectedDealPanel` in `InboxPipelineView` |
| Universal context | `syncPayloadFromOpportunity` / `onAnchorThread` | Same contract at `9410818` |
| Theme | `pipeline-view.css` | Same file, fewer overrides |
| Responsive | 25/50/75/100 layout modes | Same modes in `InboxPipelineView` |

## Phase 1 — Last stable Pipeline

| Field | Value |
|-------|-------|
| Stable commit | `9410818` — fix(pipeline): restore universal state contract and elite command UI |
| Stable files | `InboxPipelineView.tsx`, `PipelineOpportunityBoard.tsx` (early), `PipelineWorkspace.tsx` |
| Recovered behaviors | Full-card HTML5 drag, lane drop handlers, collapsible detail, horizontal board scroll, card click selection |
| Backend to retain | Acquisition opportunity engine (`e73f3db+`), canonical taxonomies, scope/metrics API, universal sync fixes (`68d0352`) |
| Regression commits | `b6f2932` (grip-only configurable cards), `4dac4e2` (Open In nav farm, slow list hydration) |

## Phase 2 — API crash

| Field | Value |
|-------|-------|
| Error | `Cannot find module './vendor-chunks/@supabase.js'` |
| Root cause | Stale `apps/api/.next` vendor chunks from interrupted/partial builds |
| Recovery | `rm -rf apps/api/.next && npm run build`; restart API on port 3000 |
| Proof | Repeated `/api/cockpit/pipeline/counts` returns JSON (401 without token), not filesystem stack |

## Canonical card grain

One card = one **acquisition opportunity** (`acquisition_opportunities.id`). Thread/property identifiers are universal context fields, not card identity.