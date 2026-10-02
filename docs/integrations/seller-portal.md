# Seller portal — backend integration

The Prominent Cash Offer site's authenticated seller portal reads REI Automation's canonical records through one secret-gated internal route family. No seller, property, offer or closing model is duplicated. Calls run on the shared scheduling core (`docs/integrations/scheduling-core.md`).

## Canonical sources (read-only projections)
| Portal surface | Canonical source |
|---|---|
| Property / status | `acquisition_opportunities` (stage, status), address from `property_address_full` or the intake submission |
| Estimate (non-binding) | `offerr_evaluation_requests.acquisition_opportunity_id` → `offerr_evaluations.seller_projection` only |
| Written offer | `seller_offers` — shown only once `sent_at` is set |
| Purchase agreement | `closing_cases.contract_status` / `contract_signed_date` (DocuSign remains the signing system) |
| Timeline | presentation mapping in `seller-portal-contracts.js`; dates only from canonical rows |
| Closing | `closing_cases`, `closing_milestones` (seller-relevant types), `closing_title_issues` (owner `seller`) |
| Calls | `scheduling_appointments` with `related_refs` containing `opportunity:<id>` (brand `prominent_cash_offer`) |
| Documents | `seller_portal_document_shares` → `email_attachments` (private bucket, 5-minute signed download URLs) |
| Messages | `seller_portal_messages`; operations are signalled through `inbox_thread_state` and `acquisition_opportunity_history` |

## Identity and security
Seller accounts are **not** Supabase Auth users: in this project the `authenticated` role can read deal tables broadly. Identity, grants, login codes, sessions, throttle, audit and notification tables are service-role only (RLS on, no policies, grants revoked).

| Control | Implementation |
|---|---|
| Code | 6 digits, peppered SHA-256 (per identity), 15-minute TTL, 5 wrong attempts lock it, single use enforced by a conditional `consumed_at IS NULL` update (concurrent submits → one session), all other open codes consumed on success |
| Throttling | per address 5 starts / 15 min; per IP 20 starts / 15 min; per IP 30 verifies / 15 min (`429 too_many_attempts`). IPs and addresses stored only as keyed HMACs |
| Enumeration | start-sign-in returns the same body whether or not the address has an account or was throttled, and takes the same minimum time (`SELLER_PORTAL_SIGNIN_MIN_MS`, production default 900 ms) |
| Sessions | opaque 256-bit token, SHA-256 at rest, new token every sign-in (no fixation), 30-day absolute, 14-day idle expiry, max 5 concurrent (oldest retired), sign-out and sign-out-everywhere revoke server-side |
| Cookie (Prominent site) | `pco_session`, HttpOnly, Secure, SameSite=Lax, 30 days |
| CSRF | every state-changing Prominent route checks same-origin; SameSite=Lax |
| Authorization | every call re-resolves session → active grants; an ungranted id is `404 not_found`, identical to a missing one; calls can only be changed when their `related_refs` hold a granted opportunity |
| Audit | `seller_portal_audit_events`: code issued, sign-in succeeded/failed, throttled, signed out (everywhere) — no codes, tokens or bodies |
| Documents | only operator-shared files; shareable = routed to this opportunity or its closing case, or on its title/seller threads — buyer-side threads never; revocation is immediate; signed URLs last 300 s and are served as downloads with the stored content type |

## Lifecycle notifications (seller-portal-lifecycle.js)
Fired after the canonical write commits, only to sellers with an active grant, once per event per seller (`seller_portal_notifications.dedupe_key`), never throwing into the writer, no-op until `SELLER_PORTAL_ENABLED=1`, sent only if `SELLER_PORTAL_EMAIL_ENABLED=1`.

| Email | Canonical source of truth | Hook | Deep link |
|---|---|---|---|
| Offer ready | `seller_offers.sent_at` stamped | `bindOfferToQueueRow` | `/account/offer/` |
| Action needed | `closing_title_issues` opened with owner `seller` | `openTitleIssue` | `/account/` |
| Closing scheduled / changed | `closing_cases` date **confirmed** (first / changed) | `setClosingDate` | `/account/closing/` |
| Closed | `finalize_closing_case` committed | `finalizeClosing` | `/account/closing/` |
| Message from Prominent | operator reply stored | `operatorReply` | `/account/messages/` |
| Document ready | operator share stored | `shareDocument` | `/account/documents/` |
| Call scheduled / rescheduled / cancelled | scheduling core commit | Prominent adapter `onChange` | `/account/schedule/` |
| Call reminders (24 h, 1 h) | scheduling core | `email_queue`, revalidated at send | `/account/schedule/` |

Links carry no tokens. A signed-out seller is sent to `/account/sign-in/?next=/account/<page>/` and returned there after the code (allow-list: `/account/<segment>/` only).

Not wired, deliberately: the legacy DocuSign path (`advanceClosingWorkflow`) already texts the seller on `closing_scheduled`; adding email there would double-notify. Target (unconfirmed) closing dates are not announced. `sent_at` is stamped when the offer SMS is queued, not delivered — the portal and the email agree with each other on that moment.

