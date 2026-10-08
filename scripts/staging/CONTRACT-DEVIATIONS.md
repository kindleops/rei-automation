# Accepted staging contract deviations

| Item (production) | Staging | Why accepted |
|---|---|---|
| `inbox_thread_state.latest_message_event_id uuid` | `text` | Pre-existing branch inbox views (`canonical_inbox_threads`, …) depend on the column; no seller-portal or scheduling code reads it. Changing it would mean rebuilding unrelated inbox views on staging. |
