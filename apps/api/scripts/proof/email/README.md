# EMAIL-1 executed migration proof

`00-prereq-schema.sql` recreates the production-shaped tables the EMAIL-1
migration alters (`email_queue`, `email_senders`, `contact_outreach_state`, and
the FK target `acquisition_opportunities`), so the real §11 migration and the
real EMAIL-1 migration can be applied to a throwaway Postgres and then
interrogated.

`10-behaviour.sql` asserts what the schema DOES, not what it says.

Run it with `npm run proof:email-migration` (skips cleanly when no local
Postgres 16 is installed).

## Why this exists

The static contract test (`email-channel-migration-contract.test.mjs`) passed
while the migration was still incomplete. Executing it found that three
pre-existing partial unique indexes on `seller_logical_communications` —
`(decision_id, communication_type)`, `(campaign_target_id, touch_number)` and
`(seller_offer_id, seller_offer_version, communication_type)` — are channel-blind.
Adding `channel` to the logical key alone moved the cross-channel collision from
the hash to the index: the second channel's insert produced a different key and
then died on `uq_seller_logical_communications_campaign_touch`.

Text can only prove a migration SAYS something. This proves the database does it.
