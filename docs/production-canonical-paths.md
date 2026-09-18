# Canonical production paths (§42–44)

One implementation per capability, named, so a surface is never fixed against a
path that does not ship. Every row here was established by tracing imports and
call sites, not by filename.

**The rule.** Production users must never encounter demo, fake, placeholder,
stub, deprecated or development-only behaviour. If a capability has no real
backend, the surface shows a truthful unavailable state — it does not fabricate
a populated one.

**What this does not touch.** Tests, fixtures used only by tests, proof
harnesses, migrations, dev scripts, observability, safety gates and rollback
tooling are engineering infrastructure and stay.

---

## Resolved in this pass

### Comp Intelligence — canonical: `views/comp-intelligence/CompIntelligenceWorkspace` (V3)

`InboxPage` rendered `{COMP_V4_ENABLED ? <V4/> : <V3/>}` where

```js
COMP_V4_ENABLED = import.meta.env.DEV && localStorage['nx.comp.v4'] !== '0'
```

so **development ran V4 and production ran V3** — two generations of the same
capability selected by build mode. Every local test exercised code that never
ships; production behaviour was never exercised locally. It is why the mobile
composition measured green on deployed staging and production while rendering
nothing in dev: `.ci-m` lives under V3, and dev never mounted it.

V3 is canonical — production serves it, acquisition qualifies from it, and the
mobile composition is built on it. The switch is removed. V4 keeps its own
dev-only harness route (`devCompIntelligenceV4Route`), which is legitimate
engineering infrastructure and is not the product.

### Buyer Match — canonical: `views/buyer-match/BuyerMatchSubjectPage` (route) / `modules/inbox/components/BuyerMatchWorkspace` (pane)

Same defect, same shape: `BUYER_MATCH_V4_ENABLED` gated on `import.meta.env.DEV`.
Removed; `devBuyerMatchV4Route` retained for development.

**Demo buyer universe deleted.** `/buyer-match` used to render
`BuyerMatchView → BuyerIntelPage`, fed entirely by `referenceCommandCenterData` —
1,175 lines of hardcoded buyers, properties and markets with synthetic
`minutesAgo()` activity and a match score the page computed in a loop. A note in
`routes.tsx` said the dataset stayed "because other reference surfaces import"
it. Nothing did. The whole chain was:

```
loadBuyer()  ->  normalize-command-center  ->  command-center-data
```

`loadBuyer` had no callers; the two views that consumed it were unreachable and
imported only types. All four files are deleted rather than left one import away
from a production screen.

### Acquisition dataset (`/properties`) — canonical: Supabase reads, empty when empty

`lib/data/acquisitionData` returned `mockDataset()` — 370 lines of fabricated
owners ("Diana Alvarez", "Oakline Holdings LLC") carrying invented
`motivation_score` and legacy Podio `ai_score` — in **two runtime paths**: when
Supabase env was absent, and whenever the real queries returned zero rows across
owners/properties/prospects/phones. A genuinely empty or degraded production read
therefore rendered demo sellers, indistinguishable from real records. Replaced
with `emptyDataset()`; the surface's own empty state is the truthful answer.

### Campaign wizard — canonical: `campaignWizardAdapter` → `/api/cockpit/campaigns/*`

`explicitDevMockModeEnabled()` branched the PRODUCT route on
`import.meta.env.DEV` plus any of `VITE_CAMPAIGN_WIZARD_MOCK_MODE` /
`VITE_CAMPAIGN_TARGETING_MOCK` / `VITE_CAMPAIGN_WIZARD_USE_MOCK`. Removed — dev
harness routes are fine, hidden branching inside a product route is not.

`previewTargetsLocal` went with it, and this is the part worth recording: it was
the **only** caller. `previewTargets` *throws* on a backend error and
`CreateCampaignModal` turns that into a critical "Campaign preview failed"
notification carrying the real message. So the honest path was already the
production path, and the zeroed local preview existed solely to serve the mock
flag. `preview_unavailable` is now unreachable — the backend never sets it — so
no consumer was added for it.

Field-catalog and option lookups keep their genuine degraded fallbacks: they
return the static catalog / an empty option list with `source: 'local_fallback'`
and an operator-visible reason. Truthful degraded, VERIFIED.

