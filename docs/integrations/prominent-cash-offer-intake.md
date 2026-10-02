# Prominent Cash Offer seller intake boundary

Status: implemented and verified through the dedicated non-production `rei-api-staging` Vercel runtime against the isolated hosted `prominent-intake-staging` Supabase branch; no production data was written.

## System of record

The shared REI Automation Supabase project remains the system of record. The new `public.external_seller_intake_submissions` table is the durable ingress/audit record for external seller submissions. The existing `public.acquisition_opportunities` remains the pipeline record and `public.inbox_thread_state` remains canonical lifecycle state.

## Write path

`POST /api/internal/acquisition/intake` is protected by `PROMINENT_INTAKE_SHARED_SECRET`, validates `prominent_cash_offer` / `web_seller_intake`, normalizes with `normalizePhone()`, attempts read-only deterministic property resolution with `resolveOfferrSubjectProperty()`, then calls one RPC: `ingest_external_seller_intake`. The migration function performs idempotency, identity matching, intake audit, opportunity initialization, and first-thread initialization in one transaction. The follow-on inbox projection migration exposes the submitted seller name in the existing canonical inbox view.

## Safety contract

Initial state is `needs_review`, queue `not_queued`, workflow `not_enrolled`, automation `inactive`. No outbound message/event/contact or campaign write occurs. The function returns only submission/lead IDs and match/replay booleans. Service-role execute permission is explicit; anon/authenticated access is revoked.

## Deployment and test boundary

Required environment variables are `PROMINENT_INTAKE_SHARED_SECRET` in REI Automation and `REI_AUTOMATION_INTAKE_URL` plus `REI_AUTOMATION_INTAKE_SECRET` in Prominent. Use separate staging values; no secret values belong in source control or browser code.

The verified non-production target is Supabase branch `prominent-intake-staging` (`eiawfeddmmwwavzlfwia`) under project `real-estate-automation` (`lcppdrmrdfblstpcbgpf`). The branch began with no data clone and was not attached to production traffic. Direct hosted proof passed for durable idempotency, matching, rollback, canonical inbox projection, attribution/consent, and zero outbound effects.

The dedicated REI staging project is `rei-api-staging` (`prj_3Ta3T0GG4PWFCcCkmLIVwwZzV22T`) with preview URL `https://rei-api-staging-edsas5re4-real-estate-automation.vercel.app`; it has no production custom domain or alias. The Prominent staging preview is `https://prominent-cash-offer-staging-4rcx9phg5-real-estate-automation.vercel.app`. The project-scoped Vercel Protection Bypass for Automation is sent as `x-vercel-protection-bypass` from the Prominent server only; it is separate from `PROMINENT_INTAKE_SHARED_SECRET`, and both secrets are absent from browser code. Missing or wrong intake secret returned 401, while the full Prominent-to-REI request returned 200 and persisted durable IDs in the isolated branch. The final synthetic canary produced `submission_id=31d3a9b8-2ab1-4fb4-b2cf-4e599da0c3e0` and `lead_id=70aa4d03-a643-466d-aaa9-f65cc9f550fc`; same-key replay returned the same identifiers and changed payload returned 409. The existing paused REI `api` project was not resumed or modified. A rendered-browser UI canary remains unverified because no in-app browser or repository-installed browser runner is available.
