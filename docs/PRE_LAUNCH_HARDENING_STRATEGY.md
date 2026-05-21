# Pre-Launch Hardening Strategy

**Date:** 2026-05-21
**Objective:** Execute the PRE-LAUNCH HARDENING phase for the acquisition operating system, focusing on operational stability, routing integrity, automation safety, observability, queue integrity, fail-safe behavior, and production readiness. No UI redesigns, no random features, and no massive architectural refactors.

## 1. Global Safety Guards
**Goal:** Add hard protections everywhere.
- **Duplicate Send Prevention:** Implement strong deduplication logic in `send_queue` and runner.
- **DNC / Opt-Out / Wrong-Number / Dead Lead Suppression:** Enforce strict suppression list checks before any send.
- **Prior-Contact Cooldown:** Implement a time-based cooldown (e.g., 24h/48h) between outbounds to the same owner.
- **Routing Enforcement:** Ensure no cross-state routing unless explicitly whitelisted (local routing).
- **Queue Protections:** Add concurrency limits, stuck row detection, and retry loop prevention in `queue/runner.ts`.

## 2. Message Safety
**Goal:** Validate before every outbound send.
- Ensure `runner.ts` and dispatch mechanisms strictly validate: phone exists, `sms_eligible=true`, no active DNC/Opt-Out, valid local TextGrid route, non-empty rendered message, correct language.
- Implement explicit logging for any validation failure (prevent sending).

## 3. Auto-Reply Safety
**Goal:** Prevent dangerous auto-replies.
- **Hard Inbound Gating:** Suppress replies to STOP/DNC, wrong numbers, and angry/legal threats.
- **Loop Prevention:** Implement AI loop detection and cooldown windows.
- **Confidence Thresholds:** Require high classification confidence to auto-reply or progress stage; fallback to human review otherwise.

## 4. Observability / Debugging
**Goal:** Elite production visibility.
- **Metrics Tracking:** Add comprehensive logging for live queue, outbound/inbound delivery, errors, retries, duplicates, and suppressions.
- **Stage Tracking:** Monitor positive, negotiating, contract, hot leads, and auto-reply triggers.

## 5. Live Ops Panel
**Goal:** Operational status indicators.
- Create or update the `Ops Panel` in the Command Center to show health statuses (LIVE, HEALTHY, DEGRADED, PAUSED, ERROR, RATE LIMITED, DISCONNECTED) for: Feeder, Queue Runner, Auto Reply, Webhooks, TextGrid, Supabase, Podio, AI Classification.

## 6. Failure Recovery
**Goal:** Robust recovery tools.
- **Replay Tools:** Implement UI or CLI tools for queue replay, webhook replay, and retry reconciliation.
- **Dead-Letter Queue:** Establish logic for stuck rows and orphan recovery (e.g., fixing the 7 orphaned rows mentioned in Blocker 1).

## 7. Performance Hardening
**Goal:** Prevent lag and memory leaks.
- **Frontend Optimization:** Apply virtualization, memoization, batched updates, and smart polling intervals to the Command Map and Inbox to prevent rerender storms and giant payloads.

## 8. Map Hardening
**Goal:** Fix map bugs permanently.
- Resolve styling/switching, overlay blocking, resize invalidation bugs.
- Optimize pin persistence and clustering performance; eliminate dead black regions.

## 9. Database / State Validation
**Goal:** Validate critical mappings.
- Enforce relational integrity across `property_id`, `prospect_id`, `owner_id`, `phone_id`, `message_event_id`, `queue_id`, `textgrid_number_id`.
- Prevent mixed IDs, orphan references, duplicate relations, and stale cached state.

## 10. AI Safety + Memory
**Goal:** Intelligent, context-aware AI interactions.
- Implement memory summaries, seller profile caching, and state snapshots.
- Ensure the AI respects the seller's stage and negotiation posture, preventing hallucinatory context and fake empathy.

## 11. Pre-Launch Checklist
**Goal:** Final verification before scaling.
- Create automated test scripts (or use existing `scripts/proof/`) to verify queue health, webhooks, duplicate prevention, routing, delivery, map stability, suppressions, and retry safety.

## 12. Execution Plan
1. **Fix Existing Blockers (Immediate):** Address Blocker 1 (Orphaned Rows / runner.ts schema mismatch), Blocker 3, and missing `inbox_activity_events` table as per `PRODUCTION_SMS_LAUNCH_CHECKLIST.md`.
2. **Implement Safety Guards & Message Validation:** Update the API and database triggers.
3. **Enhance Observability & Live Ops Panel:** Update logging and the Command Center UI strictly for ops metrics.
4. **Harden Frontend & Map:** Apply React/Mapbox performance best practices.
5. **AI & Auto-Reply Tuning:** Refine the classification prompts and routing thresholds.
6. **Final Validation:** Run the comprehensive proofing checklist.