### System health panel — DELETED

`SystemHealthOpsPanel` rendered a hardcoded `MOCK_SERVICES` list. A fabricated
system-health display is worse than none: it asserts the system is healthy when
nothing was measured. Zero consumers; removed.

### Recent queue events — canonical: `fetchAllQueueItems`

`RecentQueueEvents` rendered eleven hardcoded events with `Date.now()`-relative
timestamps, so they always looked like they had just happened — "Sent to …3847 —
Dallas", "Failed — …9921 Houston: TextGrid content filter", "Suppression written
— opt-out keyword STOP". It is mounted by `SendQueueDashboard` in the live
product, so an operator was reading invented delivery and COMPLIANCE events as
real. It was also a second implementation of something the product already does
properly — QueuePage's events section reads `fetchAllQueueItems`.

Now derived from that same canonical source: a row that sent, failed or was held
IS the event, and a row with no dispatch history produces none. Empty and failed
reads each say so.

### Census demographics — canonical: `public.census_geo_metrics` (currently empty)

`loadCensusForProperty` carried a `// TODO: Connect to real Supabase
census_geo_metrics table` directly above a hardcoded `mockData` object — tract
"48113000100", population 4230 — described in its own comment as "shaped exactly
like production data". Intelligence Panel ran `calculateInvestorOpportunityScore`
over it and rendered the result as demographic intelligence for the operator's
property. Every property got the same invented tract and the same invented grade.

It now queries the real table. That table is EMPTY, so the honest result is null,
which the panel already renders as "No demographic data found for this property
location." Wiring the census sync is the real fix for the feature; fabricating a
tract was not.

### Queue rows — canonical: `lib/data/queueData.fetchQueueModel`

`queue.adapter` generated **~600 fabricated queue rows** — seller names from
`FIRST_NAMES`/`LAST_NAMES`, synthetic `+1214555xxxx` destinations,
`Math.random()` timestamps, randomised `safeCapacityRemaining`,
`optOutRiskCount` and `apiPressureLevel`. `loadQueue` returned them from a bare
`catch`, so **any** failure of the real read showed the operator a Queue full of
pending sends that do not exist — on the surface that governs real outbound —
and the warning was `isDev`-only so production logged nothing.

Removed. `loadQueue` no longer catches; the route loader already renders a
truthful error state with the real message. The adapter went from ~310 lines to
a real read plus an `emptyQueueModel()` that keeps the genuine
`PRODUCTION_TEXTGRID_FLEET` market directory. Two further `adaptQueueModel()`
call sites inside `QueuePage` (both gated on missing Supabase env, so not
production-reachable) now yield an empty model and a stated reason.

---

## §55 — provider dispatch sweep

Every module that reaches the provider HTTP API: `lib/providers/textgrid.js`
and `lib/domain/delivery/delivery-polling-fallback.js` (status reads). Every
caller of `sendTextgridSMS`, classified:

| Call site | Classification |
| --- | --- |
| `lib/domain/queue/process-send-queue.js` (×2) | **canonical production dispatcher** |
| `lib/domain/inbox/send-now-service.js` | operator manual send — routes through `evaluateCanonicalSendAuthority` + `sms-health-guard`. Not a bypass. VERIFIED |
| `lib/verification/live-textgrid.js` | verification/proof tooling — KEEP |
| `app/api/dev/force-send/route.js` | dev tooling. Double-gated: `isProductionRuntime()` 404 **and** `requireDevRouteAccess`. `NODE_ENV=production` is set in the API Dockerfile, and a live probe of production returns **HTTP 404**. VERIFIED unreachable |
| `lib/supabase/sms-engine.js` | **not a sender** — imports only `normalizePhone` / `mapTextgridFailureBucket`. It is the canonical send-queue library |

No bypass defect found in product traffic.

---

## §55 — sender ownership and dispatch-time eligibility

Traced campaign → target → queue row → claim → dispatch → provider.

