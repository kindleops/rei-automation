# EMAIL-3 — Inbound reply cutover runbook

**Status: NOT EXECUTED.** No DNS record has been created. No MX record points at
any inbound host. This document is the procedure, and every provider-issued
value in it is a blank to be filled from the Brevo console at the time you run
it.

---

## The rule this runbook exists to enforce

> There must never be a period where seller replies are routed into
> infrastructure with no proven consumer.

An MX record is a promise that mail sent to a domain will be received and
handled. Publishing one before the consumer is deployed does not produce an
error anybody sees: Brevo accepts the message, posts it to a URL that 404s or
403s, retries a few times, and gives up. The seller sent a reply. The operator
sees silence. Nothing is logged, because the thing that would have logged it was
never reached.

The reverse ordering has no such failure. A deployed consumer with no MX record
simply receives nothing, which is the state it is in today.

So the cutover is strictly ordered, and each step is verified before the next.

---

## Preconditions

Nothing below may be started until all of these are true.

| # | Precondition | How to confirm | ☐ |
|---|---|---|---|
| 1 | The inbound route is deployed and reachable in the target environment | `GET /api/webhooks/brevo/inbound/<anything>` returns `200 {"status":"listening"}` | ☐ |
| 2 | `BREVO_INBOUND_URL_TOKEN` is set in the target environment | The route returns **401** rather than **503** for a wrong token | ☐ |
| 3 | The EMAIL-3 migration is applied in the target database | `email_reply_aliases`, `email_inbound_events`, `email_inbound_messages`, `email_inbound_attachments` all exist | ☐ |
| 4 | `EMAIL_REPLY_DOMAIN` is set to the subdomain that will carry the MX record | It is a **subdomain** — see "Why a subdomain" below | ☐ |
| 5 | `system_control.email_reply_aliases_enabled` is **off** | Aliases must not be advertised before step 6 of the cutover | ☐ |

A note on precondition 2: **503 and 401 mean different things here.** 503 says
nobody configured the endpoint, and an unconfigured endpoint refuses everything.
401 says the credential was wrong. If you see 503, the token is not set in that
environment and the cutover cannot proceed.

---

## Generating the capability token

Brevo publishes **no signature** for inbound parse webhooks — no HMAC, no shared
key, no per-request signing material. This was checked for EMAIL-2's
transactional webhooks and checked again for inbound; they are separate products
and do not share security. The strongest control Brevo genuinely supports is
that *we* choose the URL, so the URL is the credential.

```
openssl rand -hex 32
```

Set it as `BREVO_INBOUND_URL_TOKEN` in the server environment. It is **server
only** and must never appear in a client bundle, a repository, a ticket, or a
log line.

Understand what this control is and is not. It is a bearer secret in a URL, and
it can leak through proxy logs, access logs, referrer headers and browser
history in ways an HMAC cannot. If the endpoint URL is ever exposed, rotate the
token: generate a new one, set it, and update the Brevo webhook URL. Both steps,
in that order.

What compensates for it is **reply-alias correlation**: a forged callback still
has to name a 128-bit alias that only ever appeared in mail we sent to that
specific seller. And, more fundamentally, nothing downstream treats an inbound
message as authority over acquisition state. It is evidence. That is a design
decision, not a limitation to be lifted later without thought.

---

## Why a subdomain, and not the sending domain

Put the MX on something like `reply.<your-domain>`, never on the domain that
carries your corporate mailboxes.

An MX record is per-domain and total. Pointing the apex or the main sending
domain at Brevo's inbound host redirects **all** mail for that domain — every
person's mailbox included — into the parse webhook. That is not a partial
outage; it is everyone's email, gone, until the record is reverted and caches
expire.

A dedicated `reply.` subdomain has its own MX and touches nothing else.

---

## Step 1 — Configure inbound parsing in Brevo

In the Brevo console, under inbound parsing, create the webhook.

| Setting | Value |
|---|---|
| Webhook URL | `https://<your-app-host>/api/webhooks/brevo/inbound/<BREVO_INBOUND_URL_TOKEN>` |
| Domain | `reply.<your-domain>` — the value of `EMAIL_REPLY_DOMAIN` |

Brevo will display the MX host to point at. **Record the exact value it gives
you here. Do not copy one from documentation, a blog post, or this file.**

| Record | Type | Host | Value | Priority | ☐ |
|---|---|---|---|---|---|
| Inbound MX | MX | `reply.<your-domain>` | _host Brevo displays_ | _priority Brevo displays_ | ☐ |

Leave the DNS record **uncreated** for now. Configuring the webhook in Brevo
does not route any mail; only the MX record does.

---

## Step 2 — Prove the consumer before any mail can reach it

Use Brevo's own webhook test, or an authenticated request you construct
yourself, to post a sample inbound payload at the capability URL.

Expected outcomes, in order of what they tell you:

| Response | Meaning | Action |
|---|---|---|
| `200` with `results[].processing_status: "processed"` | The consumer works end to end | Proceed |
| `200` with `needs_review: 1` | Works; the sample had no resolvable conversation, which is correct for a synthetic payload | Proceed |
| `503 inbound_receipt_not_durable` | Authentication passed, the database did not accept the receipt | **Stop.** Fix the database before creating any DNS record |
| `401` | The token in the URL does not match the environment | **Stop.** Fix the token |
| `503 brevo_inbound_security_not_configured` | No credential is set in that environment | **Stop.** Set `BREVO_INBOUND_URL_TOKEN` |

Confirm in the database that a row landed in `email_inbound_events`. A 200 is
the route's opinion; the row is the fact.

☐ A synthetic inbound payload produced a durable `email_inbound_events` row.

**Do not proceed past this line until that box is ticked.** This is the step the
whole ordering exists to protect.

---

## Step 3 — Create the MX record

Only now. Fill in the values Brevo gave you in step 1.

☐ MX record created for `reply.<your-domain>`.

Wait for propagation and confirm:

```
dig +short MX reply.<your-domain>
```

☐ The record resolves to the host Brevo issued.

Note that `reply.<your-domain>` needs **no SPF, DKIM or DMARC record of its
own** for inbound — those govern mail you *send*. If you ever send from the
reply subdomain, that is a separate configuration with its own records.

---

## Step 4 — Send a real reply, end to end

From an external mailbox you control (not a Reivesti account, so the path is a
genuine external one), send a message to a **manually minted** alias address on
the reply domain.

To mint one for the test, insert a row into `email_reply_aliases` against a test
conversation and use `r1.<its token>@reply.<your-domain>`.

Confirm, in order:

☐ `email_inbound_events` has a row with `trust_class = 'authenticated_provider_callback'`.
☐ The matching `email_inbound_events` row has `resolution_tier = 'tier1_reply_alias'` and `resolution_status = 'resolved'`.
☐ `email_inbound_messages` has a row linked to it by `inbound_event_id`, carrying the conversation anchors.
☐ The message body is present, and `html_is_sanitized` is true if the mail had HTML.
☐ Sending the **same** message again produces a `duplicate` outcome and no second message row.

---

## Step 5 — Confirm nothing downstream moved

This is the check that proves the phase boundary held. Inbound email is
evidence; it is not acquisition authority.

☐ No lead status changed.
☐ No stage advanced.
☐ No offer was created or altered.
☐ No automated reply was sent to the seller.

If any of those moved, **stop and revert the MX record.** Something is wired
past the boundary EMAIL-3 deliberately stops at.

---

## Step 6 — Turn on reply aliases for outbound

Only after every box above is ticked.

```sql
update public.system_control set value = 'true' where key = 'email_reply_aliases_enabled';
```

This flag is an **operator attestation** that MX is live and the consumer is
proven. Until it is on, outbound mail carries the sender's own reply mailbox and
the dispatch result reports `reply_path: "sender_default"`, which is a working
but unautomated path — the seller can still reply, and an operator files it by
hand.

☐ Flag on.
☐ A subsequent outbound send reports `reply_path: "conversation_alias"`.

---

## Rollback

Each step reverses independently, and none of them requires a deploy.

| To stop | Do this | Effect |
|---|---|---|
| New aliases being advertised | Set `email_reply_aliases_enabled` to `false` | Outbound reverts to the sender's reply mailbox. **Aliases already in seller inboxes keep working** — the flag gates minting and advertising, not resolution |
| Processing inbound mail | `update public.system_control set value = 'false' where key = 'email_inbound_enabled'` | Callbacks are still **received and stored**, and marked `held`. Nothing is thrown away, and the events are reprocessable |
| Mail reaching us at all | Delete the MX record | Replies bounce at the sender's provider. The seller gets a delivery failure, which is louder than silence but still a loss |

The middle row is the one to reach for first. "Disabled" deliberately does not
mean "return 200 and discard the reply" — the receipt is written before the kill
switch is consulted, precisely so that turning ingestion off never loses a
seller's message.

---

## What is still missing, stated plainly

| Gap | Consequence | Owner |
|---|---|---|
| **No malware scanning.** No scanner exists in this repository | Every attachment is stored with `scan_status = 'unscanned'` and `quarantine_reason = 'no_malware_scanning_configured'`. Nothing is called clean, because nothing has been checked | A later phase |
| **No attachment byte storage.** `storage_status` never leaves `pending` | Attachment metadata and digests are recorded; the bytes are not retained, and Brevo's URLs expire | A later phase |
| **No inbound signature is possible.** Brevo provides none | Authentication rests on URL secrecy plus alias unguessability. Documented rather than overstated | Provider limitation |
| **No operator UI for the unmatched queue.** Rows land with `resolution_status` of `unmatched` or `ambiguous` and nothing surfaces them | Replies that cannot be attributed are stored correctly and are invisible until someone queries the table | EMAIL-8 owns Lead Command |

That last one matters for scheduling: an unmatched reply is safely *stored* the
day this cutover completes, but it is not *seen* until there is somewhere to see
it. Until then, someone should be querying `email_inbound_events` where
`resolution_status in ('unmatched', 'ambiguous')` on a regular cadence. There is
a partial index on exactly that predicate, so the query is cheap.
