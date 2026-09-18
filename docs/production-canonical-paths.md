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

- **Sender ownership, end to end.** The UI no longer invents one — the
  synthesised per-row sender died with the fabricated rows. Still OPEN: trace
  sender identity from campaign creation → `campaign_targets` → `send_queue` row
  → claim → dispatch, establish which component *owns* selection, and confirm
  the queue row, the canonical routing authority and the provider call all name
  the same sender. Also confirm sender-health/eligibility is enforced in the
  dispatch path rather than being advisory. `sms-health-guard` is imported by
  `send-now-service`; whether `process-send-queue` enforces it is unverified.
- **`SystemHealthOpsPanel`, `RecentQueueEvents`, `censusData`.** Flagged by the
  mock/demo/sample scan; not yet traced.
- **Campaign / Queue / messaging duplicates.** §43's remaining list — duplicate
  campaign setup paths, queue scheduling logic, workflow writers, campaign
  feeders, notification implementations, direct provider calls that bypass the
  canonical dispatcher (§55). Not yet enumerated.
- **Entity Graph, Analytics, Live Activity.** Not yet audited for duplicate or
  fallback paths.

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
