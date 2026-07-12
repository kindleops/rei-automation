# Existing Template System Audit (read-only)

Project `lcppdrmrdfblstpcbgpf`, verified 2026-07-12. No production rows were written.

## Canonical tables/views

| Object | Type | Role |
|---|---|---|
| `sms_templates` | base | canonical SMS template catalog |
| `email_templates` | base | email template catalog |
| `sms_template_kpis` | view | per-template KPI rollup (send_queue + message_events) |
| `ownership_check_template_kpis` | view | S1 ownership-check KPI rollup |
| `workflow_template_variants` | base | workflow-v2 variant rows (graph engine, dormant) |
| `send_queue` | base | outbound attribution at send time |
| `message_events` | base | inbound/outbound event attribution |

## Capability matrix (what the schema supports today)

| Capability | Supported? | Where | Gap |
|---|---|---|---|
| template identity | ✅ | `sms_templates.id` (uuid), `.template_id` (text), `.template_name`, `.podio_template_id` | — |
| immutable version | ⚠️ partial | `sms_templates.version` (mutable integer) | no immutable `template_version_id`; editing a row mutates in place, so historical sends can't be tied to the exact text they used |
| stage | ✅ | `sms_templates.stage_code`/`stage_label` | — |
| outcome / use case | ✅ | `sms_templates.use_case` | no separate `classified_outcome` (intent) dimension on the template |
| language | ✅ | `sms_templates.language` | — |
| status | ✅ | `sms_templates.is_active` | — |
| automation eligibility | ✅ | `sms_templates.safe_for_auto_reply`, `.reply_mode`, `.identity_contact_mode` | — |
| placeholders | ✅ | `sms_templates.variables` (jsonb) | — |
| experiment assignment | ❌ | none (`workflow_template_variants` is workflow-v2, not seller-template A/B) | no `experiment_assignments` table; no sticky per-thread assignment store |
| send attribution | ⚠️ partial | `send_queue.template_id/template_key/selected_template_id/template_source/use_case_template/touch_number/current_stage/language` + `metadata` jsonb | no first-class `template_version_id`, `experiment_id`, `experiment_variant_id`, `parent_outbound_event_id`, `automation_origin`, `classified_outcome` columns (all can live in `metadata` today) |
| reply attribution | ✅ | `message_events.template_id`, `.message_variant`, `.provider_message_sid`, `.stage_*`, `.language` | reply → outbound linkage is via `provider_message_sid`/thread, not an explicit `parent_outbound_event_id` |
| KPI calculation | ✅ (per template) | `sms_template_kpis` view: total_queued/sent/delivered/failed, delivery_rate, reply_rate, positive_interest_rate, ownership_confirmed_rate, price_given_rate, ask_offer_rate, time-to-reply | aggregated by `template_id` only — **not** by `template_version_id` or `experiment_variant_id`, so version/variant KPI comparison is not yet possible |

## Findings

1. **Attribution is ~70% present as first-class columns; the remainder fits in `metadata` jsonb with no migration.** The
   auto-reply insert already writes `template_id`, `selected_template_id`, `current_stage`, `use_case_template`,
   `template_source`, `language`, and a `selected_template_snapshot` (id/template_id/use_case/stage_code/language) into
   `send_queue`. Missing dimensions (`template_version`, `template_key`, `classified_outcome`, `experiment_id`,
   `experiment_variant_id`, `parent_outbound_event_id`, `automation_origin`) can be attached to the existing `metadata` jsonb
   immediately (this branch does so via a canonical `automation_provenance` block), then promoted to columns via the migration
   below when experiment KPIs are needed.

2. **No immutable template version.** `sms_templates.version` is a mutable integer; a historical send cannot be tied to the exact
   body it used. Required for defensible A/B attribution.

3. **No experiment assignment store.** Sticky per-thread A/B assignment (Mission 6) needs a table so an assignment is recorded
   before send and never changes mid-conversation.

## Minimal migration proposal (NOT APPLIED — approval required)

```sql
-- 1. Immutable template versions: one row per (template, content hash). Never updated.
CREATE TABLE IF NOT EXISTS public.template_versions (
  template_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         text NOT NULL,
  content_hash        text NOT NULL,
  template_body       text NOT NULL,
  language            text,
  use_case            text,
  stage_code          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, content_hash)
);

-- 2. Sticky experiment assignment: one active assignment per (experiment, thread).
CREATE TABLE IF NOT EXISTS public.template_experiment_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id       text NOT NULL,
  thread_key          text NOT NULL,
  variant_id          text NOT NULL,
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  assignment_source   text NOT NULL DEFAULT 'deterministic_hash',
  is_internal_only    boolean NOT NULL DEFAULT true,
  UNIQUE (experiment_id, thread_key)   -- guarantees stickiness / no mid-conversation switch
);

-- 3. Promote attribution dimensions from metadata to first-class columns for KPI joins.
ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS template_version_id     uuid,
  ADD COLUMN IF NOT EXISTS experiment_id           text,
  ADD COLUMN IF NOT EXISTS experiment_variant_id   text,
  ADD COLUMN IF NOT EXISTS parent_outbound_event_id text,
  ADD COLUMN IF NOT EXISTS automation_origin       text,
  ADD COLUMN IF NOT EXISTS classified_outcome      text;
ALTER TABLE public.message_events
  ADD COLUMN IF NOT EXISTS template_version_id     uuid,
  ADD COLUMN IF NOT EXISTS experiment_id           text,
  ADD COLUMN IF NOT EXISTS experiment_variant_id   text,
  ADD COLUMN IF NOT EXISTS parent_outbound_event_id text,
  ADD COLUMN IF NOT EXISTS automation_origin       text,
  ADD COLUMN IF NOT EXISTS classified_outcome      text;

-- 4. A KPI view keyed by (experiment_id, experiment_variant_id, template_version_id) for A/B comparison.
--    (Definition mirrors sms_template_kpis with the extra GROUP BY dimensions.)
```

No migration is applied. Until it is, the resolver writes these dimensions into `send_queue.metadata.automation_provenance`
and `message_events.metadata`, so nothing is lost and no send is blocked.
