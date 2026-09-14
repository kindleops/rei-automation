# EMAIL-4 — Seller intelligence, structured facts, reconciliation

Canonical seller communication now becomes structured acquisition intelligence,
through a channel-independent pipeline that understands and deliberately cannot
act.

---

## 1. What was built, and what was not

This phase is large, and the honest summary is that the **entire semantic core
is built, proven and tested**, while part of the **runtime plumbing is not**.

| Built | Not built |
|---|---|
| The four-layer model and assertion contract | The durable store's write path (schema exists and is proven; nothing writes it yet) |
| Deterministic extraction with a working floor | The queue worker |
| Quoted-content, question, negation and correction guards | Acquisition-stage reconciliation wiring |
| Conditions attached to terms; relative time | A live model caller (the contract, validator and provenance fields exist; nothing calls a provider) |
| Bounded context assembler, channel-independent | Seller-activity attention emission (§26) |
| Centralized reconciliation policy | |
| Structured-output validation and injection resistance | |
| Assertion ledger, processing state and review schema, executed against Postgres | |
| Versioned eval corpus and semantic harness | |
| The EMAIL-5 handoff object | |

Nothing half-built was left switched on. Every module listed as built is pure,
tested, and reachable; the unbuilt items are named here rather than stubbed.

**What this means for EMAIL-5:** the handoff contract (§39) exists and is
tested, and the eval foundation §29 requires as a precondition is in place. What
EMAIL-5 would additionally need is the persistence path, so that "what we
understand" survives the request that produced it.

---

## 2. The four layers

```
A EVIDENCE    "I'd probably take 185 if you close in two weeks."   immutable
B ASSERTION   { seller_price_expectation, 185000, basis: explicit } structured
C CANONICAL   current seller price expectation = $185,000           operational
D AUTHORITY   none                                                  EMAIL-5 owns
```

Each boundary is where a mistake changes character. Evidence that is wrong is a
transcription bug. An assertion that is wrong is a misreading. A canonical state
that is wrong is a deal negotiated against a false belief. The layers exist so a
misreading cannot become a false belief without passing a policy allowed to say
no.

**Basis is a first-class field, not a confidence number.** A confident inference
and a confident quotation are not interchangeable. A missing basis is refused
rather than defaulted, because defaulting to `explicit` would render an
inference as something the seller said.

---

## 3. What was reused rather than rebuilt

The reconnaissance found roughly 44,000 lines of existing seller intelligence.
EMAIL-4 is mostly convergence.

| Concept | Reused from | Why |
|---|---|---|
| Seller intent vocabulary | `classification/inbound-intent-ontology.js` | 75 canonical intents, load-time enforced against the live classifier's exported labels. EMAIL-4 defines **no intent enum**; a test asserts every slug it depends on still exists |
| Money parsing | `seller-flow/monetary-understanding.js` | Deterministic, already the stated "no second price parser". Verified by probe: it correctly refuses to turn "two weeks" into $2, and leaves a bare "185" low-confidence rather than silently scaling it |
| Monotonic stages | `seller-flow/resolve-seller-stage-transition.js` | Already pure, already states the monotonic invariant and multi-milestone advance |
| Economics | `property_acquisition_scores` | Read, never computed, and deliberately excluded from extraction context |
| Attention | `notification_events` + the emitter | Already channel-neutral (`inbox_message_received`, not `sms_*`) |
| PII stance | `inbound_processing_ledger` | Never the message text, only a digest and a length. Adopted wholesale |

Four concepts §7 names have **no** canonical slug — wholesaler, `requests_sms`,
`requests_credentials`, `provides_document`. They are recorded as named gaps
with reasons rather than invented as EMAIL-4 slugs beside a registry that owns
that vocabulary.

---

## 4. Deterministic first, and why it has a floor

Money is already parsed deterministically. Mood is grammar. Conditions are
phrases. Attribution is structure. None needs a model, and asking one to
rediscover it costs money, adds variance, and hands a prompt-injected message
somewhere to argue.

So the deterministic layer runs first and produces real assertions, every one
`explicit`. **With no model configured, an outage, a timeout, or a response that
fails validation, the seller's price, their closing condition and their channel
preference are still extracted.** What degrades is learning *why* they are
selling — the right thing to lose first.

The model is an enrichment and is structurally prevented from being more. It may
add what the rules could not read; it may not restate what they did, because a
model-proposed duplicate would arrive at a basis the model chose.

