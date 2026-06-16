# Master System Map — REI Automation Platform

**Audit Date:** 2026-06-13  
**Platform:** Nexus REI Automation  
**Production URL:** ops.leadcommand.ai

---

## Executive Architecture

```mermaid
graph TD
    subgraph "Frontend (Vite + React)"
        UI["Dashboard\napps/dashboard\n~420 source files\n37 CSS files\n16 views"]
    end

    subgraph "Backend (Next.js App Router)"
        API["API Layer\napps/api\n~130 routes\n380 lib files"]
    end

    subgraph "Database (Supabase / PostgreSQL)"
        DB["Supabase\n~60 tables\n16 views\n15 RPCs"]
    end

    subgraph "External Services"
        TG["TextGrid\n(SMS delivery)"]
        BREVO["Brevo\n(Email delivery)"]
        DS["DocuSign\n(Contracts)"]
        PODIO["Podio\n(CRM sync)"]
        DISC["Discord\n(Ops alerts)"]
        AI["Claude / Gemini\n(AI decisions)"]
    end

    UI -->|"API calls /cockpit/*"| API
    UI -->|"⚠️ 44 files direct"| DB
    API -->|"service_role"| DB
    API --> TG
    API --> BREVO
    API --> DS
    API --> PODIO
    API --> DISC
    API --> AI
    TG -->|"webhook inbound/delivery"| API
    BREVO -->|"webhook events"| API
    DS -->|"webhook signature"| API
    PODIO -->|"webhook hooks"| API
```

---

## Frontend Architecture

```mermaid
graph TD
    App["App.tsx\n(Auth gate)"]
    CCA["CommandCenterApp.tsx\n(Master: routing, keyboard,\ntheme, command palette)"]

    App --> CCA

    CCA --> INBOX["Inbox Module\n(largest: 13 CSS files,\n50+ components)"]
    CCA --> MAP["Map View\n(MapLibre)"]
    CCA --> QUEUE["Queue View"]
    CCA --> PIPELINE["Pipeline View"]
    CCA --> ANALYTICS["Analytics"]
    CCA --> CALENDAR["Calendar"]
    CCA --> CAMPAIGNS["Campaign Command"]
    CCA --> EMAIL["Email Command"]
    CCA --> WORKFLOW["Workflow Studio"]
    CCA --> BUYER["Buyer Match"]
    CCA --> INTEL["Deal Intelligence"]
    CCA --> CLOSING["Closing Desk"]

    CCA --> CMDPAL["⌘K Global Command\n(7 search providers)"]
    CCA --> COPILOT["⌘J AI Copilot"]

    INBOX --> AIC["ai-command-center.ts\n(13 thread intel scores)"]
    INBOX --> AUE["autonomy-engine.ts\n(market autonomy model)"]
    INBOX --> STORE["inbox-store.ts\n(reducer state)"]
```

---

## Backend Architecture

```mermaid
graph TD
    COCKPIT_NS["/cockpit/* routes\n(UI-facing, ~80 routes)"]
    INTERNAL_NS["/internal/* routes\n(automation/cron, ~50 routes)"]
    WEBHOOK_NS["/webhooks/* routes\n(external events, ~10 routes)"]

    COCKPIT_NS --> COCKPIT_SVC["cockpit-service.js\n(Control plane)"]
    COCKPIT_SVC --> INBOX_D["domain/inbox/\n(thread state, send-now)"]
    COCKPIT_SVC --> QUEUE_D["domain/queue/\n(queue processing)"]

    INTERNAL_NS --> FLOWS["flows/\n(event-driven handlers)"]
    WEBHOOK_NS --> FLOWS

    FLOWS --> AUTO["domain/automation/\n(rule evaluation)"]
    FLOWS --> SELLER["domain/seller-flow/\n(autonomous replies)"]
    FLOWS --> CAMP["domain/campaigns/\n(campaign execution)"]
    FLOWS --> BRAIN["domain/brain/\n(AI memory)"]

    AUTO --> QUEUE_D
    SELLER --> QUEUE_D
    CAMP --> QUEUE_D
    QUEUE_D --> SMS_ENG["supabase/sms-engine.js\n(low-level primitives)"]
    SMS_ENG --> DB2["Supabase DB"]
```

---

## Lead-to-Closing Pipeline

