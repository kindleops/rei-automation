# Backend Architecture — REI Automation API

**Audit Date:** 2026-06-13  
**App:** `apps/api` (Next.js App Router, deployed)  
**Total lib files:** 380 JS files across 73 categories

---

## A. API Route Graph

### Route Namespaces

```mermaid
graph TD
    API["/api/*"]
    API --> COCKPIT["/cockpit/*\n(Frontend-facing UI routes)"]
    API --> INTERNAL["/internal/*\n(Automation & cron routes)"]
    API --> WEBHOOKS["/webhooks/*\n(External event receivers)"]
    API --> WORKFLOWS["/workflows/*\n(Legacy v1 workflow routes)"]
    API --> DEV["/dev/*\n(Development utilities)"]
    API --> DIAG["/diagnostics/*\n(Debug tooling)"]
    API --> INTEL["/intel/*\n(Intelligence endpoints)"]
```

### Cockpit Routes (UI-facing)

```mermaid
graph LR
    COCKPIT --> CK_INBOX["/cockpit/inbox/*\n- live\n- threads/[key]\n- thread-hydration\n- thread-dossier\n- thread-state\n- thread-messages\n- send-now\n- queue-reply\n- schedule-reply\n- auto-reply\n- counts\n- debug-tabs"]
    COCKPIT --> CK_QUEUE["/cockpit/queue/*\n- run\n- status\n- approve\n- cancel\n- hold\n- retry\n- reschedule\n- retry-routing\n- retry-failed\n- auto-enqueue\n- reconcile\n- reprocess-paused\n- cancel-stale-followups\n- run-safe-batch\n- queue-more\n- control"]
    COCKPIT --> CK_CAMP["/cockpit/campaigns/*\n- CRUD\n- build-targets\n- lifecycle\n- progress\n- queue-batch\n- queue-plan\n- preview-targets\n- field-catalog\n- filter-options\n- options"]
    COCKPIT --> CK_WF["/cockpit/workflows/*\n- CRUD\n- clone\n- dry-run\n- pause/resume\n- steps\n- sender-pools\n- template-sets"]
    COCKPIT --> CK_BUYER["/cockpit/buyer-match/*\n- property/[id]\n- candidates/[id]\n- select-buyer\n- send-package\n- watchlist\n- run"]
    COCKPIT --> CK_THREADS["/cockpit/threads/*\n- list\n- [key]\n- sync\n- sync-all\n⚠️ DUPLICATE of inbox/threads"]
    COCKPIT --> CK_DEAL["/cockpit/deal-context/*\n- route\n- counts\n- property/[id]\n- thread/[key]"]
    COCKPIT --> CK_EMAIL["/cockpit/email/*\n- overview\n- threads\n- records\n- drafts\n- templates\n- manual-send\n- brevo-health"]
    COCKPIT --> CK_PROPS["/cockpit/properties/[id]/*\n- comps\n- comps/recalculate\n- push-to-underwriting\n- run-buyer-match\n- valuation-snapshot"]
    COCKPIT --> CK_METRICS["/cockpit/metrics/war-room"]
    COCKPIT --> CK_PIPELINE["/cockpit/pipeline/counts"]
    COCKPIT --> CK_HEALTH["/cockpit/health"]
    COCKPIT --> CK_OPS["/cockpit/ops/metrics"]
    COCKPIT --> CK_WFSTEPS["/cockpit/workflow-steps/[id]"]
    COCKPIT --> CK_WFTMPL["/cockpit/workflow-template-*"]
    COCKPIT --> CK_WFPOOL["/cockpit/workflow-sender-pools/[id]/members"]
    COCKPIT --> CK_DINTEL["/cockpit/deal-intelligence/thread/[key]"]
```

### Internal Routes (Automation/Cron-facing)