---

## 5. The readings we refuse to make

| Input | Wrong reading | Why it matters |
|---|---|---|
| `That's too low. You said "we can offer 170,000."` | seller price = 170000 | Our own number, quoted back while the seller **rejects** it. Inverts the negotiation |
| `Is your offer 175?` | seller price = 175000 | Reading a question as an answer stops us asking what they want |
| `Could you do 175?` | seller price = 175000 | A request tests us; it is not their number |
| `I don't need 200 anymore.` | seller needs 200 | Literally contains "I need 200" |
| `Sorry, I meant 190, not 290.` | seller price = 290000 | **Found by the corpus.** The exact value the seller retracted |
| `The tenant used to live there.` | tenant occupied | A past state is not a claim about now |
| `Someone offered me 205 yesterday.` | seller minimum = 205000 | Lets a seller move our floor by reporting a rumour |
| `I'd do 185 if you close before the 20th.` | seller price = 185000 | The condition is half the sentence |
| `I'll close and cover the taxes myself.` | buyer pays taxes | **Found by a test.** Inverts who owes what |

---

## 6. Reconciliation: four outcomes, not two

`ACCEPT` becomes canonical · `SOFT` known but not authoritative · `REVIEW` a
human decides · `REFUSE` not recorded as a fact.

A two-outcome policy forces every uncertain-but-useful reading into one of two
wrong answers. **SOFT is what lets the system know something without acting on
it**, which is the whole posture of this phase.

"Latest row wins" is wrong in four directions at once — it lets an inference
overwrite a statement, an ambiguous reading displace a clear one, a claim
overwrite verified title, and history be overwritten as state. Recency is the
right rule for exactly one family (temporal), and the code says which.

Implausible money goes to **review, never clamped** — a clamped number is a
number we invented. A legal conflict outranks everything. A family with no rule
falls through to REVIEW, because the safe reading of a gap is that nobody
decided yet.

---

## 7. Injection resistance

The defence is not detection — that is a losing arms race — but removing the
ability to express an instruction:

- no `action` field, so "mark sold" has nowhere to go
- no table or column field, so no SQL can be named
- assertion types from a closed allowlist
- an invented intent folds to `unclear` rather than arriving as new vocabulary
- values flattened to scalars, because nesting is where payloads hide
- counts and lengths capped, because "emit 10,000 assertions" is a cheap DoS
- nothing in the validator writes anything

**The blast radius of a fully successful prompt injection is one rejected row.**

---

## 8. Channel independence, proven

The context hash is computed over semantic content with channel and timestamps
excluded, so an SMS and an email carrying the same words in the same
conversation hash identically — while different words, or a different
conversation, do not. The equivalence is asserted **over the whole corpus**, not
one example, so a channel-shaped rule anywhere in the pipeline would show up.

---

## 9. Privacy

No seller prose reaches a notification. No message text reaches the processing
ledger — a digest and a length only. Our own economics never reach the
extraction context, because the extractor's job is to read the seller and
knowing our floor can only bias that. Context fields are copied one at a time,
never spread: a row gains columns, and a spread gains them silently.

---

## 10. Defects found on the way

- **`Number(null) === 0`, third instance.** A missing confidence read as zero
  confidence, so `null` was accepted as 0.0 while `undefined` was refused as
  NaN — the same missing value behaving two ways.
- **`my number` matched a commitment**, so "How did you get my number?" read as
  assertive. That phrase is its own canonical intent and the opposite of a
  commitment.
- **A correction asserted the retracted value.** Mood alone cannot prevent it,
  because a correction *is* assertive.
- **Condition capture ran greedily** through the next clause, hiding a second
  condition and breaking the date resolution of the first.
- **Elided subjects inverted who pays.** Fixing it needed a guard in the other
  direction so "I'll cover the taxes myself" is not read as a buyer obligation.
- **Five migration-proof checks passed for the wrong reason** — the inserts
  before them had failed, so the uniqueness guarantees were never exercised.
  The same shape found in EMAIL-3.

---

## 11. Deliberately not built

No autonomous replies, no outbound copy, no automated counteroffers, no
negotiation authority, no campaign sequences, no cross-channel orchestration, no
offer or contract generation, no Lead Command UI.

EMAIL-4 understands. EMAIL-5 selects actions. EMAIL-6 owns negotiation
authority.