```mermaid
graph TD
    LEAD["🏠 Lead Acquired\n(Podio sync or webhook)"]

    CLASSIFY["📊 Classification\nclassify.js\n(positive / negative / neutral)"]

    SUPPRESS["🚫 Suppression Check\ncompliance-handler.js\n(TCPA, opt-out, DNC)"]

    QUEUE_OUT["📤 Outbound Queue\nsend_queue table\n(55+ service producers)"]

    SMS_SEND["📱 SMS Delivery\nTextgrid provider"]

    INBOX_THREAD["📥 Inbox Thread\noperator workspace"]

    AI_SCORE["🤖 AI Intelligence\nai-command-center.ts\n(13 scores + recommendations)"]

    AUTO_ENGINE["⚙️ Automation Engine\nautomation-engine.js\nRule evaluation"]

    OPS_REVIEW["👤 Human Review\n(if escalated)"]

    AUTO_REPLY["💬 Autonomous Reply\nexecute-autonomous-reply.js\n→ send-now-service.js\n→ send_queue"]

    OFFER_SIGNAL["💰 Offer Signal\n(positive intent detected)"]

    OFFER["📋 Offer Creation\n/internal/offers/create"]

    BUYER_MATCH["🎯 Buyer Match\ngeospatial engine\nbuy_match_candidates"]

    CONTRACT["📝 Contract\nDocuSign envelope"]

    CLOSING["🔑 Closing\nmilestone tracking"]

    LEAD --> CLASSIFY
    CLASSIFY -->|"negative / DNC"| SUPPRESS
    CLASSIFY -->|"positive / neutral"| QUEUE_OUT
    SUPPRESS -->|"allowed"| QUEUE_OUT
    SUPPRESS -->|"blocked"| sms_suppression_list["sms_suppression_list"]
    QUEUE_OUT --> SMS_SEND
    SMS_SEND -->|"delivered"| INBOX_THREAD
    INBOX_THREAD --> AI_SCORE
    INBOX_THREAD --> AUTO_ENGINE
    AUTO_ENGINE -->|"auto-reply eligible"| AUTO_REPLY
    AUTO_ENGINE -->|"escalate"| OPS_REVIEW
    AUTO_REPLY --> QUEUE_OUT
    OPS_REVIEW --> INBOX_THREAD
    INBOX_THREAD -->|"offer keywords detected"| OFFER_SIGNAL
    OFFER_SIGNAL --> OFFER
    OFFER --> BUYER_MATCH
    BUYER_MATCH -->|"match found"| CONTRACT
    CONTRACT --> CLOSING
```

---

## Data Ownership Map

```mermaid
graph LR
    subgraph "Frontend owns (display only)"
        FE1["Thread display\n(reads message_events)"]
        FE2["Queue display\n(reads send_queue)"]
        FE3["Map pins\n(reads v_map_property_pins)"]
        FE4["Analytics\n(reads *_kpis_v views)"]
    end

    subgraph "Backend owns (canonical)"
        BE1["Thread state mutations\n(inbox_thread_state)"]
        BE2["Queue mutations\n(send_queue)"]
        BE3["Compliance checks\n(sms_suppression_list)"]
        BE4["Campaign execution\n(campaign_* tables)"]
        BE5["Workflow execution\n(workflow_* tables)"]
    end

    subgraph "⚠️ Currently Shared (risk)"
        SH1["send_queue (CRITICAL)"]
        SH2["message_events (CRITICAL)"]
        SH3["properties (HIGH)"]
        SH4["phones (HIGH)"]
        SH5["master_owners (HIGH)"]
    end
```

---

## CSS Architecture

```mermaid
graph TD
    ROOT["html[data-nexus-theme=X]"]

    ROOT --> NT["nexus-theme.css\n(canonical: all --nx-* vars\n13 theme palettes)"]
    NT --> NGS["nx-glass-system.css\n(glass morphism primitives)"]
    NT --> NUF["nx-ui-foundation-final.css\n(UI components)"]
    NT --> MR["mobile-responsive.css"]

    NUF --> INBOX_CSS["inbox-premium.css\n(PRIMARY inbox authority)"]
    INBOX_CSS --> UNI["inbox-universal.css\n(utilities)"]
    UNI --> POLISH["inbox-polish.css\n(FINAL override — last import)"]

    INBOX_CSS --> KPI["kpi-dashboard.css"]
    INBOX_CSS --> MWR["metrics-war-room.css"]
    INBOX_CSS --> CR["conversation-redesign.css"]
    INBOX_CSS --> QO["queue-ops.css"]
    INBOX_CSS --> NH["notification-hud.css"]

    NGS --> GCC["global-command.css\n(command palette)"]
    NGS --> CPV2["copilot-v2.css"]
```

---

## AI Systems

