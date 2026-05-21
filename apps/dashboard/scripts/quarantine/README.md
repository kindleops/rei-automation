# QUARANTINED SCRIPTS

These scripts mutate production backend data (send_queue, message_events, inbox_thread_state)
or modify files in real-estate-automation directly.

**They must NOT run from nexus-dashboard.**

Backend mutation scripts belong in real-estate-automation.
If you need to run a repair/backfill, run it from the real-estate-automation repo.

If you absolutely must run one of these from here (incident response only):
1. Set `NEXUS_ALLOW_BACKEND_MUTATION=true` in your shell
2. Understand what the script does before running it
3. Prefer dry-run mode first

## Files quarantined here:

- `patch-feeder.mjs` — Modifies JS source files in ../real-estate-automation directly. FORBIDDEN.
- `patch-feeder-v2.mjs` — Same as above. FORBIDDEN.
- `run-real-feeder-test.ts` — Directly invokes real-estate-automation feeder in live mode.
