# EMAIL-2 — Brevo Transport

Status: implemented. Migrations written, **none applied**. No credentials in this
environment, so the 429 live probe and a real send were not performed.
Depends on: EMAIL-1.

EMAIL-2 earns the right to automate later by making transport trustworthy first.
Nothing in this phase interprets a seller's words, replies to anyone, or sends a
campaign.

---

## 1. Canonical send-state machine

Unchanged from §11, which is the point. Email enters the same seam as SMS:

```
domain action  →  email-queue-row-identity      refuses if it cannot name the action
               →  seller_logical_communications one row per action, per CHANNEL
               →  canAllocateAttempt()          would another attempt duplicate?
               →  evaluateCanonicalSendAuthority brakes, kill switches, execution mode
               →  assertNoEmDash()              content guards
               →  allocateAttempt()             atomic, numbered
               →  provider_request_started_at   COMMITTED BEFORE the network call
               →  Brevo                         the only network primitive
               →  classifyBrevoProviderError()  provider codes → the shared vocabulary
               →  mapTransportOutcome()         state × delivery_possibility × retry_authority
               →  evaluateLogicalTransition()   the one authority
               →  projections                   LAST, and never authority
```

Two seam changes were required, both in `canonical-communication-dispatch.js`:

* **The whole message reaches the provider.** It previously projected to
  `{to, from, body}`. Email also needs subject, html, text, reply_to, tags and
  the brand that selects its credential. Projecting would have forced the email
  bridge to smuggle the rest past the seam in a closure, which is how a second
  send path starts.
* **A returned failure is a failure.** The email adapter reports rather than
  throws. A seam that only understood exceptions would have filed a reported
  failure as a send with no message id, discarding a precise classification and
  stranding the communication as an unexplained ambiguity.

## 2. The three vetoes, deliberately not merged

| Authority | Question | Module |
|---|---|---|
| Runtime | is the SYSTEM allowed to send? | `canonical-send-authority.js` (shared with SMS) |
| Recipient | is this SELLER contactable? | `email-outreach-eligibility.js` |
| Sender | is this MAILBOX fit to carry it? | `email-sender-readiness.js` |

All three must say yes. A perfect recipient and an unlocked system still cannot
rescue a suspended domain.

Order in `dispatch-email-queue-row.js` is cheapest-and-most-absolute first: the
kill switch, then identity, then recipient, then sender — and all of them before
attempt allocation, so **a refused send never consumes an attempt number.** An
attempt is a durable claim that a provider request was about to happen; spending
one on a message we were never going to send corrupts the ledger crash recovery
reads.

## 3. Provider abstraction changes

`domain/email/transport/` is unchanged in shape from EMAIL-1. The adapter still
does exactly one job: bytes out, classified outcome back. It does not retry,
suppress, write to the queue, or hold an opinion about whether a failure is safe
to repeat.

`transport-outcome-mapping.js` gained one terminal class in EMAIL-1
(`invalid_to_address`) and nothing in EMAIL-2. A second ESP remains one new file.

## 4. Brevo implementation

* **Send** — `POST /v3/smtp/email`. Credentials resolve **per brand**:
  `BREVO_PROMINENT_API_KEY` / `BREVO_REIVESTI_API_KEY`, with `BREVO_API_KEY` used
  only for an unbranded call. A caller that names a brand gets that brand's key
  or nothing, so a branded send can never go out under the wrong identity.
* **Events** — `brevo-webhook-verification.js` → `reconcile-email-provider-event.js`
  → `email-provider-event-store.js`.
* **Vocabulary** — `email-provider-outcome-lattice.js` maps Brevo's event names
  (including its spelling variants across API versions) onto the *existing*
  provider-outcome classes. The monotonic gate itself is imported from the SMS
  lattice, not reimplemented: two implementations of "may this outcome replace
  what we believe" would drift, and the direction they drift in is a delivered
  message being downgraded.

### The 429 decision

`provider_rate_limited` is a **named class that is deliberately unmapped**, so it
falls into the fail-closed ambiguous branch: `may_have_been_sent` +
`retry_denied`.

**This has a real cost** — a rate-limited send stalls instead of backing off.
Brevo documents 429 as "too many requests", which describes the status code and
says nothing about whether a message was created, and the existing SMS mapping
refuses to assume the same thing about TextGrid for exactly that reason.

`npm run proof:brevo-429-probe` establishes the answer from evidence. It refuses
to run without deliberate opt-in because it sends real API traffic, records the
exact status, rate-limit headers, body and `messageId` presence of every attempt
to a JSON report, and **does not change the classification** — an automated
script that rewrote a retry policy from its own output would be deciding a safety
question without a human.

`email-rate-limit-policy.test.mjs` carries a tripwire that fails the day someone
maps the class, forcing the change to be accompanied by a citation of the probe
that justified it.

