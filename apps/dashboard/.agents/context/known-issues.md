# Known Issues & Edge Cases

## 1. Message Fragmentation
- **Issue**: Threads are grouped by `seller_phone_key` (canonical E164). If a phone number is missing or incorrectly formatted in the webhook, messages may fragment into separate threads.
- **Mitigation**: Ensure `canonical_e164` is always populated by the ingress worker.

## 2. Vercel Edge Function Timeouts
- **Issue**: Complex joins in `inbox_threads_hydrated` can lead to timeouts on large datasets (10k+ threads).
- **Mitigation**: Use limit/offset in queries and ensure indexes on `property_id` and `master_owner_id`.

## 3. Real-time Subscription Scaling
- **Issue**: Subscribing to all changes on `message_events` may become noisy as volume grows.
- **Status**: Currently using a scaffold in `src/lib/data/realtime.ts`.

## 4. Classifier False Positives
- **Issue**: Regex-based classification in `nexus_inbox_threads_v` may miscategorize "Stop" or "Wrong number" if patterns overlap.
- **Mitigation**: Follow the `classifier-tuning` skill guidelines.
