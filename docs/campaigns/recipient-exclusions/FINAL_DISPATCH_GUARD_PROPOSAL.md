# Final-dispatch exclusion check: proposal for sending-safety review

> **Status:** proposal only. No send-path file is edited on this branch, and this PR stays draft / DO NOT MERGE until the review below is complete, the migration is separately authorized and applied, and build/plan hooks plus this check ship together.

## Revision (2026-10-09): fold into the existing P0 send-time guard
8.5.0 already has the final send-time check: `runSendTimeContactGuard`, added in `send-time-contact-guard.js` and wired in `7dce1e2a`.
- `evaluateAndBlockSendAtCompliance` (`block-send-at-compliance.js`) runs it for **every** send that reaches transport: both `process-send-queue` paths and Send Now.
- **Its conventions:**
  - a block → `blockSendAtCompliance` (row `cancelled`, terminal, no transport);
  - a read error → `send_time_guard_read_failed` → `deferSendAtGuard` (claim released, status kept, re-evaluated next run; never sent).

The earlier draft of this proposal added a separate check before `evaluateSmsHealthGuard`, with its own `blocked` / `held` statuses. **That draft is withdrawn.** A second, differently behaving final check would duplicate the P0 guard. The exclusion becomes one more fact and one more reason inside the existing guard.

## Proposed change (in `apps/api/src/lib/domain/queue/send-time-contact-guard.js`)

```js
// SEND_TIME_GUARD_REASONS
CAMPAIGN_RECIPIENT_EXCLUDED: "campaign_recipient_excluded",
// REASON_CODE
[R.CAMPAIGN_RECIPIENT_EXCLUDED]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,

// evaluateSendTimeContactGuard — before "6. already contacted":
// campaign-scoped, exact campaign + exact phone; applies to every row of that campaign (openers and follow-ups)
const campaign_id = clean(row.campaign_id)
if (campaign_id) {
  for (const x of facts.campaign_exclusions || []) {
    if (x.is_active === false) continue
    if (clean(x.campaign_id) !== campaign_id) continue
    if (!same(x.phone_e164)) continue
    return block(R.CAMPAIGN_RECIPIENT_EXCLUDED, { scope: "campaign_recipient" })
  }
}

// loadSendTimeContactFacts — only for rows that carry a campaign_id:
const campaign_exclusions = clean(row.campaign_id)
  ? await read(supabase.from("campaign_recipient_exclusions")
      .select("campaign_id,phone_e164,is_active")
      .eq("campaign_id", clean(row.campaign_id))
      .eq("is_active", true)
      .in("phone_e164", variants)
      .limit(5))
  : []
```

- Rows with no `campaign_id` (manual inbox sends, inbound auto-replies) read nothing new and behave exactly as today.
- A read error throws, so the guard returns `send_time_guard_read_failed` and the row is **deferred** (existing path). Nothing is sent, and nothing is cancelled because of a transient failure.

### Tests to add (beside `send-time-contact-guard-20261008.test.mjs`)
- **a)** An active exclusion for (campaign A, phone) blocks a campaign-A row, whether the phone is stored as 10 digits, `1`+10 or E.164 → `cancelled`; transport is never called.
- **b)** A campaign-B row for the same phone passes. So do inactive exclusions, and rows with no `campaign_id`.
- **c)** An exclusion read error → `deferred`. The row is unlocked with its status kept; the next run with a healthy read proceeds.
- **d)** Empty table → no change for any row.
- **e)** Existing P0 guard tests stay green, with suppression, opt-out, wrong-number, not-owner and already-contacted unchanged.

## Questions for the reviewer
1. **Missing table.** With this read in place and the table **not** yet migrated, every campaign row would defer, halting campaign sending. The required order is migration → verify → code. Should the loader also treat `relation does not exist` as a hard deployment error? Never as "no exclusions".
2. **Existing queue rows.** Already-queued rows are cancelled at send time. Is `cancelled` with `campaign_recipient_excluded` the right terminal state, or should they stay retryable after a deactivation?
3. **Retries.** A deferred row keeps its status and retries. Confirm the resume drain (`apply-resume-drain.js`) re-plans it in-window as for other deferrals.
4. **Rollback.**
   - The code is reversible by revert.
   - The migration adds two tables, two functions and triggers, and alters no existing object.
   - Rolling back means deactivating rows, or dropping the objects after reverting the code. Agree?

## Required release order (each step separately authorized)
1. Review and approve the migration. CI proof is green (`campaign-exclusions-db-proof`, real Postgres 17).
2. Apply the migration (**separate authorization**).
3. Verify the table, constraints, grants and RLS in production (read-only).
4. Ship the build/plan hooks **and** this guard change **together**.
5. Verify end to end with zero exclusion rows: no behaviour change.
6. Only then request approval for the first exclusion (Erika Rivers, Miami Test).

No merges, migrations or deploys during the Atlanta/St. Louis sending ramp.