```mermaid
graph TD
    subgraph "Client-side AI (display)"
        AIC2["ai-command-center.ts\nPer-thread analysis\n13 intel dimensions\nRuns on: thread selection"]
        AUE2["autonomy-engine.ts\nMarket-level model\nCoverage + risk metrics\nRuns on: inbox load"]
    end

    subgraph "Server-side AI (decisions)"
        AI_ROUTER["/internal/ai-router\nAI decision routing"]
        CLASSIFY2["classify.js\nMessage classification\n(positive/negative/neutral)"]
        OFFER_AI["/internal/dashboard/inbox/offer-stage-ai\nOffer stage detection"]
        AUTO_BRAIN["domain/brain/\nConversation memory\n(Claude API)"]
    end

    AIC2 -->|"reads thread data"| INBOX_THREADS["inbox threads"]
    AUE2 -->|"aggregates"| AIC2
    AI_ROUTER --> CLASSIFY2
    AI_ROUTER --> AUTO_BRAIN
    CLASSIFY2 -->|"routes"| AUTO_ENGINE2["automation-engine.js"]
```

---

## Queue System

```mermaid
graph TD
    PRODUCERS["Queue Producers (24 services)"]
    PRODUCERS --> SQ_TABLE["send_queue\n(central fact table)"]

    subgraph "Producers"
        P1["campaign-automation-service"]
        P2["execute-autonomous-reply"]
        P3["queueAutoReply"]
        P4["seller-followup-scheduler"]
        P5["no-reply-followup-scheduler"]
        P6["send-now-service (manual)"]
        P7["...18 more"]
    end

    SQ_TABLE --> CLAIM["claim_queue_jobs RPC\n(atomic claim)"]
    CLAIM --> PROCESSOR["run-send-queue.js\n(main processor)"]
    PROCESSOR --> VALIDATE["validate-send-queue-item.js"]
    VALIDATE --> SMS_ENG2["sms-engine.js\n(Textgrid dispatch)"]
    SMS_ENG2 --> TG2["TextGrid API"]
    TG2 -->|"delivery webhook"| DELIVERY["handle-textgrid-delivery.js\n(status update)"]
    DELIVERY --> SQ_TABLE
```

---

## Final Statistics

| Metric | Count |
|--------|-------|
| **Total source files (frontend)** | ~420 |
| **Total source files (backend lib)** | ~380 |
| **Total API routes** | ~133 |
| **Total domain service groups** | 44 |
| **Total Supabase tables** | ~60 |
| **Total Supabase views** | ~20 |
| **Total RPCs** | 15 backend + 3 frontend direct |
| **Frontend files with direct Supabase access** | 44 |
| **Shared tables (frontend + backend)** | 15 |
| **CSS files total** | 37 |
| **CSS files targeting inbox** | 13 |
| **Duplicate ownership findings** | 30 |
| **Conflict findings** | 33 |
| **Critical risks** | 8 |
| **High risks** | 12 |
| **Total AI scoring dimensions** | 13 (per-thread) |
| **Theme modes** | 13 |
| **Queue service producers** | 24+ |

---

## Recommended Cleanup Order

**Phase 1 — Stop the bleeding (security + correctness)**
1. Add RLS to `send_queue`, `message_events`, `sms_suppression_list`, `phones`
2. Gate all `/internal/*` routes from frontend origin
3. Route all autonomous replies through `send-now-service.js`
4. Add idempotency key to `runSupabaseCandidateFeeder` (RISK-003)

**Phase 2 — Consolidate duplicates (reliability)**
5. Deprecate `/workflows/*` — migrate callers to `/cockpit/workflows/*`
6. Merge `/cockpit/threads/*` into `/cockpit/inbox/threads/*`
7. Merge `queueAutoReply.js` into `execute-autonomous-reply.js`
8. Consolidate context loading into single `loadContextWithFallback`
9. Choose canonical send-now route; deprecate 2 others

**Phase 3 — CSS consolidation (maintainability)**
10. Merge `inbox-rebuild-v2.css` into `inbox-premium.css`
11. Merge `light-theme-premium.css` into `nexus-theme.css`
12. Deprecate `queue-premium.css` in views/queue; use `queue-ops.css`
13. Document and enforce CSS import order in `InboxPage.tsx`

**Phase 4 — API migration (architecture)**
14. Move `queueData.ts` + `fetchQueueModel.ts` from direct Supabase → `/cockpit/queue/status`
15. Move `inboxData.ts` message queries → `/cockpit/inbox/thread-messages`
16. Move buyer match RPC → `/cockpit/buyer-match/property/[id]/candidates`
17. Move map pin RPC → `/internal/dashboard/ops/map`
18. Gate `dev/*` routes behind `NODE_ENV !== 'production'`

**Phase 5 — Service unification (long-term)**
19. Create `lib/domain/queue/schedule-followup.js` (unify 2 schedulers)
20. Create `InboxThreadStateService` (unify read + write)
21. Add shared data contract between `ai-command-center.ts` and `autonomy-engine.ts`
22. Formalize `lib/domain/validation/MessageValidationService.js` (unify 2 validators)
