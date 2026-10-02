# Seller portal — backend integration

The Prominent Cash Offer site's authenticated seller portal reads REI Automation's canonical records through one secret-gated internal route family. No seller, property, offer or closing model is duplicated.

## Canonical sources (read-only projections)
| Portal surface | Canonical source |
|---|---|
| Property / status | `acquisition_opportunities` (stage, status), address from `property_address_full` or the intake submission |
| Estimate (non-binding) | `offerr_evaluation_requests.acquisition_opportunity_id` → `offerr_evaluations.seller_projection` only |
| Written offer | `seller_offers` — shown only once `sent_at` is set |
| Purchase agreement | `closing_cases.contract_status` / `contract_signed_date` (DocuSign remains the signing system) |
| Timeline | presentation mapping in `seller-portal-contracts.js`; dates only from canonical rows |
| Closing | `closing_cases`, `closing_milestones` (seller-relevant types), `closing_title_issues` (owner `seller`) |
| Calls | `calendar_manual_events` (`event_type='manual_call'`) — already read by Calendar Nexus |
| Documents | `seller_portal_document_shares` → `email_attachments` (private bucket, 5-minute signed URLs) |
| Messages | `seller_portal_messages`; operations are signalled through `inbox_thread_state` and `acquisition_opportunity_history` |

## Identity and security
Seller accounts are **not** Supabase Auth users: in this project the `authenticated` role can read deal tables broadly. Identity (`seller_portal_identities`), grants, login codes and sessions are service-role-only tables (RLS on, no policies, grants revoked). Sessions are opaque 256-bit tokens stored as SHA-256 hashes. Codes are 6 digits, peppered SHA-256, 15-minute TTL, 5 attempts, 5 codes / 15 min, single use. Sign-in responses do not reveal whether an email has an account. An account claims opportunities from accepted Prominent intake submissions with the same email; operators may grant more.

## Routes
- `POST /api/internal/seller-portal/{sign-in-start|sign-in-verify|sign-out|state|messages|messages-send|call-slots|call-book|document-link}` — `x-seller-portal-secret` (SELLER_PORTAL_INTERNAL_SECRET), seller token in `x-seller-session`. Disabled unless `SELLER_PORTAL_ENABLED=1`.
- `GET|POST /api/cockpit/seller-portal/[opportunity_id]` — ops dashboard auth; list the conversation, `reply`, `share` a document.

## Environment
`SELLER_PORTAL_ENABLED`, `SELLER_PORTAL_INTERNAL_SECRET`, `SELLER_PORTAL_CODE_PEPPER` (required in production), `SELLER_PORTAL_CALL_HOURS` (JSON; without it no availability is offered), `SELLER_PORTAL_OPERATOR_DIRECTORY` (JSON `{operator_key:{name,title}}`; a contact is shown only when listed), `SELLER_PORTAL_EMAIL_ENABLED`, `SELLER_PORTAL_PUBLIC_BASE_URL`, `BREVO_PROMINENT_API_KEY`.

## Not yet done
- Migration `supabase/migrations/20261002120000_seller_portal.sql` is written, **not applied**.
- The `pco-intake/v1` receiver route exists only on the WIP branch `feat/offerr-app-public-state`; until it ships, no new intake creates opportunities.
- `offer_ready` / `closing_scheduled` / `action_needed` emails are rendered but not yet triggered from the offer-send and closing flows.
- The operator dashboard has API endpoints but no UI for the seller conversation or document sharing.
