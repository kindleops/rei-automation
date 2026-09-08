# EMAIL-1 — Canonical Email Domain

Status: implemented, migration NOT yet applied (see "Apply ordering")
Depends on: EMAIL-0 reconnaissance

## What this phase does

Email becomes a first-class channel of the communication seam the platform already
has, rather than a second, parallel sending system. Nothing new was invented where
something canonical could be extended.

### 1. Channel is now part of a communication's identity (`lck_v1` → `lck_v2`)

This is the defect that would have caused a duplicate or contradictory seller
contact the first time email was switched on.

Every anchor set in the logical key is channel-blind. `campaign_target_id +
touch_number`, `decision_id`, `follow_up_id` and `offer_id + offer_version` all
describe a domain action without saying how it travels. Under `lck_v1`, "touch 3
of target T by SMS" and "touch 3 of target T by email" hashed to the **same** key
and resolved to **one** logical communication. Two outcomes, both unrecoverable:

* the email is refused as a duplicate attempt on the SMS communication, or
* the email adopts the SMS attempt's provider evidence and delivery state.

`channel` is now a **required** component with no default. A caller that cannot
say how its message travels is refused exactly like a caller with no anchors.
The refusal is checked *after* the anchor check, so every pre-existing refusal
reason is unchanged and an anchor gap is never reported as a channel gap.

The version bump is mandatory rather than cosmetic: a `lck_v1` and a `lck_v2` key
for the same SMS action are different strings and must never be compared or
deduplicated against each other.

**Blast radius, measured 2026-09-08:** `seller_logical_communications` holds
exactly one row — an `internal_canary` in `ambiguous_provider_outcome` /
`retry_denied`, already un-retryable by the transition authority. Re-keying
strands nothing that could ever be sent again. No campaign, decision, follow-up
or offer communication exists.

Callers updated to state their channel rather than have one assumed:
`queue-row-identity.js` (reads `send_queue`, the SMS queue) and
`dispatch-manual-operator-send.js` (takes `to_phone_number`, classifies TextGrid
errors). Both declare `sms` explicitly at the top of the file.

### 2. Address normalization — `domain/email/normalize-email-address.js`

Two deliberately different forms:

| Form | Used for | Behaviour |
|---|---|---|
| `normalized` | sending, and the suppression key | conservative: case-folded, display name stripped, trailing domain dot removed |
| `mailbox_identity` | deduplication and suppression matching | aggressive: plus-tags removed, Gmail dots removed, googlemail folded onto gmail |

Sending must use the address as given, because a rewritten address may bounce.
Deduplication must use the folded form, because `bob+house@gmail.com` and
`b.ob@gmail.com` are one person with one inbox. When the two goals conflict,
suppression wins: over-suppressing costs one outreach, under-suppressing costs a
complaint from someone who already said stop.

Refuses rather than repairs. A list (`a@x.com, b@y.com`) is refused outright —
silently taking the first entry is how a message reaches the wrong seller.

### 3. Eligibility — `domain/email/email-outreach-eligibility.js` (pure) + `email-eligibility-store.js` (IO)

The pure evaluator answers "is this recipient contactable". It is **not** the send
authority: emergency stop, `queue_processor_mode`, `queue_execution_mode` and the
operator brakes remain `canonical-send-authority.js`'s job and are still
re-evaluated on every attempt inside the dispatcher. Both must say yes.

The invariant the store exists to protect:

```
null       we looked, and there is no such record
undefined  we could not look        →  REFUSAL
```

The implementation this replaces queried `contact_outreach_state.master_owner_id`,
`.property_id` and `.last_outreach_at` — none of which exist on that table
(production has `podio_master_owner_id`, `podio_property_id`, and
`last_sms_at` / `last_email_at` / `last_outbound_at`). The query errored, the
helper caught the error and returned `false`, and **the only cross-channel
duplicate-contact protection in the platform failed open, silently, on every
row.** That is now a refusal.

Blocking reasons are ranked by durability, not by check order. An address that is
both opted out and inside a cooldown reports `opted_out`; reporting `cooldown`
would imply it becomes contactable in an hour, and eventually somebody waits an
hour and sends.

### 4. Provider abstraction — `domain/email/transport/`

```
email-transport-contract.js   the interface, the closed failure vocabulary, shape assertion
brevo-error-classifier.js     Brevo codes → the vocabulary transport-outcome-mapping already speaks
brevo-email-transport.js      the one network primitive: bytes out, classified outcome back
```

The adapter does not retry, suppress, write to the queue, or hold an opinion about
whether a failure is safe to repeat. `retryable` is not a fact about a response;
it is a judgement the transition authority makes from one.

A 2xx **without** a `messageId` is `provider_ambiguous_accept`, not a success.
Reporting it as sent would write a ledger row that can never be matched to a
webhook.

`transport-outcome-mapping.js` gained exactly one new terminal class,
`invalid_to_address` — the email twin of `invalid_to_number`, named separately so
an operator reading a ledger row can tell which address kind was refused without
also knowing the channel.