## 5. Webhook security and idempotency

**The hole this closes.** The endpoint began `if (!secret) return { ok: true }`.
An unset `BREVO_WEBHOOK_SECRET` therefore made it accept anything — not
accept-and-mark-untrusted, but accept, process, and write suppression rows and
delivery state from an unauthenticated request. Anyone who found the URL could
mark a seller unsubscribed or an undelivered message delivered.

| Situation | Response | Trust class |
|---|---|---|
| secret unset | **503** `brevo_webhook_secret_not_configured` | unauthenticated |
| secret set, none presented | **401** `brevo_webhook_credential_absent` | unauthenticated |
| secret set, wrong value | **401** `brevo_webhook_credential_mismatch` | unauthenticated |
| shared secret matches | 200 | authenticated |
| proxy HMAC over the raw body matches | 200 | authenticated |

503 and 401 are told apart on purpose: both refuse, but "nobody configured this"
and "someone forged this" need different fixes.

> **Brevo does not HMAC-sign transactional webhooks.** Its documented mechanism is
> a caller-chosen URL plus IP allow-listing, so the shared secret is the whole of
> the authentication story and the URL should be treated as a secret too. The
> HMAC path exists for a proxy that adds one, and is the branch to use if Brevo
> ships signing later.

**Idempotency** is the `UNIQUE` index on `email_events.event_key`, not a
read-then-write two workers can interleave. The key prefers Brevo's own event id;
its fallback hashes only the semantic content (message, address, type, instant)
because Brevo varies incidental fields between redeliveries, and hashing those
would make every duplicate look new.

**Out-of-order** events are handled by rank, not arrival time. `delivered` then
`request` is normal; the late `request` is older, weaker evidence and is recorded
as `stale` rather than applied. Two contradictory *terminal* outcomes
(`delivered` then `hard_bounce`) are a `conflict` — recorded, never silently
overwritten.

Every event is stored on every path, including refusals. An event we would not
act on is still the only evidence it arrived.

## 6. Suppression behaviour

**Channel specificity is the load-bearing distinction.**

* An **email unsubscribe is channel-specific.** It writes `email_suppression` and
  nothing else — never `sms_suppression_list`, never
  `contact_outreach_state.dnc`. A seller who unsubscribes from emails has not
  opted out of a phone conversation, and treating it as global would silently
  destroy a live acquisition lead.
* A **DNC is global.** `contact_outreach_state.dnc` blocks email exactly as it
  blocks SMS.

| Brevo event | Suppression reason | Moves delivery state? |
|---|---|---|
| `hard_bounce` | `hard_bounce` | yes — `delivery_failed_after_acceptance` |
| `soft_bounce` | `soft_bounce` (the only reason that may expire) | yes |
| `blocked` | `blocked` | yes |
| `invalid_email` | `invalid_address` | yes |
| `unsubscribed` | `unsubscribed` | **no** |
| `spam` / `complaint` | `complaint` | **no** |
| `opened` / `clicked` | none | **no** |

Suppression is written against **both** the delivery address and the folded
mailbox identity, so a seller who unsubscribed as `bob+house@gmail.com` is not
emailed at `bob@gmail.com` tomorrow.

**Suppression is not gated on resolution.** If a seller unsubscribes and we
cannot work out which send they were answering, the correct outcome is still to
stop emailing them; refusing because our own bookkeeping failed would turn an
internal problem into a compliance one. It still requires an authenticated
receipt — the alternative is letting a stranger suppress arbitrary addresses.

### Opens and clicks are telemetry, never authority

An open is inferred from a tracking pixel loading. That happens when a security
scanner prefetches the message, when a corporate gateway rewrites and fetches
links, when an image proxy caches content, and when Apple Mail Privacy Protection
preloads **every** image for **every** message regardless of whether a human ever
looked. A click can be a link-safety scanner following the URL.

So an open proves that something fetched a resource. Treating it as delivery
evidence would let a scanner mark a message delivered; treating it as engagement
would let a scanner promote a seller into a warm bucket and trigger outreach
nobody asked for.

The mechanism is the vocabulary, not a downstream special case someone can
forget: telemetry events carry **no outcome**, so the shared monotonic gate sees
`UNKNOWN` and returns `inert`. The database enforces it too —
`email_queue_record_telemetry()` can only write telemetry columns, and is proven
unable to set `delivered_at_event`.

## 7. Sender readiness

Reads `email_senders`. A **missing sender is a refusal, not a fallback** to
`EMAIL_DEFAULT_SENDER_EMAIL`: the env default has no caps, no status and no
warm-up state, so it is not a sender, it is a hole in the policy.

