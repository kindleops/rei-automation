# Research trigger hook — `lc.research-trigger-hook.v1` (rc-8.5.21 part B)

The turn engine (rc-8.5.21 part A) calls this hook after it has understood an inbound
message, to enqueue autonomous property research (`property.research`, R2 runtime) for
meaningful seller events. The hook decides; the runtime enforces.

Module: `apps/api/src/lib/agent/missions/research-trigger-hook.js`
(also re-exported from `apps/api/src/lib/agent/missions/index.js`).

## Pure function

```js
import { researchTriggerFromTurn } from '@/lib/agent/missions/research-trigger-hook.js'

const t = researchTriggerFromTurn({
  property_id,          // the ONE property in scope (string | number). null ⇒ no trigger
  intents,              // string[] — deterministic + understood intents of THIS inbound
  actions,              // [{ type }] — the decision plan (SUPPRESS ⇒ no trigger)
  decision_outcome,     // e.g. 'PREPARE_OFFER' | 'NEGOTIATE_WITHIN_AUTHORITY' | null
  seller_request,       // { kind?: 'asks_offer'|'counter'|..., amount?: number|null }
  ledger_before,        // thread ledger before this inbound (canonical or factLedgerOf view) | null
  ledger_after,         // thread ledger after it | null
  ask_before, ask_after,// optional explicit asks (override the ledgers)
  our_last_offer,       // our last amount on record (counteroffer detection) | null
  now,                  // the turn clock (ms or ISO) — never read from the wall clock
})
// → { trigger, property_id, discriminator, priority, reason, version }   or   { trigger: null, reason }
```

- No I/O, no clock read, no model call. Same input ⇒ same output.
- Exactly one trigger per event, strongest first:

| trigger | when | discriminator (dedupe) | priority |
|---|---|---|---|
| `counteroffer` | `seller_request.kind === 'counter'`, a counter intent, or a seller number after our offer | `counter:<amount>` | 100 |
| `offer_request` | `seller_request.kind === 'asks_offer'`, `decision_outcome === 'PREPARE_OFFER'`, or `asks_offer` / `contract_requested` | `offer_request:<UTC day>` | 105 |
| `asking_price_revealed` | the stated ask is new or changed | `ask:<amount>` | 110 |
| `seller_interest` | an interest intent, no price | `interest:<UTC day>` | 130 |

- Never a trigger: `opt_out` / stop, `wrong_number`, an ownership denial
  (`property_specific_non_owner`, `property_correction`, `sold_property`, `former_owner_respondent`,
  `tenant_respondent`), `hostile_or_legal`, a plan containing `SUPPRESS`, or no property in scope.

## Enqueue wrapper

```js
import { enqueueResearchForTurn } from '@/lib/agent/missions/research-trigger-hook.js'
const r = await enqueueResearchForTurn(event, { store: runtimeStore, env })
// → { ok: true, job_id, deduped, trigger } | { ok: false, reason }
```

`store` is the R2 runtime store (`enqueueEvent`, i.e. `agent.runtime_enqueue_event`).
OFF twice by default:

1. code flag `PROPERTY_RESEARCH_ENABLED=1` (absent ⇒ `PROPERTY_RESEARCH_DISABLED`, nothing enqueued);
2. the database refuses (`kind_not_armed`) until an operator arms `property.research` in
   `agent.runtime_limits.kind_limits`, and claims it only when `enabled: true`.

The event key is `sha256(property.research, trigger, encoded property ref, discriminator)`:
one job per (trigger, property, discriminator); a repeated event is `deduped`. The job input
carries an encoded property ref, never the raw id.

## What the job does (`property.research`, 8.5.21-b)

Checkpointed steps that each fit the runtime tick (default 25 s):

1. **internal** — internal data first ($0): dossier, comps + area, economics, offer plan with the
   labelled ZIP prior. If a web step is wanted but does not fit the rest of the tick, the job
   **yields** (released, no attempt burned) and the web step starts a fresh tick.
2. **web** (optional, its own step) — one bounded ask: step timeout ≤ 22 s, per-model-call
   timeout ≤ 20 s, 1 model call by default. On timeout the attempt is cancelled, its cost is
   checkpointed and the job resumes next tick (≤ 2 attempts, then internal-only). Before every
   attempt the remaining JOB budget must cover one model-call reservation (default $0.26), else
   `skipped_budget` — the job still completes with findings. Web prices are listings, never sales;
   every parsed item must cite a provider-observed URL.
3. **findings** — `property.dossier`, `property.comps_area`, `property.economics`,
   `property.offer_plan` (internal only), `property.web_evidence`, `property.research`.

Budget: an event job's `budget_cap_usd` is `kind_limits.property.research.event_budget_cap_usd`
clamped by `agent.runtime_event_budget_ceiling('property.research')` —
PROPOSED migration `PROPOSED_20261016160000_runtime_event_budget_ceilings.sql` (default 0.05 for
every kind; the owner may set `property.research` up to 0.30).

Nothing in the hook or the job sends, grants, writes a stage, a valuation or an offer.
