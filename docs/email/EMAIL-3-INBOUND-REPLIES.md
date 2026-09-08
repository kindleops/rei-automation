# EMAIL-3 — Inbound replies and canonical cross-channel threading

Seller replies now have a place to land, a durable receipt, and a resolver that
refuses far more readily than it guesses. No MX record has been created; the
consumer exists first, deliberately.

---

## 1. The three decisions this phase is built on

**Email joins the canonical communication domain.** It does not get a parallel
one. Everything that makes an SMS send safe applies to an email send unchanged,
because it lives in the §11 seam rather than in either channel's caller.

**A channel is an attribute of a communication. It is not the identity of the
seller relationship.** `acquisition_opportunities` is the conversation — owner
and property, no channel anywhere in it. A seller who starts on SMS and
continues by email is one relationship with two channels, not two leads. If
channel ever climbs up into conversation identity, an operator ends up
negotiating against themselves.

**Inbound communication is evidence. It is not acquisition authority.** Nothing
in this phase writes a lead status, a stage, a temperature, or an offer, and
nothing sends a reply. A message arriving is a fact about correspondence; what
it *means* is EMAIL-4's problem, and separating the two is what makes it safe to
turn transport on before intelligence exists.

---

## 2. The reply address

```
r1.<32 hex chars>@reply.<domain>
```

**One alias per conversation, not per message.** This is what makes thread
fragmentation impossible by construction rather than by care. A transport retry,
a template rotation, a second touch and a follow-up three weeks later all carry
the same `Reply-To`, so a seller replying to any of them lands in one place. A
per-message token would have to be threaded correctly through every retry path
and would fail quietly the first time one of them forgot.

Uniqueness is enforced by a partial unique index in Postgres, not in JavaScript.
Two concurrent sends to the same seller both find no alias and both insert; the
loser gets `23505` and adopts the winner's row. A lookup *failure* never mints —
that is precisely how a conversation ends up with two live reply addresses,
because the row exists and we simply could not see it.

### Why a durable random alias and not a signed token

A signed token is stateless and tempting. It was rejected for three reasons:

1. **Old mail must stay replyable.** A signing secret that is ever rotated — after
   an incident, a staff change, a scheduled rotation — silently invalidates every
   email already sitting in every seller's inbox. A stored alias survives rotation
   because it does not depend on a secret at all.
2. **Revocation must be auditable.** Revoking one signed token needs a denylist,
   which is a table — so the stateless design stores state anyway, just the
   awkward half. A row per alias makes creation, last use and revocation
   queryable.
3. **No internal ids in the wire format.** A signed token either carries them in
   plaintext or needs encryption on top of the signature. Random bytes carry
   nothing.

### What an alias does *not* do

It does not authenticate the sender. Anyone who learns an alias can send to it.
A valid alias is strong evidence of **which conversation** a message belongs to
and no evidence at all about **who wrote it**. Nothing downstream may read
"arrived on a known alias" as proof of seller identity.

### Aliasing is off by default, and never gates a send

Advertising a `Reply-To` on a domain with no MX means every seller reply
hard-bounces — the worst failure in this phase, because the seller believes they
answered, the operator sees silence, and nothing logs an error. So aliasing
requires both `EMAIL_REPLY_DOMAIN` and the `email_reply_aliases_enabled` system
flag, the latter being an operator's attestation that the runbook is complete.

When either is off, or the store cannot answer, the send still goes: it falls
back to the sender's own monitored reply mailbox, and the dispatch result
reports `reply_path: "sender_default"` with the reason. The seller can always
reply; what is lost is automatic filing. Refusing the send instead would stop
seller outreach over a threading convenience while making the seller no safer.

A dry run reads an existing alias but never mints one. A preview that leaves
durable rows behind is not a preview.

---

## 3. Authentication, described honestly

Brevo publishes **no signature for inbound parse webhooks** — no HMAC, no shared
key, no per-request signing material. This was investigated for EMAIL-2's
transactional webhooks and again here; they are separate products and do not
share security.

So the endpoint rests on:

| Control | What it actually is |
|---|---|
| **A secret capability URL** | The token lives in the path. Possession of the URL is the credential. The strongest control the provider genuinely supports — and a bearer secret in a URL, which can leak through proxy logs and browser history in ways an HMAC cannot |
| **A shared-secret header** | For a proxy that can add one, verified by the same code EMAIL-2 uses so both surfaces agree on what "authenticated" means |
| **Reply-alias correlation** | The compensating control that matters: a forged callback still has to name a 128-bit alias that only appeared in mail we sent to that seller |
| **The evidence boundary** | Nothing downstream treats inbound email as authority over acquisition state |

We do not claim a signature we do not have. The endpoint fails closed: with
neither credential configured it refuses everything with 503, told apart from
401 for a forged one, because "nobody configured this" and "someone forged this"
need different fixes.