| Question | Answer |
| --- | --- |
| Who owns initial sender selection? | `sms-engine.selectAvailableTextgridNumber`, the one named routing authority. Called from `process-send-queue` at dispatch. |
| Where does sender identity live? | Persisted on the `send_queue` row (`from_phone_number` / `selected_from_number` / `outbound_number_phone`). `pickMessageFields` reads ONLY the row — there is no fleet fallback, so the dispatcher cannot invent one. |
| Can any layer silently replace it? | Reassignment exists and is bounded: if selection returns a different number, `reserveFromPhoneNumber` **persists** the effective sender under the row lock before dispatch, and the health guard then runs on the effective sender. It is auditable and the row reflects what executed. |
| Is the exact sender persisted with the attempt? | Yes — `message_fields.from` is carried into the dispatch seam, the provider request and the attempt/result records. |
| Do campaign and global brakes still apply? | Unchanged. Queue brakes, contact window, compliance guard, idempotency and `evaluateCanonicalSendAuthority` are all upstream of this and were not touched. |

### The defect this pass closed

`selectAvailableTextgridNumber` short-circuited on any row that already carried
`from_phone_number` and returned it **with no eligibility check at all**. Status,
cooling and daily caps were consulted only on the ROTATION branch — the one that
runs when a row has no sender. So for every normal campaign row (sender chosen at
materialization) the only dispatch-time validation was the operator blocklist in
`evaluateSmsHealthGuard`, which checks `blocked_sender_numbers` and
`blocked_template_ids` and nothing else.

Enforcement before / after:

| Dimension | Before | After |
| --- | --- | --- |
| `sms_blocked_sender_numbers` | YES (loaded fresh at dispatch) | YES |
| `blocked_template_ids` | YES | YES |
| number `status` (paused/inactive/…) | **NO** for the intended sender | YES |
| `health_state` (cooling/blocked/…) | **NO** anywhere | YES |
| `cooling_until` window | **NO** | YES |
| `daily_limit` vs `messages_sent_today` | **NO** for the intended sender | YES |

`validateQueuedOutboundNumberItem` in `process-send-queue` appeared to cover
this. It has **zero callers**, and it checks `hard_pause` / `pause_until` columns
that do not exist on `public.textgrid_numbers`.

**Ineligible now blocks rather than fails.** A sender-ineligible verdict returns
`ineligible_sender`, and `process-send-queue` parks the row as
`blocked_sender_ineligible` (or `paused_sender_eligibility_unavailable` when the
fleet read itself failed) with the intended number and reason in metadata. It is
not thrown into the provider-failure catch, so it does not consume a retry or get
filed as a transport fault for a send that never happened. No substitute sender
is chosen.

**Eligibility is deny-listed, deliberately.** Measured against the live fleet:
12 numbers, **all** `health_state:'unverified'` — including all 10 that are
`status:'active'` and sending — `registration_status` NULL on every row,
`daily_limit` 800 against a max `messages_sent_today` of 3. A gate written as
"must be healthy and registered" would have stopped every send in the system.

### Who owns sender selection — THREE selectors, now one rule

Selection happens at three moments, and the rules disagreed:

| Selector | When | status | daily cap | health / cooling |
| --- | --- | --- | --- | --- |
| `enqueue-campaign-target-one::resolveSender` | campaign materialization | yes | yes | **no** |
| `supabase-candidate-feeder::buildRoutingSelection` | candidate feed | yes | **no** | **no** |
| `sms-engine::selectAvailableTextgridNumber` | dispatch | yes | yes | yes (this pass) |

So the feeder could route a candidate to a number already at its ceiling, and
either materializer could assign a cooling one. Dispatch revalidation makes that
*safe* — the row blocks instead of sending — but the work then silently parks
rather than going to a sender that could have carried it.

All three now filter through `evaluateOutboundNumberEligibility`. The feeder was
deliberately kept from importing the campaign path (`buildRoutingSelection` is
module-private precisely so the feeder stays out of that primitive), so the
shared rule lives in `sms-engine`, which both already depend on — no cycle, and
both modules verified to still import cleanly.

One deliberate difference is retained: campaign materialization additionally
requires a configured `daily_limit > 0`. The shared evaluator treats a NULL cap
as uncapped, which is the correct reading at dispatch; a campaign should not
start scheduling against a number nobody has given a ceiling.

### The sweep is already enforced, not just audited

