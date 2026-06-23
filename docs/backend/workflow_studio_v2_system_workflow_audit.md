# Workflow Studio V2 — System Workflow Audit

Generated: 2026-06-22T20:18:49.677Z
Source: live cockpit workflow catalog + detail APIs (audit-only, no mutations).

## Seller Journey S1–S6 Mapping

| Stage | Canonical Workflow | Workflow ID | Trigger | Nodes | Edges | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Stage 1 — Ownership | Ownership Verification | e19c6dc8-b5b5-43b6-8d9c-13ed3eaa934a | trigger.classification_completed | 11 | 11 | mapped |
| Stage 2 — Interest | Interest Qualification | 32fa7116-af98-41d0-ad54-26f1bf24f587 | trigger.ownership_confirmed | 13 | 15 | mapped |
| Stage 3 — Pricing | Asking Price Extraction | f08d1622-0f0d-4b7b-a623-f4770990926f | trigger.interest_confirmed | 13 | 15 | mapped |
| Stage 4 — Underwriting | Underwriting Collection | 7acaa9dc-7943-40ce-b376-a078742d4979 | trigger.asking_price_extracted | 13 | 14 | mapped |
| Stage 5 — Offer Engine | Acquisition Engine Orchestration | c4609f16-260e-4e8f-95a4-aeb9f0f51196 | trigger.underwriting_fact_updated | 12 | 14 | mapped |
| Stage 6 — Contract-to-Close | Offer Follow-Up | f7c77fe9-e699-44a9-8330-975434ddb34c | trigger.offer_sent | 13 | 12 | BLOCKED (pipeline/calendar not wired) |

## Full Workflow Inventory

| ID | Name | Enabled | Lifecycle | Version | Trigger | Nodes | Edges | Val Err | Val Warn | System | Legacy | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| c4609f16-260e-4e8f-95a4-aeb9f0f51196 | Acquisition Engine Orchestration | no | published | 2 | trigger.underwriting_fact_updated | 12 | 14 | 0 | 0 | yes | no | 2026-06-21T02:54:58.615896+00:00 |
| f08d1622-0f0d-4b7b-a623-f4770990926f | Asking Price Extraction | no | published | 2 | trigger.interest_confirmed | 13 | 15 | 0 | 0 | yes | no | 2026-06-21T02:54:50.654958+00:00 |
| 660fd911-a7cc-4806-ac24-1b93fe2548b6 | Delivery Recovery | no | published | 2 | trigger.message_failed | 14 | 16 | 0 | 0 | yes | no | 2026-06-21T02:54:36.172789+00:00 |
| 98c4fb1b-4598-41b0-84f4-5018a3367da9 | Human Review Escalation | no | published | 2 | trigger.classification_completed | 12 | 12 | 0 | 0 | yes | no | 2026-06-21T02:55:19.615074+00:00 |
| b7f45492-4bdb-45e9-afc5-8d6b2b58b2b5 | Inbound Classification | no | published | 2 | trigger.inbound_message_received | 14 | 13 | 0 | 0 | yes | no | 2026-06-21T02:54:39.814407+00:00 |
| 32fa7116-af98-41d0-ad54-26f1bf24f587 | Interest Qualification | no | published | 2 | trigger.ownership_confirmed | 13 | 15 | 0 | 0 | yes | no | 2026-06-21T02:54:46.849332+00:00 |
| 82a08034-c1a5-4eeb-9623-dab7e1527b52 | Master Acquisition Orchestrator | no | published | 2 | trigger.manual_enrollment | 18 | 17 | 2 | 0 | yes | no | 2026-06-21T02:55:24.455397+00:00 |
| 133ea14f-cb2e-4b40-83d3-218ec7d78571 | Nurture/Reactivation | no | published | 2 | trigger.pipeline_stage_changed | 10 | 9 | 0 | 0 | yes | no | 2026-06-21T02:55:13.35729+00:00 |
| f7c77fe9-e699-44a9-8330-975434ddb34c | Offer Follow-Up | no | published | 2 | trigger.offer_sent | 13 | 12 | 0 | 0 | yes | no | 2026-06-21T02:55:02.181895+00:00 |
| 239eb9d9-be17-42b1-885c-0c2e9ba525ff | Opt-Out/Suppression | no | published | 2 | trigger.inbound_message_received | 10 | 9 | 0 | 0 | yes | no | 2026-06-21T02:55:16.255884+00:00 |
| a0b497b2-2cd0-4241-b396-e315b82118eb | Owner Acquisition Follow-Up | no | draft | 1 | — | 0 | 0 | 1 | 1 | no | no | 2026-06-21T02:49:33.438755+00:00 |
| 41fdc8a9-87ae-42ac-8b5d-359d757dde85 | Owner Acquisition Follow-Up | no | draft | 1 | — | 0 | 0 | 1 | 1 | no | no | 2026-06-21T02:41:03.410174+00:00 |
| e19c6dc8-b5b5-43b6-8d9c-13ed3eaa934a | Ownership Verification | no | published | 2 | trigger.classification_completed | 11 | 11 | 0 | 0 | yes | no | 2026-06-21T02:54:42.968586+00:00 |
| d8467f35-8092-461a-a3b1-a0ceb284cdc5 | Stage-Aware No-Reply | no | published | 2 | trigger.follow_up_due | 12 | 14 | 0 | 0 | yes | no | 2026-06-21T02:55:10.550832+00:00 |
| 93074370-706d-4725-bc25-db71dba58324 | Test WF1: trigger -> update_status | yes | active | 1 | lead_entered_workflow | 2 | 1 | 0 | 0 | no | no | 2026-06-12T05:51:09.826003+00:00 |
| b99def78-52f1-4f69-8860-20b54688d84f | Test WF2: trigger -> timing -> update_status | yes | active | 1 | lead_entered_workflow | 3 | 2 | 0 | 0 | no | no | 2026-06-12T05:56:54.029939+00:00 |
| 7acaa9dc-7943-40ce-b376-a078742d4979 | Underwriting Collection | no | published | 2 | trigger.asking_price_extracted | 13 | 14 | 0 | 0 | yes | no | 2026-06-21T02:54:54.695052+00:00 |
| bcc0d666-f8f8-4cff-8fbc-c31c7758dca2 | Wrong Number Recovery | no | published | 2 | trigger.inbound_message_received | 12 | 12 | 0 | 0 | yes | no | 2026-06-21T02:55:05.607755+00:00 |

## Flags

- Duplicate definition keys: none detected
- Legacy V1 workflows in catalog: 0
- System templates: 14
- Workflows with validation errors: 3
- Disabled workflows expected in operator paths: review required before strategy pass
