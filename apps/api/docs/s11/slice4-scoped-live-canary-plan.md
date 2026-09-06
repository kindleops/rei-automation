# §11 Slice 4 — Scoped Live Provider Canary

**STATUS: DESIGNED, NOT EXECUTED. Execution requires explicit operator authorization.**

---

## 1. Why this exists

Slices 1–3 certify the state machine, the transition authority, the database
concurrency semantics and the crash/recovery behaviour. None of them can certify
one thing:

> that a **real** TextGrid callback binds to a **real** canonical attempt.

Production today has `seller_communication_attempts = 0` and
`seller_logical_communications = 0`, because there has been no canonical
outbound send since the §11 attempt ledger was introduced. Every real provider
callback arriving now resolves to `orphan_unmatched` — recorded as evidence,
bound to nothing, advancing nothing. That is **correct behaviour**, and it is
also **an evidence gap that only a live send can close**.

This canary exists to close exactly that gap and nothing else.

## 2. Identity model

The canary uses the canonical `internal_canary` communication type, which the
database already recognises and constrains:

```
CHECK (... WHEN 'internal_canary' THEN (canary_run_id IS NOT NULL
                                    AND canary_leg   IS NOT NULL) ...)
```

- `communication_type` : `internal_canary`
- `logical_key`        : `lck_v1:internal_canary:<sha256>` (shape enforced by CHECK)
- `canary_run_id`      : **fresh per run**, never reused
- `canary_leg`         : explicit, e.g. `s4_outbound_leg`
- destination          : an authorized internal handset resolved **from the
                         canonical registry at run time**

The number is never hardcoded, never printed, and never appears in a commit, a
log line, a PR body or this document.

Reusing a `canary_run_id` is a hard abort: the Slice 1 scoped-canary claim path
looks the run up with `maybeSingle`, so a resumed run must always mint a new id.

## 3. Scope — exactly one of everything

| Dimension | Bound |
|---|---|
| canary runs | 1 |
| logical communications | 1 |
| destinations | 1 |
| intended provider sends | 1 |
| callback lifecycles | 1 (plus any provider redeliveries, which must be inert) |
| campaign traffic | 0 |
| unrelated queue rows executed | 0 |

## 4. Containment method

**Do NOT** clear the emergency brake. **Do NOT** set `queue_execution_mode` to a
broad processing mode. **Do NOT** enable campaigns.

Use the scoped-canary authorization built and proven in Slice 1: authority is
consumed *inside* `queue_atomic_claim_send_row`, so the claim RPC itself verifies
the canary rather than a route deciding beforehand. Production is already in
`queue_execution_mode = scoped_canary_only`, which is the mode this path was
designed for — no global control needs to move.

Containment that must remain unchanged throughout:

- `campaign_mode = paused`
- `queue_processor_mode = off`
- emergency brake active
- Vercel project paused
- no send-capable cron

## 5. Preconditions (ALL required before execution)

1. Slice 3 PASS
2. Release topology reconciled — production SHA present in a canonical release
   lineage (`release/cloudflare-production` = `a7838e44`, tag
   `prod-2026-09-06-a7838e44`)
3. Production source known exactly, and the deploy path documented and
   unambiguous
4. Fatal invariants = 0 across all 22 codes
5. Provider baseline recorded (TextGrid send count before the run)
6. Outbound baseline recorded (`send_queue` sent/delivered counts, latest
   outbound timestamp)
7. Canonical internal handset validated as authorized and reachable
8. TextGrid credentials and runtime healthy
9. Callback endpoint reachable from the provider
10. **Callback trust posture explicitly documented** — see §8
11. STOP/DNC/compliance state verified clean for the destination
12. A named operator watching, with the abort procedure in hand

## 6. Expected deltas

| Measure | Expected |
|---|---|
| provider send invocations | **exactly +1** |
| seller-visible outbound | **exactly +1** |
| `seller_logical_communications` | +1, with the expected canary identity |
| `seller_communication_attempts` | +1 |
| `provider_request_started_at` | present, and **committed before** the network call |
| bound provider SID | exactly 1 |
| `seller_provider_callback_events` | ≥1 (depends on provider behaviour) |
| duplicate callbacks | idempotent — one event per fingerprint |
| provider truth | monotonic; `delivered` never regresses |
| second attempt | **none** |
| retry | **none** |
| unrelated queue rows executed | 0 |
| campaign traffic | 0 |
| unrelated seller mutation | 0 |

## 7. Abort criteria (any one aborts immediately)

- more than one provider invocation
- unexpected destination
- unexpected logical identity or reused `canary_run_id`
- a second attempt is allocated
- callback SID conflict, or a SID bound to more than one attempt
- any unrelated queue row executes
- containment drift on any control in §4
- any fatal invariant becomes non-zero
- seller-visible outbound delta > 1
- any campaign send

## 8. The honest caveat about callback trust

Slice 2 established, and Slice 3 confirmed by static analysis, that **receipt
trust never gates a transition**. Trust is classified and recorded on the ledger
row; `resolveBinding` does not receive it and no conditional reads it. Combined
with the verifier's fail-open when no secret is configured, an unauthenticated
caller could in principle advance canonical provider truth.

This does **not** permit a duplicate seller-visible send — no callback path
allocates an attempt, invokes a provider, or grants retry authority, and Slice 3
proves this exhaustively. The exposure is to *truth integrity*, not to send
safety, and it errs toward not-sending.

Before the canary runs, the operator should decide one of:
- accept the exposure for a single scoped run (the canary SID is not predictable
  by a third party within the 30-minute adoption window), or
- gate adoption on `trust_class = 'authenticated_provider_callback'` first.

This is recorded as a decision to make, not silently assumed.

## 9. What the canary would prove

The one thing the model cannot: that a real provider callback, carrying a real
SID, binds to the real canonical attempt created by a real send — and that the
projection, the ledger, and canonical truth all agree afterwards.
