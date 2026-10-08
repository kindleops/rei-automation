# Staging dependency manifest — seller portal + shared scheduling core

Generated 2026-10-08 from production's system catalog (structure only; no rows
read). Target: preview branch `prominent-intake-staging` (`eiawfeddmmwwavzlfwia`)
of REI Automation (`lcppdrmrdfblstpcbgpf`).

## Contract tables (dependency closure, incl. foreign keys)
| Table | On branch before | Action |
|---|---|---|
| acquisition_opportunities | yes, older | +17 columns, stage/strategy CHECKs, index, closed-won trigger, ops read policy |
| acquisition_opportunity_history | yes | FK, ops read policy, authenticated SELECT |
| external_seller_intake_submissions | yes | RLS on, anon revoked |
| inbox_thread_state | yes, older | +18 columns, UNIQUE(thread_key), 9 indexes, NOT NULLs relaxed to production, legacy PUBLIC policies **removed**, production policies |
| system_control, ops_operators, notification_events, closing_activity_events, closing_milestones, email_senders, email_suppression, email_threads, seller_offers, offerr_evaluation_requests, offerr_evaluations, closing_cases, closing_title_issues, email_queue, email_inbound_messages, email_attachments | no | created exactly as production |

## Other objects
- Extensions: pgcrypto (present), btree_gist (installed by the scheduling migration).
- Enums / custom types: none used by the contract tables.
- Functions: set_updated_at, set_email_senders_updated_at, set_email_foundation_updated_at, offerr_touch_updated_at, touch_inbox_thread_state_updated_at, email_thread_touch_inbound/outbound, enforce_closed_won_authority, is_ops_operator. All checked: no pg_net/http/pg_notify/dblink/cron.
- Triggers: the 8 production triggers on these tables (updated_at, email thread touch, closed-won authority).
- Grants: anon holds nothing; authenticated exactly as production.
- Storage: private bucket `email-attachments`.

## Deliberately excluded
finalize_closing_case (needs the settlement system; closed state is seeded), every
send/queue/campaign/workflow table, pg_cron jobs, the property universe. Staging
has no `send_queue` — nothing on it can text anyone.

## Order
00_claim_staging_identity → 01_schema_parity_from_production → 02_align_preexisting_tables
→ migrations 20261009100000 → 101000 → 102000 → 103000 → seed-staff.sh → 90_synthetic_fixtures.
Applied with scripts/staging/apply.sh (plain SQL, logged in staging_guard.applied, never
recorded in supabase_migrations — a branch merge cannot carry any of it to production).
Validated with scripts/staging/validate-contract.sh (1 documented deviation).