| Refusal | Cause |
|---|---|
| `sender_not_found` | no row, or the lookup was not performed |
| `sender_inactive` | `is_active = false` |
| `sender_suspended` | status suspended/disabled/paused/blocked/revoked, **or unrecognised** |
| `sender_missing_from_address` | no `from_email` |
| `sender_domain_unverified` | `domain_verified = false` (absent is unknown, and only warns) |
| `sender_warmup_paused` | `warmup_status` paused/halted |
| `sender_daily_cap_reached` | `messages_sent_today >= daily_limit` |
| `sender_warmup_cap_reached` | the warm-up ladder binds independently |

Warm-up ladder: `new` 20/day, `warming` 100/day, `warmed`/`established`
unlimited by the ladder. **The lower of the ladder and the configured limit
governs** — a `daily_limit` of 500 on a domain in its first week is an
aspiration, not a permission.

## 8. Kill-switch behaviour

| Switch | Scope | Read by |
|---|---|---|
| `system_control.email_enabled` | email only | `dispatch-email-queue-row.js`, first, before anything else |
| `system_control.queue_emergency_stop_at` | everything | `canonical-send-authority` |
| `system_control.queue_processor_mode` | everything | `canonical-send-authority` |
| `system_control.queue_execution_mode` | everything | `canonical-send-authority` |

`email_enabled` exists so email can be stopped without stopping SMS. It is read
**first** because when it is off no other question can change the answer. The
shared authorities are re-evaluated on **every attempt** inside the seam, never
inherited from the pre-flight checks: a seller can opt out, or an operator can
hit the brake, between attempt 1 and attempt 2.

All of them fail closed. `email_enabled` is currently `false` in production.

## 9. Migration compatibility — expand / deploy / contract

| Step | File | Applied? |
|---|---|---|
| expand | `20260908120000_email_channel_canonical_domain.sql` | no |
| expand | `20260908150000_email_provider_event_ledger.sql` | no |
| **deploy** | the lck_v2 code | no |
| contract | `20260908140000_email_channel_contract_strict.sql` | **no — must wait** |

A migration and a deploy are not atomic, so EMAIL-1's original coupling ("apply
them together") was a hope rather than a design.

**Expand** accepts a caller that names no channel, records it as `sms`, and
stamps `channel_source = 'expand_default_sms'`. The coercion is provably bounded
rather than hopeful: the only callers that can omit a channel predate lck_v2 and
are SMS by construction, and an email caller cannot reach the branch even by
accident because `buildLogicalCommunicationKey()` refuses to produce a key
without a channel.

**Contract** removes the tolerance and **refuses to apply while any caller still
relies on it** — it raises if an `expand_default_sms` row landed inside a quiet
window (60 minutes, settable via `SET LOCAL email.contract_quiet_minutes`). A
contract step that proceeds over its own guard is one nobody can trust.

`npm run proof:email-migration` runs all three phases against a throwaway
Postgres: **33 checks, all passing**, including that contracting too early is
refused, that the refusal does not half-apply, and that a channel-less caller is
refused afterwards.

## 10. What Ryan must provide

### Environment — the repository's real names

Server-only, never in a browser bundle. All are now in `apps/api/.env.example`.

| Variable | Required for | Notes |
|---|---|---|
| `BREVO_PROMINENT_API_KEY` | sending as Prominent Cash Offer | per-brand; no cross-brand fallback |
| `BREVO_REIVESTI_API_KEY` | sending as Reivesti | per-brand |
| `BREVO_API_KEY` | unbranded sends only | legacy fallback |
| `BREVO_WEBHOOK_SECRET` | **the webhook at all** | unset ⇒ every request refused with 503 |
| `EMAIL_DEFAULT_BRAND_KEY` | choosing a credential for unbranded sends | defaults to `prominent_cash_offer` |
| `EMAIL_TEST_ALLOWLIST` | internal test sends | comma-separated |

`EMAIL_DEFAULT_SENDER_EMAIL` / `_NAME` / `EMAIL_DEFAULT_REPLY_TO` /
`BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME` exist for legacy paths. **The dispatch
path deliberately does not use them** — it requires an `email_senders` row.

### DNS — per sending domain or subdomain

**No values are invented here.** Every record below must be taken from what Brevo
shows during domain authentication, and recorded in this table as it is
configured. A fabricated DKIM selector or SPF include is worse than a missing
one: it looks configured and fails silently.

| Record | Type | Host | Value | Status |
|---|---|---|---|---|
| SPF | TXT | `@` (or the subdomain) | _record Brevo displays — typically an `include:` plus your existing mechanisms, merged into ONE TXT record_ | ☐ |
| DKIM | TXT | _selector Brevo issues, e.g. `mail._domainkey`_ | _key Brevo issues_ | ☐ |
| Brevo DKIM 2 | TXT | _second host Brevo issues, if shown_ | _value Brevo issues_ | ☐ |
| DMARC | TXT | `_dmarc` | _policy you choose; start `p=none` with `rua=`, tighten to `quarantine` then `reject` once aligned_ | ☐ |
| Domain verification | TXT | `@` | _`brevo-code:…` token Brevo issues_ | ☐ |

