# Acquisition Brain — Architecture Map (v1)

**Status:** Living document. PR A lands the Stage 1–10 lifecycle + NBA registry only.  
**Public automation:** unchanged / not activated by this work.  
**PR #29:** merged (`578fae13`) — E.164 routing, supersession, contact-window deferral, Stage 3 routing.

## 1. End-to-end path (current production)

```
TextGrid inbound webhook
  → handle-textgrid-inbound.js
  → normalizeInboundTextgridPhone (E.164 only)
  → resolveCanonicalInboundThreadKey (archived alias redirect)
  → beginIdempotentProcessing (message dedupe)
  → loadContextWithFallback
  → classify.js (sole classifier)
  → processSellerInboundMessage
      → cancelPendingFollowUpsForThread (inbound takeover)
      → normalizeClassificationContract
      → run-inbound-intelligence-phase / fact extraction
      → apply-inbound-automation-decision
          → route profiles + lifecycle resolver
          → selectSafeAutoReplyTemplate (sms_templates → limited local fallback)
          → queue auto_reply row
  → process-send-queue
      → evaluateContactWindow → buildContactWindowDeferral
      → TextGrid send
      → finalizeSendQueueSuccess (+ provider_attempts on retry)
  → delivery webhook → delivery reconciliation
  → maybeScheduleFollowUpAfterDelivery
  → syncClassifiedInboxThreadState / cross-view hydration
  → Workflow Studio / automation_events (partial)
```

## 2. Canonical ownership (target)

| Decision | Authority (target) | Current module |
|----------|-------------------|----------------|
| Phone normalize | `normalizeInboundTextgridPhone` | textgrid.js |
| Thread identity | `resolveCanonicalInboundThreadKey` | resolve-canonical-inbound-thread.js |
| Classification | `classify.js` only | classify.js |
| Lifecycle stage | **Acquisition Brain lifecycle registry** | NEW + legacy SELLER_FLOW_STAGES |
| Next-best action | **Acquisition Brain NBA resolver** | NEW + resolve-seller-auto-reply-plan / apply-inbound |
| Template body | OCC `sms_templates` | selectSafeAutoReplyTemplate |
| Contact window | evaluateContactWindow + deferral | sms-engine + contact-window-deferral |
| Supersession | cancelSupabasePendingOutbound INBOUND_TAKEOVER | cancel-supabase-pending-outbound.js |
| Follow-up | delivery-triggered-followup + followup-policy-registry | seller-flow |
| Stages 7–10 advance | Authoritative transaction events only | lifecycle-registry.js |

## 3. Duplicate / legacy paths

- `SELLER_FLOW_STAGES` (granular) vs `ACQUISITION_STAGES` (5-stage) vs **new 10-stage** registry
- `resolve-seller-auto-reply-plan` vs `apply-inbound-automation-decision` ROUTE_PROFILES
- `queueAutoReply.js` Discord path vs seller orchestration
- Workflow-v2 follow-up-service vs seller-followup-scheduler
- Local template negotiation fallback excludes Stage 3 (DB path is canonical)

## 4. PR sequence

| PR | Scope |
|----|--------|
| **A (this)** | Lifecycle 1–10 registry + NBA pure resolver + tests + architecture map |
| B | Fact/provenance store + multi-label classification contract |
| C | Burst controller + timing + supersession hardening |
| D | Follow-up engine unification |
| E | Seller Intelligence Profile + temperature |
| F | Observability / Workflow Studio decision timeline |
| G | Corpus + full-journey simulation harness |

## 5. Hard rules

1. One production classifier: `classify.js` (no new LLM).
2. No hardcoded outbound bodies in the classifier.
3. Stages 7–10 never advance from seller text alone.
4. Opt-out / wrong-number always suppress.
5. Stronger inbound supersedes weaker pending replies (`superseded_by_newer_inbound`).
6. Outside contact hours: classify + facts immediately; send deferred (`deferred_contact_window`).