`tests/critical/seller-send-source-inventory.test.mjs` enumerates every provider
invocation in the tree and fails if one appears outside the permitted set: the
definition, the hard-fenced canary, the 404-in-production dev route, the buyer
blast (scoped out), and at most ONE inside the retained unreachable legacy body.
It also asserts both live paths dispatch through the canonical seam
(`dispatchSellerQueueRow`, `dispatchManualOperatorSend`) and that a manual send
establishes durable operator identity *before* dispatch.

That is a stronger guarantee than a point-in-time grep, and it independently
confirms the §55 classification above.

**Correction to an earlier conclusion in this document.**
`processLegacyQueueItemUnreachable` is NOT dead code to delete. It is
deliberately retained, and the same guard asserts both that it remains behind the
unreachable marker and that the `legacy_podio_path_fenced_by_s11` fence precedes
it. Removing it would delete a safety contract, not dead weight. It keeps its own
provider call and does not carry the new revalidation — which is correct, because
nothing can reach it.

Covered by `tests/critical/outbound-sender-authority.test.mjs` (14 cases):
healthy sends; paused/cooling/capped after enqueue refuse; cooling window opens
and closes; not-in-fleet refuses; unreadable fleet defers instead of sending;
rotation is never reached for an intended sender; rotation applies the same rules
as revalidation; an unrecognised state does not stop the fleet.

---

## Verified already canonical

| Capability | Canonical path | Note |
| --- | --- | --- |
| Acquisition scoring | `property_acquisition_scores` | Legacy Podio `properties.cash_offer` / `ai_score` / `final_acquisition_score` are screening-era, not decision authority. Already purged from the Entity Graph display layer. |
| Global search | `modules/command-center` registry + `MobileGlobalSearch` / `GlobalCommandOverlay` | One hook, one execute path, two presentations. The second search (`MobileSearchOverlay` + `useInboxTopSearch`) was removed. |
| App launcher | `modules/mobile/AppLauncher` | `WorkspaceLauncher`'s `mobileShell` mode deleted. |
| Notifications | `modules/notifications/MobileNotificationCenter` | `LeadCommandNotificationCenter`'s `mobileSheet` mode removed. |
| Cross-app context | `domain/locator/active-context` + `NavigationIntent` | URL is the only carrier. The ambient sessionStorage fallback is gone. |
| Email overview | `views/email-command/emailAdapter` | `MOCK_OVERVIEW` (nine zeros) already removed upstream. |

---

## Open — audit continuing

Listed with what is known so far. None is yet cleared, and no surface should be
built against one until it is.

- **UI truthfulness for blocked senders.** `blocked_sender_ineligible` and
  `paused_sender_eligibility_unavailable` are new queue statuses. Campaign and
  Queue surfaces must render them with the sender and reason rather than as a
  generic failure.
- **`lib/domain/buyers/send-buyer-blast.js`.** A provider send path on the BUYER
  side, explicitly scoped out by the source-inventory guard below. Not yet
  classified against §55; seller traffic is closed, buyer/disposition outreach is
  not.
- **Census ingestion.** `census_geo_metrics` exists with 40 columns and is
  EMPTY — the sync has never populated it (`census_sync_runs` exists too). The
  UI is now truthful about that; the feature itself needs the sync wired. This
  is the one item where the honest state is "unavailable" rather than "fixed".
- **Campaign / Queue / messaging duplicates.** §43's remaining list — duplicate
  campaign setup paths, queue scheduling logic, workflow writers, campaign
  feeders, notification implementations, direct provider calls that bypass the
  canonical dispatcher (§55). Not yet enumerated.
- **Entity Graph, Analytics, Live Activity.** Not yet audited for duplicate or
  fallback paths.

---

## Capability register

Status: **VERIFIED** (one canonical path, proven) · **OPEN** (work remains) ·
**BLOCKED** (correct today, but a real backend is missing).

### Seller SMS dispatch — VERIFIED
- surface `views/queue/QueuePage` · adapter `lib/data/queueData.fetchQueueModel`
- authority `lib/domain/queue/canonical-send-authority` (4 operator gates)
- sender `sms-engine.selectAvailableTextgridNumber` + `evaluateOutboundNumberEligibility`
- worker `lib/domain/queue/process-send-queue` → `dispatchSellerQueueRow` seam
- provider `lib/providers/textgrid.sendTextgridSMS`
- tables `send_queue`, `textgrid_numbers`, `message_events`
- legacy `processLegacyQueueItemUnreachable` — RETAINED, fenced, asserted by
  `seller-send-source-inventory.test.mjs`. Do not delete.

