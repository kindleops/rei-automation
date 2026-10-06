# Command Wall V1 — Audit (brief §3)

Date: 2026-10-06 · branch `feat/mobile-product-v1` · audited at `d3ae1a05` while prod was moving to RC 8.4.2 B (`8f4bf32b`).
Scope: what the wall can REUSE, what it must not duplicate, and what breaks on a TV.

## 1. Auth, session and the trust boundary

| Piece | Where | What it means for the wall |
|---|---|---|
| Worker session gate | `infra/cloudflare/worker/index.ts` `handleBrowserApi` | `/api/cockpit/*`, `/api/internal/dashboard/*`, `/api/intel/*` and `/api/internal/offers/*` need a Supabase session (`/auth/v1/user`) plus `OPS_ALLOWED_USER_IDS`. The Worker strips inbound secrets and attaches `OPS_DASHBOARD_SECRET`. **Every other `/api/*` path is forwarded to the container with no session check**, so `/api/wall/*` lands there and must authenticate itself. |
| Container gate | `lib/security/dashboard-auth.js` `requireOpsDashboardAuth` (via `cockpit/_shared.js` `ensureMutationAuth`/`ensureDashboardReadAuth`) | Shared secret, a Bearer equal to it, or the `ops_dashboard_session` cookie. A display token can never equal it. |
| Legacy helper | `app/api/_shared.js` `ensureMutationAuth` | Opens when no secret is set **in any env**. Used by `/api/workflows/*` and `/api/intel/buyer-match`. The wall's middleware refusal (below) covers these too. |
| API middleware | `apps/api/middleware.js` | CORS only, matched to cockpit/internal. The wall adds a display-credential refusal here (tightening only, see ARCHITECTURE §Read-only). |
| Dashboard session | `src/lib/supabaseClient.ts`, `RequireAuth`, `backendClient.callBackend` | Operator Supabase session + Bearer. **The wall must not use any of it**: a TV must never hold an operator session. `App.tsx` wraps everything in `RequireAuth`, so `/wall` has to branch before `App` (done in `main.tsx`). |
| Device/session/token infra | none | There is no device registry, no device token, no pairing flow anywhere. `push_subscriptions` is per-device push only. → new, PROPOSED tables. |
| Rate limiting | none generic (one 429 in `internal/events/sync-podio`) | → `wall-rate-limit.js` (in-process; the API is one container instance, `api-singleton`). |

Mutation surface: **228 pre-existing route files** export POST/PUT/PATCH/DELETE (cockpit 109, internal 93, webhooks 11, workflows 10, other 5); 232 with the wall's four operator routes under `/api/cockpit/wall/`. The read-only test enumerates them from disk on every run.

## 2. Realtime and event sources (do not duplicate)

- **Machine Feed** = `listPlatformEvents` (`lib/domain/platform/events/platform-events-service.js`): 8 adapters (messages, campaign-sends, campaigns, lead-state, pipeline, workflow, closing/notifications, research), each its own query. Desktop tails it every 15 s per open window.
- **Notification stories projector** (`/api/internal/notifications/stories/project`, Worker cron every 30 s) already copies the story-relevant envelopes plus `notification_events` into **`notification_story_inputs`** (7-day window, ~1.3k rows, indexed `occurred_at`). Measured 2026-10-06 08:14Z: projector lag ≈ 25 s.
  → **The wall reads this table** (one indexed query per shared tick) instead of re-running 8 adapters. Same events and ids, so it is a projection of the Machine Feed, not a second event universe.
- **Gap:** outbound volume is not in the story inputs (`message.sent` = 35/24 h there vs **1,758 `send_queue` sends** in the same 24 h, 5 markets, peak 308/h). → the wall reads `send_queue.sent_at` (indexed `idx_send_queue_sent_at`, 4 columns) and folds it into per-market 2-minute aggregates, like the Machine Feed's `campaign.batch_sent`.
- **Dashboard realtime** (Supabase channels): ~12 subscribers across inbox/queue/map/pipeline/calendar; only `message_events`, `inbox_thread_state`, `send_queue` are confirmed published. Rejoin backoff `inbox-realtime-sync.ts` (a2e67d0b), shared counts `shared-counts-fetch.ts` (01d937a4).
  → **Not usable from a TV**: Supabase realtime needs a Supabase JWT and the RLS lockdown (anon refused) is correct. Wall realtime is server-side: one shared tick fanned out over a cursor poll. The a2e67d0b policy shape (2 → 30 s backoff, reset only after a stable period) is reused in the wall's recovery ladder.
- **Signal Center**: `signals` table (open: 15 `inbox.new_replies_backlog`, 2 `queue.stalled`, 1 `sender.content_filter_spike`, 1 `campaign.content_filter_spike`), read by `GET /api/cockpit/signals` (operator gate). The wall reads open signals directly (display only; one line per rule) and never calls ack/resolve/arm.
- **PII in sources:** envelope `details.preview` holds the seller's message text; `summary`, `entity_refs`, `actor.label` hold names/addresses; `notification_events.title` holds phone numbers (`New message — +1949…`). → wall events are built from a closed vocabulary; no source free text is ever copied.

## 3. Metrics, queue, fleet, campaigns

