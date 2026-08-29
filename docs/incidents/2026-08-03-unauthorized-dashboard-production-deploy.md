# Incident — Unauthorized production deploy of the operator dashboard

**Date:** 2026-08-03
**Severity:** Low impact, high process significance
**Status:** Closed — deployment retained by explicit operator authorization
**Author:** Claude Opus 5 (agent), recorded at operator request

---

## Summary

Merging PR #64 (N.1 — Deal Desk state and hydration stabilization) to `main` automatically
deployed the operator dashboard to production. The merge itself was authorized. The
production deployment was **not** — the governing instruction for that lane was explicitly
"Do not deploy."

No rollback was performed. The operator subsequently reviewed the facts and authorized
leaving the deployment in place.

---

## What happened

| Event | Detail |
|---|---|
| PR merged | #64 → `main`, merge commit `6fcfde73`, 2026-08-03 **02:29:00Z** |
| Auto-deploy triggered | `rei-automation-dashboard` → **Production** (`fnlb9p7qu`), Ready in 49s |
| Production surface | **https://ops.leadcommand.ai** |
| Detected | After the merge, via `vercel ls` while confirming "no production deployment" |
| Reported | Immediately, before any further action |
| Decision | Operator authorized retaining the deployment |

A second production dashboard deploy followed at **03:25:36Z** when PR #63
(`eeee5bd8`, backend final completion) merged to `main`. That deploy (`gtqaxp4ti`) is the
build currently serving `ops.leadcommand.ai`. It contains the N.1 code, because `eeee5bd8`
descends from `6fcfde73`. PR #63 was a separate authorized merge and is noted here only so
the deployment timeline is complete.

---

## What was and was not affected

**Deployed:**
- `rei-automation-dashboard` (frontend only) → `ops.leadcommand.ai`

**Not deployed — verified via `vercel ls`:**
- `api` project: latest **Production** deployment is `api-9yhcklmbn`, **2 days old**,
  predating both merges. Two newer `api` deployments exist but are **Preview** only.
  Notably, PR #63 changed only `apps/api/**` and still did not produce a production `api`
  deployment — the `api` project does not auto-deploy from `main`.
- `real-estate-automation` project: 37 days old, untouched.

**Not changed:**
- Database schema — no migration was applied by this deploy. (PR #63 added migration
  *files*; applying them is a separate operator action and did not occur here.)
- Production data — no row was inserted, updated or deleted.
- Queue state, campaign execution, automation engine, scrape, seller messaging.
- Environment variables and Vercel project configuration.

**No** queue run, campaign, automation execution, scrape, seller send, or live proof
occurred at any point.

---

## Code that reached production

N.1's Deal Desk frontend changes. Two are operator-visible behaviour changes:

1. **Bucket switching no longer blanks the workspace.** The previously hydrated
   conversation stays on screen until the new list resolves, instead of the panels going
   blank and an auto-select re-hydrating. This is the DD-017 fix and is the intended
   improvement, but it changes how the workspace feels.
2. **Read-mark now reports failure.** A thread with no server-writable canonical phone
   route previously fired a request the server silently rejected; it now shows
   "This conversation has no writable canonical phone route." and does not mark read.
   Previously it also did not mark read — the difference is that the operator can now see
   why.

Everything else is internal: one canonical selection source, one thread-reference
resolver, request-generation cancellation, per-thread composer drafts.

**Quality gates the code had passed before merge:** 113 unit/integration tests, clean
typecheck, clean build, a fixture-backed browser verification run, and a CodeRabbit review
that produced 13 findings — all valid, all fixed, all threads resolved.

**What it had NOT had:** any verification against production data. All runtime evidence
is fixture-backed by design, so production-data behaviour was unproven at deploy time.

---

## Root cause

The repository's `main` branch is connected to the `rei-automation-dashboard` Vercel
project with automatic production deployment. **This was never verified before merging.**

The compounding failure is more specific than "did not know": throughout the pre-merge
phase, "no production deployment" was repeatedly checked and reported as a passing gate —
but the check only ever inspected deployment *history*. A history check cannot detect a
deployment that a future merge will trigger. The verification was structurally incapable
of catching the thing it was meant to prevent, and it was reported with more confidence
than it earned.

Contributing factor: the instruction set separated "merge PR #64" and "do not deploy" as
independent directives, and they were treated as independent. In a repository with
auto-deploy on the default branch, they are the same action.

---

## Decision and rationale

Retain the deployment. Rationale recorded by the operator:

- The deployed scope is frontend-only.
- It is reviewed and tested.
- It is materially safer than the prior Deal Desk selection/hydration behaviour, which had
  known defects (workspace blanking on every bucket switch, stale responses overwriting
  the current selection, silent read-mark failure).
- Rolling back would restore those known defects.

---

## Process correction

**Any merge to a production-connected branch is a production action** and requires
explicit production authorization — separately from authorization to merge.

The reusable pre-merge gate is documented at
[`docs/runbooks/PRE_MERGE_PRODUCTION_IMPACT_GATE.md`](../runbooks/PRE_MERGE_PRODUCTION_IMPACT_GATE.md)
and must be completed before any merge to `main`.

Specifically, a safety property must be verified by checking the mechanism that would
cause the unsafe outcome, not by checking that the outcome has not happened yet.

---

## Follow-ups

| Item | Owner | Status |
|---|---|---|
| Read-only production smoke check of the deployed dashboard | agent | Recorded separately |
| Pre-merge production-impact gate added to runbooks | agent | Done |
| Consider requiring manual production promotion for `rei-automation-dashboard` | operator | Open — **no Vercel configuration was changed by this task** |
| Verify N.1 behaviour against production data | operator | Open — fixture-backed evidence only |
