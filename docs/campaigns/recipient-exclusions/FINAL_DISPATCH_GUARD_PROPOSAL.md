# Final-dispatch guard: proposal for sending-safety review

> **Status:** proposal only. `process-send-queue.js` is **not** edited on this branch. The sending-safety owners must review, decide the open questions below, and implement it. Until then this PR stays blocked from merging.

## Why it is needed
This branch's hooks keep excluded recipients out of **target build** and **queue planning**. A row that was already queued before an exclusion was added is still dispatchable. The final guard closes that gap at send time.

## Anchors at `91b4f873` (Entity Graph 8.5.0, `release/cloudflare-production`)
- `apps/api/src/lib/domain/queue/process-send-queue.js:2333`: `const sms_health_guard = evaluateSmsHealthGuard({`. The guard goes immediately before this line.
- `:573`: `blockQueueRowBySmsHealthGuard`. The new helpers go next to it.
- `:1510`: `const manual_inbox_send = isManualInboxSend(queue_row)`. Manual inbox sends are not affected.

## Proposed change (verbatim)

```text
PROPOSED (NOT APPLIED) — final-dispatch campaign recipient exclusion guard
File: apps/api/src/lib/domain/queue/process-send-queue.js
Owner review: 8.4.7 sending-safety owners. The send path was not edited from this session (code-edit safety boundary).

1) Imports (with the other domain imports):

  import {
    loadCampaignRecipientExclusions,
    isRecipientExcluded,
  } from "@/lib/domain/campaigns/campaign-recipient-exclusions.js";

2) Helpers (next to blockQueueRowBySmsHealthGuard):

  async function blockQueueRowByCampaignExclusion(queue_row, deps = {}) {
    const now = new Date().toISOString();
    await getSupabase(deps).from(QUEUE_TABLE).update({
      queue_status: "blocked",                      // terminal (TERMINAL_QUEUE_OUTCOMES)
      guard_status: "blocked",
      guard_reason: "campaign_recipient_excluded",
      failed_reason: "campaign_recipient_excluded",
      is_locked: false, locked_at: null, lock_token: null, updated_at: now,
      metadata: { ...(queue_row.metadata ?? {}), skip_reason: "campaign_recipient_excluded",
        final_queue_status: "blocked", blocked_by: "campaign_recipient_exclusion",
        blocked_at: now, finalized_at: now },
    }).eq("id", queue_row.id);
    return { ok: false, skipped: true, reason: "campaign_recipient_excluded",
      queue_status: "blocked", final_queue_status: "blocked", queue_row_id: queue_row.id, queue_item_id: queue_row.id };
  }

  async function holdQueueRowForExclusionLookup(queue_row, error_code, deps = {}) {
    const now = new Date().toISOString();
    await getSupabase(deps).from(QUEUE_TABLE).update({
      queue_status: "held",                         // non-terminal, cancellable; nothing is sent
      guard_status: "blocked",
      guard_reason: error_code,
      is_locked: false, locked_at: null, lock_token: null, updated_at: now,
      metadata: { ...(queue_row.metadata ?? {}), skip_reason: error_code,
        held_by: "campaign_recipient_exclusion_lookup", held_at: now },
    }).eq("id", queue_row.id);
    return { ok: false, skipped: true, reason: error_code, queue_status: "held",
      queue_row_id: queue_row.id, queue_item_id: queue_row.id };
  }

3) Guard, immediately BEFORE `const sms_health_guard = evaluateSmsHealthGuard({`:

  if (!manual_inbox_send) {
    const exclusion_campaign_id = queue_row.campaign_id || queue_row.metadata?.campaign_id || null;
    if (exclusion_campaign_id) {
      const exclusion_read = await loadCampaignRecipientExclusions(getSupabase(deps), exclusion_campaign_id);
      if (!exclusion_read.ok) {
        warn("queue.campaign_exclusion_lookup_failed", { queue_row_id, campaign_id: exclusion_campaign_id, error: exclusion_read.error });
        return holdQueueRowForExclusionLookup({ ...queue_row, id: queue_row_id }, exclusion_read.error, deps);
      }
      if (isRecipientExcluded(exclusion_read.phones, queue_row)) {
        warn("queue.campaign_recipient_excluded", { queue_row_id, campaign_id: exclusion_campaign_id });
        return blockQueueRowByCampaignExclusion({ ...queue_row, id: queue_row_id }, deps);
      }
    }
  }

Tests to add (tests/critical/campaign-recipient-exclusion-dispatch.test.mjs):
  a) campaign row + active exclusion for the phone  -> status 'blocked', transport never called
  b) exclusion lookup error / unreadable rows      -> status 'held', transport never called
  c) empty exclusion set                           -> unaffected (normal path continues)
  d) row without campaign_id, and manual inbox rows -> unaffected
  e) exclusion on campaign A, row for campaign B   -> unaffected
  f) retry after 'held' with a healthy lookup      -> proceeds normally

Owner decisions:
  - Is 'held' the right recoverable state in the 8.4.7 dispatcher (and who/what releases it)?
  - Placement relative to assertDispatchAuthorization / claim (recommend: after claim+authorization, before transport, as above).
  - Release order: migration first, then campaign-service hooks, then this guard (otherwise lookups fail closed and block builds/plans/sends).
```

## Required release order (no step without separate authorization)
1. Review and approve the migration. CI proof is green: `campaign-exclusions-db-proof`.
2. Apply the migration. **This needs separate authorization.**
3. Verify the table, constraints, grants and RLS in production (read-only).
4. Deploy the build/plan hooks **and** this dispatch guard **together**. The hooks fail closed if the table is missing, which would block **every** campaign's build and queue plan.
5. Verify end to end with no exclusion rows: no change in behaviour.
6. Only then request approval for the first exclusion (Erika Rivers, Miami Test).