---

## 4. Thread resolution: four tiers, and the discipline of refusing

The wrong answer here is **silent**. A reply attached to the wrong property does
not error; it appears in a deal, an operator reads it, and they negotiate about
the wrong house. There is no alert for that.

| Tier | Evidence | Resolves when |
|---|---|---|
| 1 | **Reply alias** | 128 random bits that only ever appeared in mail we sent to this conversation |
| 2 | **RFC headers** | `In-Reply-To` / `References` naming a Message-ID we issued, spanning exactly one conversation. Resolved through the canonical attempt ledger, which is where an outbound provider message id actually lives |
| 3 | **Provider thread** | Present and deliberately **inert** — Brevo documents no stable thread id, and building on an undocumented field is building on something they can change without telling anyone |
| 4 | **Sender context** | The address maps to **exactly one** active conversation |

**What is never used: subject line, owner name, nearest timestamp, or "the only
one that looks active".** Each is a plausible-sounding correlation with no
evidential weight and an invisible failure mode.

Tier 4 is narrow on purpose. One landlord emails about six properties; a family
shares a mailbox; an assistant handles three estates. The moment an address maps
to more than one candidate, "most recent" and "closest subject" are guesses
dressed as logic. **Ambiguous is a correct answer.** An operator spending thirty
seconds attaching a reply is cheap; discovering three weeks later that an offer
was discussed against the wrong property is not.

A token that was **presented and did not resolve** is a louder outcome than no
token at all — someone replied to an address we minted and we cannot find it —
so it refuses rather than falling through to weaker evidence that might attach
it somewhere plausible and wrong.

### What an unmatched reply does get

It is stored as a **readable message row with null conversation anchors**.
Deciding where it belongs means reading it, and an operator cannot read what was
never normalized. The null anchors are what "not filed" means — no query joining
a conversation can reach the row. Its receipt stays `received` rather than
`processed`, and no communication event is emitted, because evidence is evidence
*of* a conversation and there is not one yet.

---

## 5. The six failure modes, and what stops each

| Failure | What stops it |
|---|---|
| **Silent loss** | The receipt is written before anything else can fail, and before the kill switch is even read. A receipt we cannot store answers 503, never 200 — answering 200 tells Brevo the reply was accepted and stops it retrying |
| **Duplicate inbound** | A unique index on `event_key`, not a read-then-write two workers can interleave between. The key never uses a random UUID, and never uses the RFC `Message-ID` — that header is chosen by the sender's client, so trusting it would let a hostile sender suppress their own reply by reusing a known id |
| **Wrong-property attribution** | The four tiers above, and the refusal to guess |
| **Spoofed mutation** | Only `TRUST_CLASS.AUTHENTICATED` advances anything, and inbound advances no acquisition state at all |
| **Channel fragmentation** | One alias per conversation; channel in communication identity and absent from conversation identity; `related_thread_keys` for the several threads one relationship carries |
| **Unsafe HTML and attachments** | Allow-list sanitization, remote images dropped, every attachment quarantined and typed `application/octet-stream` regardless of what was claimed |

---

## 6. Content safety

**HTML is hostile input.** It reaches an operator's browser inside an
authenticated session; an XSS here is an attacker acting as an acquisitions
operator inside the seller database.

The sanitizer is an **allow-list, never a deny-list**. A deny-list is a bet that
you thought of every dangerous thing; you did not — there is always another
`onanimationstart`, another `<svg><set attributeName="onload">`. An allow-list is
a bet that you thought of every *safe* thing, and being wrong there costs a
missing bullet point rather than a compromised session. Twenty-five attack
vectors are exercised in `email-inbound-safety.test.mjs`; the same file also
checks the seller's actual words survive all of them, because a sanitizer that
empties the message is safe and useless.

Remote images are dropped by default: a tracking pixel in a seller's reply
reports **when an operator read it** and leaks the office IP.

**Quote stripping is conservative.** Three views are kept — raw, normalized, and
newest reply — because quote stripping is a heuristic over infinitely many mail
clients, and when it is wrong it is wrong by *deleting the seller's words*.
Stripping that would leave nothing falls back to the whole message.

**Classification is header-first.** RFC 3834 `Auto-Submitted`, `List-*`, and
delivery-status content types decide what a message is; body prose does not. A
seller who writes "I was out of office last week, sorry — yes, still interested"
is a seller, and treating prose as protocol would let them be silenced by a
phrase they happened to use. Unknown fails *towards* a human, because a missed
seller reply is worse than a reviewed robot.

**Attachments are never called safe.** There is no malware scanner in this
repository, so every file lands `scan_status = 'unscanned'` with
`quarantine_reason = 'no_malware_scanning_configured'`. The provider's claimed
content type is recorded and never believed. Filenames are neutralised —
traversal, control characters, and the right-to-left override that renders
`photo<RLO>gnp.exe` as "photo exe.png" in a listing.