### Buyer / disposition messaging — CANONICAL, and BLOCKED on contact data
- intent `lib/domain/buyers/materialize-buyer-outreach` -> table `buyer_outreach_targets`
- destination `lib/domain/buyers/resolve-buyer-contact` (server-side, from `buyer_contacts_v2`)
- execution `sms-engine.insertSupabaseSendQueueRow` -> `send_queue` (the ONE queue)
- reconciliation `lib/domain/buyers/reconcile-buyer-outreach`, called from the
  dispatcher after finalize and from the canonical delivery-receipt path
- inbound `lib/domain/buyers/handle-inbound-buyer-reply`, called from
  `flows/handle-textgrid-inbound` BEFORE the idempotency claim
- route `api/cockpit/buyer-match/property/[property_id]/outreach` (GET state,
  POST preflight/commit; `dry_run` defaults TRUE)
- surface `views/buyer-match/mobile/BuyerOutreachSheet`

`send-buyer-blast.js` is GONE. It picked recipients in memory and called
`sendTextgridSMS` directly: no queue row, so no claim, lease or lock; no
idempotency, so a retry re-sent; no contact window, so nothing stopped a 2 AM
blast; no suppression check; and nothing durable for a receipt or a reply to
reconcile against. Buyer work now inherits all of it from the canonical queue
rather than re-implementing any of it.

Idempotency is structural, not a disabled button: the outreach row and the queue
row share a deterministic `dedupe_key` (`buyer:<property>:<buyer>:<touch>`), and
`uq_send_queue_active_dedupe_key` plus `uq_buyer_outreach_live_touch` refuse a
second LIVE touch. A double-tap, a retried request and a worker retry are all
structurally incapable of duplicating outreach.

The send kind rides in `metadata`, because **`send_queue` has no `send_kind`
column**. A top-level field would not error — `sanitizeSendQueuePayload` sweeps
unknown keys into `metadata.unknown_payload_fields` — it would quietly file the
marker where no reader looks, and every buyer row would come back out of the
database looking like seller traffic.

**BLOCKED: no buyer in production has a reachable phone number.** Measured
2026-09-18, not assumed:

    public.buyer_entities_v2      26,390 rows
    contact_enrichment_status     'not_started' on 26,390 of 26,390
    public.buyer_contacts_v2      0 rows

So preflight against the three top-ranked real buyers for property `2130387643`
returns `selected: 3, eligible: 0`, each blocked `no_contact_on_record`, and
nothing is queued or written. That is the correct and truthful product state.
The provider canary (§16-§18) is BLOCKED for the same reason and was NOT run:
there is no buyer to contact, and inventing a recipient is the one thing this
path is built to make impossible. Buyer contact enrichment is the missing
capability; the seam is complete and works the moment it lands.

The seller boundary is now WIRED, not merely written. `routeInboundBuyerReply`
existed and was correct for days while **nothing called it** — every buyer reply
would still have been processed as a seller's, and a unit test on the classifier
would have passed throughout. `tests/critical/inbound-buyer-boundary.test.mjs`
asserts the production handler calls it, and calls it before the idempotency
claim (claiming first would make a deferral a duplicate on retry and lose the
reply).

**Migration safety, counted after applying (2026-09-18):**

    buyer_outreach_targets rows                0
    buyer_outreach_targets columns            26  (4 added this pass, all additive)
    rows with replied_at                       0
    send_queue rows total                 18,092  (unchanged)
    send_queue rows with buyer domain          0
    sms_suppression_list total               331  (unchanged)
    suppressions sourced inbound_buyer_opt_out  0

No existing row was rewritten and no existing table was altered other than by
`ADD COLUMN IF NOT EXISTS`. Every buyer count is zero because nothing has been
sent — which is the expected state while contact enrichment is `not_started`,
and is the number to watch when it lands.


