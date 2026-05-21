# AI Underwriting & SMS Agent Plan

> **Principle:** The dashboard observes. The backend executes. AI drafts, classifies, and recommends — it never sends.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    real-estate-automation backend                │
│                                                                  │
│  TextGrid Webhook ──► inbound-router ──► message_events (store)  │
│                        │                                         │
│                        ├─► suppression check                     │
│                        ├─► contact window check                  │
│                        ├─► send_queue insert                     │
│                        │                                         │
│                        ├─► AI draft request ───────────────┐     │
│                        │                                   │     │
│                        ▼                                   │     │
│                   deterministic engine ◄────────────────────     │
│                   (suppression / windows / audit / queue)        │
│                        │                                         │
│                        ▼                                         │
│                   queue processor ──► TextGrid send              │
└──────────────────────────────────────────────────────────────────┘
         │                                    ▲
         │ calls                              │ reads drafts
         ▼                                    │
┌──────────────────────────────────────────────────────────────────┐
│                     OpenCode Zen API                             │
│                                                                  │
│  endpoint: https://opencode.ai/zen/v1/chat/completions           │
│  model: big-pickle (free during preview)                         │
│                                                                  │
│  Role: receive redacted context, return drafts/scores/labels     │
│  Constraint: NO direct access to TextGrid or send infrastructure │
└──────────────────────────────────────────────────────────────────┘
         ▲
         │ displays drafts, scores, recommendations
         │
┌──────────────────────────────────────────────────────────────────┐
│                     NEXUS Dashboard (this repo)                  │
│                                                                  │
│  - AI Copilot UI shows draft responses for human approval        │
│  - Deal analyzer panel shows MAO, score, verdict                 │
│  - Read-only view of queue processor state                       │
│  - NO webhook receivers, NO direct SMS sends                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow: Inbound SMS

1. **TextGrid webhook** hits `real-estate-automation` backend (NOT dashboard)
2. Backend stores message in `message_events` (Supabase)
3. Backend runs **suppression check** (DNC, opt-out, blocked)
4. Backend checks **contact window** (local time, quiet hours)
5. If allowed, backend calls **Zen API** with redacted context
6. AI returns a **draft response** — NOT sent yet
7. Draft stored in `inbox_thread_state` as `ai_draft_ready`
8. Dashboard shows draft in Inbox UI for **human review/approval**
9. On approval, backend inserts into `send_queue`
10. **Queue processor** (existing) handles actual TextGrid send

### What AI NEVER touches:
- Suppression lists
- Contact window enforcement
- Direct TextGrid API calls
- send_queue writes
- Queue processor logic

---

## 3. AI Integration: OpenCode Zen / Big Pickle

### Endpoint
```
POST https://opencode.ai/zen/v1/chat/completions
Authorization: Bearer <ZEN_API_KEY>
```

### Model
- `big-pickle` — free during preview period
- Data sent during free period **may be used to improve the model**
- **Redact PII before sending**: replace phone numbers with `[PHONE]`, names with `[NAME]`, addresses with `[ADDRESS]`

### Redaction Layer (runs in backend before Zen call)
```
Original: "Hi John, I'm interested in 123 Main St. Call me at 555-1234"
Redacted: "Hi [NAME], I'm interested in [ADDRESS]. Call me at [PHONE]"
```

### AI Roles
| Role | Input | Output |
|------|-------|--------|
| **SMS Draft** | Redacted message + thread history + property context | Draft reply (text, < 160 chars) |
| **Intent Classifier** | Redacted message | Label: `hot_lead`, `follow_up`, `not_interested`, `wrong_number`, `dnc`, `needs_offer`, `needs_call` |
| **Sentiment Analyzer** | Thread messages | Score: -1 to +1, flags: `angry`, `urgent`, `motivated` |
| **Deal Underwriter** | Property data (non-PII) | MAO, score, verdict, comps, risk factors |
| **Dashboard Intelligence** | Aggregated metrics (no PII) | Briefings, alerts, recommendations |

---

## 4. Offer Profile System

