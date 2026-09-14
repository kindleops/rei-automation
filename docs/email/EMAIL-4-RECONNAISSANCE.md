# EMAIL-4 — Reconnaissance and architecture reconciliation

Written before any EMAIL-4 code. The purpose is to establish what already
exists, so EMAIL-4 extends the acquisition brain rather than growing a second
one beside it.

**Headline: this repository already contains a large, mature seller-intelligence
system — roughly 44,000 lines under `domain/seller-flow`, `domain/classification`
and `domain/acquisition`.** EMAIL-4's job is therefore mostly *convergence*, not
construction. The genuinely new primitives are few and named at the end.

---

## 1. Operational attention (for §0)

| Thing | Where | Verdict |
|---|---|---|
| `notification_events` table | `20260626120000_notification_intelligence.sql` | **REUSE** |
| `emitNotificationFromBusinessEvent()` | `domain/notifications/notification-emitter.js` | **REUSE** |
| `EVENT_CATALOG` (a registry of ~100 typed events across 10 domains) | `domain/notifications/notification-event-catalog.js` | **REUSE, extend with entries** |
| `notification-scanners.js` sweeps | same dir | **REUSE as the backstop pattern** |

This is exactly what §0 and §26 ask for, and it already exists at production
quality. Three properties matter:

- **The vocabulary is already channel-neutral.** The `inbox` domain carries
  `inbox_message_received`, `inbox_price_captured`, `inbox_ownership_confirmed`,
  `inbox_hot_lead`, `inbox_needs_call`, `inbox_hostile_reply`,
  `inbox_multi_property_match`. None of them says "sms". EMAIL-4 must emit
  *these*, not new email-shaped twins — and must never create
  `email_priority_score`.
- **`deduplication_key` already exists** on the table and in the emitter, plus
  an in-process `isRateLimited()`. That is the mechanism for §0's "provider
  retries must not create duplicate alerts" invariant.
- **The SMS inbound path already emits through it**
  (`process-seller-inbound-message.js` maps its decision events onto
  `inbox_*` types). EMAIL-4 copies that shape rather than inventing one.

**One caution.** `emitNotificationFromBusinessEvent` is deliberately
non-blocking and swallows every error ("never thrown to callers"). That is right
for a notification, but it means an emit failure is silent — and §0's invariant
is precisely that a seller reply needing attention *cannot* sit unnoticed. So
emission alone is not sufficient evidence of visibility; a **sweep** that
re-derives attention from the durable rows is required as the backstop, in the
shape of the existing `scan*Notifications()` functions.

---

## 2. Seller intelligence (for §1)

### Reuse unchanged — these are canonical and must not be duplicated

| Concept | Module | Why it is authoritative |
|---|---|---|
| **Seller intent vocabulary** | `classification/inbound-intent-ontology.js` | Self-describes as "the single semantic source of truth for what an inbound seller message can MEAN, independent of which detector produced the label". Load-time enforced against the live classifier's exported `INTENT_PRIORITY`, so it cannot drift. §7's "prefer canonical existing vocabularies" resolves here. |
| **Money understanding** | `seller-flow/monetary-understanding.js` | Deterministic, no AI. Classifies every number into a semantic kind (asking price, counter, payoff, repair, tax, monthly payment, earnest money, per-unit, package) with confidence, raw text and qualifiers (firm/net/range/minimum/approximate). `extract-seller-facts.js` already states the rule: "no second price parser". §9 resolves here. |
| **Structured fact extraction** | `seller-flow/extract-seller-facts.js` | Already evidence-backed: "normalized value, confidence, source message id, exact evidence text, evidence position, timestamp, extractor version, needs_review flag and conflict flag". Already encodes §8's ownership rule: "Authority is claim-tracking, never verification". |
| **Monotonic stage transition** | `seller-flow/resolve-seller-stage-transition.js` | Pure, no I/O. Invariants already stated: "Stage advancement is monotonic — stage_after is never below stage_before" and "A single message may advance multiple stages when it resolves multiple milestones (e.g. price + condition in one reply)". That IS §2 and §17. Being pure, it is directly reusable with email-sourced facts. |
| **Stage registry / aliases** | `acquisition/acquisition-stage-registry.js`, `lead-state/universal-lead-state-registry.js` | Canonical stage codes and ordering. |
| **Economics** | `property_acquisition_scores` | §3's named source of truth. Carries `recommended_cash_offer`, `minimum_acceptable_offer`, `investor_ceiling_*`, `decision_tier`, `evidence`, `computed_at`. EMAIL-4 reads it and never computes it. |
| **Canonical conversation** | `acquisition_opportunities` | Established in EMAIL-3 as the channel-neutral seller relationship. |
| **Canonical communication** | `seller_logical_communications` + EMAIL-3's `email_inbound_messages` | The evidence layer (Layer A). |