```mermaid
graph LR
    INTERNAL --> IN_INBOX["/internal/inbox/*\n- send-now ⚠️ DUPLICATE\n- thread-context"]
    INTERNAL --> IN_DB_INBOX["/internal/dashboard/inbox/*\n- live ⚠️ DUPLICATE\n- thread-state ⚠️ DUPLICATE\n- offer-stage-ai"]
    INTERNAL --> IN_QUEUE["/internal/queue/*\n- run ⚠️ DUPLICATE\n- retry ⚠️ DUPLICATE\n- status ⚠️ DUPLICATE\n- reconcile\n- dry-run\n- force-due\n- seed-test\n- smoke-create"]
    INTERNAL --> IN_OB["/internal/outbound/*\n- send-now ⚠️ TRIPLICATE\n- auto-enqueue ⚠️ DUPLICATE\n- direct-send\n- queue-message\n- feed-candidates\n- feed-master-owners\n- coverage-report\n- sms-eligible-audit"]
    INTERNAL --> IN_CAMP["/internal/campaigns/*\n- rebuild-target-graph"]
    INTERNAL --> IN_BUYERS["/internal/buyers/*\n- match\n- blast"]
    INTERNAL --> IN_OFFERS["/internal/offers/*\n- create\n- recalculate\n- underwrite"]
    INTERNAL --> IN_CONTRACTS["/internal/contracts/*\n- create\n- send\n- sync"]
    INTERNAL --> IN_CLOSINGS["/internal/closings/*\n- create\n- sync"]
    INTERNAL --> IN_AI["/internal/ai-router"]
    INTERNAL --> IN_AUTO["/internal/automation/*\n- run\n- replay\n- rules\n- runs\n- ingest-event"]
    INTERNAL --> IN_AUTOPILOT["/internal/autopilot/run"]
    INTERNAL --> IN_DISCORD["/internal/discord/*"]
    INTERNAL --> IN_EMAIL["/internal/email/*\n- cockpit\n- preview\n- send-test\n- queue/run"]
    INTERNAL --> IN_OPS["/internal/dashboard/ops/*\n- auth\n- feed\n- feeder\n- filters\n- kpis\n- map\n- queue"]
    INTERNAL --> IN_MISC["/internal/*\n- acquisition/score-*\n- context/lookup-phone\n- events/sync-podio\n- maintenance/*\n- revenue/*\n- runs/*\n- title/*\n- verification/*\n- alerts/*\n- run-locks/*"]
```

### Webhooks

```mermaid
graph LR
    WEBHOOKS --> WH_TG["/webhooks/textgrid/*\n- inbound (SMS receipt)\n- delivery (status update)"]
    WEBHOOKS --> WH_BREVO["/webhooks/brevo/*\n- events\n- root"]
    WEBHOOKS --> WH_DS["/webhooks/docusign"]
    WEBHOOKS --> WH_PODIO["/webhooks/podio/hooks"]
    WEBHOOKS --> WH_DISC["/webhooks/discord/interactions"]
    WEBHOOKS --> WH_BUYERS["/webhooks/buyers"]
    WEBHOOKS --> WH_CLOSINGS["/webhooks/closings"]
    WEBHOOKS --> WH_TITLE["/webhooks/title"]
```

---

## B. Service Graph

### Core Service Layers

```mermaid
graph TD
    ROUTES["API Routes\n(~130 route handlers)"]
    COCKPIT_SVC["cockpit-service.js\n(Control Plane)"]
    DOMAIN["Domain Services\n(44 subdirectories)"]
    FLOWS["Flow Handlers\n(8 event-driven flows)"]
    SUPABASE_LAYER["Supabase Layer\n(client.js, sms-engine.js)"]
    SUPABASE_DB["Supabase Database"]

    ROUTES --> COCKPIT_SVC
    ROUTES --> DOMAIN
    ROUTES --> FLOWS
    COCKPIT_SVC --> DOMAIN
    DOMAIN --> SUPABASE_LAYER
    FLOWS --> DOMAIN
    SUPABASE_LAYER --> SUPABASE_DB
```

### Domain Service Map

