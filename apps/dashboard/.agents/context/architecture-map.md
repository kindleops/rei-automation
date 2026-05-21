# Architecture Map: Inbox Data Flow

## 1. Ingress Path
1. **Webhook**: TextGrid/Twilio sends POST to `/api/translate`.
2. **Persistence**: Ingress worker writes raw payload to `message_events`.
3. **Normalization**: `canonical_e164` and `direction` are set.

## 2. Transformation Layer (Supabase Views)
1. **`deduped_message_events`**: Removes exact duplicates from multi-region webhook retries.
2. **`nexus_inbox_threads_v`**: 
    - Groups by `seller_phone_key`.
    - Computes `last_message_at`.
    - Runs regex-based priority classification (Hot/Warm/Cold/DNC).
3. **`inbox_threads_hydrated`**: 
    - Joins `properties` (for address/status).
    - Joins `prospects` (for lead names).
    - Joins `master_owners` (for assignee info).

## 3. Presentation Layer
1. **`src/lib/data/inboxData.ts`**: Fetches from `inbox_threads_hydrated`.
2. **`src/modules/inbox/inbox.adapter.ts`**: Maps DB records to UI `Thread` models.
3. **React Components**: Renders the inbox sidebar and message panel.
