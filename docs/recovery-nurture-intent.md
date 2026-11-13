# Recovery nurture intent — `lc.recovery-nurture-intent.v1` (rc-8.5.21 part B → part A)

Seller policy: a genuine "not interested" is a 30-day follow-up (nurture). Recovery (part B) only
**builds and enqueues the intent**; the part A follow-up pipeline owns scheduling, permission
re-checks, template selection and sending.

Module: `apps/api/src/lib/agent/operations/ownership-evidence.js` (`nurtureIntentFor(facts, candidate, { now })`).
Wiring: `createRecoverySweepHandler({ …, linkage: { enqueueFollowupIntent, ownershipEvidenceFor } })`.

```js
{
  contract: 'lc.recovery-nurture-intent.v1',
  kind: 'not_interested_30d_nurture',
  conversation_id,          // inbox_thread_state.id
  property_ref,             // encoded property ref (never the raw id)
  opportunity_id,           // or null
  not_interested_at,        // the seller's reply time (ISO)
  due_at,                   // not_interested_at + 30 days
  ownership,                // 'confirmed' | 'unverified' (never 'denied': denials are not nurtured)
  evidence_refs,            // ids only
  idempotency_key,          // sha256(conversation | reply message id): enqueue at most once
  sends: 0,
}
```

`enqueueFollowupIntent(intent) → { ok, deduped?, reason? }` is provided by part A. Without it the sweep
counts `FOLLOWUP_PIPELINE_NOT_CONFIGURED` (nothing is dropped silently).

Built ONLY when all hold: the latest meaningful reply is `not_interested`; no stop / opt-out /
suppression; no wrong number and no property-scoped ownership denial (including a canonical-ledger
denial: a bare "No" to OUR ownership question); no pending queue item or active follow-up enrollment;
the reply is RECENT (≤ 7 days). Older replies are historical recovery: they need their own
owner-approved scope (the PROPOSED dead-deal correction plan), never a bulk backfill from the sweep.