```mermaid
graph TD
    DOMAIN --> ACQ["acquisition/\n(10 files)\nLead decisions, contact lifecycle,\nno-reply follow-up, delivery retry"]
    DOMAIN --> AUTO["automation/\n(10 files)\nRule eval, action exec,\nevent logging, compliance"]
    DOMAIN --> CAMP["campaigns/\n(8 files)\nState machine, execution lock,\nprogress tracking, targeting"]
    DOMAIN --> CLASS["classification/\n(2 files)\nMessage classification,\nnegative reply detection"]
    DOMAIN --> INBOX_D["inbox/\n(8 files)\nThread state, send-now,\ncontext enrichment"]
    DOMAIN --> QUEUE_D["queue/\n(12 files)\nQueue processing, validation,\nretry, safety checks"]
    DOMAIN --> SELLER["seller-flow/\n(11 files)\nAutonomous reply planning,\nconversation automation,\nfollow-up scheduling"]
    DOMAIN --> OFFERS["offers/\n(14 files)\nOffer creation, sync,\nnegotiation, follow-up"]
    DOMAIN --> BRAIN["brain/\n(5 files)\nAI conversation memory,\npost-send/post-inbound updates"]
    DOMAIN --> WF["workflows/workflow-v2/\n(15+ files)\nComplex workflow execution,\ncondition evaluation"]
    DOMAIN --> BUYERS_D["buyers/\n(5 files)\nBuyer matching,\nresponse classification, blast"]
    DOMAIN --> COMMS["communications-engine/\n(1 file)\nState machine for message flows"]
    DOMAIN --> CONTEXT["context/\n(8 files)\nContext loading (4 overlapping impls)"]
    DOMAIN --> DELIVERY["delivery/\n(2 files)\nSMS delivery state, health guards"]
    DOMAIN --> EVENTS_D["events/\n(8 files)\nEvent logging, idempotency"]
    DOMAIN --> COMPLIANCE["compliance/\n(2 files)\nSuppression, phone validation"]
    DOMAIN --> MASTER["master-owners/\n(5 files)\nOwner feeding, follow-up timing"]
    DOMAIN --> ROUTING["routing/\n(4 files)\nMessage routing decisions"]
```

### Duplicate Service Logic

```mermaid
graph TD
    subgraph "Auto-Reply (3 paths — CRITICAL DUPLICATE)"
        AR1["queueAutoReply.js\n(automation/)"]
        AR2["execute-autonomous-reply.js\n(seller-flow/)"]
        AR3["resolve-seller-auto-reply-plan.js\n(seller-flow/)"]
        AR3 --> AR2
        AR1 --> SQ["send_queue INSERT"]
        AR2 --> SQ
    end

    subgraph "Context Loading (4 implementations)"
        CL1["load-context.js (basic)"]
        CL2["load-context-with-fallback.js (retry)"]
        CL3["thread-context-service.js (inbox)"]
        CL4["enrich-message-event-context.js (enrichment)"]
    end

    subgraph "Follow-Up Scheduling (2 implementations)"
        FS1["no-reply-followup-scheduler.js\n(acquisition)"]
        FS2["seller-followup-scheduler.js\n(seller-flow)"]
        FS1 --> SQ2["send_queue scheduled INSERT"]
        FS2 --> SQ2
    end

    subgraph "Queue Message Insertion (2 implementations)"
        QI1["queue-outbound-message.js\n(flow-level)"]
        QI2["campaign-automation-service.js\n(campaign-level)"]
        QI1 --> SQ3["send_queue INSERT"]
        QI2 --> SQ3
    end

    subgraph "Reply Validation (2 implementations)"
        RV1["reply-sms-safety-checks.js\n(Discord context)"]
        RV2["queue-control-safety.js\n(queue rate limiting)"]
    end
```

---

## C. Workflow Graph

### Lead-to-Closing Pipeline

```mermaid
graph TD
    LEAD["Lead Ingested\n(Podio sync / webhook)"]
    CLASSIFY["Classification\n(classify.js)\nPositive / Negative / Neutral"]
    ROUTE["Routing Decision\n(routing-decisions table)"]
    QUEUE["Send Queue\n(send_queue table)\n55+ service consumers"]
    SEND["SMS Send\n(Textgrid provider)"]
    INBOX["Inbox Thread\n(operator reviews)"]
    AUTO["Automation Engine\n(automation-engine.js)"]
    OFFER["Offer Creation\n(offers/create)"]
    BUYER["Buyer Match\n(buyer-match engine)"]
    CONTRACT["Contract\n(DocuSign)"]
    CLOSING["Closing\n(closing service)"]

    LEAD --> CLASSIFY
    CLASSIFY -->|positive intent| ROUTE
    CLASSIFY -->|negative/DNC| SUPPRESS["Suppression\n(sms_suppression_list)"]
    ROUTE --> QUEUE
    QUEUE --> SEND
    SEND --> INBOX
    INBOX --> AUTO
    AUTO -->|auto-reply eligible| SELLER_FLOW["seller-flow\n(autonomous reply)"]
    SELLER_FLOW --> QUEUE
    AUTO -->|escalate| OPS["Human Review\n(operator)"]
    OPS --> INBOX
    INBOX -->|offer signal| OFFER
    OFFER --> BUYER
    BUYER -->|match found| CONTRACT
    CONTRACT --> CLOSING
```