---

## 7. What was found on the way

**Nineteen public entry points threw a `TypeError` on a `null` argument** —
eleven pure ones and eight async — including `buildLogicalCommunicationKey`,
which sits on the canonical send seam, and `dispatchEmailQueueRow` itself. The
cause was `function f(input = {})`, which defaults `undefined` and does nothing
for `null` — a defect that had already been fixed six separate times in this
codebase by people who knew about it, including twice in this phase before the
sweep.

Throwing is the wrong failure on these paths: a `TypeError` escaping one can be
caught by a caller and read as a transport error, which is precisely the reading
that justifies a **retry**. So a null argument that throws does not merely fail;
it can become a duplicate send or a seller reply that vanishes into a catch
block. Fixed as a class — a shared `asObject` guard plus a contract test that
calls every entry point with thirteen hostile shapes.

**Two of the four resolution tiers could never have matched anything.**

Tier 2 read `email_queue.rfc_message_id`. Nothing in the codebase writes that
column — `email_queue`'s own `CREATE TABLE` is not in `supabase/migrations`, so
whether it exists at all cannot be settled from the repository, but it is
certainly never populated. Tier 4 selected `contact_outreach_state.podio_prospect_id`,
which appears in no migration and nowhere else in the codebase.

Either way the outcome is the same and it is the worst shape a defect can have.
PostgREST rejects the **whole** select for one unknown column; the code then
logs and returns an empty list, because that is the right thing to do with a
failed lookup. So the tier does not crash, does not fail a test, and does not
show up in review — it silently becomes a control that returns nothing, forever.
An absent tier is a known gap; an inert one is a documented protection that is
not there.

This is the same defect EMAIL-0 found twice in the pre-existing code — a code
path targeting a table shape nobody built — written fresh in this phase by
someone who had just finished writing that finding up. Three instances was
enough to stop fixing instances: `email-schema-column-contract.test.mjs` now
reads column names out of the migration DDL and checks every literal `.select()`
in the email domain against them, and is itself verified by reintroducing a
phantom column and confirming it fails.

Tier 2 now resolves through the canonical attempt ledger, where the provider
message id is actually recorded; the test's Supabase stand-in throws on any
direct table access, so that ownership is proven rather than asserted. Tier 4
also now distinguishes "we looked and there is nothing" from "we could not
look" — both are correctly unmatched, but reporting the second as the first
hides a broken query behind a routine outcome nobody investigates.

**Malformed payloads stored their attachment bytes.** A payload that cannot be
read is kept as evidence, and it was kept verbatim — so a 25MB attachment landed
base64-encoded inside a `jsonb` column, roughly 33MB of row, for bytes nobody
reads as bytes. Anyone who could reach the endpoint could have bloated the
database deliberately. The descriptors are kept and only the content is
replaced, with the omitted byte count recorded so a stripped attachment is
distinguishable from one that never had content.

**The migration proof found a defect in itself.** `psql` prints the command tag
alongside a `RETURNING` value, so an id came back with `INSERT 0 1` glued to it;
every attachment insert then failed on the malformed uuid, and the
duplicate-attachment check *passed* because both inserts failed rather than
because the unique index worked. A proof that passes for the wrong reason is
worse than one that fails.

---

## 8. Deliberately not built

Per the phase boundary: no AI understanding of inbound content, no autonomous
replies, no intent classification beyond deterministic protocol classification,
no negotiation, no cross-channel sequencing, no automatic offer generation, no
Lead Command redesign. `EMAIL-8` owns the operator surface; the unmatched queue
is correctly *stored* the day the cutover completes and not *seen* until there
is somewhere to see it.

Also missing and documented rather than papered over: malware scanning,
attachment byte storage, and any inbound signature (a provider limitation, not
an omission).

---

## 9. Configuration

| Name | Where | Purpose |
|---|---|---|
| `EMAIL_REPLY_DOMAIN` | env, server only | The subdomain seller replies are addressed to |
| `BREVO_INBOUND_URL_TOKEN` | env, server only | The capability token in the webhook path. `openssl rand -hex 32` |
| `BREVO_INBOUND_WEBHOOK_SECRET` | env, server only | Optional shared-secret header; falls back to `BREVO_WEBHOOK_SECRET` |
| `email_reply_aliases_enabled` | `system_control` | Operator attestation that MX is live and the consumer is proven |
| `email_inbound_enabled` | `system_control` | Stops *processing* without stopping *receiving*. Held events keep their payload and are reprocessable |

Cutover procedure: `EMAIL-3-INBOUND-MX-CUTOVER-RUNBOOK.md`.