**429 is deliberately left unmapped.** Brevo documents it as a rejected request,
which would make it provably unsent and safe to repeat after a delay. That is not
proven against the live API in this repository, and the existing SMS mapping
refuses to assume the same thing about TextGrid for exactly that reason. It is
returned as the named class `provider_rate_limited` and lands in the fail-closed
ambiguous branch. **This has a real cost — a rate-limited send is held rather
than retried — and upgrading it is an EMAIL-2 task requiring evidence from a live
probe, not a reading of the documentation.**

### 5. Migration — `20260908120000_email_channel_canonical_domain.sql`

* `seller_logical_communications`: `channel` (NOT NULL, no surviving default,
  `CHECK IN ('sms','email')`) and `to_email`, plus a constraint that a row cannot
  carry both a phone and an email recipient.
* `seller_logical_communication_get_or_create`: writes `channel` and `to_email`;
  `channel` joins the identity-conflict guard in both halves. No `COALESCE` to a
  default — an absent channel violates NOT NULL and the caller hears about it.
* `email_suppression`: **created.** It did not exist. Both email code paths read
  and wrote a table of that name, so every suppression check returned "not
  suppressed" via its error path and every recorded opt-out was discarded. Closed
  reason vocabulary; only a soft bounce may carry an expiry.
* `email_queue`: gains the lineage a canonical dispatch requires
  (`logical_communication_id`, `dedupe_key`, campaign/decision/follow-up/offer
  anchors), with dedupe uniqueness scoped to live rows only.
* `contact_outreach_state`: gains `uq_contact_outreach_state_owner_email`, the
  email twin of the long-standing `(owner, phone)` unique key. Without it the
  email path had no upsert target and recorded no outreach at all, so every
  downstream cooldown check found nothing.

Additive only: no `DROP`, no `TRUNCATE`, no `DELETE`. One `UPDATE`, the channel
backfill. Single transaction, re-runnable.

## Apply ordering — required, and not yet done

**The migration has not been applied to production.** It must not be applied
before the code that ships with it, because the coupling is inherent: the new RPC
requires `channel` NOT NULL, and the currently deployed code does not send one.
Applying migration-first would make the live SMS dispatch seam refuse every send.

Deploy the code and apply the migration together, or code first. The reverse
order is not safe. (Nothing is currently sending — `queue_processor_mode=off`,
`queue_execution_mode=scoped_canary_only`, `queue_emergency_stop_at` set,
`campaign_mode=paused`, `email_enabled=false` — so the window is contained, but
the ordering is still the ordering.)

## Deliberately not in this phase

* Retargeting `lib/email/*` and `domain/email/email-service.js` off the phantom
  tables (`email_send_queue`, `email_messages`, `email_drafts`, `v_email_records`)
  and onto `email_queue` / `email_events`. That is EMAIL-2.
* Routing email sends through `canonical-communication-dispatch`. EMAIL-2.
* Webhook signature verification hardening. EMAIL-2.
* Any inbound email path. EMAIL-3.

## Frontend

One change, no redesign. `emailAdapter.ts` answered a failed backend call with
`MOCK_OVERVIEW` (every counter zero) and `MOCK_HEALTH` (`connected: false`, every
rate zero), which made a broken backend indistinguishable from a healthy empty
one. Those are removed; the reads return `null`, and the Email Command Center
renders "unavailable" rather than zeros, using its existing styles.

## Tests

| File | Tests | Covers |
|---|---:|---|
| `email-address-normalization.test.mjs` | 23 | folding, delivery-vs-identity split, every refusal |
| `email-outreach-eligibility.test.mjs` | 30 | unchecked-is-refusal, reason ranking, cross-channel cooldown, purity |
| `email-eligibility-store.test.mjs` | 14 | failed read ≠ pass, production column names, cross-channel row folding |
| `email-transport-brevo.test.mjs` | 26 | ambiguity never retried, no silent success, credential never leaks, header injection |
| `logical-communication-channel-identity.test.mjs` | 15 | the collision closed for every anchor type; lck_v1 guarantees preserved |
| `email-channel-migration-contract.test.mjs` | 22 | the statements a reviewer approved are the statements that run |

Existing §11 suites were updated where the contract deliberately changed (fixtures
must now name a channel): `logical-communication-key`,
`canonical-communication-dispatch`, `monetary-communication-authority`,
`s11-crash-race-matrix`, `email-layer-brevo-discord`.

## Still required from Ryan before EMAIL-2 can send

* `BREVO_PROMINENT_API_KEY` and/or `BREVO_REIVESTI_API_KEY` (server-side only).
* `BREVO_WEBHOOK_SECRET`, and the Brevo webhook configured to send it.
* Verified sending domain(s) with SPF, DKIM and DMARC published, plus the
  `email_senders` rows to match (`from_email`, `reply_to_email`, `domain`,
  `daily_limit`).
* Intended per-domain daily caps and warm-up schedule.
* A decision on the 429 question above: either accept the conservative hold, or
  authorise a live probe to establish Brevo's rate-limit acceptance semantics.
