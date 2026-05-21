# Boundary Rules

## Hard Rules
- Dashboard cannot mutate `send_queue`, `message_events`, or `inbox_thread_state`.
- Dashboard cannot send SMS.
- Dashboard cannot classify messages.
- Dashboard cannot render templates.
- Dashboard cannot use `SUPABASE_SERVICE_ROLE_KEY`.
- API owns all seller-facing logic.
