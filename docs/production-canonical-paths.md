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

- **Campaign wizard mock mode.** `campaignWizardAdapter` has
  `explicitDevMockModeEnabled()` behind `import.meta.env.DEV` **and** an explicit
  `VITE_CAMPAIGN_WIZARD_MOCK_MODE` / `VITE_CAMPAIGN_TARGETING_MOCK` /
  `VITE_CAMPAIGN_WIZARD_USE_MOCK` flag. Not reachable in production and off by
  default in dev, so it is not a §42 breach — but it is a second path through
  campaign targeting and §43 wants dev and production to agree. Decide: delete,
  or document as intentional.
- **`campaignWizardAdapter` local fallback.** `fallbackMeta()` /
  `source: 'local_fallback'` marks a degraded non-backend path. Needs tracing:
  degraded-but-truthful is acceptable, degraded-but-populated is not.
- **Queue senders.** `queue.adapter` aliases `MOCK_TEXTGRID_FLEET =
  PRODUCTION_TEXTGRID_FLEET`. The data is production; the name is a lie and the
  synthesised per-row sender assignment needs checking against canonical
  `send_queue` routing.
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
