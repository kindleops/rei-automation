# Canonical Shared Contracts (post-integration)

Reconciliation pass after Slices A–D on `integration/canonical-20260622`.

| Contract | Canonical file | Deprecated / adapter | Remaining callers | Migration | Tests |
| --- | --- | --- | --- | --- | --- |
| Universal entity context | `apps/dashboard/src/domain/entity-graph/universal-entity-context.ts` + `universal-entity-context-store.ts` | Legacy inbox-only selection in `active-context.ts` (adapter) | Pipeline, Inbox, Entity Graph, Map | Stash universal-sync deltas verified identical or older than base; no second store added | Pipeline universal-context proofs |
| Canonical property resolver (API) | `apps/api/src/lib/domain/comp-intelligence/canonical-subject-property.js` | None active | Comp routes, Buyer Match engine, subject route | Buyer Match stash resolver excluded; engine imports comp-intelligence module | `comp-intelligence-coordinate-resolver.test.mjs`, `buyer-match-production-lock.test.mjs` |
| Coordinate resolver (API) | `apps/api/src/lib/domain/comp-intelligence/coordinate-resolver.js` | Market fallback only when unresolved | `canonical-subject-property.js`, comp discovery | Slice A restore from `7dc7a3f` | `comp-intelligence-coordinate-resolver.test.mjs` |
| Coordinate resolver (Dashboard) | `apps/dashboard/src/domain/comp-intelligence/coordinate-resolver.ts` | None | `canonical-property/resolver.ts`, `useCompIntelligence.ts` | Dashboard resolver delegates to coordinate-resolver; not a second algorithm | Comp Intelligence UI build + coordinate tests |
| Canonical property (Dashboard) | `apps/dashboard/src/domain/canonical-property/resolver.ts` | Direct field reads in workspaces | Comp Intelligence, Buyer Match prefetch | Added in campaign dashboard coherence commit; consumes coordinate-resolver | Dashboard typecheck/build |
| Backend API client | `apps/dashboard/src/lib/api/backendClient.ts` | None | All cockpit views | Base version preserved from `da5340b` with TS fixes from `55aebc6` | Dev runtime doctor JSON probes |
| Operator error sanitizer (API) | `apps/api/src/lib/intel/buyer-match-api-errors.js` | Raw `error.message` in routes | Buyer Match intel routes | Ported from stash `1b9b734^3` | `buyer-match-production-lock.test.mjs` |
| Queue writer | `apps/api/src/lib/domain/queue/canonical-queue-writer.js` | Direct `send_queue.insert` (forbidden) | SMS engine enqueue path | `55aebc6` deletion **not** ported; base writer retained | `send-queue-canonical-writer.test.mjs` |
| Template language adapter | `apps/api/src/lib/domain/templates/template-language-adapter.js` | English fallback paths | Template selector, acquisition routing | Base `b972cd1` ancestry preserved | `acquisition-template-routing-correction.test.mjs` |
| Template runtime resolver | `apps/api/src/lib/domain/templates/template-runtime-resolver.js` | Legacy Podio-only resolver | Outbound feeder, auto-reply | Base version retained | Template routing + outbound tests |
| Outbound retry contract | `apps/api/src/lib/domain/outbound/outbound-retry-contract.js` | Superseded 21610 retry loops | SMS engine finalize path | Base `b972cd1` preserved | `outbound-production-incident-repair.test.mjs` |
| Campaign readiness engine | `apps/api/src/lib/domain/campaigns/campaign-operator-state.js` | Proof-row live counting | Campaign Command routes | Ported from `55aebc6` without queue-writer regression | `campaign-command-summary.test.mjs`, `risk-017-campaign-gate.test.mjs` |
| Theme token system | `apps/dashboard/src/styles/nexus-theme-contract.css` + `nx-ui-foundation-final.css` | Ad-hoc per-view CSS overrides | Shell, Inbox, Pipeline | Stash theme CSS reconciled; shell-primitives import restored in `main.tsx` | Manual theme smoke (Dark/Light/Red Ops) |
| Shell surface manager | `apps/dashboard/src/modules/shell/useShellSurface.ts` | None | NexusTopBar, Workspace Launcher | `55aebc6` dashboard shell baseline + stash KPI/theme deltas | Shell load smoke |
| Workflow Studio routing | `apps/dashboard/src/views/workflow-studio/v2/workflow-studio-routing.ts` | `WorkflowStudio` legacy embed in Inbox | Routes, Inbox workspace | Inbox now hard-wires V2; legacy alias `/workflow-studio-v1` retained | `workflow-studio-v2-routing-contract.test.mjs` |
| Cockpit workflow envelopes | `apps/api/src/app/api/cockpit/_shared.js` (`workflowSuccess` / `workflowError`) | Per-route duplicate envelopes | Workflow cockpit routes | Restored after accidental pipeline-slice deletion (`f4f374d`) | `workflow-studio-v2-routing-contract.test.mjs` |
| Outbound feeder test injection | `load-supabase-outbound-candidates.js`, `supabase-candidate-feeder.js` (`deps.*` hooks) | None | `risk-017-campaign-gate.test.mjs` | Hooks restored from `55aebc6` for deterministic campaign gate proofs | `risk-017-campaign-gate.test.mjs` |

## Explicit exclusions

- Self-storage acquisition (`d3cc075`, `selfStorageStrategies.js`, migrations, UI) — deferred to post-canonical feature integration.
- Wholesale application of preservation stashes `1b9b734` and `dfd12558`.
- Cherry-pick of entire divergent branches.