### Campaign Command — canonical path (traced 2026-09-18)

    Campaign Command mobile   views/campaign-command/mobile/CampaignCommandMobile
    builder                   views/campaign-command/CreateCampaignModal
                              (+ mobile/CampaignBuildMobile | ReachMobile | LaunchMobile)
    draft persistence         campaign-builder-launch.buildCampaignPersistPayload
                              -> POST /api/cockpit/campaigns
                              -> campaign-automation-service.createCampaign
                              -> normalizeCampaignInput -> public.campaigns
    rehydration               campaign-builder-launch.hydrateLaunchSettings
    audience                  POST /api/cockpit/campaigns/preview-targets
                              -> campaign-field-filter-compiler (locked catalog)
    targets                   POST /api/cockpit/campaigns/[id]/build-targets
                              -> public.campaign_targets
    SCHEDULE (canonical)      POST /api/cockpit/campaigns/[id]/lifecycle
                              { action: 'schedule', scheduled_for }
                              -> applyCampaignLifecycleAction
                              -> campaign-state-machine.transitionCampaignStatus
                              -> RPC campaign_transition_status  (advisory-locked)
                              -> campaigns.status='scheduled' + campaigns.scheduled_for
    activation (scheduled)    cron */5 -> GET /api/internal/campaigns/activate-due
                              -> runDueScheduledCampaignActivations
                              -> campaign-activation-orchestrator.activateCampaignNow
    activation (now)          same orchestrator — ONE activation authority
    queue materialization     createCampaignQueuePlan
                              -> sms-engine.insertSupabaseSendQueueRow -> public.send_queue
    execution                 process-send-queue (claim/lease, contact window,
                              suppression, sender revalidation, canonical send
                              authority, emergency stop) -> sendTextgridSMS
    provider result           finalizeSendQueueSuccess / Failure
    delivery                  reconcileDeliveryReceipt (RPC or local)
    inbound                   flows/handle-textgrid-inbound

**Authority.** `campaigns` owns the campaign; `campaign_targets` owns the target;
`send_queue` owns the touch and its execution; `campaign_transition_status` (a
DB function, advisory-locked) owns every status change AND the schedule. The
schedule is not a second state machine: `scheduled_for` is only meaningful
paired with `status='scheduled'`, and one RPC writes both.

**FIXED this pass.**

`callBackend` had NO request deadline. Any surface awaiting it stayed in
`loading` forever when the upstream neither answered nor refused — the mechanism
behind "Campaign Command hangs in readiness". The error branch each component
wrote was unreachable because the promise never settled. Now 60s reads / 120s
mutations, overridable, reported as `BACKEND_TIMEOUT` (never as an unreachable
backend, which would send an operator to check a healthy server).

The builder wrote pacing to real columns and never read any of them back, and
never persisted the start time at all — so a reload silently replaced the
operator's settings with presets. Pacing and the contact window now rehydrate
from the campaign; the planned start persists as
`metadata.planned_first_scheduled_at` (intent), with `campaigns.scheduled_for`
still written only by the state machine.

`/api/cockpit/campaigns/market-inventory` HAS NO ROUTE and never did — the
request fell through to `campaigns/[id]` and was rejected as a non-UUID campaign
id, so every load fired a guaranteed 400 to feed two components that could never
render. Removed.

**Controlled proof — campaign `928cc2c0-5570-4837-ae75-f0efc97e415d`** (inert,
no targeting, archived afterwards so the activation cron can never act on it):

    created draft            pacing 300/90/250, interval 60s, window 09:00-18:00
    reload (GET)             returned every value exactly
    schedule action          draft -> scheduled, scheduled_for 2026-09-20 14:00Z
                             (= 09:00 America/Chicago — correct offset)
    6 CONCURRENT schedules   all idempotent:true
                             1 campaign row, 0 targets, 0 queue rows
    pause                    scheduled -> paused
    resume                   truthfully REFUSED: "No ready recipients in target
                             snapshot" (this campaign has 0 targets)
    archive                  paused -> archived

### Queue writers — VERIFIED
**No direct `send_queue` table inserts exist anywhere.** Every row is created by
`sms-engine.insertSupabaseSendQueueRow`. Nine callers converge on it:
proof/s1s2-attended, `unknown-inbound-router`, `run-supabase-outbound-feeder`,
`build-send-queue-item`, `apply-inbound-automation-decision`,
`execute-referral-automation`, `workflow-v2/queue-adapter`, `sms/queue_message`,
and `dev/send-test` (dev only). Multiple entry points, one writer — the shape the
brief calls acceptable.