### resolveOfferProfile
Single resolver that returns the correct offer profile based on property type:

```
resolveOfferProfile(propertyType):
  SFH (1-4 units)    → wholesale_cash_offer_sfh
  2-4 unit           → wholesale_cash_offer_multifamily_small
  5+ multifamily     → wholesale_cash_offer_multifamily_large
  Land               → wholesale_land_offer
  Commercial         → wholesale_commercial_offer
```

### Legacy Migration
- Existing `cash_offer` table/column → renamed to `legacy_cash_offer`
- `legacy_cash_offer` is **read-only**, preserved for historical reports
- New AI-underwritten offer profile becomes the **primary** source for all offer calculations
- Migration script copies existing `cash_offer` data to `legacy_cash_offer` before cutover

### Offer Profile Fields
```
{
  property_id: string
  property_type: "sfh" | "multifamily_small" | "multifamily_large" | "land" | "commercial"
  arv: number
  arv_low: number
  arv_high: number
  repairs_total: number
  repair_breakdown: { roof, kitchen, baths, flooring, paint, hvac, electrical, plumbing, other }
  assignment_fee: number
  mao: number                    // (ARV * 0.70) - repairs - assignment_fee
  mao_ceiling: number            // ARV * 0.75 (max stretch)
  asking_price: number | null
  equity: number                 // arv - repairs - asking_price
  margin_percent: number         // ((mao - asking_price) / mao) * 100
  score: number                  // 0-100
  verdict: "strong-buy" | "buy" | "maybe" | "pass"
  risk_factors: string[]
  strengths: string[]
  comps: CompResult[]
  recommendation: string
  ai_confidence: number          // 0-100, from Big Pickle
  underwritten_by: "ai" | "manual" | "hybrid"
  underwritten_at: timestamptz
  approved: boolean
  approved_by: string | null
  approved_at: timestamptz | null
}
```

---

## 5. Backend Changes (real-estate-automation)

### New Serverless Functions
| Endpoint | Purpose |
|----------|---------|
| `POST /api/ai/draft-sms` | Generate draft reply for inbound message |
| `POST /api/ai/classify-intent` | Classify message intent |
| `POST /api/ai/analyze-sentiment` | Analyze thread sentiment |
| `POST /api/ai/underwrite-deal` | Run MAO analysis + scoring |
| `POST /api/ai/dashboard-briefing` | Generate intelligence for dashboard |

### New Tables
| Table | Purpose |
|-------|---------|
| `ai_drafts` | Store AI-generated drafts awaiting approval |
| `offer_profiles` | AI-underwritten offer data (replaces cash_offer) |
| `legacy_cash_offer` | Migrated historical cash offer data |

### Modified Tables
| Table | Change |
|-------|--------|
| `inbox_thread_state` | Add `ai_draft_id`, `intent`, `sentiment_score` columns |
| `message_events` | Add `redacted_body` column |

### Redaction Utility
Shared function in backend:
```
redactForAI(text: string): { redacted: string, entities: EntityMap }
```
- Replaces phone numbers, names, addresses, emails with tokens
- Stores entity map for re-hydrating approved drafts before send
- Entity map never leaves backend, never sent to Zen API

---

## 6. Dashboard Changes (nexus-dashboard)

### What Gets Added
- **AI Copilot** reads `ai_drafts` from Supabase (read-only)
- **Deal Analyzer** calls backend `/api/ai/underwrite-deal` (proxy, no direct Zen calls)
- **Inbox UI** shows draft status, approve/reject buttons
- **Property Detail** shows offer profile with MAO breakdown

### What Stays Out
- ❌ No `api/sms-webhook.ts`
- ❌ No `api/ai-router.ts`
- ❌ No `api/deal-analyzer.ts` as serverless
- ❌ No `ZEN_API_KEY` in dashboard env
- ❌ No `TEXTGRID_API_KEY` in dashboard env
- ❌ No `SUPABASE_SERVICE_KEY` in dashboard env

