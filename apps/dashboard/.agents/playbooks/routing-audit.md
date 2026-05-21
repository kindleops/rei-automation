# Routing Audit

1. Run `scripts/proof-routing.mjs`.
2. Analyze any 'unknown' directions.
3. Check for 'inbound' messages that failed to group into a thread.
4. Verify that `master_owner_id` is correctly propagated for outbound responses.
