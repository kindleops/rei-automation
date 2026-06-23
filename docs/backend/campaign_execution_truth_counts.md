# Campaign execution truth — Miami Test Campaign count reconciliation

Campaign ID: `320c798a-84c9-45b8-a7c9-d166ddd7bd46`

## Why the UI showed 1,000 / 879 / 855 / 24 / 0 queued

| UI label | Shown | Database truth | Root cause |
|----------|-------|----------------|------------|
| Targets built | 1,000 | 1,000 `campaign_targets` rows | `buildCampaignTargets` capped graph pull at `CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT` (1000); event logged `inserted: 1000` |
| Total targets | 879 | 1000 | `getCampaign` previously loaded targets with `.limit(500)`; `mapCampaignSummary` counted only loaded rows (~879 after partial fetch) |
| Ready | 855 | 976 ready (+ other statuses) | Same 500-row partial load; ready counted from incomplete snapshot |
| Scheduled | 24 | 24 `target_status=planned` | `planned` maps to `scheduled_targets` in summary — this count was accidentally correct |
| Canonical queued | 0 | 0 active `send_queue` | Prior hydration wrote rows then they moved to `expired`; `queued_count` excludes expired statuses |
| Queue hydration % | 0% | `hydration_cursor.inserted=24` | Cursor from schedule/queue-plan pass; not synced to `campaigns.queued_count` |

## Code paths (post-fix)

- **True totals**: `fetchCampaignTargetStatusCounts` aggregates all `campaign_targets` without row download caps.
- **Recipient vs property**: `computeCampaignRecipientMetrics` + `collapseGraphRowsToRecipients` separate graph property matches from deduplicated recipients.
- **Targets tab**: `GET /api/cockpit/campaigns/:id/targets` paginates with `total_count` from exact count query.
- **Launch readiness**: `evaluateCampaignLaunchReadiness` probes canonical `renderOutboundTemplate`; blocked when `template_required`.
- **Activation**: `runCanonicalCampaignActivation` shared by Activate Now and `/api/internal/campaigns/activate-due` cron (`*/5 * * * *`).
- **Non-send proof**: `no_send: true` + `hydrate_canonical_queue` inserts canonical `send_queue` rows with `sms_eligible=false` / `metadata.no_send=true` — processor skips via `shouldRunSendQueueRow`.