### Generalize — right design, wrong channel scope

| Thing | Problem | Plan |
|---|---|---|
| `inbound_processing_ledger` | Excellent §22 design already: `idempotency_key`, `attempt_count`, `status`, `terminal_disposition` with a CHECK list, `latency_ms`, `classifier_version`, retention via `retain_until`, and deliberate PII minimisation (`body_sha256` + length, never raw text — "never store raw seller message text"). But it is SMS-shaped: `from_phone`, `to_phone`, and the sibling audit table CHECKs `thread_key ~ '^\+[1-9]\d{6,14}$'`. | Follow this design exactly for EMAIL-4's processing state, channel-neutral. Its PII stance is the standard §32 wants and is adopted wholesale. |
| Model invocation | Two independent provider paths exist: `providers/ai.js` (OpenAI, free-form string return, no usage capture, no versioning) and an inline client inside `natural-response-engine.js` (Groq/OpenRouter, strict `response_format: json_object`, model allowlist, AbortController timeout, one bounded retry on 429/5xx only, usage + latency captured). §32 says "reuse existing centralized model-provider configuration" — there is **no** centralized one; there are two. | The natural-response engine's contract is the right one and is the template. EMAIL-4 needs it as a *shared* extraction client rather than a third inline copy. |

### Replace later — not EMAIL-4's job, but do not build on it

| Thing | Problem |
|---|---|
| `workflow_extracted_facts` | Looks like an assertion ledger and is not one. `UNIQUE (enrollment_id, fact_key)` means one row per key — **it overwrites history**, which is the exact opposite of §5's "do not destroy historical seller statements". It is also scoped to `workflow_enrollments`, not to acquisition opportunities. EMAIL-4 must not persist seller assertions here. |
| `property_participant_graph` | Named in `REQUIRED_INTELLIGENCE_SCHEMA` and read by three modules, but it has **no `CREATE TABLE` anywhere in `supabase/migrations`**. So one of the three tables the intelligence persistence layer declares it requires cannot exist. The code anticipates this — `isSchemaMissingError`, and a `deployment_order: "apply_schema_before_code_deploy"` hint on the failure — so it degrades observably rather than crashing, but it degrades. **EMAIL-4 must not make its own durable path depend on it.** |
| `PROPOSED_`-prefixed migrations | Three files carry this prefix, which does not match the timestamp-first pattern a migration runner applies, so they are inert. Two were superseded by properly-named migrations (`inbound_intelligence_audit` by `20260627120000_...`, `closing_cases` by `20260828000000_...`), which is the benign case. The third, `PROPOSED_20260729120000_offerr_evaluation_spine.sql`, is the **only** definition of the `offerr_evaluations` family — so those tables are as absent as `property_participant_graph`. Out of EMAIL-4's scope, recorded because it is the same defect class EMAIL-3 closed with the schema-column guard. |

### Genuinely new primitives required

Only four, and each is justified by something that demonstrably does not exist:

1. **A durable assertion ledger with supersession** (§5). Nothing in the repo
   keeps a seller's *history* of statements — `workflow_extracted_facts`
   overwrites, and `extract-seller-facts` produces facts in memory that are
   consumed and discarded. "225k, then 205k, then 190k if you close Friday" has
   nowhere to live today.
2. **A centralized reconciliation policy** (§16, §24). Conflict handling today
   is distributed through the stage engines. §24 explicitly requires it
   centralized: "do not scatter arbitrary confidence checks through handlers".
3. **A shared structured-extraction client** (§18, §21, §30) — generalizing the
   natural-response engine's contract so EMAIL-4 is not a third inline model
   caller, and so model/prompt/schema versions and token usage are recorded once.
4. **A channel-independent intelligence seam** (§27) — the entry point that
   takes a canonical communication from *any* channel and runs the existing
   brain over it. The existing brain's entry (`process-seller-inbound-message`)
   is SMS-shaped down to `thread_key` being an E.164 phone number.

---

## 3. What this means for sequencing

§0 (operational visibility) is genuinely independent of the intelligence work
and gates production MX, so it lands first and separately.

The intelligence work is then mostly *seam* work: the four new primitives above,
plus wiring email communications into `resolve-seller-stage-transition`,
`monetary-understanding`, `extract-seller-facts` and the intent ontology that
already exist. Every place EMAIL-4 is tempted to write a classifier, a price
parser, a stage rule or an intent enum, the answer is that one already exists.