| Fact | Reused source | Wall cache |
|---|---|---|
| Sent / delivered / replies / positive / opt-outs today | RPC `cockpit_ops_metrics_snapshot` (same window as `/cockpit/ops/metrics`: server-local midnight) | 30 s, shared |
| Queue health | RPC `cockpit_queue_processor_health` + `deriveStatus` semantics | 30 s. Its service falls back to **14 count queries** when the RPC fails — the wall does not use the fallback; it says "Queue unavailable". |
| Sender fleet | `textgrid_numbers` (18 rows: 14 active/unverified, 1 cooling, 2 paused, 1 disabled) | 30 s |
| Campaigns | `campaigns` progress columns (5 active, 1 scheduled, 2 paused) | 30 s |
| Offers today | `offer.generated` story inputs since midnight (head count) | 30 s |
| Market geography | `canonical_markets` (+ centroids from `mi_zip_geo` sales-weighted ZIP boxes; 1 build) | 6 h |
| Event geography | `properties` (zip/lat/lng/canonical_market_id) via `home-read-kit.propertyIndex`, ZIP centroids via `mi_zip_geo` | LRU, per new id |

Failure honesty: `fetchOpsMetricsAggregate`'s fallback returns zeros for every count — the wall calls the RPC itself and shows **Unavailable** instead.

## 4. Map, Market Intelligence, spatial layers

- **Map engine** = MapLibre GL 5 inside `InboxCommandMap.tsx` (~11k lines, thread-coupled, mounts its own chrome). Not embeddable read-only. The engine's reusable surface is its **style system**: `commandMapThemes.getCommandMapThemeStyle`, `nexusThemes[].mapThemeId`, `map-basemap-paint.applyVisualPresetBasemapPaint`, `map-layer-ownership` (`nx-*` owned prefixes), `context-layers` (`ensureCameras/ensureCrime/ensurePresence`). Other surfaces (AnalyticsGeo, Globe, EvidenceMap) already build their own `maplibregl.Map` on these — the wall does the same, so there is **one engine, no fork**.
- WebGL probing/blocked-context handling lives un-exported inside InboxCommandMap; the wall has its own capability probe (render modes) and a non-WebGL fallback view.
- **Market Intelligence**: `marketIntelService().run(op)` (in-process summary of `mi_geo_period_rollup`, LRU caches). Wall uses `rank` (ZIPs within a market: sales, median price/PPSF, recorded investor share with its `n`, inferred share only when `mi_geo_period_inferred` exists — it is PROPOSED/unapplied, so it reports unavailable), cached 5 min.
- **Cameras / crime / investor presence**: `getCamerasInView`, `getCrimeInView` (zoom ≥ 11, span ≤ 0.6°), `getInvestorPresence` (aggregated cells; recorded investor purchases vs entity ownership kept separate per the 10-02 owner rule). Wall calls them server-side with viewports snapped to 0.1° and cached 10 min.
- Investor semantics (memory, owner rule 10-02): Investor Purchases (`is_investor`) ≠ Entity Ownership (`investor_inferred_current_owner`); never summed. The wall labels each.

## 5. Deploy / version / PWA

- `build-freshness` (f974bc96): identifies the build by the hashed `/assets/main-<hash>.js` in `/`; polls 5 min + focus; chunk-failure reload once per session guard. The wall reuses `checkForNewBuild`/`parseMainEntry` but owns the *when*: it applies the update at a quiet moment (no P0/P1 event for 2 min) behind "Updating Command Wall…".
- `/api/version` (`build_sha`, `git_sha`) is a non-browser path — the wall does not need it.
- Service worker (`main.tsx`): reloads immediately on `controllerchange` / `NEXUS_SW_ACTIVATED`. On the wall this is acceptable (a deploy is a version change) and is guarded by the recovery ladder's reload budget; noted as a gap: it bypasses the quiet-moment rule.

## 6. TV / browser hazards

- Static `_headers`: `frame-ancestors 'none'` + `X-Frame-Options: DENY` — the wall cannot be framed (no "embed in a TV app webview via iframe"); a kiosk browser must open the URL top-level.
- Smart-TV browsers (Tizen ≤ 5, webOS ≤ 5, older WebKit): no/limited WebGL2, no `backdrop-filter`, no `ResizeObserver` (old WebKit), no `requestIdleCallback` (Safari), `structuredClone` missing on old engines, aggressive tab suspension (timers frozen → `visibilitychange`/`pageshow` resume path needed), cookies sometimes cleared on power-off (→ Bearer fallback).
- Overscan: many TVs crop 2–5 % → 3.5 % safe inset.
- The ops site fails on Ryan's TV today — cause unknown without the model; `/wall/diagnostics` reports capability facts so the failing API can be identified without exposing tokens.
- Layout breakpoints: the desktop has 1440/1920 and an ultrawide mode; nothing targets 3840×2160 at DPR 1 (TV 4K), where desktop type renders at half physical size. The wall scales type with `clamp()` on the viewport height, not the desktop scale.
- Load history: 2026-09-30 inbox-counts PATCH stampede (38k writes/20 min) and two Supabase-side outages on 10-05 → the wall must add near-zero load (§ARCHITECTURE Performance).
