---
name: project-queue-hardening
description: Queue/Outbound Command Center audit and full rebuild — safety fixes, hydration, alert spam, 21610, UI
metadata:
  type: project
---

Queue subsystem fully audited and patched (2026-06-12). All 8 phases completed.

**Why:** Queue Inspector showed "Unknown seller" + "Missing owner"; health permanently Critical; 21610 blacklisted phones not suppressed for future rows; createRows defaulted to opt-in; scheduled count inflated by unknown DB statuses.

**How to apply:** Reference these root-cause findings if queue issues resurface.

## Root causes fixed

| Issue | File | Fix |
|-------|------|-----|
| createRows defaults to TRUE | campaign-automation-service.js:6061 | Flipped to `=== true` (explicit opt-in) |
| Unknown seller / Missing owner | fetchQueueModel.ts | Re-enabled ownerRes + evtRes fetches; added targetSnapshot to hydration chain |
| Scheduled count inflated | fetchQueueModel.ts:toQueueStatus | Fallback changed from 'scheduled' to 'blocked'; added duplicate_blocked/incident_quarantine/expired |
| Alert render-loop spam | NexusNotificationCenter.tsx | Health-status notifications changed from 'unread' to 'read' |
| 21610 doesn't cancel future rows | sms-engine.js + process-send-queue.js | Added cancelBlacklistedPhoneQueueRows(); called from is_blacklist_error branch |

## Architecture

- **Core insert fn:** `insertSupabaseSendQueueRow()` in sms-engine.js — all 8 write paths funnel here
- **21610 cancellation:** `cancelBlacklistedPhoneQueueRows()` in sms-engine.js cancels scheduled/queued/ready rows for the to_phone_number
- **Hydration:** fetchQueueModel.ts re-enables ownerRes (master_owners) and evtRes (message_events) with chunked queries; also checks metadata.target_snapshot
- **New types:** QueueItemStatus gained duplicate_blocked, incident_quarantine, expired
- **UI:** QueuePage.tsx rebuilt as Outbound Command Center (.occ-* CSS namespace in queue-premium.css)

## New OCC layout

Top → KPI strip (Scheduled/Queued/Sending/Delivered/Sent/Failed/Blocked/Opt-Outs, clickable filters)
Middle → ops table (left 65%) + Hero Inspector (right 35%)
Bottom → accordion: Failure Taxonomy + Market Load + Recent Events
