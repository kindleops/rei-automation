# Stages 1–6 — Canonical Production-Path Map

This is the **actual** inbound seller-SMS path that runs in production, traced
from the webhook entry point. Established by repo-wide caller analysis, not
assumption.

## Live chain

```
TextGrid → POST /api/webhooks/textgrid/inbound/route.js
   └─ signature verify + idempotency + webhook log + inbound message event
   └─ maybeHandleBuyerTextgridInbound()         (buyer dispo branch — not seller)
   └─ handleTextgridInbound()  [lib/flows/handle-textgrid-inbound.js]
        ├─ loadContext() / loadContextWithFallback()
        │     └─ if !context.found → handleUnknownInboundRouter()   ← "0 unowned" path
        ├─ classify(message, brain_item)         [lib/domain/classification/classify.js]
        ├─ syncClassifiedInboxThreadState()
        ├─ isNegativeReply() → cancelPendingQueueItemsForOwner()
        ├─ resolveRoute()                         [lib/domain/routing/resolve-route.js]
        ├─ buildInboundConversationState()        [communications-engine/state-machine.js]
        ├─ routeInboundOffer()  (bypassed for wrong_number / opt_out)
        ├─ offer-stage AI (dry-run)
        ├─ updateBrainAfterInbound() / master-owner / supabase second pass
        └─ executeInboundAutomationDecision()     [seller-flow/apply-inbound-automation-decision.js]
              └─ applyInboundAutomationDecision()  ← DECISION CORE (+ coverage net)
                    └─ ensureInboundCoverage()     [seller-flow/coverage/*]  ← SAFE NET (new)
```

## Canonical components (single sources of truth)

| Concern | Canonical module | Vocabulary |
|---|---|---|
| Intent classification | `classification/classify.js` → `INTENT_PRIORITY` | 19 canonical intents |
| Intent reconciliation | `seller-flow/coverage/canonical-intent-aliases.js` **(new)** | normalizes all legacy/divergent labels |
| Routing decision | `seller-flow/apply-inbound-automation-decision.js` → `ROUTE_PROFILES` + decision branches | keys on classifier intents |
| Coverage guarantee | `seller-flow/coverage/ensure-inbound-coverage.js` **(new)** | every decision covered |
| Conversation stages | `communications-engine/state-machine.js` → `CONVERSATION_STAGES` | 10 lifecycle stages |
| Granular seller stages | `seller-flow/canonical-seller-flow.js` → `SELLER_FLOW_STAGES` | ~40 micro-stages → templates |
| Contact identity | `inbox/contact-identity.js` → `resolveContactIdentityClass` | 7 identity classes |
| Unknown-number handling | `inbound/unknown-inbound-router.js` → `UNKNOWN_BUCKETS` | 10 owned buckets |
| Exception workflows | `seller-flow/coverage/exception-workflows.js` **(new)** | 10 owned workflows w/ SLA |
| Safe fallback | `seller-flow/coverage/safe-fallback.js` **(new)** | stage × uncertainty matrix |

## Feature gating (no live sends without these)

`executeInboundAutomationDecision` queue insertion is gated by:
`system_control.auto_reply_enabled` AND `auto_reply_mode ∈ {internal_only, live_limited}`
AND not emergency-stopped. Default mode is `disabled` / `dry_run`. The coverage
net is **additive only** — it never flips `should_queue_reply` /
`should_suppress_contact` / `reply_mode`, so it introduces **no new sends**.
