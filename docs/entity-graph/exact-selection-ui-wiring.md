# Exact-property selection: UI wiring (for the Entity Graph RC owner)

The backend and the selection model are done and tested on this branch. The desktop wiring is deliberately left to the RC owner, because `EntityGraphTableView` is under active RC changes. Nothing on this branch queues, launches or sends.

## What exists

| Piece | Where |
|---|---|
| Read-only preview endpoint | `POST /api/cockpit/campaigns/preview-selection` → `apps/api/src/app/api/cockpit/campaigns/preview-selection/route.js` |
| Classification / integrity | `apps/api/src/lib/domain/campaigns/campaign-exact-selection.js` (reuses `resolveCampaignTargetReadiness` from the campaign automation service) |
| Selection model (pure) | `apps/dashboard/src/domain/entity-graph/entity-graph-selection.ts` |
| Client | `previewCampaignSelection()` in `apps/dashboard/src/lib/api/backendClient.ts` |
| Tests | `apps/api/tests/critical/campaign-exact-selection.test.mjs` (incl. the South Florida acceptance case), `entity-graph-selection.node.test.ts` |

## Preview contract

- **Request:** `{ property_ids: string[], cohort_confirmation?: { confirmed_count: number } }`, at most 5,000 ids.
- **Response:** `results[]` holds exactly one outcome per requested id:

  | `status` | `reason` |
  |---|---|
  | `included` | — |
  | `excluded` | the readiness block reason |
  | `held` | `active_queue_item` or `pending_prior_touch` |
  | `duplicate` | `same_recipient_as:<property_id>` |
  | `unresolved` | `not_in_campaign_graph` or `missing_phone` |

  It also returns `counts`, `target_filter`, `dry_run: true` and `no_send_queue_rows_created: true`.
- **Fails closed:**
  - any row outside the selection → `ok:false, error:'rows_outside_selection'`;
  - a cohort count that changed → 409 `cohort_count_changed`;
  - a graph read error → `campaign_graph_unavailable`.
- Vendor DNC is reported as an advisory with `unknown` preserved, never as `false`.

## Wiring steps

1. **State.**
   - Hold one `EntityGraphSelection` in the Entity Graph page.
   - Hydrate it with `loadSelection(sessionStorage)` and persist it with `saveSelection` on change.
   - It survives pagination and filter changes on purpose. Never clear it on a filter change.
2. **Table** (`EntityGraphTableView`).
   - Add a leading checkbox column bound to `isSelected` / `toggleRow`.
   - The header checkbox selects the visible page only, via `addRows(pageRows)`.
3. **Bulk bar.**
   - Shows "N selected", plus Clear, Remove, "Select all M matching" and Preview.
4. **Whole cohort.**
   - "Select all M matching" first shows a confirmation naming the exact count M and the active filters.
   - On confirm, fetch the full id list for the current filter and call `addConfirmedCohort({ cohortKey, cohortIds, confirmedCount: M })`.
   - If it throws `cohort_count_changed`, add nothing and show the new count.
5. **Preview panel.**
   - Call `previewCampaignSelection(toPreviewSelectionPayload(selection))`.
   - Render five groups (included / excluded / held / duplicate / unresolved), with each row's reason.
   - Show `outside_selection_count` (it must be 0).
6. **Draft.**
   - Pass `toCampaignTargetFilter(selection)` (`properties.property_id in [...]`) into the existing campaign-draft path. `checkExplicitTargetContainment` already refuses anything wider.
   - The selection must be identical in preview and draft. Re-preview if it changed.
   - No queue, launch or send control in this flow.

## Acceptance

Select 520 NW 17th Ave (227990249), 376 NW 80th St (232476849) and 3101 NW 66th St (232481638), across separate searches. The preview must contain exactly those three, before eligibility exclusions, with `outside_selection_count: 0`.
