# VIEW RECOVERY MATRIX

## Hard Rules
- No CSS redesign today
- No Liquid Glass today
- No unrelated refactors
- No WIP merges into main
- One view at a time
- Build after every patch

## P1 Workflow Studio
Status: Real UI exists. Standalone route exists. Inbox workspace registry missing.
Files:
- InboxPage.tsx
- NexusTopBar.tsx
- WorkflowStudio.tsx
- workflowStudio.adapter.ts

Goal:
- Workflow opens inside Inbox workspace
- /workflows route still works
- API unavailable/schema not ready does not make UI look broken

## P2 Metrics
Status: MetricsWarRoom exists but placeholder grid pollutes view.
Goal:
- MetricsWarRoom primary
- Placeholder cards removed/hidden

## P3 Buyer Match
Status: Real embedded workspace exists. Standalone route also exists.
Goal:
- Embedded Buyer Match is launch-critical
- Standalone Buyer page is P2

## P4 Comp Intelligence
Status: Real embedded workspace exists. Context dependent.
Goal:
- Strong empty state when no selected property/thread exists

## P5 Production Guardrails
Goal:
- Inbox works
- Queue works
- Workflow works
- Buyer Match works
- Comp Intelligence works
- No-send guards intact