### Sender selection — VERIFIED (four selectors, one rule)
`enqueue-campaign-target-one::resolveSender` (materialize),
`supabase-candidate-feeder::buildRoutingSelection` (feed),
`sms-engine::selectAvailableTextgridNumber` (dispatch),
`routing/choose-textgrid-number` (buyer/routing). All four now agree on status,
daily cap, health state and cooling. Two intentional differences retained:
campaign materialization also requires a configured `daily_limit > 0`;
`choose-textgrid-number` additionally enforces hourly caps, local send windows and
risk spikes.

### Campaign targets — VERIFIED (enforced by the database)
- writers `api/cockpit/campaigns/[id]/build-targets` (operator),
  `campaign-automation-service` (automation), `discord-action-router`
- table `campaign_targets`

Three writers, and duplicate live work is **structurally impossible** rather than
merely unlikely:

    CREATE UNIQUE INDEX idx_campaign_targets_recipient_dedup
      ON campaign_targets (campaign_id, touch_number, to_phone_number)
      WHERE to_phone_number IS NOT NULL
        AND target_status IN ('ready','planned','queued','scheduled')

A partial unique index, so a superseded attempt can coexist with a live one while
two LIVE rows for the same recipient and touch cannot. Verified against
production: 27 duplicate `(campaign_id, touch_number, to_phone_number)` groups
exist and **every one has exactly one row in a live status** — the rest are
terminal, e.g. `{blocked, ready}`. Zero violations. The database is the authority
here, which is stronger than convention between three writers.

### Notifications — VERIFIED
- writers `api/cockpit/notifications/*`, `notification-scanners`,
  `launch-critical-alerts` · domain `notification-intelligence-service`
- push `web-push-transport` → `push_subscriptions`
- No client-side synthesis: the mobile and desktop centres are two presentations
  of one persisted source.

### Live Activity — VERIFIED
- adapter `lib/data/inboxActivityData.fetchInboxActivity` → table
  `inbox_activity_events`. A failed read yields an empty feed, not a fabricated
  one. Truthful empty is the correct state.

### Analytics / KPI — VERIFIED
- adapter `lib/data/kpiDashboardData` → `GET /api/cockpit/metrics/war-room`
- No demo states, no hardcoded metrics, no DEV switch. Rates are withheld below
  `MIN_VOLUME_FOR_RATE`; unmeasured states are absent rather than zeroed.

### Entity Graph — VERIFIED clean / Universe Lens BLOCKED
- No mock nodes, sample graphs, local fallbacks or build-mode switches.
- `/api/cockpit/entity-graph/lens` **does not exist**. The directory holds browse,
  contact, counts, filter-catalog, market, organization, owner, property, prospect,
  search and zip — no `lens`. The client latches the 404 per session and the Lens,
  saved cohorts and compare stay unreachable. That is the honest state and it must
  stay that way until the endpoint is built. Do not fabricate lens data.

### Workflow execution — VERIFIED by containment (not by design)

Two runtimes exist: the seller-flow automation writers, and Workflow Studio V2.
They cannot act on the same event today because **V2 is inert in production**:
`matchDefinitions` requires `status = 'active'`, and production holds zero active
definitions — 6 draft, 2 archived, 1 paused. `automation_events` is the canonical
acquisition bus; `workflow_events` is V2's private inbox.

State this precisely: the separation is a CONTAINMENT fact, not a structural one.
Activating a single workflow definition reopens the question of two systems
scheduling or mutating lifecycle state for one event. Before any workflow is
activated, the overlap between V2 actions and seller-flow automation writers has
to be worked out — it has not been.

---

## How to check a capability before building on it

1. Find every implementation: `grep -rn "<Capability>" src/` including **dynamic**
   `import()` — a static grep missed `loadBuyer` entirely, because
   `buyer.adapter` reached the demo store through `await import(...)`.
2. Establish which one production renders. Watch for `import.meta.env.DEV`,
   `localStorage` flags and `VITE_*` env gates in the selection expression.
3. If dev and production differ, that is the defect — fix it before anything else,
   or every subsequent measurement is taken against code that does not ship.
4. Prove the loser is unreferenced before deleting it (§58).