Rules that are not negotiable:

* **One SPF record per domain.** Two TXT SPF records is a permanent error;
  Brevo's `include:` must be merged into the existing record.
* **SPF has a 10-lookup limit.** Adding an `include:` to a domain that already
  has several can silently push it over and break *all* mail from that domain.
  Verify with an SPF checker after editing.
* **DMARC alignment needs a matching return-path.** Brevo's default return-path
  is on Brevo's own domain, which passes SPF but does **not** align with your
  From domain. If DMARC is set to `quarantine` or `reject`, configure Brevo's
  custom/dedicated return-path (a CNAME Brevo provides) on a subdomain of the
  sending domain so SPF aligns. Skipping this while tightening DMARC will bounce
  your own mail.
* **DKIM alignment** is satisfied by signing with a key on the sending domain,
  which the DKIM records above do.

**Reply/inbound domain:** not required for EMAIL-2, which sends only. EMAIL-3
adds inbound and will need an MX record pointing at Brevo's inbound-parse host
for a dedicated reply subdomain, plus the parse webhook URL. Do not configure it
yet — an MX record with no consumer silently drops replies.

### Database — `email_senders` rows

One row per sending identity. The dispatch path refuses without one.

| Column | Value | Why |
|---|---|---|
| `sender_key` | stable slug, e.g. `pco-acquisitions-primary` | what a queue row references |
| `from_email` | the verified sender in Brevo | must match exactly, unique |
| `sender_name` | display name | |
| `reply_to_email` | a monitored mailbox | EMAIL-3 depends on this being real |
| `provider` | `brevo` | |
| `provider_api_key_name` | `BREVO_PROMINENT_API_KEY` or `BREVO_REIVESTI_API_KEY` | records which credential this identity uses |
| `domain` | the sending domain | |
| `sender_status` | `active`, `ready` or `warming` | **anything else refuses**, including unrecognised values |
| `warmup_status` | `new` → `warming` → `warmed` | the ladder caps 20/day then 100/day |
| `daily_limit` | integer | **leave NULL for no cap**; `0` blocks everything |
| `messages_sent_today` | `0` | reset daily by the sender-rotation job |
| `market`, `agent_persona`, `language` | optional routing dimensions | |
| `is_default` | one per brand | |
| `is_active` | `true` | |

`domain_verified` is not yet a column. Until it is added, verification is
reported as a **warning** rather than a refusal — absent is unknown, not
unverified, and refusing on absence would stop every existing sender.

### Brevo dashboard — the steps that cannot be done from the repository

1. Create or confirm the sending domain under **Senders, Domains & Dedicated
   IPs → Domains**, and complete authentication. **Record the exact DNS values
   it displays into the table above.**
2. Add each `from_email` as a verified sender.
3. Generate an API key per brand under **SMTP & API → API Keys**. Give each key
   only transactional-email scope.
4. Configure the transactional webhook under **Transactional → Settings →
   Webhook**: point it at `POST /api/webhooks/brevo/events`, subscribe to
   `delivered`, `hard_bounce`, `soft_bounce`, `blocked`, `spam`, `unsubscribed`,
   `invalid_email`, `deferred`, `opened`, `click`, and add the shared secret as a
   header or query parameter matching `BREVO_WEBHOOK_SECRET`.
5. Decide the per-domain daily cap and warm-up schedule, and put them in
   `email_senders`.
6. If a dedicated IP is used, complete its warm-up before raising caps.

## 11. Testing

| File | Tests |
|---|---:|
| `email-dispatch-canonical-seam.test.mjs` | 18 |
| `email-sender-readiness.test.mjs` | 21 |
| `email-queue-row-identity.test.mjs` | 14 |
| `email-webhook-verification.test.mjs` | 14 |
| `email-provider-event-reconcile.test.mjs` | 28 |
| `email-suppression-consequences.test.mjs` | 16 |
| `email-rate-limit-policy.test.mjs` | 7 |
| `email-channel-migration-contract.test.mjs` (extended) | 33 |

Executed proofs: `proof:email-migration` (33 checks against a real Postgres),
`proof:email-dry-run` (17 checks with a network tripwire).

## 12. Deliberately not in this phase

AI inbound understanding, autonomous replies, intent classification,
negotiation, cross-channel sequencing, large-scale campaign sending, automatic
offer generation, Lead Command redesign. Those are EMAIL-3 onward.