## Routes
- `POST /api/internal/seller-portal/{sign-in-start|sign-in-verify|sign-out|sign-out-everywhere|state|messages|messages-send|call-slots|call-book|call-reschedule|call-cancel|document-link}` — `x-seller-portal-secret`, seller token in `x-seller-session`, client IP in `x-seller-client-ip`. Disabled unless `SELLER_PORTAL_ENABLED=1`.
- `GET /api/cockpit/seller-portal/conversations[?unread=1]` — seller conversations for operations, unread first, with opportunity context.
- `GET|POST /api/cockpit/seller-portal/[opportunity_id]` — context, conversation, shared + shareable documents, calls; `reply`, `mark_read`, `share`, `revoke`. The actor is the authenticated ops user (`x-ops-user-id`), never the request body.
- Intake: `POST /api/internal/acquisition/intake` (`x-prominent-intake-secret`) — carried out of the WIP snapshot on this branch.

## Deployment order (staging first; nothing here has been run against production)
1. **Merge order.** `feat/seller-portal-api` → `feat/scheduling-core` (stacked) onto the API release branch. The branch is based on `c8f33381`; local `feat/mobile-product-v1` is 3 commits ahead (rc-7.1 / ic8) — rebase onto it first; the only overlapping file is `infra/cloudflare/worker/index.ts` (cron table).
2. **Intake.** `external_seller_intake` and `external_seller_inbox_projection` are already applied in production (recorded 20260908082307 / 20260908082317). The files on this branch are byte-identical; do not re-apply. Set `PROMINENT_INTAKE_SHARED_SECRET` on the API and the matching secret on the Prominent site.
3. **Migrations, in order** (staging project first):
   1. `supabase/migrations/20261002120000_seller_portal.sql`
   2. `supabase/migrations/20261003120000_scheduling_core.sql` (installs `btree_gist` in `extensions`)
   3. `supabase/migrations/20261003121000_scheduling_prominent_types.sql`
   All are idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`).
4. **API environment.**
   - Seller portal: `SELLER_PORTAL_ENABLED=1`, `SELLER_PORTAL_INTERNAL_SECRET` (≥32 random chars), `SELLER_PORTAL_CODE_PEPPER` (≥32 random chars; rotating it invalidates open codes and throttle keys only), `SELLER_PORTAL_PUBLIC_BASE_URL=https://www.prominentcashoffer.com`, `SELLER_PORTAL_EMAIL_ENABLED=1` when ready to email, `SELLER_PORTAL_OPERATOR_DIRECTORY` only if a named contact should show.
   - Email: `BREVO_PROMINENT_API_KEY`, `EMAIL_DEFAULT_SENDER_EMAIL` (verified Prominent sending address); for reminders an `email_senders` row: `sender_key='prominent_cash_offer'`, `from_email=<verified address>`, `sender_name='Prominent'`, `provider='brevo'`, `provider_api_key_name='BREVO_PROMINENT_API_KEY'`, `is_active=true` (`email_senders` is empty in production today). Reminders also require the existing `EMAIL_SEND_ENABLED=true` and `system_control.email_enabled='true'`.
   - Scheduling: see `scheduling-core.md` (Google OAuth client, token keys, webhook URL, ops app URL).
   - Remove `SELLER_PORTAL_CALL_HOURS`: availability now comes only from configured people.
5. **People.** Each team member signs in to the dashboard, opens Calendar → My calendar, sets hours and time zone, connects Google, and is added to `seller_advisors` (and `transaction_team` if applicable). Until someone is in a pool, Prominent shows "Online scheduling isn't open yet."
6. **Cron.** Deploy the worker; set `CRON_SCHEDULING_ENABLED=true` in `wrangler.production.jsonc` vars when Google is connected (the cron-scope test lists the job as registered-not-enabled; enabling it is a deliberate change to that test's enabled list).
7. **Prominent site.** `REI_AUTOMATION_SELLER_PORTAL_URL`, `REI_AUTOMATION_SELLER_PORTAL_SECRET` (= `SELLER_PORTAL_INTERNAL_SECRET`), then `PORTAL_ENABLED=1`. Never set `PORTAL_FIXTURE_MODE` on a deployed environment (it is ignored on Vercel regardless).
8. **Verify on staging** with `scripts/proof/scheduling-staging-race.mjs` and `scripts/proof/scheduling-google-proof.mjs`, then the end-to-end story.

**Staging caveat:** the existing Cloudflare staging environment shares the **production** database (`infra/cloudflare/worker/index.ts`, "STAGING RUNS NOTHING"). An isolated staging proof needs its own Supabase project (or a Supabase branch) and its own API deployment pointing at it.

## Rollback
`PORTAL_ENABLED=0` on the site hides the account (readiness notice); `SELLER_PORTAL_ENABLED=0` on the API stops every portal action and lifecycle email; `CRON_SCHEDULING_ENABLED=false` stops sync. Migrations are additive; nothing existing is altered except `email-send-safety.js` (thread-less `scheduling` source) and the lifecycle hooks, which are inert while the portal is disabled.
