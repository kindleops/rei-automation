# Ownership First-Touch A/B — Experiment & KPI Definitions

Experiment `ownership_first_touch_ab_v1` (internal-only, **dormant**, `status: draft`, `active: false`).

- **Variant A** (`ownership_only_A`, control): existing Stage 1 `ownership_check` template.
- **Variant B** (`ownership_interest_combo_B`, combo): `ownership_interest_combo_v1` (ownership + soft offer interest, EN + ES).

Assignment is a deterministic hash of `(experiment_id, thread_key)` (`assignVariantDeterministic`) → sticky per conversation,
recorded on the outbound attribution **before** the send. Resolves only for approved internal canary phones and only when
explicitly activated; production never activates it and no real send occurs.

## Attribution each send carries (via `automation_provenance`)

`experiment_id`, `experiment_variant_id`, `template_id`, `template_version_id` (content-hash surrogate), `template_key`,
`stage`, `classified_outcome`, `language`, `touch_number`, `parent_outbound_event_id`, `automation_origin`.

## KPI queries

These read `automation_provenance` from `send_queue.metadata` / `message_events.metadata` today; after the proposed migration
(`docs/automation/TEMPLATE_SYSTEM_AUDIT.md`) they read the promoted columns. Written against **internal-only** experiment rows —
they return nothing until the experiment runs. **No sample metrics are fabricated.**

```sql
-- Common base: internal experiment outbound sends, one row per send with its variant.
WITH exp_sends AS (
  SELECT sq.id AS queue_id,
         sq.thread_key,
         sq.provider_message_sid,
         (sq.metadata->'automation_provenance'->>'experiment_variant_id') AS variant_id,
         (sq.metadata->'automation_provenance'->>'template_version_id')    AS template_version_id,
         sq.queue_status, sq.created_at
    FROM public.send_queue sq
   WHERE sq.metadata->'automation_provenance'->>'experiment_id' = 'ownership_first_touch_ab_v1'
),
exp_replies AS (
  SELECT me.thread_key, me.provider_message_sid, me.received_at,
         me.current_stage, me.last_intent
    FROM public.message_events me
   WHERE me.direction = 'inbound'
)

-- 1. Delivered rate, 2. Response rate  (per variant)
SELECT s.variant_id,
       count(*)                                                        AS sends,
       count(*) FILTER (WHERE s.queue_status IN ('delivered'))         AS delivered,
       round(100.0 * count(*) FILTER (WHERE s.queue_status='delivered') / nullif(count(*),0), 2) AS delivered_rate,
       count(DISTINCT r.thread_key)                                    AS threads_with_reply,
       round(100.0 * count(DISTINCT r.thread_key) / nullif(count(DISTINCT s.thread_key),0), 2)     AS response_rate
  FROM exp_sends s
  LEFT JOIN exp_replies r ON r.thread_key = s.thread_key AND r.received_at > s.created_at
 GROUP BY s.variant_id;
```

Per-KPI definitions (each `GROUP BY variant_id`, over `exp_sends`/`exp_replies` + `inbox_thread_state`):

| KPI | Definition |
|---|---|
| delivered rate | `delivered / sends` (queue_status='delivered') |
| response rate | distinct threads with an inbound after the send / distinct sent threads |
| verified-owner rate | threads whose `inbox_thread_state.lifecycle_stage` advanced to `offer_interest`+ (owner confirmed) / sent threads |
| qualified-interest rate | threads with `last_intent IN ('seller_interested','asks_offer','asking_price_provided')` / sent threads |
| asking-price acquisition | threads that reached `lifecycle_stage='asking_price'` with a captured price fact / sent threads |
| opt-out rate | threads with `contactability_status='opted_out'` after the send / sent threads |
| wrong-number rate | threads with `disposition='wrong_number'` after the send / sent threads |
| messages to Stage 3 | count of sends whose thread reached `asking_price` (S3) |
| time to Stage 3 | median(`stage_entered_at(S3)` − first send) per variant |
| progression to offer | threads reaching `lifecycle_stage='offer'` (S5) / sent threads |
| progression to contract | threads reaching `lifecycle_stage='formal_contract'` (S6) / sent threads |

All comparisons are keyed on `experiment_variant_id` × `template_version_id`, so a variant's numbers are always tied to the exact
immutable template body that produced them.