### Dashboard-Only Env Vars
```
VITE_NEXUS_API_URL=          # backend base URL
VITE_NEXUS_API_SECRET=       # dashboard auth secret
VITE_SUPABASE_URL=           # Supabase project URL (anon-safe)
VITE_SUPABASE_ANON_KEY=      # Supabase anon key (anon-safe)
```

---

## 7. Safety Constraints

### Absolute Rules
1. **No direct TextGrid sends from AI** — all sends go through queue processor
2. **No PII to Zen API** — redaction layer runs before every AI call
3. **No service keys in dashboard** — dashboard uses anon key + RLS only
4. **No webhook endpoints in dashboard** — all webhooks live in backend
5. **AI output is always a draft** — human approval required before send
6. **Suppression is never bypassed** — deterministic engine checks before AI is even called
7. **Contact windows are enforced before AI** — no drafts generated outside windows
8. **Free-period data awareness** — assume Big Pickle training data may include redacted inputs

### Audit Trail
Every AI interaction logged in `ai_audit_log`:
```
{
  id: uuid
  timestamp: timestamptz
  model: string
  task_type: "draft_sms" | "classify_intent" | "underwrite" | "sentiment" | "briefing"
  input_redacted: string       // what was sent to AI
  output_raw: string           // what AI returned
  entities_held_back: number   // count of redacted entities
  approval_status: "pending" | "approved" | "rejected" | "modified"
  approved_by: string | null
  sent_via_queue: boolean
}
```

---

## 8. Migration Steps

### Phase 1: Backend Foundation
- [ ] Create `ai_drafts`, `offer_profiles`, `legacy_cash_offer` tables
- [ ] Build redaction utility
- [ ] Create Zen API client with redaction layer
- [ ] Add `ai_draft_id`, `intent`, `sentiment_score` to `inbox_thread_state`
- [ ] Migrate `cash_offer` → `legacy_cash_offer`

### Phase 2: AI Endpoints
- [ ] `POST /api/ai/draft-sms` with suppression + window gates
- [ ] `POST /api/ai/classify-intent`
- [ ] `POST /api/ai/underwrite-deal`
- [ ] `POST /api/ai/analyze-sentiment`
- [ ] `POST /api/ai/dashboard-briefing`

### Phase 3: Dashboard Integration
- [ ] Connect AI Copilot to `ai_drafts` (read-only)
- [ ] Add approve/reject UI in Inbox
- [ ] Add Deal Analyzer panel in Property Detail
- [ ] Show offer profiles instead of legacy cash offers

### Phase 4: Validation & Rollout
- [ ] Test suppression bypass prevention
- [ ] Test contact window enforcement
- [ ] Test redaction completeness
- [ ] Run parallel mode (AI drafts shown but not used)
- [ ] Gradual rollout: 10% → 50% → 100% of threads

---

## 9. Files Reverted (2026-05-02)

| File | Action | Reason |
|------|--------|--------|
| `api/sms-webhook.ts` | **Deleted** | Unsafe: direct TextGrid send, bypasses suppression |
| `api/ai-router.ts` | **Deleted** | Unsafe: backend routing in dashboard context |
| `api/deal-analyzer.ts` | **Deleted** | Unsafe: serverless underwriting in dashboard |
| `vite.config.ts` | **Reverted** | Removed AI proxy forwarder to localhost:3001 |
| `.env.example` | **Reverted** | Removed ZEN_API_KEY, TEXTGRID_API_KEY, SUPABASE_SERVICE_KEY |
| `src/lib/data/inboxData.ts` | **Kept** | Safe UI changes: metadata parsing + debug logs |

---

## 10. Model Context Note: Big Pickle Free Period

> ⚠️ During the free preview period, data sent to Big Pickle **may be used to improve the model**.

**Mitigation:**
1. Redact ALL PII before sending (phone, name, address, email, SSN, EIN)
2. Send minimal context — only what's needed for the task
3. Never send financial data (bank accounts, SSNs, deal terms with real numbers)
4. Use generic property descriptors when possible: "3bed/2bath SFR in midwest market" vs full address
5. Assume anything sent could become part of model training data

When paid tier is available, upgrade and confirm data is not retained or used for training.
