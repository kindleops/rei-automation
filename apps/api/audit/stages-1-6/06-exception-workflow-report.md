# Stages 1–6 — Exception Workflow Report

Generic "Needs Review" is replaced by **owned** workflows
(`coverage/exception-workflows.js`). Every human-review or suppression decision
is mapped to exactly one workflow, each with: owner, SLA, allowed next actions,
auto-reclassification rule, automatic fallback action, and terminal resolution.

## Registry

| Workflow | Owner | SLA | Auto-reclassify | Fallback action | Terminal | Blocks outreach |
|---|---|---|---|---|---|---|
| `identity_clarification` | acquisition_rep | 24h | yes | send_identity_clarifier | suppress_unverified_after_2_attempts | no |
| `ambiguous_context` | acquisition_rep | 12h | yes | send_safe_clarifier | nurture_then_close_after_no_response | no |
| `legal_compliance_hold` | compliance_officer | 4h | no | hold_no_automated_reply | suppress_contact | **yes** |
| `safety_hold` | safety_officer | 4h | no | hold_no_automated_reply | suppress_contact | **yes** |
| `language_unsupported` | ops_triage | 24h | yes | send_language_clarifier | nurture_then_close_after_no_response | no |
| `attachment_manual_processing` | ops_triage | 24h | no | acknowledge_receipt_clarifier | close_after_acknowledged | no |
| `conflicting_property_identity` | acquisition_rep | 24h | yes | send_property_clarifier | suppress_unverified_after_2_attempts | no |
| `technical_classification_failure` | engineering_oncall | 2h | yes | replay_classification | route_to_ambiguous_context | no |
| `duplicate_out_of_order` | ops_triage | 6h | yes | ignore_duplicate | auto_resolved_duplicate | no |
| `suppression_confirmed` | compliance_officer | 1h | no | confirm_suppression | suppress_contact | **yes** |

## Reason → workflow mapping (from live decision reason strings)

`opt_out` / `wrong_number` / `wrong_person` → `suppression_confirmed`;
`hostile_or_legal` → `safety_hold`; `legal*` / `timing_complaint*` →
`legal_compliance_hold`; `missing_context` / `identity_unclear` →
`identity_clarification`; `property_correction` → `conflicting_property_identity`;
`unclear*` / `ambiguous_intent` / `reaction_only` / `acknowledgement` /
`confidence_or_policy_block` / `unhandled_classification` → `ambiguous_context`;
`language_unsupported` → `language_unsupported`; `attachment`/`mms` →
`attachment_manual_processing`; `missing_classification` /
`conversation_resolution_failed` → `technical_classification_failure`;
`duplicate`/`out_of_order` → `duplicate_out_of_order`. **Unmapped → `ambiguous_context`** (still owned).

## Tracking surface (recommended dashboard reads)

- open exception count by workflow
- oldest open item per workflow vs SLA deadline (`exception_sla_deadline`)
- SLA-breach count
- resolution rate per workflow
- auto-fallback fired count

These map to fields already attached to each decision (`exception_workflow.key`,
`exception_workflow.owner`, `exception_sla_deadline`, `scheduled_next_action`).