### Campaign Execution Flow

```mermaid
graph TD
    CAMP_CREATE["Campaign Created\n(/cockpit/campaigns POST)"]
    BUILD_TARGETS["Build Targets\n(build-targets route)\nRefresh target graph"]
    PREVIEW["Preview\n(queue-plan route)"]
    APPROVE["Approve\n(queue-batch route)"]
    CAMP_SM["Campaign State Machine\n(campaign-state-machine.js)\npending→active→paused→complete"]
    EXEC_LOCK["Execution Lock\n(campaign_acquire_execution_lock RPC)"]
    CAMP_AUTO["campaign-automation-service.js\nBatch queue insertion"]
    SEND_QUEUE["send_queue table\nINSERT per target"]
    PROCESS["process-send-queue.js\nSMS delivery"]

    CAMP_CREATE --> BUILD_TARGETS
    BUILD_TARGETS --> PREVIEW
    PREVIEW --> APPROVE
    APPROVE --> CAMP_SM
    CAMP_SM --> EXEC_LOCK
    EXEC_LOCK --> CAMP_AUTO
    CAMP_AUTO --> SEND_QUEUE
    SEND_QUEUE --> PROCESS
```

### Inbound SMS Flow

```mermaid
graph TD
    TG_HOOK["/webhooks/textgrid/inbound"]
    FLOW["handle-textgrid-inbound.js\n(flows/)"]
    CLASSIFY2["classification/classify.js\nNLP intent detection"]
    BRAIN_UPDATE["brain/ updates\n(AI memory)"]
    AUTO2["automation-engine.js\nRule evaluation"]
    THREAD_STATE["inbox_thread_state\n(state update)"]
    NOTIFY["Discord notification\n(alerts)"]
    REPLY_PLAN["resolve-seller-auto-reply-plan\n(if eligible)"]
    QUEUE2["send_queue\n(auto-reply queued)"]

    TG_HOOK --> FLOW
    FLOW --> CLASSIFY2
    FLOW --> BRAIN_UPDATE
    FLOW --> AUTO2
    AUTO2 --> THREAD_STATE
    AUTO2 --> NOTIFY
    AUTO2 -->|auto-reply| REPLY_PLAN
    REPLY_PLAN --> QUEUE2
```

---

## D. Cockpit Service — Canonical Control Plane

**File:** `src/lib/cockpit/cockpit-service.js`

| Function | Tables | Actions |
|----------|--------|---------|
| `getCockpitHealth()` | none | Reads feature flags |
| `getCockpitQueueStatus()` | send_queue | COUNT by status |
| `runQueueAction()` | send_queue | approve, cancel, retry, hold, reschedule, retry-routing |
| `runInboxAction()` | inbox_thread_state | send-now, queue-reply, schedule-reply, auto-reply |
| `patchThreadStateSafe()` | inbox_thread_state | UPSERT allowed fields |

**Allowed patch fields (whitelist):** is_read, is_pinned, is_archived, assigned_user, manual_review, conversation_status, seller_stage, temperature, autopilot_mode, wrong_number, opt_out, not_interested, suppression_status, unread_count

**Forbidden patch fields (blacklist):** seller_status, seller_state, is_hot_lead, positive_flag, classification

---

## E. Flow Handlers (`src/lib/flows/`)

| File | Trigger | Responsibility |
|------|---------|----------------|
| `handle-textgrid-inbound.js` | Inbound SMS webhook | Route incoming messages, classify, trigger automations |
| `handle-textgrid-delivery.js` | Delivery status webhook | Update queue item delivery state |
| `handle-brevo-event.js` | Email status webhook | Update email delivery state |
| `handle-buyer-match.js` | Buyer match trigger | Run geospatial match algorithm |
| `handle-closing.js` | Closing webhook | Process closing milestone |
| `handle-docusign.js` | DocuSign webhook | Contract signature events |
| `queue-outbound-message.js` | Queue action | Route outbound message to queue |
| `unknown-inbound-router.js` | Unknown sender | Route unknown contacts |
