# Deal Desk — Frontend, State & Runtime Audit

**Date:** 2026-08-02
**Branch audited:** `checkpoint/mac1-backend-closure-20260801-185255`
**Scope:** Deal Desk workspace only (left inbox rail, thread list, center conversation, composer, state controls, active-prospect selector, right Deal Intelligence panel, Street View/media, counts, pagination, filters, loading contracts, and the Supabase/API/query layers those surfaces depend on).
**Mode:** Read-only. No application code, tests, migrations, or database state were modified. No scrape, campaign, send, or automation process was started.

**Evidence discipline used in this document**
- **[OBSERVED]** — read directly out of the repository (file + line). Verifiable by opening the file.
- **[INFERRED]** — a runtime consequence deduced from observed code, not reproduced live.

**Environment limitation (stated up front):** production credentials for the live Supabase instance and the deployed API are operator-held and were deliberately not used (per prior containment decisions the prod queue remains paused). Therefore every runtime claim below is a **static trace**, and every claim tagged [INFERRED] is a logical consequence of observed code rather than an observed browser session. Where a defect is provable from source alone (a wrong constant, an unreachable branch, a vocabulary mismatch), it is tagged [OBSERVED].

---

## A. Executive verdict

Deal Desk is not slow because of one bad component. It is slow, unstable, and untrustworthy because **four independent contracts disagree with each other**, and the UI was built to paper over the disagreement rather than resolve it.

1. **There are two different databases-of-record for the same thread, queried by two different predicates.** The category *counts* come from `inbox_thread_state` scanned row-by-row in JavaScript (`countThreadsMatchingTab`, `live-inbox-service.js:2167`), or from the `v_inbox_thread_counts_live_v2` view which is built over `canonical_inbox_threads`. The category *list* for every bucket tab comes from a different query against `inbox_thread_state` using Supabase `.eq("inbox_bucket", …)` filters (`applyInboxThreadStateBucketFilter`, `live-inbox-service.js:1457`). Count and list can never be guaranteed to agree, so the badge next to a tab is structurally unable to match the rows inside it.

2. **Pagination is dead on every bucket tab.** `queryAuthoritativeInboxThreads` already slices its result to exactly `limit` rows (`live-inbox-service.js:1846-1847`), and then `getLiveInbox` recomputes `hasMore = postFiltered.length > limit` (`live-inbox-service.js:2432`). `limit > limit` is always false. Every bucket tab therefore returns `has_more: false` and `next_cursor: null` forever. The client hides "Load More" (`InboxPage.tsx:5232`), and since bucket switches request `limit: 30` (`InboxPage.tsx:1524`), **the operator can only ever see the newest 30 threads in Priority, New Replies, Needs Review, Follow-Up, Waiting, Cold, Dead and Suppressed.** Everything older is unreachable through the UI.

3. **The manual controls write into a vocabulary the UI does not speak, through a key the server rejects, with no rollback.** The UI's stage vocabulary (`SellerStage`: `ownership_check`, `price_discovery`, `mf_suppressed`, …, `inboxWorkflowData.ts:33-56`) has **zero overlap** with the canonical vocabulary the database stores (`LIFECYCLE_STAGE_ORDER`: `ownership_confirmation`, `asking_price`, `closed`, …, `universal-lead-state-registry.ts:6-21`). The translator `normalizeLifecycleStage` silently falls back to `'ownership_confirmation'` for anything it can't map (`universal-lead-state-registry.ts:297`). Meanwhile the server hard-requires `thread_key` to match `/^\+1\d{10}$/` (`cockpit-service.js:27-31`), but the mutation layer sends `thread.threadKey || thread.id` (`inboxWorkflowData.ts:286-289`) — a composite key or UUID for many threads. And `handleWorkflowMutation` never rolls the optimistic patch back on failure (`InboxPage.tsx:3161-3186`). The net effect: **the control moves, a green "Action completed successfully" toast appears, and the database either stores a different value or nothing at all.**

4. **Selection is not a stable identity — it is a full teardown.** Every bucket switch calls `setSelectedId(null)` (`InboxPage.tsx:1518-1520`), which fires the null branch of the hydration effect and wipes `selectedMessages`, `threadContext`, `threadIntelligence` and `dealContext` (`InboxPage.tsx:2004-2017`). The workspace goes blank, then an auto-select effect picks the first row, then a four-request hydration cascade runs — and that cascade is **not parallel**: `executeThreadSelectFetches` awaits `messages` to completion *before* starting the other three (`thread-select-orchestrator.ts:275-281`), despite every plan entry being labelled `parallelGroup: 'primary'`.

The workspace *feels* untrustworthy because it is honest about none of this: failures are swallowed (`void callBackend(...)` with no `.catch`, `InboxPage.tsx:3470`), successes are asserted before they are confirmed, and the same fact is rendered from three different sources in three different panels.

---

## B. System map

### B.1 Route → workspace

| Layer | File | Notes |
|---|---|---|
| Route table | `apps/dashboard/src/app/routes.tsx:57-77` | `/`, `/inbox`, `/conversation`, `/deal-intelligence` all resolve to the same component |
| View wrapper | `apps/dashboard/src/views/inbox/InboxView.tsx` | 22-line pass-through to `InboxPage` |
| View wrapper | `apps/dashboard/src/views/conversation/ConversationView.tsx` | mobile → `routeMode="workspace"`, desktop → `initialWorkspaceView="sms_thread"` |
| Redirect shim | `apps/dashboard/src/views/deal-intelligence/DealIntelligenceInboxRoute.tsx` | `useEffect` → `openInboxDealIntelligence()`; renders a bare `<p>Opening Deal Intelligence…</p>` |
| **Workspace root** | `apps/dashboard/src/modules/inbox/InboxPage.tsx` | **5,468 lines, one component, 60+ `useState`** |

Deal Desk is the default workspace preset: `DEFAULT_WORKSPACE_KEY = 'deal_desk'` (`InboxPage.tsx:511`), label `'Deal Desk'` (`InboxPage.tsx:379`), layout version `v3` (`InboxPage.tsx:513`), default panes `['thread','sms_thread','deal_intelligence']` (`InboxPage.tsx:476`).

### B.2 Deal Desk component inventory

| Surface | File | Lines |
|---|---|---|
| Workspace shell / all orchestration | `modules/inbox/InboxPage.tsx` | 5,468 |
| Left rail + category nav + thread list | `modules/inbox/components/InboxSidebar.tsx` | 1,686 |
| Virtual list wrapper (react-window) | `modules/inbox/components/VirtualizedInboxList.tsx` | 125 |
| Row renderers (4 variants) | `InboxSidebar.tsx:770` `ConversationRow`, `:904` `ConversationRowOps75`, `:977` `CompactRow25`, `:1092` `CommandCenterRow` | — |
| Center conversation | `modules/inbox/components/ChatThread.tsx` | 981 |
| Composer | `modules/inbox/components/Composer.tsx` | 759 |
| Canonical state controls | `modules/inbox/components/ThreadStateBar.tsx` | 387 |
| Stage-change confirm modal | `modules/inbox/components/StageChangeConfirmModal.tsx` | — |
| **Right Deal Intelligence panel** | `modules/inbox/components/IntelligencePanel.tsx` | **6,099** |
| Active prospect selector | `modules/inbox/components/ActiveProspectCard.tsx` | 223 |
| Participant rail | `modules/inbox/components/PropertyParticipantRail.tsx` | 149 |
| Street View thumbnail (list rows) | `modules/inbox/components/InboxStreetViewThumb.tsx` | 82 |
| Street View / aerial iframes (panel) | `IntelligencePanel.tsx:2424-2620` `PropertyHeroCard` | — |
| Street View URL cache | `modules/inbox/utils/streetViewImageCache.ts` | 55 |
| Legacy/dead thread list | `modules/inbox/components/ThreadList.tsx` | 146 — **unused by Deal Desk**, own duplicated filter logic |
| Advanced filters UI | `components/AdvancedFiltersModal.tsx`, `AdvancedFiltersPopover.tsx` | — |

### B.3 State, hooks and domain layer

| Concern | File | Notes |
|---|---|---|
| Bucket store reducer (pure) | `modules/inbox/inbox-store.ts` | 492 lines; the only well-isolated piece in the system |
| Data hook + realtime + polling | `modules/inbox/inbox.adapter.ts:978-1886` `useInboxData` | Wraps the reducer; builds `InboxModel` **inline, unmemoized**, `:1828` |
| Thread-select planner | `domain/inbox/thread-select-orchestrator.ts` | 282 lines; **the "parallel" executor is sequential-then-parallel**, `:275-281` |
| Message cache | `domain/inbox/thread-selection-cache.ts` | 45 lines |
| Optimistic patches | `domain/inbox/optimistic-thread-patch.ts` | 106 lines; **no rollback helper exists** |
| Canonical state key resolver (reads) | `domain/inbox/resolveCanonicalThreadStateKey.ts` | phone-first |
| Thread key resolver (writes) | `lib/data/inboxWorkflowData.ts:286-289` `toThreadKey` | threadKey/id-first — **different resolver, same table** |
| Canonical vocabulary registry | `domain/lead-state/universal-lead-state-registry.ts` | 354 lines |
| Lead-state persistence | `domain/lead-state/persistUniversalLeadState.ts` | 206 lines |
| Workflow mutations | `lib/data/inboxWorkflowData.ts` | 984 lines |
| Thread/message reads | `lib/data/inboxData.ts` | 5,449 lines |
| Backend HTTP client | `lib/api/backendClient.ts` | `patchUniversalLeadState` `:1148`, `updateThreadState` `:1137` |
| Bucket classification (client) | `domain/inbox/classifyInboxBucket.ts`, `inbox-decisioning.ts` | 40 / 486 |
| Advanced filter engine (client) | `domain/inbox/inbox-advanced-filter-engine.ts` | 275 |
| Status/stage/temp resolvers | `modules/inbox/status-visuals.ts:423-488` | — |

### B.4 API routes

| Route | File | Lines |
|---|---|---|
| `GET /api/cockpit/inbox/live` | `apps/api/src/app/api/cockpit/inbox/live/route.js` | 157 |
| `GET /api/cockpit/inbox/counts` | `.../counts/route.js` | 40 |
| `GET /api/cockpit/inbox/thread-hydration` | `.../thread-hydration/route.js` | 352 |
| `GET /api/cockpit/inbox/thread-messages` | `.../thread-messages/route.js` | 189 |
| `GET /api/cockpit/inbox/thread-dossier` | `.../thread-dossier/route.js` | 168 |
| `GET /api/cockpit/inbox/property-participants` | `.../property-participants/route.js` | 282 |
| `PATCH /api/cockpit/inbox/thread-state` | `.../thread-state/route.js` | 59 |
| `PATCH /api/cockpit/inbox/threads/[thread_key]` | `.../threads/[thread_key]/route.js` | — |
| **`PATCH /api/cockpit/lead-state/patch`** | `apps/api/src/app/api/cockpit/lead-state/patch/route.js` | 62 |
| `GET .../inbox/filter-catalog` / `filter-options` / `filter-preview` | `.../filter-*/route.js` | 16 / 38 / 33 |

### B.5 Server domain services

| Concern | File | Lines |
|---|---|---|
| **List + counts engine** | `apps/api/src/lib/domain/inbox/live-inbox-service.js` | **3,880** |
| Bucket/tab predicates (counts path) | `.../inbox-thread-state-contract.js` | 199 |
| Bucket predicates (shared) | `.../inbox-bucket-predicates.js` | 210 |
| Bucket derivation from classification | `.../resolve-inbox-state-from-classification.js` | 675 |
| **Write during read** | `.../reconcile-inbox-thread-state.js:12` `transitionStaleWaitingThreads` | 113 |
| Advanced-filter query builder | `.../inbox-hydrated-filter-service.js` | 376 |
| Linked-context hydration | `.../hydrate-inbox-thread-linked-context.js` | 515 |
| Participant ranking / next-best | `.../participant-intelligence.js` | 387 |
| Participant graph response shape | `.../property-participant-graph.js` | 187 |
| Canonical lead-state writer | `apps/api/src/lib/domain/lead-state/patch-universal-lead-state.js` | — |
| Thread-state write guard | `apps/api/src/lib/cockpit/cockpit-service.js:538-591` | — |

### B.6 Database objects

| Object | Kind | Defined in |
|---|---|---|
| `inbox_thread_state` | table (write target + bucket-tab list source + counts source) | `apps/dashboard/supabase/migrations/20260428_create_inbox_thread_state.sql` (+ ~8 later alters) |
| `canonical_inbox_threads` | view (`PRIMARY_THREAD_SOURCE`, `live-inbox-service.js:46`) | `apps/api/supabase/migrations/20260529181259_…`, `20260629120000_…` |
| `v_inbox_threads_live_v2` | view (legacy primary) | same |
| `v_inbox_enriched` | view (fallback) | same |
| `canonical_inbox_counts` / `v_inbox_thread_counts_live_v2` | count views over `canonical_inbox_threads` | `20260529181259_…:544`, `20260629120000_…:238` |
| `inbox_threads_hydrated` | view (advanced-filter source) | `inbox-hydrated-filter-service.js` |
| **`property_participant_graph`** | **view over `message_events`** | `apps/api/supabase/migrations/20260627120000_inbound_intelligence_shadow_mode.sql:124-207` |
| `seller_contact_referrals` | table | same migration |
| `message_events`, `send_queue`, `phones`, `prospects`, `master_owners`, `properties` | tables | — |
| `inbox_filter_field_options` | RPC | called at `inbox-hydrated-filter-service.js:359` |

### B.7 Realtime subscriptions

| Channel | Where | Tables |
|---|---|---|
| `nexus-inbox-realtime` (global, 1 per session) | `inbox.adapter.ts:1742-1750` | `message_events`, `send_queue`, `inbox_map_pins`, `operator_thread_state`, `inbox_thread_state`, `universal_lead_state_events`, `operator_entity_preferences` |
| `nexus-inbox-thread-${selectedKey}` (**re-created on every thread click**) | `InboxPage.tsx:2292` | `message_events`, `send_queue` |

Both subscribe with `event: '*'` and **no server-side row filter** — every message event in the entire system is delivered to every connected client and discarded in JavaScript (`belongsToSelection`, `InboxPage.tsx:2276-2289`).

### B.8 Tests touching Deal Desk

| File | Kind |
|---|---|
| `apps/dashboard/tests/ui/inbox-stabilization-acceptance.spec.ts` | Playwright |
| `apps/dashboard/tests/ui/deal-intelligence.spec.ts` | Playwright |
| `apps/dashboard/tests/ui/deal-intelligence-25-acceptance.spec.ts` | Playwright |
| `apps/dashboard/tests/ui/manual-inbox-send-now-acceptance.spec.ts` | Playwright |
| `apps/dashboard/tests/unit/inbox-boot-read.test.ts` | unit |
| `apps/dashboard/tests/unit/thread-selection-cache.test.ts` | unit |
| `apps/dashboard/src/domain/inbox/view-layout.test.ts` / `view-layout-sanitize.test.ts` | unit |

**Coverage gap [OBSERVED]:** there is no test anywhere that asserts a stage/status/temperature/automation mutation actually persists the requested value, no test that asserts `has_more` is true when more rows exist, and no test that asserts a count equals the length of its own list.

---

## C. Runtime sequence — thread click → hydrated workspace

Traced statically from `InboxSidebar` row `onClick` to the last panel commit.

```
 1. Row click            InboxSidebar.tsx:1566 onThreadSelect(id)  → console.log + onSelect(id)
 2. handleSelect         InboxPage.tsx:3427
      setPreviewContext(null)                                        [render 1]
      findThreadByRef(threads, id)                                   O(n) scan
      selectNonceRef++ ; pendingUncachedSelectRef = {...}
      if alreadySelected → planThreadSelect() run purely for telemetry (:3441-3454)
      setActiveContext(buildContextFromThread(...))                  [render 2]
      setSelectedId(thread.id)                                       [render 3]
      setSelectedThreadKey(thread.threadKey || thread.id)            [render 4]
      setLayoutState({...current, selectedThreadId})                 [render 5]
      selectedThreadFallbackRef.current = thread
 3. Fire-and-forget read-mark   InboxPage.tsx:3468-3474
      key = resolveCanonicalThreadStateKey(thread)      ← phone-first resolver
      void callBackend('/api/cockpit/inbox/thread-state', PATCH {is_read:true})
      ** no .then, no .catch, no state update, result never inspected **
 4. Render pass          selectedRef.current = selected              ← ASSIGNED DURING RENDER (:1046)
                         selectedKeyForEffect = resolveMessageCacheKeyForThread(selected)
 5. Hydration effect     InboxPage.tsx:2002   deps [DEV, selectedKeyForEffect, messageRefetchKey]
      planThreadSelect()                        thread-select-orchestrator.ts:86
      8 synchronous setState calls (:2038-2048):
          setThreadTranslations({}) setThreadViewMode('original') setDetectedThreadLanguage(null)
          setDealContext(fallback)  setSelectedMessages(cached)     setMessagesLoading(...)
          setHasOlderMessages(false) setOlderMessagesLoading(false)
          setContextLoading(true)   setThreadContext(seed)          setThreadIntelligence(seed)
 6. executeThreadSelectFetches    thread-select-orchestrator.ts:223
      ┌── await runKind('messages')            ← BLOCKING, SEQUENTIAL (:276-278)
      │      GET /api/cockpit/inbox/thread-messages   (maxMessages: 50)
      └── then Promise.all([                   ← only now do these start (:279-281)
             hydration      GET /api/cockpit/inbox/thread-hydration?skipMessages&skipDossier
             dossier        GET /api/cockpit/inbox/thread-dossier/{threadKey}?…
             thread_context GET /api/internal/inbox/thread-context
          ])
      Each callback commits independently → 4+ more render passes
 7. Participants effect  InboxPage.tsx:3513   deps include selected?.propertyId
      GET /api/cockpit/inbox/property-participants?property_id=…
        server: loadPropertyContext          1 query
                loadProspectPhoneIndex       2 queries
                loadParticipantsFromGraph    1 query (limit 50)
                enrichParticipants           ** N sequential loadLatestInboundMessage queries **
                                                (property-participants/route.js:131-142) → up to 50 round trips
 8. Per-thread realtime effect  InboxPage.tsx:2233
      supabase.removeChannel(previous)  +  new channel `nexus-inbox-thread-${selectedKey}`
      → WebSocket channel churn on every single click
 9. Right panel          IntelligencePanel receives thread=workspaceThread (new object each refresh)
      DealIntelligenceCard useEffect (:738) → fetch /api/cockpit/properties/{id}/valuation-snapshot
      PropertyHeroCard  → 2 Google Maps Embed iframes
```

### C.1 Direct answers to the audit questions

| Question | Answer | Evidence |
|---|---|---|
| Full workspace remount on select? | No | pane `key={view}` is stable (`InboxPage.tsx:5295`) |
| Center-panel remount? | No, but full re-render + skeleton | `ChatThread.tsx:539` `if (loading && messages.length===0)` replaces content with skeleton |
| Right-panel remount? | **Yes, effectively** — `IntelligencePanel` early-returns an empty shell when `thread` is null (`:5996`), and bucket switches set `selected` to null | `InboxPage.tsx:1518-1520` |
| Street View remount? | **Yes** — see §H | `IntelligencePanel.tsx:2459, 2544-2560` |
| Redundant property queries? | **Yes** — `hydration`, `dossier` and `thread_context` all resolve overlapping property/deal context, and `valuation-snapshot` is a 4th | `thread-select-orchestrator.ts:97-102`; `IntelligencePanel.tsx:738` |
| Redundant prospect queries? | **Yes** — participants route re-queries `prospects` and `phones` on every property change, then N+1 on `message_events` | `property-participants/route.js:54-79, 131-142` |
| Redundant thread queries? | **Yes** — `messages` and `hydration` both return `messages`; `onHydration` overwrites the cache the `messages` handler just wrote | `thread-select-orchestrator.ts:188-197`; `InboxPage.tsx:2114-2120` |
| Stale response overwrites? | **Guarded for list & messages, unguarded for participants** — bucket/message fetches use requestId stale-guards (`inbox-store.ts:289, 369`), but the participants effect has no cancellation token on the response commit | `InboxPage.tsx:3513+` |
| Race conditions? | **Yes** — `onMessages` and `onHydration` both call `setSelectedMessages` and both write `messageCacheRef.current[cacheKey]`; ordering is not deterministic | `InboxPage.tsx:2092-2120` |
| Selection clearing? | **Yes, by design on every bucket switch** | `InboxPage.tsx:1518-1520`, `:1363-1365` |
| Derived-state mismatch? | **Yes** — `automationState` is fabricated from `isArchived`/`isSuppressed` | `inbox.adapter.ts:550` |
| Request-cancellation failures? | **Partially** — `AbortController` is passed to the 4 primary fetches, but the participants fetch, the valuation-snapshot fetch and the read-mark PATCH are all uncancelled | `IntelligencePanel.tsx:744`; `InboxPage.tsx:3470` |

---

## D. State ownership matrix

Legend — **SC** server-canonical · **CC** client-canonical · **D** derived · **DUP** duplicated · **SP** stale-prone · **O** optimistic · **SUB** subscription-driven · **Q** query-driven · **LP** locally patched · **?** unclear.

| State | Intended source of truth | Actual writable sources | Duplicate representations in the client | Classification |
|---|---|---|---|---|
| Selected thread | client | `selectedId`, `selectedThreadKey`, `layoutState.selectedThreadId`, `activeContext.threadKey`, `previewContext.threadKey`, `selectedThreadFallbackRef`, `universalEntityContext`, `inbox-store.selectedThreadKey` (written but **never read** by InboxPage) | **8** — `InboxPage.tsx:661-665, 735, 754, 666`; `inbox-store.ts:28` | CC · DUP · SP |
| Selected property | none | `selected.propertyId`, `activeContext.propertyId`, `canonicalSelectedContext.propertyId`, `mapSelectedPropertyId`, `universalEntityContext.propertyId`, `mapPropertyCoords.propertyId` | **6** — `InboxPage.tsx:1055, 1069, 1076, 3514` | D · DUP · ? |
| Selected owner | none | only as `thread.ownerId` / `masterOwnerId` string; `master_owner_name` scalar from the participants route | 3 | D · ? |
| Selected prospect | none | `selectedParticipant` (a **phone-keyed** row), `thread.prospectId`, `dealContext` prospect fields | 3 | CC · DUP |
| Selected phone number | none | conflated with *both* selected thread and selected prospect | — | **DUP — no independent representation** |
| Selected conversation | none | conflated with selected thread | — | **DUP — no independent representation** |
| Lifecycle stage | `inbox_thread_state.lifecycle_stage` | `IntelligencePanel` menu v2 (`:1058`), `IntelligencePanel` menu v3 (`:3158`), `ThreadStateBar` (`:348`), proof-bridge drive action (`InboxPage.tsx:3366`) | `thread.conversationStage` (UI vocab) + `ThreadStateBar.stage.value` (canonical vocab) + `optimisticPatches[id].conversationStage` | **SC written by 4 sources in 2 vocabularies** · DUP · O · LP · SP |
| Operational status | `inbox_thread_state.operational_status` | same 4 surfaces | `thread.inboxStatus` (7-value UI enum) + `ThreadStateBar.status.value` (9-value canonical enum) + optimistic patch | **SC · DUP · O · LP** |
| Lead temperature | `inbox_thread_state.lead_temperature` | `ThreadStateBar` only (`:359`); `markThreadHot` writes it indirectly via `priority` (`inboxWorkflowData.ts:947`) | `thread.priority` (urgent/high/low), `thread.isHotLead`, `ThreadStateBar.temperature.value` | **SC · DUP · SP — no propagation** |
| Automation state | `inbox_thread_state.autopilot_mode` | `ThreadStateBar` writes `autopilot_mode` (`:373`); `pauseAutomation`/`resumeAutomation` write `operational_status` (`inboxWorkflowData.ts:955-961`) | `thread.automationState` is **fabricated client-side** from `isArchived‖isSuppressed` (`inbox.adapter.ts:550`) | **BROKEN — write path and read path touch different columns** |
| Read/unread | `inbox_thread_state.is_read` | `handleSelect` fire-and-forget PATCH (`:3470`), `handleThreadAction('read')` (`:3259`), realtime patch (`inbox.adapter.ts:1606`) | `isRead`, `unread`, `unreadCount`, `status:'read'`, `inboxStatus:'closed'` — **5 fields set by one action** (`optimistic-thread-patch.ts:56`) | **SC · DUP · O · LP — 3 writers, 2 key resolvers** |
| Archive | `inbox_thread_state.is_archived` + `archive_scope` | `archiveThread` (`:837`), `unarchiveThread` (`:853`) | `isArchived` + `inboxStatus:'closed'` + `automationState:'completed'` | SC · O · LP |
| Pin / Star | `is_pinned` / `is_starred` | `pinThread`/`starThread` (`:872-886`) | `isPinned`/`isStarred` + optimistic patch | SC · O · LP |
| Inbox bucket | `inbox_thread_state.inbox_bucket` (server) | server classification + `REALTIME_PATCH_THREAD` client re-bucketing (`inbox-store.ts:397-458`) + client `rowBelongsToBucket` re-derivation (`inbox-store.ts:177-219`) + server `threadMatchesInboxTab` (`inbox-thread-state-contract.js:122`) + server `applyQueryFilter` (`live-inbox-service.js:1563`) | **5 independent bucket predicates** | **SC · DUP · SP — five implementations of one rule** |
| Latest message | `message_events` | `selectedMessages` state, `messageCacheRef`, `pendingMessagesByThread`, row `latestMessageBody`, realtime append | 5 | Q · SUB · DUP |
| Seller intent | server `last_intent` | client `buildConversationDecision` re-derives it (`inbox-decisioning.ts`) | 2 | D · DUP |
| Suppression | `contactability_status` + `is_suppressed` + `phones.activity_status` + `message_events.metadata.suppression_scope` | `suppressThread` writes 3 canonical fields at once (`inboxWorkflowData.ts:897`) | `isSuppressed`, `isOptOut`, `inboxStatus:'suppressed'`, `conversationStage:'dead_suppressed'` | **SC · DUP — scope is stored in JSON metadata, not a column** |
| Delivery status | `message_events.delivery_status` / `send_queue.queue_status` | server hydration (skipped in fast mode) | `deliveryStatus` on row + on message + pending-message reconciliation (`InboxPage.tsx:1267-1316`) | Q · SP |
| Contact outcome | `disposition` column exists | **no UI writes it** | `wrong_number`/`opt_out` booleans read but never written from Deal Desk | **SC · orphaned** |
| Realtime status | `inbox-store.realtimeStatus` | reducer only | mirrored into `data.realtimeConnected`, `data.connectionState`, `data.realtimeDegraded`, `data.refreshMode` | SC · D |
| View counts | `inbox-store.viewCounts` | `SET_VIEW_COUNTS` from `/counts`, from `/live`, and `applyCountDeltas` from realtime | plus `getInboxViewCounts(threads)` local recompute merged in `InboxPage.tsx:854-969` | **DUP · SP** |
| List scroll offset | `sidebarListScrollOffset` (single scalar) | `VirtualizedInboxList.onRowsRendered` → `setSidebarListScrollOffset` | `inbox-store.buckets[key].scrollTop` exists in the reducer but **is never dispatched or read** (`inbox-store.ts:460-469`) | **CC · DUP — the per-bucket slot exists and is unused** |

**States with more than one writable source: lifecycle stage, operational status, lead temperature, automation state, read/unread, inbox bucket, view counts, selected thread.** That is eight of the sixteen states the workspace is built around.

---

## E. Mutation matrix

Common path for everything except `ThreadStateBar`:

```
UI → InboxPage.handleThreadAction / handleStatusChange / handleStageChange / handleOperatorAction
   → setOptimisticPatches({[thread.id]: patch})            ← applied immediately, NEVER cleared
   → handleWorkflowMutation(label, mutation, {skipRefresh:true})   InboxPage.tsx:3161
       → mutation()  →  persistWorkflowPatch / persistUniversalLeadState
           → toThreadKey(thread) = thread.threadKey || thread.id      inboxWorkflowData.ts:286
           → mapWorkflowPatchToCanonical()                            inboxWorkflowData.ts:168
           → normalizePatchToCanonical()                              registry.ts:332
           → PATCH /api/cockpit/lead-state/patch
               → isCanonicalThreadKey(key)  /^\+1\d{10}$/             cockpit-service.js:27
               → upsert into inbox_thread_state                        patch-universal-lead-state.js:310
       → if (!result.ok) emitNotification(severity:'critical'); RETURN  ← optimistic patch left in place
       → emitNotification('Action completed successfully')
```

| Mutation | UI trigger | Validation | API → table | Optimistic | Rollback | Cache invalidation | Cross-view propagation | Audit | Failure mode |
|---|---|---|---|---|---|---|---|---|---|
| **Stage change (panel)** | `IntelligencePanel:1058` & `:3158` → `onStageChange` | none client-side | `lead-state/patch` → `lifecycle_stage` | yes (`conversationStage`) | **none** | **none** (`skipRefresh:true`) | none | `logInboxActivity` only if `ok` | **Vocabulary loss** — `mf_units_confirmed`, `mf_occupancy_requested`, `mf_rent_roll_requested`, `mf_gross_rents_requested`, `mf_suppressed` all silently become `ownership_confirmation` (`registry.ts:297`). **Key rejection** — non-E.164 `threadKey` ⇒ `invalid_canonical_thread_key`. Both report success in the UI. |
| **Stage change (bar)** | `ThreadStateBar:348` → confirm modal → `:306` | canonical enum enforced by type | `lead-state/patch` → `lifecycle_stage` | yes, local only | **yes** (`useOptimisticField:233`) | `onRefetch?.()` — optional, not passed by `ChatThread` | **none** — value lives in component-local state | server-side | Correct behaviour, but **invisible to the list, counts and right panel** |
| **Status change (panel)** | `IntelligencePanel:1038` & `:3139` | none | `operational_status` | yes | **none** | none | none | none | 7-value UI enum → 9-value canonical enum via `INBOX_STATUS_TO_OPERATIONAL` (`inboxWorkflowData.ts:150-158`); `suppressed` and `closed` **both collapse to `paused`** — information destroyed |
| **Status change (bar)** | `ThreadStateBar:337` | typed | `operational_status` | local | yes | optional | none | server | as above |
| **Temperature** | `ThreadStateBar:359` **only** | typed | `lead_temperature` | local | yes | optional | **none** | server | No temperature control exists outside `ThreadStateBar`; `markThreadHot` (`handleOperatorAction:'mark_hot'`) writes it with **no optimistic patch at all** ⇒ zero visible feedback |
| **Automation state** | `ThreadStateBar:373` writes `autopilot_mode` | typed | `autopilot_mode` | local | yes | optional | none | server | **Round-trip broken**: the client never reads `autopilot_mode` back. `resolveAutopilotMode` (`status-visuals.ts:478`) reads `thread.automationState`, which `toWorkflowThread` fabricates as `isArchived‖isSuppressed ? 'completed' : 'active'` (`inbox.adapter.ts:550`) |
| **Pause automation** | `handleOperatorAction:'pause_automation'` | none | writes `operational_status='paused'` | **none** | n/a | none | none | none | Collides with `suppressed`/`closed`, which also map to `paused` |
| **Resume automation** | `handleOperatorAction:'resume_automation'` | none | — | **none** | n/a | none | none | none | **Guaranteed failure.** `mapWorkflowPatchToCanonical` maps only `automationState === 'paused'` (`inboxWorkflowData.ts:205`); `'active'` produces `{}` ⇒ `persistUniversalLeadState` returns `ok:false, 'No allowed universal lead state fields in patch'` (`persistUniversalLeadState.ts:90-98`). Every invocation shows a red error toast. |
| **Mark read** | `handleSelect:3470` (implicit) | none | `thread-state` → `is_read` | via `mergeOptimisticPatches`? **no** — `handleSelect` sets **no** optimistic patch | n/a | none | none | none | **Fire-and-forget with no `.catch`.** Key is `resolveCanonicalThreadStateKey` (phone-first) while every other write uses `toThreadKey`. If the thread has no dialable phone, the resolver returns a raw identity ⇒ `isCanonicalThreadKey` fails ⇒ silent 400. **This is why counts never decrease.** |
| **Mark read (explicit)** | `handleThreadAction('read')` | none | `lead-state/patch` → `is_read` | yes — sets **5** fields incl. `inboxStatus:'closed'` (`optimistic-thread-patch.ts:56`) | **none** | none | none | none | Marking read optimistically sets `inboxStatus:'closed'`, which the client bucket predicate reads — the row can visually jump buckets on a read |
| **Mark unread** | `handleThreadAction('unread')` | none | `is_read=false` | yes | none | none | none | none | — |
| **Archive** | `handleToggleArchive:3397` | none | `is_archived` + `archive_scope='conversation'` | yes | **none** (Undo button issues a *second* mutation, `:3292-3305`) | none | none | `logInboxActivity` | Undo is not a rollback — if the archive silently failed, Undo issues an unarchive on a row that was never archived |
| **Unarchive** | `handleThreadAction('unarchive')` | none | `is_archived=false` + recomputed `operational_status` | yes | none | none | none | none | — |
| **Pin / Unpin / Star / Unstar** | `handleTogglePin/Star:3350-3358` | none | `is_pinned` / `is_starred` | yes | none | none | none | none | — |
| **Snooze** | `handleOperatorAction:'snooze'` | none | `operational_status='snoozed'` + `snoozed_until` | yes | none | none | none | none | `buildOptimisticThreadPatch('snooze')` sets `inboxStatus:'waiting'` — **does not match** the canonical `snoozed` it writes |
| **Suppress (DNC)** | `handleOperatorAction:'suppress'` | none | `contactability_status='opted_out'` + `lifecycle_stage='closed'` + `operational_status='paused'` | **none** | n/a | none | none | none | Three canonical fields written from one boolean; **no scope selection** — cannot express phone-scoped vs prospect-scoped vs global |
| **Wrong number** | **does not exist in Deal Desk** | — | `disposition` column exists and is normalizable (`registry.ts:80-98`) | — | — | — | — | — | No UI path writes `disposition` |
| **Not owner** | **does not exist in Deal Desk** | — | `disposition='wrong_person'` supported by the registry | — | — | — | — | — | No UI path |
| **Opt-out** | inbound-classified server-side only | — | — | — | — | — | — | — | No operator-initiated scope-aware opt-out |
| **Prospect switch** | `handleParticipantSelect:3481` | phone must be non-empty | **none — no mutation at all** | n/a | n/a | n/a | n/a | n/a | Purely a client-side selection change; the outcome that motivated the switch is never recorded |
| **Phone switch** | conflated with prospect switch | — | none | — | — | — | — | — | — |
| **Property-context switch** | `handleOpenDealIntelligence` / map / pipeline handlers | — | none | — | — | — | — | — | Changes panes; does not carry a property-scoped conversation identity |

### E.1 Why the controls "cannot be changed reliably" — the four proximate causes

1. **Key rejection [OBSERVED].** `isCanonicalThreadKey` = `/^\+1\d{10}$/` (`cockpit-service.js:27-31`, and again at `patch-universal-lead-state.js:255`). `toThreadKey` returns `thread.threadKey || thread.id || ownerId:propertyId:phone` (`inboxWorkflowData.ts:286-289`). Any thread whose `threadKey` is a composite (`ct:…`, `owner:prop:phone`) or a UUID is **unwritable**.
2. **Vocabulary loss [OBSERVED].** `SellerStage` (23 values, `inboxWorkflowData.ts:33-56`) ∩ `LIFECYCLE_STAGE_ORDER` (10 values, `registry.ts:6-21`) = ∅. `STAGE_ALIASES` (`registry.ts:163-209`) covers 9 of the 23; the heuristic chain covers 9 more; **5 fall through to the `ownership_confirmation` fallback** at `registry.ts:297`.
3. **No rollback [OBSERVED].** `handleWorkflowMutation` on `!result.ok` emits a toast and returns (`InboxPage.tsx:3167-3170`) without touching `optimisticPatches`. `optimisticPatches` is never cleared anywhere in the file — `grep` finds only `setOptimisticPatches(prev => ({...prev, …}))` additions. It is merged into every render via `mergeOptimisticPatches` (`InboxPage.tsx:778-781`), so a failed write persists visually until page reload.
4. **No propagation [OBSERVED].** Every mutation passes `skipRefresh: true`, so `refreshInbox` is never called, counts are never re-fetched, and the right panel/list/counts keep their pre-mutation values.

---

## F. Identity-model findings

### F.1 Required vs implemented

| Required relationship | Implemented? | Evidence |
|---|---|---|
| Property → **multiple** owners | **No.** `properties.master_owner_id` is a single scalar; the participants route reads exactly one owner and returns one `master_owner_name` | `property-participants/route.js:28-52` |
| Owner may be individual / trust / estate / LLC / corp / group | Partially — `master_owners` exists; the Deal Desk UI renders only `display_name` and never an owner *type* | `route.js:38-43`; `ActiveProspectCard.tsx:81` |
| Owner → multiple prospects | **Data yes, UI no.** `prospects` is queried by `master_owner_id` (limit 100) but is only used to *decorate* phone rows; prospects are never a first-class list | `route.js:58-67`, `mergeParticipantRecord:96-129` |
| Prospect has independent identity/role/relationship/confidence/phones/emails/outcomes | **No.** The unit of the UI is a **phone**: `participant_id = md5(property_id : phone : owner : prospect)` (view) or `` `${property_id}:${phone}` `` (fallback). Email is absent from the entire participant contract | `20260627120000_…sql:126-136`; `route.js:184` |
| Prospect → multiple phone numbers | **No grouping exists.** Each phone becomes its own top-level "linked" entry in the switcher | `ActiveProspectCard.tsx:160-217` |
| Phone → own thread and contact outcome | Partially — thread yes (thread_key ≈ phone), **outcome no** (`disposition` never written from the UI) | §E |
| Thread preserves prospect **and** property context | **No.** `inbox_thread_state.thread_key` is an E.164 phone. A phone that belongs to a prospect linked to two properties has **one** thread row | `cockpit-service.js:27-31` |
| Seller/prospect → multiple properties | **Not representable in the thread model** | as above |
| Property → multiple seller/prospect threads | Yes at the message level, no at the thread-state level | — |
| Contact outcome may suppress a phone without suppressing the prospect | **Schema supports it, UI cannot express it.** `suppression_scope ∈ {none, phone, property, global}` lives in `message_events.metadata` JSON, projected by the view | `20260627120000_…sql:170-176` |
| Identity outcome invalidates one prospect, preserving others | **No.** `suppressThread` writes `contactability_status='opted_out'` on the **whole thread row**, unconditionally | `inboxWorkflowData.ts:896-898` |

### F.2 The participant graph is a message projection, not an identity graph [OBSERVED]

`property_participant_graph` (`apps/api/supabase/migrations/20260627120000_inbound_intelligence_shadow_mode.sql:124-207`):

```sql
FROM public.message_events me
LEFT JOIN public.phones ph ON ph.canonical_e164 = COALESCE(me.from_phone_number, me.thread_key)
...
WHERE me.direction = 'inbound'
  AND me.property_id IS NOT NULL;
```

Consequences, all provable from the DDL:

1. **No `GROUP BY`, no `DISTINCT ON`.** The view emits **one row per inbound message event**. A phone that has replied 20 times produces 20 participant rows. Nothing downstream dedupes them: the route sorts and `.limit(50)`s them (`route.js:145-151`), and `rankParticipants` is a 1:1 `.map()` (`participant-intelligence.js:259-298`). **The "N linked" badge in `ActiveProspectCard` (`:121`) is a count of messages, not contacts.**
2. **Only phones that have replied exist.** `WHERE me.direction = 'inbound'` means an un-contacted prospect, or a prospect contacted with no reply, is invisible. **"Try Next Eligible Contact" can therefore only ever offer someone who has already replied** — which is precisely the population you do *not* need to advance to.
3. **`unread_count` is `0::integer` and `is_current_participant` is `false`** — hardcoded (`:169, 181`). The UI's `active_thread_state` derivation (`route.js:125`) is computed from a constant.
4. **The comment in the migration says so explicitly:** *"Read-only participant projection for inbox UI … not an identity source of truth."* (`:209`). The UI treats it as one.

### F.3 Wrong-number / not-owner / opt-out — end-to-end [OBSERVED]

| Expected behaviour | Actual |
|---|---|
| Wrong number → suppress **that phone**, stay on the prospect if another phone exists, advance prospect only when exhausted | No UI action exists. Nearest available action is `suppress` → writes `contactability_status='opted_out'` for the whole thread row. Phone-level suppression is only reachable by the inbound classifier writing `metadata.suppression_scope` on `message_events`. |
| Not owner → record identity outcome, preserve history, move to next probable owner | No UI action exists. `disposition='wrong_person'` is a valid canonical value (`registry.ts:81`) with **no writer**. |
| Opt-out at correct scope | Server classifier only; the operator cannot choose a scope. |
| Multiple properties → same person, distinct property contexts | Impossible — thread identity is a bare phone. |

"Try Next Eligible Contact" (`ActiveProspectCard.tsx:147` → `handleTryNextEligible:3509` → `handleParticipantSelect:3481`) does exactly one thing: it looks for a thread whose phone matches, and selects it (`InboxPage.tsx:3485-3497`). **It records nothing.** This is why wrong-number and not-owner outcomes never "visibly or reliably advance" — there is no advancement mechanism, only a selection change.

### F.4 N+1 in the participant load [OBSERVED]

```js
// property-participants/route.js:131-142
for (const row of participants) {
  const latestInboundMessage = await loadLatestInboundMessage(property_id, clean(row.canonical_e164))
  enriched.push(...)
}
```
Up to **50 sequential `message_events` queries** per participant-rail load, on top of 4 setup queries. Because the view is undeduped, most of those 50 are the same phone repeated.

---

## G. Inbox findings — counts, buckets, lifecycle, pagination, scroll, visibility

### G.1 Category contracts

| Category | Count query | List query | Same contract? |
|---|---|---|---|
| `all` / `all_messages` | `v_inbox_thread_counts_live_v2` (over `canonical_inbox_threads`), else `countThreadsMatchingTab` full scan of `inbox_thread_state` | `queryFastInboxThreadRows` over `BOOT_FAST_THREAD_SOURCE` | **No** |
| `priority` | as above | `.eq("inbox_bucket","priority")` on `inbox_thread_state` (`live-inbox-service.js:1460`) | **No** |
| `new_replies` | as above | `.or("inbox_bucket.eq.new_replies, and(latest_direction.eq.inbound, inbox_bucket.neq.dead, inbox_bucket.neq.suppressed)")` (`:1463-1469`) — **then re-filtered in JS** by `threadMatchesFilter` because `new_replies ∈ FACT_DERIVED_LIST_FILTERS` (`:2426`) | **No** |
| `needs_review` | as above | `.eq("inbox_bucket","needs_review")` (`:1473`) | **No** |
| `follow_up` | as above | `.eq(…,"follow_up")` (`:1476`) | **No** |
| `waiting` | `countThreadsMatchingTab` → `threadMatchesBucketFilter` (24h window) | `.or(…)` + JS re-filter | **No** |
| `cold` | as above | `.or(…)` + JS re-filter | **No** |
| `dead` | as above | `.eq(…,"dead")` (`:1490`) | **No** |
| `suppressed` | as above | `.eq(…,"suppressed")` (`:1493`) | **No** |
| `active` | `priority+new_replies+needs_review+follow_up` (`:2260-2261`) | `.in("inbox_bucket",[4 buckets])` (`:1508`) | close, but derived differently |

**Dependencies per category** are encoded in `threadMatchesInboxTab` (`inbox-thread-state-contract.js:122-160`) → `threadMatchesBucketFilter` (`inbox-bucket-predicates.js`) for counts, and in `applyInboxThreadStateBucketFilter` / `applyQueryFilter` (`live-inbox-service.js:1457, 1563`) for lists. They read overlapping but **not identical** field sets: counts consider `is_archived`, `needs_review`, `disposition`, `metadata`, `pending_queue_count`, `automation_*` (`INBOX_THREAD_STATE_SELECT_FIELDS`, `:45-74`); lists consider only `inbox_bucket`, `latest_direction`, `latest_message_at`, `thread_key`.

### G.2 The live endpoint never returns counts [OBSERVED]

```js
// live/route.js:55-57
const liveOptions = timeoutMode === 'initial_boot' || timeoutMode === 'manual_bucket_switch' || timeoutMode === 'auto_refresh'
  ? { listOnly: true, skipCounts: true, skipDelivery: true }
  : {}
```
`timeoutMode` is coerced to one of those three at `:37-39` (default `'manual_bucket_switch'`). The ternary can therefore **never be false**. Every `/inbox/live` response carries `countPreservedReason: 'counts_skipped_by_request'`, which triggers a *second* round trip to `/inbox/counts` from the client (`inbox.adapter.ts:1239-1252`).

The same always-true condition sets `listOnly: true`, which sets `skipLinkedContextHydration` (`live-inbox-service.js:2369`), which **skips `hydrateThreadIdentityFromMessageEvents` and `bulkHydrateInboxThreadLinkedContext` on every request** (`:2505-2511`) — despite the comment two lines above stating *"Keep linked-context hydration on bucket tab switches so list rows show owner/address."* **This is the direct cause of list rows showing bare phone numbers with no name, no address and no image (audit item #16).**

### G.3 Counts are a full-table scan × 9, plus a write [OBSERVED]

```js
// live-inbox-service.js:2167-2189
async function countThreadsMatchingTab(supabase, tab, {pageSize = 1000, …}) {
  while (true) {
    const {data} = await supabase.from("inbox_thread_state")
      .select(INBOX_THREAD_STATE_SELECT_FIELDS)     // 25 columns, NO WHERE CLAUSE
      .range(offset, offset + pageSize - 1);
    for (const row of rows) if (threadMatchesInboxTab(row, tab, nowMs)) total += 1;
    …
  }
}
```
Called once per tab for **9 tabs** (`:2227-2241`). For N threads that is `9 × ceil(N/1000)` round trips, each returning 25 columns, with all filtering done in Node. `augmentCountsWithDerivedNullBuckets` (`:2191`) adds another full scan.

Worse, `fetchAuthoritativeInboxCounts` **opens with a write**:
```js
// live-inbox-service.js:2224
await transitionStaleWaitingThreads(supabase, nowMs);
```
which issues up to **500 individual `UPDATE` statements in a loop** (`reconcile-inbox-thread-state.js:24-38`) inside a `GET /api/cockpit/inbox/counts` request. This runs on boot, on the degraded poll tick, and on a 
debounced timer after **every realtime event** (`inbox.adapter.ts:1724-1729`).

This path is only reached when the fast view `v_inbox_thread_counts_live_v2` returns no concrete row (`:2281-2308`), so in a healthy deployment it is the fallback — but it is the fallback that fires exactly when the system is already degraded.

### G.4 Pagination is structurally dead on bucket tabs [OBSERVED — highest-confidence defect in this audit]

```js
// live-inbox-service.js:1843-1850  (queryAuthoritativeInboxThreads)
const hasMore = rawRows.length > limit;
const page = hasMore ? rawRows.slice(0, limit) : rawRows;
const rows = page.map(mapAuthoritativeInboxRow);
return { data: rows, count: rows.length, hasMore, … };   //  ← hasMore is returned…
```
```js
// live-inbox-service.js:2391-2399  (getLiveInbox)
const { data: rawRows, count, sourceConfig } = await queryThreadSource(…);   //  ← …and discarded
…
// :2432
const hasMore = postFiltered.length > limit;      //  data.length === limit  ⇒  limit > limit  ⇒  false
```
`nextCursor` is then gated on `hasMore` (`:2542`), so it is always `null`.

Client side: `canLoadMore={Boolean(data.pagination?.hasMore)}` (`InboxPage.tsx:5232`) ⇒ the Load-More button never renders (`InboxSidebar.tsx:1644`). Bucket switches request `limit: 30` (`InboxPage.tsx:1524`, `:1374`).

**Result: 30 rows maximum per bucket tab, permanently, with no affordance to load more.** By contrast the `all` filter goes through `queryFastInboxThreadRows`, which returns `limit + 1` rows without slicing (`:1907-1911, 1956-1960`), so `hasMore` works there — which is exactly why the problem reads as "some threads are missing" rather than "pagination is broken".

A second, independent truncation: even on the `all` path, `postFiltered` is computed *after* `threadMatchesSearch` and (for `waiting`/`new_replies`/`all_messages`/`cold`) `threadMatchesFilter` JS post-filtering (`:2428-2430`). Any row dropped there reduces the count below `limit` and flips `hasMore` to false early.

### G.5 Scroll [OBSERVED]

The scroll bugs come from a single structural error: **`groupsRef` is not the scrolling element when the list is virtualized.**

`shouldVirtualizeList = !isMobile && displayedActiveThreads.length >= 12` (`InboxSidebar.tsx:1561`) — true in essentially every real session. When true, react-window owns its own scroll container inside `groupsRef`. Yet all four scroll behaviours target `groupsRef`:

| Behaviour | Code | Effect when virtualized |
|---|---|---|
| Capture position before Load More | `InboxSidebar.tsx:1351-1356` reads `groupsRef.current.scrollTop` | always `0` |
| Restore position after append | `:1381-1392` sets `el.scrollTop = saved.top + (newScrollHeight - saved.height)` | no-op on the wrong element |
| Reset to top on bucket switch | `:1396-1401` `el.scrollTop = 0` | no-op |
| Scroll selected row into view | `:1365-1377` `root.querySelector('[data-thread-id=…]')` | returns `null` for any row outside the render window |

Meanwhile the virtual list runs a **feedback loop**:
```tsx
// VirtualizedInboxList.tsx:76-99
useEffect(() => {
  …
  api.scrollToRow({ index: targetIndex, align:'start', behavior:'instant' })
  onScrollOffsetChange?.(targetOffset)
}, [initialScrollOffset, items.length, listRef, onScrollOffsetChange, rowHeight])
```
`onRowsRendered` (`:113-119`) calls `onScrollOffsetChange(offset)` → `setSidebarListScrollOffset` in `InboxPage` (`:5246`) → `initialScrollOffset` prop changes → the effect re-runs → `scrollToRow` snaps the list to a row boundary. **User scrolling is quantised and fights the effect.**

And because `sidebarListScrollOffset` is **one global scalar** (`InboxPage.tsx:687`) rather than per bucket, switching buckets carries the old offset into the new list. `applySavedPreset` compensates with `setSidebarListScrollOffset(0)` (`:1513`) and a comment admitting the design flaw — *"Virtual list scroll offset is global — reset on every bucket switch so a deep scroll in All Messages cannot leave Priority/New Replies looking blank."* The per-bucket slot **already exists and is dead code**: `BucketSlice.scrollTop` and `SET_BUCKET_SCROLL` (`inbox-store.ts:11, 46, 460-469`) are never dispatched.

`items.length` in the effect deps also means **every Load-More append re-triggers `scrollToRow`**.

### G.6 Lifecycle — why counts never decrease [OBSERVED]

There is no completion lifecycle for any active category:

- `priority`, `new_replies`, `needs_review`, `follow_up` are derived from message chronology and `inbox_bucket`, not from an operator "handled" flag. The only fields that could retire a row are `is_read` and `is_archived`.
- **`is_read` write is fire-and-forget with a different key resolver** (`InboxPage.tsx:3468-3474`) — `void callBackend(...)` with no `.then`/`.catch`. A `400 invalid_canonical_thread_key` is invisible.
- **`is_archived` is the only true removal**, and it is a destructive-feeling action ("Archive") rather than "Handled" / "Done". Hence audit item #12 — *threads cannot be cleanly removed from active categories without deletion.*
- `applyCountDeltas` clamps at zero (`inbox-store.ts:248`) and `SET_VIEW_COUNTS` with `preserveExisting` **refuses to lower a positive count** (`inbox-store.ts:478-480`: `if (Number.isFinite(next[key]) && next[key] > 0) continue`). **Counts are structurally monotonic-upward in the degraded path.**

---

## H. Street View and property-media findings

### H.1 Two independent implementations

| | List thumbnails | Right panel |
|---|---|---|
| Component | `InboxStreetViewThumb` (`components/InboxStreetViewThumb.tsx`) | `PropertyHeroCard` (`IntelligencePanel.tsx:2424`) |
| Technique | `<img>` Static Street View API | `<iframe>` Google Maps **Embed** API |
| Memoised | **yes** (`:82`) | **no** |
| Failure cache | **yes** — `localStorage` `lc.streetview.v1:` (`utils/streetViewImageCache.ts`) | **no** |
| Fallback | placeholder tile with `⌂` glyph (`:73-76`) | `<div className="nx-panel-fallback"><Icon name="eye"/></div>` — an **empty box** (`IntelligencePanel.tsx:2517`) |

### H.2 Exact cause of the repeated reload [OBSERVED]

The iframe has **no `key`**, and it lives inside subtrees that are structurally swapped:

```tsx
// IntelligencePanel.tsx:2544-2560
const renderMediaWorkspace = () => {
  if (mediaMode === 'street')  return <div className="nx-prop-media-workspace is-single">{renderStreetPanel(…)}</div>
  if (mediaMode === 'aerial')  return <div className="…is-single">{renderAerialPanel(…)}</div>
  return <div className="…is-split">{renderStreetPanel(…)}{renderAerialPanel(…)}</div>   // different position
}
```
React reconciles by position. Moving the street panel from index 0 of an `is-split` container to index 0 of an `is-single` container is a different element path ⇒ **the iframe is destroyed and recreated ⇒ the Google Maps Embed reloads from scratch ⇒ a white frame for the duration of the load.**

Three triggers, all confirmed in source:

1. `useEffect(() => { setMediaMode('split') }, [address])` (`:2459`) — **every property change forces a mediaMode reset**, and if the user had switched to `street`, that reset is itself a remount.
2. Any user toggle of the media mode buttons (`:2855`).
3. `layoutMode` / `panelMode` are derived from pane width (`InboxPage.tsx:4844-4851`), and `renderMediaWorkspace`'s branches differ by layout — **resizing a pane remounts the iframe**.

### H.3 Blank/black frames are provider failure states, not loading states [OBSERVED]

```tsx
// IntelligencePanel.tsx:2437-2438
const propertyLat = Number((thread as any).lat ?? thread.latitude ?? 0)
const propertyLng = Number((thread as any).lng ?? thread.longitude ?? 0)
```
Missing coordinates coerce to **`0`**. `buildInteractiveStreetViewUrl` guards with `Math.abs(Number(lat)) > 0.0001` (`:74`) and falls back to `address` — so Null Island is avoided *there*. But:

- `buildAerialViewUrl` / `buildInteractiveAerialViewUrl` and `buildStreetViewUrl` (`domain/inbox/inbox-normalization.ts`) receive the same `0` values in other call paths.
- When Google has **no panorama** for a location, the Embed API renders its own grey/black "no imagery" frame **inside the iframe**. The host has no error channel for an iframe — `onError` does not fire — so `imageFailed` never becomes true and the fallback never shows. **The black/blank box the operator sees is the raw provider failure state, rendered at full panel size.**
- The `<img>` path *does* have `onError` (`:2515`) and a failure cache, but the iframe path (the one used at every non-compact layout) has neither.

### H.4 Property data and media do not load together [OBSERVED]

Four independent, unsynchronised requests feed the right panel:

| Request | Where | Cancellable | Cached |
|---|---|---|---|
| `thread-hydration` | orchestrator | yes | no |
| `thread-dossier` | orchestrator | yes | `dealContextCacheRef` (`InboxPage.tsx:769`) |
| `thread-context` | orchestrator | yes | no |
| `properties/{id}/valuation-snapshot` | `IntelligencePanel.tsx:738-766` — a bare `fetch`, cancel flag only, **no AbortController** | no | no |

Each commits independently, so the panel paints in four visible steps: address → snapshot numbers → dossier context → media.

---

## I. Performance findings

### I.1 Unstable identities that defeat every memo

| Issue | Evidence | Consequence |
|---|---|---|
| `InboxModel` built inline on every render of `useInboxData` | `inbox.adapter.ts:1828-1883` — a 40-key object literal, not `useMemo`d | `data` identity changes every render; `data.pagination`, `data.counts` reads are fine but any consumer memo keyed on `data` recomputes |
| `metaRef.current` mutated outside render | `inbox.adapter.ts:1256-1277` | `data.pagination.hasMore` (which gates Load More) can change **without a re-render** |
| `renderRow={(thread) => renderThreadRow(thread)}` | `InboxSidebar.tsx:1628` | new function every render ⇒ `rowProps={{items, renderRow}}` (`VirtualizedInboxList.tsx:112`) is a new object every render ⇒ **react-window re-renders every visible row on every parent render**, defeating `memo` on `CompactRow25`/`CommandCenterRow` |
| `memo(VirtualizedInboxListInner)` | `VirtualizedInboxList.tsx:125` | useless — `renderRow` prop always differs |
| `selected` memo depends on `threads` **and** `filtered` | `InboxPage.tsx:1045` | new `selected` object on every 15s poll and every realtime event ⇒ `canonicalSelectedContext` → `workspaceThread` → `IntelligencePanel` full re-render (6,099-line component, unmemoised) |
| `effectiveActiveContext = previewContext ?? activeContext` | `InboxPage.tsx:665` — computed inline | referenced in ~12 dep arrays |
| `selectedRef.current = selected` **assigned during render** | `InboxPage.tsx:1046` | render-phase side effect; unsafe under StrictMode/concurrent rendering |
| Realtime effect deps `[refresh, realtimeEnabled]`; `refresh` deps `[runLoad, sourceMode, minRefreshMs]` | `inbox.adapter.ts:1810, 1417` | changing `sourceMode` tears down and re-subscribes the global channel **and re-runs the boot fetch** (`:1458-1460`) |
| Per-thread channel recreated on every click | `InboxPage.tsx:2292, 2467` | WebSocket subscribe/unsubscribe per click |
| No server-side realtime filters | `inbox.adapter.ts:1744-1750`, `InboxPage.tsx:2293` | every `message_events` row in the system is pushed to every client and filtered in JS (`belongsToSelection`, `:2276`) |

### I.2 Expensive work during render

| Work | Where | Cost |
|---|---|---|
| `getInboxViewCounts(threads)` + **6 separate `threads.filter()` passes** | `InboxPage.tsx:861-896` | 7 O(n) passes per render of the counts memo |
| `new Map(threads.map(t => [t.id, buildConversationDecision(t)]))` | `InboxPage.tsx:849-852` | full decision engine over every thread |
| **The same decision map computed again** in the sidebar | `InboxSidebar.tsx:1288-1292` | duplicated O(n) work |
| `applyInboxFilters(threads, {search, stage, view, advanced})` | `InboxPage.tsx:983-1000` | runs on **every keystroke** of `searchQuery` |
| `matchesSearch(thread, searchQuery)` over all threads | `InboxSidebar.tsx:1284-1286` | second search pass, same keystroke |
| `sortThreadsByDecision(...).slice(0, visibleThreadCount)` | `InboxSidebar.tsx:1301` | full sort per render; `visibleThreadCount` starts at **1000** (`InboxPage.tsx:696`) |
| `void useMemo(() => getAdvancedFilterOptions(threads), [threads])` | `InboxPage.tsx:848` | **result explicitly discarded** — pure waste |
| `mapThreads` rebuilds a pin index and maps all threads | `InboxPage.tsx:811-846` | runs whenever `data.mapPins` or `threads` change |
| `sortRowsNewestFirst` on every realtime patch, for **every bucket** | `inbox-store.ts:433-444` | O(buckets × n log n) per inbound message |

### I.3 Server-side cost

| Query | Where | Cost |
|---|---|---|
| Counts full scan × 9 tabs | `live-inbox-service.js:2167-2241` | `9 × ceil(N/1000)` round trips, 25 cols each |
| Null-bucket augmentation scan | `:2191-2221` | +`ceil(M/1000)` |
| Up to 500 sequential `UPDATE`s **inside a GET** | `reconcile-inbox-thread-state.js:24-38` | write amplification on a read path |
| `select("*", {count:"exact"})` on `inbox_threads_hydrated` | `inbox-hydrated-filter-service.js:314` | forces a full COUNT over the filtered set **and** returns every column of a wide view — **on every advanced-filter page** |
| `fetchInboxThreads` reads 2,500 `send_queue` rows unconditionally | `inboxWorkflowData.ts:680-684` | — |
| `fetchSentMessages` pages `message_events` and `send_queue` **without bound** | `inboxWorkflowData.ts:700-737` | unbounded `while(true)` |
| Participant N+1 | `property-participants/route.js:131-142` | ≤50 sequential queries |
| `hydrateVisibleThreadDelivery` | `live-inbox-service.js:1186` | skipped in fast mode ⇒ delivery badges are frequently absent |

### I.4 Why filters feel slowest

Three compounding effects, all [OBSERVED]:
1. Any active advanced filter re-routes the list to `inbox_threads_hydrated` with `select("*", {count:"exact"})` (`inbox-hydrated-filter-service.js:314`) — the single most expensive query in the workspace.
2. Applying a preset calls `refreshInbox({_force:true, limit:30})` **and** clears selection **and** resets scroll (`InboxPage.tsx:1512-1534`), so the entire workspace re-hydrates.
3. Search is debounced 250 ms **only for the server request** (`inbox.adapter.ts:1408`); the client-side `applyInboxFilters` + `matchesSearch` + `sortThreadsByDecision` chain runs synchronously on every keystroke.

---

## J. Loading, error and empty-state findings

There is no single contract. Eleven distinct treatments are in use:

| # | Treatment | Location |
|---|---|---|
| 1 | 5-row shimmer skeleton | `InboxSidebar.tsx:1608-1619` |
| 2 | 5-bubble chat skeleton | `ChatThread.tsx:539-547` |
| 3 | Plain text `"No conversations match this filter."` | `InboxSidebar.tsx:1639` |
| 4 | Error button `"Inbox could not load. Retry."` | `InboxSidebar.tsx:1636-1638` |
| 5 | Inline `"Loading…"` string replacing a headline | `ActiveProspectCard.tsx:110` |
| 6 | Centred spinner + text block with **inline styles** | `IntelligencePanel.tsx:1350-1356` |
| 7 | `"Unavailable"` literal for ~40 individual fields | `IntelligencePanel.tsx:55-61` and ~25 call sites |
| 8 | Silent `null` render (component returns nothing) | `ActiveProspectCard.tsx:99`; `VirtualizedInboxList.tsx:101` |
| 9 | Empty grey box | `IntelligencePanel.tsx:2517, 2537` |
| 10 | **Raw provider failure surface** (Google's own no-imagery frame) | `IntelligencePanel.tsx:2506-2513, 2526-2533` |
| 11 | Bare route text `"Opening Deal Intelligence…"` | `DealIntelligenceInboxRoute.tsx:12` |

Plus a blocking `alert()` on a success path — `IntelligencePanel.tsx:783` `if (result.ok) alert('Deal pushed to underwriting workflow.')`.

**Error boundaries:** none wrap any Deal Desk surface. `WorkspaceSuspense` (`InboxPage.tsx:276`) provides a Suspense fallback for lazy chunks only — not an error boundary.

**Where good data is wiped by an unresolved request [OBSERVED]:**

1. **Bucket switch nulls the selection**, which runs the hydration effect's null branch and clears `selectedMessages`, `threadContext`, `threadIntelligence`, and `dealContext` (`InboxPage.tsx:2004-2017`) — the center and right panels blank even though the previously-selected thread's data was valid and cached.
2. **`ChatThread` swaps content for a skeleton** whenever `loading && messages.length === 0` (`:539`) — and `setSelectedMessages(plan.immediate.selectedMessages)` sets `[]` on a cache miss (`thread-select-orchestrator.ts:112`), so every uncached open flashes a skeleton over a panel that previously had content.
3. **`onHydration` can overwrite the message list** that `onMessages` just committed (`InboxPage.tsx:2114-2120`) — guarded by `current.length > 0 ? current : result.messages`, but it unconditionally re-writes `messageCacheRef` and `hasOlderMessages`.
4. **`optimisticPatches` is never cleared**, so a wiped-then-refetched list still carries stale patches from failed mutations (`InboxPage.tsx:740, 778-781`).

**Good precedents that exist and should be generalised:** the store deliberately *preserves* rows on error (`inbox-store.ts:314-315`), and `useInboxData` refuses to commit degraded responses over richer ones (`inbox.adapter.ts:1118-1146`). The problem is that this discipline stops at the bucket list and is absent everywhere else.

---

## K. Information-architecture findings

### K.1 Stage / status / temperature / automation appear in **three** places

| Surface | Stage | Status | Temperature | Automation | Vocabulary | Rollback |
|---|---|---|---|---|---|---|
| `ThreadStateBar` (in `ChatThread`, `:783`) | ✅ `:348` | ✅ `:337` | ✅ `:359` | ✅ `:373` | **canonical** | ✅ |
| `IntelligencePanel` — `WorkflowControl` v2 | ✅ `:1058` | ✅ `:1038` | ✗ | ✗ | UI legacy | ✗ |
| `IntelligencePanel` — `WorkflowControl` v3 | ✅ `:3158` | ✅ `:3139` | ✗ | ✗ | UI legacy | ✗ |

**Recommended canonical location: `ThreadStateBar`.** It is the only surface that uses the canonical vocabulary, is the only one with pending/error/rollback affordances, and is the only one with a stage-change confirmation modal. Both `IntelligencePanel` `WorkflowControl` variants should be deleted, and the right panel should render stage/status/temperature as **read-only evidence** with a link to the bar.

### K.2 Duplication and hierarchy

| Finding | Evidence |
|---|---|
| Deal Intelligence duplicates stage/status already shown in the conversation header | `IntelligencePanel.tsx:1038-1058, 3139-3158` vs `ThreadStateBar` |
| Two Street View surfaces, two aerial surfaces, two failure models | §H.1 |
| Four row renderers for one list, each with its own layout and pill set | `InboxSidebar.tsx:770, 904, 977, 1092` |
| Pill/chip/badge proliferation in the panel — `identityChips`, `physicalChips`, `constructionChips`, `equityChips`, `riskChips`, `prospectTagBadges`, `propertyTagBadges`, `prospectMatchBadges`, `MatchBadge` | `IntelligencePanel.tsx:2698, 2724, 2751, 2802, 2826, 2924, 3017, 3039` |
| Right panel reads as field-driven, not decision-driven — ~40 `'Unavailable'` fallbacks mean the layout is generated from whatever the row happens to carry | `IntelligencePanel.tsx:55-61` + call sites |
| Property **facts** rendered as state-like pills (beds/baths/sqft/year built next to stage pills) | `IntelligencePanel.tsx:4911-4919` |
| `nextSystemAction: 'Review thread for system recommended next steps.'` — a **hardcoded string** presented as intelligence | `inbox.adapter.ts:551` |
| Bulk-action bar renders 6 buttons that all `console.warn('BACKEND_ENDPOINT_NOT_READY')` | `InboxSidebar.tsx:1547-1549, 1329-1332` |
| Modules with no operational question: `SellerOwnerCard`, `ProspectPanel`, `ContactIntelligenceCard`, `ConversationBrainModule`, `BuyerMatchingModule`, `CompIntelligenceModule` all render simultaneously in one grid | `IntelligencePanel.tsx:5903-5930` |
| Buried: the **next-best-contact decision** — the single most operationally important element — sits inside a collapsed dropdown | `ActiveProspectCard.tsx:142-155, 158` |
| Dead code shipped: `ThreadList.tsx` (146 lines, own filter logic) is imported nowhere in the Deal Desk path | — |
| 13 CSS files layered over one workspace | `modules/inbox/*.css` |

---

## L. Prioritised defect register

Root-cause codes: **DM** data-model · **AC** API-contract · **SD** state-duplication · **RR** request-race · **CI** cache-invalidation · **CR** component-remount · **MF** mutation-failure · **QP** query-performance · **PG** pagination · **SB** subscription · **RN** rendering · **LS** loading-state · **ID** identity-model · **IA** information-architecture · **VS** visual-system.

---

**DD-001 — Bucket-tab pagination always reports `has_more: false`**
Severity **P0** · Root cause **PG, AC**
*Symptom:* Only ~30 threads are reachable in Priority / New Replies / Needs Review / Follow-Up / Waiting / Cold / Dead / Suppressed. No "Load More" button appears. Operators believe threads have disappeared.
*Evidence:* `live-inbox-service.js:1846-1850` slices to `limit` and returns `hasMore`; `:2391` discards it; `:2432` recomputes `hasMore = postFiltered.length > limit` where `postFiltered.length ≤ limit`. `:2542` gates `nextCursor` on it. Client: `InboxPage.tsx:5232`, `InboxSidebar.tsx:1644`.
*Files:* `apps/api/src/lib/domain/inbox/live-inbox-service.js`
*Fix:* Thread `hasMore` and `nextCursor` out of `queryThreadSource` (all four branches) and stop recomputing them in `getLiveInbox`. Have every source return `limit + 1` rows and slice in exactly one place, after post-filtering.
*Dependencies:* none · *Risk:* low (server-only)
*Verification:* Seed a bucket with `limit + 5` rows; assert `pagination.has_more === true` and `next_cursor !== null`; assert two successive pages return disjoint `thread_key` sets covering all rows.

---

**DD-002 — Stage/status writes are lossy and silently mis-persist**
Severity **P0** · Root cause **DM, MF, AC**
*Symptom:* Stage changes appear to succeed, then revert or land on the wrong stage after refresh.
*Evidence:* `SellerStage` (`inboxWorkflowData.ts:33-56`) ∩ `LIFECYCLE_STAGE_ORDER` (`registry.ts:6-21`) = ∅. `STAGE_ALIASES` (`registry.ts:163-209`) misses `mf_units_confirmed`, `mf_occupancy_requested`, `mf_rent_roll_requested`, `mf_gross_rents_requested`, `mf_suppressed`; the heuristic chain (`:287-296`) does not catch them; `:297` returns fallback `'ownership_confirmation'`. `INBOX_STATUS_TO_OPERATIONAL` (`inboxWorkflowData.ts:150-158`) collapses `suppressed` and `closed` to `paused`.
*Files:* `apps/dashboard/src/domain/lead-state/universal-lead-state-registry.ts`, `apps/dashboard/src/lib/data/inboxWorkflowData.ts`, `apps/dashboard/src/modules/inbox/components/IntelligencePanel.tsx`
*Fix:* Delete the `SellerStage`/`InboxStatus` vocabularies from the mutation path; make `LifecycleStageCode`/`OperationalStatusCode` the only types accepted by the UI controls. Make `normalizeLifecycleStage`/`normalizeOperationalStatus` **throw or return null on unknown input** rather than silently falling back.
*Dependencies:* DD-006 (single canonical control) · *Risk:* medium — every stage-reading call site must be reviewed
*Verification:* Table-driven test asserting every value a stage control can emit round-trips to itself through `normalizePatchToCanonical` → DB → `resolveThreadStage`.

---

**DD-003 — Every write is rejected for threads whose key is not a bare E.164**
Severity **P0** · Root cause **DM, MF, ID**
*Symptom:* On some threads no control works at all; on others everything works. Appears random.
*Evidence:* `isCanonicalThreadKey` = `/^\+1\d{10}$/` (`cockpit-service.js:27-31`; duplicated `patch-universal-lead-state.js:255`). Write path uses `toThreadKey = thread.threadKey || thread.id || owner:prop:phone` (`inboxWorkflowData.ts:286-289`). Read-mark path uses a **different** resolver, `resolveCanonicalThreadStateKey` (`domain/inbox/resolveCanonicalThreadStateKey.ts:80-84`), which is phone-first.
*Files:* `apps/dashboard/src/lib/data/inboxWorkflowData.ts`, `apps/api/src/lib/cockpit/cockpit-service.js`, `apps/api/src/lib/domain/lead-state/patch-universal-lead-state.js`
*Fix:* One resolver for all thread-state I/O. Either widen the server contract to accept the composite key and resolve it server-side, or make the client always resolve to E.164 and **fail loudly** when it cannot.
*Dependencies:* none · *Risk:* medium
*Verification:* For each thread returned by `/inbox/live`, assert `resolve(thread)` satisfies the server predicate; assert a `PATCH` with a synthetic `property:*` key returns a surfaced, user-visible error.

---

**DD-004 — Failed mutations are reported as successes and never rolled back**
Severity **P0** · Root cause **MF, SD, LS**
*Symptom:* "Action completed successfully" appears; the DB is unchanged; the wrong value persists on screen until reload.
*Evidence:* `InboxPage.tsx:3167-3170` returns on `!result.ok` without touching `optimisticPatches`; `:3177-3182` emits success. `optimisticPatches` has no clear path anywhere in the file. `mergeOptimisticPatches` (`optimistic-thread-patch.ts:66-74`) re-applies it every render. All mutations pass `skipRefresh: true`.
*Files:* `apps/dashboard/src/modules/inbox/InboxPage.tsx`, `apps/dashboard/src/domain/inbox/optimistic-thread-patch.ts`
*Fix:* Add `revertOptimisticPatch(threadId, keys)`; call it on `!ok` and on throw. Reconcile (drop the patch) when a server row for that thread arrives with matching values. Never emit a success toast before `ok === true`.
*Dependencies:* DD-003 · *Risk:* low
*Verification:* Force a 400 from `/lead-state/patch`; assert the control returns to its prior value and an error is surfaced.

---

**DD-005 — "Resume automation" can never succeed**
Severity **P1** · Root cause **MF, DM**
*Symptom:* Resume Automation always shows a red error.
*Evidence:* `mapWorkflowPatchToCanonical` maps only `automationState === 'paused'` (`inboxWorkflowData.ts:205`); `resumeAutomation` sends `'active'` (`:959-961`) ⇒ `{}` ⇒ `persistUniversalLeadState.ts:90-98` returns `ok:false`.
*Files:* `apps/dashboard/src/lib/data/inboxWorkflowData.ts`
*Fix:* Route pause/resume through the canonical `autopilot_mode` field used by `ThreadStateBar` (`:373`), not `operational_status`.
*Dependencies:* DD-011 · *Risk:* low
*Verification:* Assert `resume_automation` returns `ok:true` and `autopilot_mode` reads back as `autopilot_on`.

---

**DD-006 — Stage/status controls exist in three places with two vocabularies and two failure models**
Severity **P1** · Root cause **SD, IA, MF**
*Evidence:* `ThreadStateBar.tsx:337-373` (canonical, with rollback) vs `IntelligencePanel.tsx:1038/1058` and `:3139/3158` (legacy, no rollback).
*Fix:* `ThreadStateBar` becomes the single control surface. Both `WorkflowControl` variants become read-only displays.
*Dependencies:* DD-002 · *Risk:* low-medium (visual)
*Verification:* Grep for `onStageChange`/`onStatusChange` — exactly one writer should remain.

---

**DD-007 — Counts and lists are computed from different sources by different predicates**
Severity **P1** · Root cause **AC, DM, QP**
*Symptom:* Tab badges never match row counts; counts never decrease.
*Evidence:* Counts → `v_inbox_thread_counts_live_v2` over `canonical_inbox_threads` (`20260529181259_…:544`) or `threadMatchesInboxTab` JS scan of `inbox_thread_state` (`inbox-thread-state-contract.js:122`). Lists → `applyInboxThreadStateBucketFilter` SQL on `inbox_thread_state` (`live-inbox-service.js:1457`) plus JS re-filtering for four buckets (`:2426-2430`). Five separate bucket predicates exist (§D).
*Fix:* One SQL predicate per bucket, expressed once (a SQL function or generated view), used by both count and list. Delete the client-side re-bucketing in `inbox-store.ts:177-219`.
*Dependencies:* DD-001 · *Risk:* high (touches the live query engine)
*Verification:* For each bucket, assert `count(bucket) === length(paginate-all(bucket))`.

---

**DD-008 — Mark-read is fire-and-forget with a divergent key; counts cannot decrement**
Severity **P1** · Root cause **MF, AC, ID**
*Evidence:* `InboxPage.tsx:3468-3474` — `void callBackend(...)`, no `.catch`, no state update, different resolver from every other write. Reducer refuses to lower positive counts in the preserve path (`inbox-store.ts:478-480`).
*Fix:* Await the result, roll back the unread badge on failure, and use the same resolver as every other write.
*Dependencies:* DD-003 · *Risk:* low
*Verification:* Open an unread thread; assert `new_replies` decrements within one counts cycle.

---

**DD-009 — No completion lifecycle: threads can only leave an active bucket by being archived**
Severity **P1** · Root cause **DM, IA**
*Evidence:* No `handled_at` / `resolved_at` / `dismissed_at` in `INBOX_THREAD_STATE_SELECT_FIELDS` (`inbox-thread-state-contract.js:45-74`). Bucket predicates are chronology-driven. Archive is the only removal (`inboxWorkflowData.ts:837`).
*Fix:* Add an explicit operator-completion state distinct from archive, and include it in the single bucket predicate from DD-007.
*Dependencies:* DD-007 · *Risk:* medium (migration)
*Verification:* Mark handled → row leaves the bucket, count decrements, thread remains findable in All Messages.

---

**DD-010 — Participant graph is an undeduped projection of inbound messages**
Severity **P1** · Root cause **ID, DM, QP**
*Symptom:* One person appears many times under "Active Prospect"; the "N linked" count is wrong; contacts who never replied are invisible.
*Evidence:* `20260627120000_inbound_intelligence_shadow_mode.sql:124-207` — no `GROUP BY`/`DISTINCT ON`, `WHERE me.direction='inbound'`, `unread_count` hardcoded `0`, `is_current_participant` hardcoded `false`. No dedupe downstream (`participant-intelligence.js:259-298`; `route.js:145-151`). N+1 at `route.js:131-142`.
*Fix:* Replace with a prospect-centric contract: `DISTINCT ON (prospect_id, phone_id)` sourced from `prospects` + `phones` (not messages), left-joined to last activity. Batch the latest-inbound lookup into one query.
*Dependencies:* DD-012 · *Risk:* medium
*Verification:* Assert one row per (prospect, phone); assert a never-contacted prospect appears; assert ≤3 queries per participant load.

---

**DD-011 — Automation state is fabricated client-side and its write target is never read back**
Severity **P1** · Root cause **DM, SD**
*Evidence:* `inbox.adapter.ts:550` `automationState: (isArchived || isSuppressed) ? 'completed' : 'active'`. `resolveAutopilotMode` reads that fabricated value (`status-visuals.ts:478-488`). `ThreadStateBar` writes `autopilot_mode` (`:373`), which never reaches the client model.
*Fix:* Project `autopilot_mode` into the thread row contract; delete the fabrication.
*Dependencies:* DD-005 · *Risk:* low
*Verification:* Change automation; refresh; assert the control shows the persisted value.

---

**DD-012 — Thread identity is a phone number, so property-scoped conversation context cannot exist**
Severity **P1** · Root cause **ID, DM**
*Symptom:* A seller with two properties has one merged conversation; suppression cannot be scoped.
*Evidence:* `isCanonicalThreadKey` = E.164 (`cockpit-service.js:27-31`). `suppression_scope` lives in `message_events.metadata` JSON, not a column (`20260627120000_…sql:170-176`). `suppressThread` writes thread-wide `contactability_status` (`inboxWorkflowData.ts:896-898`).
*Fix:* Introduce a composite conversation identity (property × prospect × phone) as a first-class row, with suppression scoped at the phone level and identity outcomes at the prospect level.
*Dependencies:* DD-003, DD-010 · *Risk:* **high** — schema change
*Verification:* One prospect, two properties → two distinct threads; suppressing a phone on property A leaves property B contactable.

---

**DD-013 — Wrong-number / not-owner / scoped opt-out have no UI path**
Severity **P1** · Root cause **ID, IA, MF**
*Evidence:* `handleOperatorAction` (`InboxPage.tsx:3933-4023`) has no such case. `disposition` is a valid canonical field (`registry.ts:80-98`, `UNIVERSAL_LEAD_STATE_PATCH_FIELDS:131`) with **no writer** in the dashboard. "Try Next Eligible Contact" only changes selection (`InboxPage.tsx:3509-3511`).
*Fix:* Add explicit outcome actions that write `disposition` + a scope, then advance the contact path as a consequence of the recorded outcome.
*Dependencies:* DD-010, DD-012 · *Risk:* medium
*Verification:* Wrong-number on phone 1 of 2 → phone 1 suppressed, same prospect selected on phone 2, history preserved.

---

**DD-014 — Counts endpoint performs 9 full-table scans and up to 500 writes**
Severity **P1** · Root cause **QP**
*Evidence:* `countThreadsMatchingTab` (`live-inbox-service.js:2167-2189`) — no `WHERE`, 25 columns, 1000-row pages, called for 9 tabs (`:2227-2241`). `augmentCountsWithDerivedNullBuckets` (`:2191`) adds another. `fetchAuthoritativeInboxCounts` opens with `transitionStaleWaitingThreads` (`:2224`), which issues ≤500 sequential `UPDATE`s (`reconcile-inbox-thread-state.js:24-38`) inside a GET.
*Fix:* One SQL aggregate (`COUNT(*) FILTER (WHERE …)`) over the shared bucket predicate. Move the waiting→cold transition to the existing `/api/internal/maintenance/reconcile-inbox-buckets` cron.
*Dependencies:* DD-007 · *Risk:* medium
*Verification:* Assert `/inbox/counts` issues exactly one query and zero writes.

---

**DD-015 — Street View iframe remounts on media-mode toggle, address change and pane resize**
Severity **P1** · Root cause **CR, RN, LS**
*Evidence:* `IntelligencePanel.tsx:2544-2560` returns structurally different subtrees per `mediaMode`; the iframe has no `key` (`:2506`); `:2459` resets `mediaMode` on every address change; `layoutMode` derives from pane width (`InboxPage.tsx:4844-4851`).
*Fix:* Render both panels once with a stable `key={propertyId}`, hoisted above the layout branches; drive `mediaMode` with CSS visibility, not conditional rendering. Memoise `PropertyHeroCard`.
*Dependencies:* none · *Risk:* low
*Verification:* Instrument iframe `load`; assert exactly one load per property, zero on mode toggle or resize.

---

**DD-016 — Iframe provider failures render as raw white/black panels with no fallback**
Severity **P2** · Root cause **LS, VS**
*Evidence:* iframes at `IntelligencePanel.tsx:2506-2513, 2526-2533` have no `onError` (iframes do not fire it); `imageFailed` (`:2454`) only guards the `<img>` branch; the fallback is an empty box (`:2517`). The `<img>` path's `localStorage` failure cache (`utils/streetViewImageCache.ts`) is not used by the iframe path.
*Fix:* Probe availability via the Street View metadata endpoint before mounting the embed; cache negative results per property; render a designed fallback (address card + external links) instead of an empty box.
*Dependencies:* DD-015 · *Risk:* low
*Verification:* Force a no-panorama coordinate; assert the fallback renders and no blank frame appears.

---

**DD-017 — Bucket switch clears the selection, blanking the center and right panels**
Severity **P2** · Root cause **SD, LS, CR**
*Evidence:* `InboxPage.tsx:1518-1520` and `:1363-1365` call `setSelectedId(null)`; the hydration effect's null branch (`:2004-2017`) clears messages, context, intelligence and deal context; an auto-select effect then picks the first row (`:2299+`), triggering a second full hydration.
*Fix:* Keep the selection if the thread is still present in the new bucket; otherwise show a "not in this view" affordance rather than tearing down. Never clear hydrated panel data on selection change — swap it.
*Dependencies:* DD-018 · *Risk:* medium
*Verification:* Switch buckets with a thread selected; assert the right panel never renders an empty state if the thread is still visible.

---

**DD-018 — Selected thread has eight representations**
Severity **P2** · Root cause **SD**
*Evidence:* `selectedId`, `selectedThreadKey`, `layoutState.selectedThreadId`, `activeContext.threadKey`, `previewContext.threadKey`, `selectedThreadFallbackRef`, `universalEntityContext`, and `inbox-store.selectedThreadKey` (`InboxPage.tsx:661-666, 735, 754`; `inbox-store.ts:28`). `SELECT_THREAD` is dispatched into the store but the value is never read by `InboxPage`.
*Fix:* Single `selection` object `{threadKey, propertyId, prospectId, phoneE164}` owned by the reducer; everything else derives.
*Dependencies:* DD-012 · *Risk:* medium
*Verification:* Grep — exactly one `useState`/reducer slice for selection.

---

**DD-019 — Scroll logic targets the wrong element when the list is virtualized**
Severity **P2** · Root cause **RN, PG**
*Evidence:* `shouldVirtualizeList` is true at ≥12 rows (`InboxSidebar.tsx:1561`), yet capture (`:1351-1356`), restore (`:1381-1392`), reset (`:1396-1401`) and scroll-into-view (`:1365-1377`) all use `groupsRef`, the non-scrolling outer wrapper.
*Fix:* Route all scroll operations through the `ListImperativeAPI` already held in `VirtualizedInboxList`.
*Dependencies:* DD-020 · *Risk:* low
*Verification:* Scroll to row 40, Load More, assert the anchor row stays in view.

---

**DD-020 — Virtual-list scroll offset is a single global scalar in a feedback loop**
Severity **P2** · Root cause **RN, SD**
*Evidence:* `sidebarListScrollOffset` (`InboxPage.tsx:687`, wired at `:5245-5246`); `onRowsRendered` → `onScrollOffsetChange` → prop change → effect re-run → `scrollToRow` (`VirtualizedInboxList.tsx:76-99, 113-119`). Per-bucket `scrollTop` exists unused in `inbox-store.ts:11, 46, 460-469`.
*Fix:* Store the offset per bucket via the existing `SET_BUCKET_SCROLL` action; restore only on bucket change (not on `items.length` change); do not echo scroll position back as a controlled prop.
*Dependencies:* none · *Risk:* low
*Verification:* Scroll bucket A, switch to B, return to A — position restored; no scroll-quantisation jitter.

---

**DD-021 — Live endpoint always skips linked-context hydration; list rows lack identity**
Severity **P2** · Root cause **AC, DM**
*Evidence:* `live/route.js:55-57` — the ternary can never be false, so `listOnly: true` is always passed ⇒ `skipLinkedContextHydration` is always true (`live-inbox-service.js:2369`) ⇒ `hydrateThreadIdentityFromMessageEvents` and `bulkHydrateInboxThreadLinkedContext` never run (`:2505-2511`), contradicting the comment at `:2367-2368`.
*Fix:* Keep `listOnly` only for `initial_boot`; hydrate on bucket switch and auto-refresh, or move owner/address into the list view so no hydration pass is needed.
*Dependencies:* none · *Risk:* low-medium (latency)
*Verification:* Assert every row on a bucket tab has a non-empty `owner_name` or `property_address_full` when the underlying data has one.

---

**DD-022 — Advanced filters run `select("*", {count:"exact"})` on a wide hydrated view**
Severity **P2** · Root cause **QP**
*Evidence:* `inbox-hydrated-filter-service.js:314`.
*Fix:* Select only the row-contract columns; use `{count:'planned'}` or drop the count entirely and rely on cursor pagination.
*Dependencies:* DD-001 · *Risk:* low
*Verification:* Compare p95 latency with and without the exact count.

---

**DD-023 — Row re-render storm: unstable `renderRow` defeats every row memo**
Severity **P2** · Root cause **RN**
*Evidence:* `InboxSidebar.tsx:1628` inline arrow → new `rowProps` object each render (`VirtualizedInboxList.tsx:112`) → react-window re-renders all visible rows; `memo` on `CompactRow25`/`CommandCenterRow` (`:977, 1092`) and on `VirtualizedInboxList` (`:125`) is therefore inert.
*Fix:* Pass the memoised `renderThreadRow` directly; memoise `rowProps`.
*Dependencies:* none · *Risk:* low
*Verification:* React Profiler — row commits should not exceed the number of rows whose data changed.

---

**DD-024 — Thread hydration is sequential despite claiming to be parallel**
Severity **P2** · Root cause **RR, QP**
*Evidence:* `thread-select-orchestrator.ts:275-281` awaits `messages` before `Promise.all` of the other three; every plan entry is nonetheless labelled `parallelGroup: 'primary'` (`:97-102`).
*Fix:* Start all four concurrently; keep the existing `isStillSelected` guard for commit ordering.
*Dependencies:* none · *Risk:* low
*Verification:* Assert the four request start timestamps fall within one tick.

---

**DD-025 — Per-thread realtime channel churn plus unfiltered global subscriptions**
Severity **P2** · Root cause **SB, QP**
*Evidence:* `InboxPage.tsx:2292/2467` creates and destroys `nexus-inbox-thread-${key}` per click. Both channels subscribe with `event:'*'` and no filter (`inbox.adapter.ts:1744-1750`), filtering in JS at `InboxPage.tsx:2276-2289`. The global subscription effect also depends on `refresh`, which changes with `sourceMode` (`inbox.adapter.ts:1810, 1417`), re-running the boot fetch.
*Fix:* One long-lived channel with server-side filters; narrow the effect deps to primitives.
*Dependencies:* none · *Risk:* medium
*Verification:* Count subscribe/unsubscribe events across 20 thread clicks — expect zero.

---

**DD-026 — Participant load issues up to 50 sequential queries**
Severity **P2** · Root cause **QP, ID**
*Evidence:* `property-participants/route.js:131-142`.
*Fix:* One batched `message_events` query keyed by the participant phone set.
*Dependencies:* DD-010 · *Risk:* low
*Verification:* Assert query count is O(1) in participant count.

---

**DD-027 — Eleven loading/empty/error treatments, no error boundary**
Severity **P2** · Root cause **LS, VS**
*Evidence:* §J. No `ErrorBoundary` wraps any Deal Desk surface; `WorkspaceSuspense` (`InboxPage.tsx:276`) is Suspense-only.
*Fix:* One `<Panel state="loading|empty|error|partial">` primitive; error boundary per pane; never replace successful content with a skeleton.
*Dependencies:* DD-017 · *Risk:* low
*Verification:* Snapshot every pane in each state.

---

**DD-028 — Optimistic patches contradict the canonical writes they accompany**
Severity **P2** · Root cause **SD, DM**
*Evidence:* `optimistic-thread-patch.ts:56` — `'read'` sets five fields including `inboxStatus:'closed'`, which the client bucket predicate consumes (`inbox-store.ts:177-219`); `:60` — `'snooze'` sets `inboxStatus:'waiting'` while the server writes `operational_status:'snoozed'`.
*Fix:* Optimistic patches must set exactly the canonical fields the mutation writes.
*Dependencies:* DD-004 · *Risk:* low
*Verification:* Property test — patch keys ⊆ server patch keys.

---

**DD-029 — `alert()` on a success path**
Severity **P3** · Root cause **VS, LS**
*Evidence:* `IntelligencePanel.tsx:783`.
*Fix:* Use `emitNotification`. *Risk:* none.

---

**DD-030 — Dead and non-functional UI shipped**
Severity **P3** · Root cause **IA**
*Evidence:* `ThreadList.tsx` (146 lines) unused in the Deal Desk path; bulk-action bar renders 6 buttons that only `console.warn('BACKEND_ENDPOINT_NOT_READY')` (`InboxSidebar.tsx:1547-1549, 1329-1332`); `void useMemo(() => getAdvancedFilterOptions(threads), …)` result discarded (`InboxPage.tsx:848`); `nextSystemAction` is a hardcoded sentence (`inbox.adapter.ts:551`).
*Fix:* Delete. *Risk:* none.

---

**DD-031 — Four row renderers and thirteen stylesheets for one list**
Severity **P3** · Root cause **VS, IA**
*Evidence:* `InboxSidebar.tsx:770, 904, 977, 1092`; `modules/inbox/*.css` (13 files).
*Fix:* One row component with density variants; one stylesheet with tokens. *Risk:* medium (visual).

---

**DD-032 — Right panel is field-generated, not decision-designed**
Severity **P3** · Root cause **IA**
*Evidence:* ~40 `'Unavailable'` fallbacks (`IntelligencePanel.tsx:55-61` + call sites); 8 chip collections; 10+ modules rendered simultaneously (`:5903-5930`).
*Fix:* Restructure around three decision questions — *Is this the right person? · Is this deal worth pursuing? · What is the next action?* *Risk:* medium.

---

**DD-033 — A 5,468-line component and a 6,099-line panel**
Severity **P3** · Root cause **RN, IA**
*Evidence:* `InboxPage.tsx` (60+ `useState`, 40+ `useEffect`), `IntelligencePanel.tsx`.
*Fix:* Extract per §M lanes; do not attempt a single-pass rewrite. *Risk:* high if done first — schedule after contracts stabilise.

---

## M. Recommended implementation sequence

Each lane is scoped to be independently mergeable. Lanes marked ⛓ must not run in parallel with their dependency.

**Lane 1 — Canonical state and identity contracts** (DD-002, DD-003, DD-012, DD-018)
Single thread-key resolver; canonical stage/status/temperature vocabulary as the only UI type; `normalize*` fails loudly on unknown input; single `selection` object in the reducer. Composite conversation identity is the schema-level part — land the resolver unification first, then the schema change behind a flag.

**Lane 2 — Mutation reliability** ⛓ after 1 (DD-004, DD-005, DD-006, DD-008, DD-011, DD-028)
Rollback on failure; success toast only after `ok:true`; one control surface (`ThreadStateBar`); fix resume-automation and mark-read; project `autopilot_mode` into the row contract; align optimistic patches with canonical writes.

**Lane 3 — Thread selection and hydration stability** ⛓ after 1 (DD-017, DD-024, DD-025)
True parallel hydration; never clear hydrated data on selection change; one long-lived filtered realtime channel.

**Lane 4 — Street View and property-media isolation** (independent — safe to run in parallel with 1–3) (DD-015, DD-016)
Stable `key={propertyId}`, hoisted above layout branches; CSS-driven mode switching; metadata pre-check with a negative cache; designed fallback.

**Lane 5 — Inbox lifecycle and counts** ⛓ after 1 (DD-007, DD-009, DD-014, DD-021)
One SQL bucket predicate shared by count and list; explicit completion state; single-aggregate counts; move the waiting→cold write out of the read path; restore linked-context hydration.

**Lane 6 — Pagination and scroll restoration** ⛓ after 5 (DD-001, DD-019, DD-020)
Fix `hasMore`/`nextCursor` threading; route scroll through the list API; per-bucket offsets via the existing store action.

**Lane 7 — Filter simplification** ⛓ after 5 and 6 (DD-022)
Narrow the hydrated select; drop the exact count; consider collapsing ad-hoc filters into saved views.

**Lane 8 — Loading/error-state system** ⛓ after 3 (DD-027)
One `<Panel state=…>` primitive; per-pane error boundaries; no skeleton over existing content.

**Lane 9 — Interaction redesign** ⛓ after 2 and 8 (DD-013, DD-030, DD-031)
Wrong-number / not-owner / scoped opt-out actions; delete dead UI; one row component.

**Lane 10 — Deal Intelligence redesign** ⛓ after 9 (DD-010, DD-026, DD-032)
Prospect-centric participant contract; batched enrichment; three-question panel structure.

**Lane 11 — Visual system and motion** ⛓ after 9 and 10 (DD-029, DD-033)
Token consolidation; stylesheet collapse; component extraction.

**Lane 12 — Final verification**
Contract tests (count == list length per bucket; mutation round-trip per control; pagination reaches every row), React Profiler budgets, Playwright regression across all four layout widths.

---

## N. Agent-ready follow-up prompts

> Each prompt is scoped to a disjoint file set so they can run sequentially or in isolated worktrees. Overlapping files are called out explicitly.

### N.1 — State and hydration stabilization
> Scope: `apps/dashboard/src/modules/inbox/InboxPage.tsx`, `apps/dashboard/src/modules/inbox/inbox-store.ts`, `apps/dashboard/src/modules/inbox/inbox.adapter.ts`, `apps/dashboard/src/domain/inbox/thread-select-orchestrator.ts`, `apps/dashboard/src/domain/inbox/resolveCanonicalThreadStateKey.ts`, `apps/dashboard/src/lib/data/inboxWorkflowData.ts` (key resolver only).
>
> Collapse the eight representations of the selected thread (`selectedId`, `selectedThreadKey`, `layoutState.selectedThreadId`, `activeContext.threadKey`, `previewContext.threadKey`, `selectedThreadFallbackRef`, `universalEntityContext`, `inbox-store.selectedThreadKey`) into one reducer-owned `selection: {threadKey, propertyId, prospectId, phoneE164}`; everything else must derive. Unify `toThreadKey` (`inboxWorkflowData.ts:286`) and `resolveCanonicalThreadStateKey` into one resolver used by every read and write, and make it fail loudly when it cannot produce a key the server's `/^\+1\d{10}$/` guard (`apps/api/src/lib/cockpit/cockpit-service.js:27`) accepts. Make `executeThreadSelectFetches` (`thread-select-orchestrator.ts:275-281`) genuinely parallel. Stop clearing `selectedMessages`/`threadContext`/`threadIntelligence`/`dealContext` when the selection changes (`InboxPage.tsx:2004-2017`) — swap them instead. Remove the render-phase assignment `selectedRef.current = selected` (`InboxPage.tsx:1046`). Do not touch mutations, Street View, or the inbox list. Add unit tests asserting: one selection source; four hydration requests start within one tick; panel data is never set to empty during a swap.

### N.2 — Manual control repair
> Scope: `apps/dashboard/src/domain/lead-state/universal-lead-state-registry.ts`, `apps/dashboard/src/domain/lead-state/persistUniversalLeadState.ts`, `apps/dashboard/src/lib/data/inboxWorkflowData.ts`, `apps/dashboard/src/domain/inbox/optimistic-thread-patch.ts`, `apps/dashboard/src/modules/inbox/components/ThreadStateBar.tsx`, `apps/dashboard/src/modules/inbox/components/IntelligencePanel.tsx` (`WorkflowControl` blocks at `:1020-1070` and `:3120-3170` only).
> **Depends on N.1** (shared key resolver).
>
> Delete the `SellerStage`/`InboxStatus` vocabularies from the mutation path; the UI must emit only `LifecycleStageCode`/`OperationalStatusCode`/`LeadTemperatureCode`. Make `normalizeLifecycleStage`/`normalizeOperationalStatus`/`normalizeLeadTemperature` return `null` on unknown input instead of falling back (`registry.ts:297, 305, 313`) and make callers surface that as an error. Add `revertOptimisticPatch` and call it whenever `handleWorkflowMutation` sees `!ok` or throws (`InboxPage.tsx:3167-3170`); never emit a success toast before `ok === true`. Fix `resumeAutomation` (`inboxWorkflowData.ts:959`) to write `autopilot_mode` rather than an unmapped `automationState`, and project `autopilot_mode` into the thread row so `resolveAutopilotMode` stops reading the fabricated value at `inbox.adapter.ts:550`. Make `ThreadStateBar` the only writer; convert both `IntelligencePanel` `WorkflowControl` variants to read-only. Align every optimistic patch with the exact canonical fields its mutation writes (`optimistic-thread-patch.ts:56, 60`). Add a table-driven test asserting every emittable control value round-trips to itself.

### N.3 — Inbox lifecycle and count repair
> Scope: `apps/api/src/lib/domain/inbox/live-inbox-service.js`, `apps/api/src/lib/domain/inbox/inbox-thread-state-contract.js`, `apps/api/src/lib/domain/inbox/inbox-bucket-predicates.js`, `apps/api/src/lib/domain/inbox/reconcile-inbox-thread-state.js`, `apps/api/src/app/api/cockpit/inbox/live/route.js`, `apps/api/src/app/api/cockpit/inbox/counts/route.js`, plus one new migration.
>
> Express each bucket as **one** SQL predicate used by both the count aggregate and the list query — today counts use `threadMatchesInboxTab` (`inbox-thread-state-contract.js:122`) or `v_inbox_thread_counts_live_v2`, lists use `applyInboxThreadStateBucketFilter` (`live-inbox-service.js:1457`) plus JS post-filtering (`:2426-2430`), and the client re-buckets again (`inbox-store.ts:177-219`). Replace `countThreadsMatchingTab`'s 9× unfiltered full scan (`:2167-2189`) with a single `COUNT(*) FILTER (WHERE …)` aggregate. Remove the `transitionStaleWaitingThreads` write from the counts read path (`:2224`) and schedule it on the existing `/api/internal/maintenance/reconcile-inbox-buckets` cron. Fix the always-true ternary at `live/route.js:55-57` so `listOnly` applies only to `initial_boot`, restoring linked-context hydration for bucket tabs. Add an explicit operator-completion state distinct from `is_archived`. Add a contract test asserting `count(bucket) === length(paginate-all(bucket))` for every bucket.

### N.4 — Identity / contact-path reconstruction
> Scope: `apps/api/src/lib/domain/inbox/property-participant-graph.js`, `apps/api/src/lib/domain/inbox/participant-intelligence.js`, `apps/api/src/app/api/cockpit/inbox/property-participants/route.js`, `apps/dashboard/src/modules/inbox/components/ActiveProspectCard.tsx`, `apps/dashboard/src/modules/inbox/components/PropertyParticipantRail.tsx`, `apps/dashboard/src/modules/inbox/utils/participantLabels.ts`, plus one migration replacing the `property_participant_graph` view.
> **Depends on N.1 and N.2.**
>
> Replace `property_participant_graph` (`apps/api/supabase/migrations/20260627120000_inbound_intelligence_shadow_mode.sql:124-207`) — which is `FROM message_events … WHERE direction='inbound'` with no `GROUP BY`, hardcoded `unread_count = 0` and `is_current_participant = false` — with a prospect-centric contract sourced from `prospects` + `phones`, `DISTINCT ON (prospect_id, phone_id)`, left-joined to last activity, so never-contacted prospects appear and one person appears once. Batch `loadLatestInboundMessage` (`route.js:131-142`) into a single query. Restructure `ActiveProspectCard` around prospects with nested phones instead of a flat phone list. Add wrong-number / not-owner / scoped opt-out actions that write `disposition` plus an explicit scope, and make "Try Next Eligible Contact" a **consequence** of a recorded outcome rather than a bare selection change (`InboxPage.tsx:3509-3511`). Verify: one prospect with two phones renders once with two phone rows; suppressing phone 1 keeps the prospect selected on phone 2.

### N.5 — Street View / media repair
> Scope: `apps/dashboard/src/modules/inbox/components/IntelligencePanel.tsx` (`PropertyHeroCard`, `:2424-2620`, and `buildInteractive*Url`, `:63-110`), `apps/dashboard/src/modules/inbox/components/InboxStreetViewThumb.tsx`, `apps/dashboard/src/modules/inbox/utils/streetViewImageCache.ts`, `apps/dashboard/src/domain/inbox/inbox-normalization.ts` (URL builders only).
> **Independent — safe to run in parallel with N.1–N.3.**
>
> Render the street and aerial embeds exactly once with a stable `key={propertyId}`, hoisted above the `mediaMode` and `layoutMode` branches — today `renderMediaWorkspace` (`:2544-2560`) returns structurally different subtrees, so every mode toggle, address change (`:2459` resets `mediaMode`) and pane resize destroys and recreates the iframe. Drive mode changes with CSS visibility. Memoise `PropertyHeroCard`. Because iframes never fire `onError`, probe the Street View metadata endpoint before mounting and cache negative results per property in the existing `streetViewImageCache`; render a designed fallback (address card + external links) instead of the empty box at `:2517`. Add an AbortController to the valuation-snapshot fetch (`:738-766`). Instrument iframe `load` and assert exactly one load per property.

### N.6 — Pagination and scroll repair
> Scope: `apps/api/src/lib/domain/inbox/live-inbox-service.js` (`queryThreadSource`/`getLiveInbox` pagination only), `apps/dashboard/src/modules/inbox/components/VirtualizedInboxList.tsx`, `apps/dashboard/src/modules/inbox/components/InboxSidebar.tsx` (scroll effects `:1342-1422` and the list block `:1591-1652`), `apps/dashboard/src/modules/inbox/inbox-store.ts` (`SET_BUCKET_SCROLL` wiring).
> **Depends on N.3** (shares `live-inbox-service.js`).
>
> Thread `hasMore`/`nextCursor` out of `queryThreadSource` — `queryAuthoritativeInboxThreads` computes them correctly (`:1846-1850`) and `getLiveInbox` discards and wrongly recomputes them (`:2432`), making `has_more` permanently false on every bucket tab. Slice to `limit` in exactly one place, after post-filtering. Then: route all scroll operations through `ListImperativeAPI` instead of `groupsRef` (which is not the scrolling element when virtualized — `InboxSidebar.tsx:1351, 1381, 1396, 1365`); store the offset **per bucket** using the already-defined-but-unused `SET_BUCKET_SCROLL` action (`inbox-store.ts:46, 460-469`) instead of the single global `sidebarListScrollOffset` (`InboxPage.tsx:687`); and remove the scroll feedback loop by dropping `onScrollOffsetChange` and `items.length` from the restore effect's deps (`VirtualizedInboxList.tsx:99`). Pass the memoised `renderThreadRow` directly rather than the inline arrow at `InboxSidebar.tsx:1628`. Verify: a bucket with 200 rows is fully reachable; scroll position survives a bucket round-trip; React Profiler shows no full-list row commits on selection change.

### N.7 — Deal Intelligence redesign
> Scope: `apps/dashboard/src/modules/inbox/components/IntelligencePanel.tsx` (everything except `PropertyHeroCard`, owned by N.5), `apps/dashboard/src/domain/deal-intelligence/*`.
> **Depends on N.2 and N.4.**
>
> Restructure the panel around three decision questions — *Is this the right person? · Is this deal worth pursuing? · What is the next action?* Remove duplicated stage/status controls (now read-only per N.2). Replace the ~40 `'Unavailable'` field fallbacks (`:55-61` + call sites) and 8 chip collections (`:2698, 2724, 2751, 2802, 2826, 2924, 3017, 3039`) with a hierarchy that shows only decision-relevant facts and collapses the rest. Delete the hardcoded `nextSystemAction` sentence (`inbox.adapter.ts:551`) or back it with real data. Replace the `alert()` at `:783` with `emitNotification`. Separate property **facts** from workflow **state** visually. Do not change mutation paths or the participant contract.

### N.8 — Final cinematic UI pass
> Scope: `apps/dashboard/src/modules/inbox/*.css` (13 files), `apps/dashboard/src/modules/inbox/components/InboxSidebar.tsx` (row components `:770, 904, 977, 1092`), a new shared `<Panel state=…>` primitive.
> **Depends on all of N.1–N.7.**
>
> Collapse the four row renderers into one component with density variants. Collapse 13 stylesheets into one token-driven sheet. Introduce a single loading/empty/error/partial primitive replacing the eleven treatments catalogued in §J, and add a per-pane error boundary (none exists today; `WorkspaceSuspense` at `InboxPage.tsx:276` is Suspense-only). Delete dead UI: `ThreadList.tsx`, the `BACKEND_ENDPOINT_NOT_READY` bulk bar (`InboxSidebar.tsx:1547-1549`), and the discarded `useMemo` at `InboxPage.tsx:848`. Add Playwright snapshots for every pane state at all four layout widths.

---

## Appendix — verification status

| Claim class | Method | Confidence |
|---|---|---|
| Constants, predicates, vocabularies, dead branches, SQL DDL | Direct file read | **Observed** |
| Render/effect ordering, request counts, remount causes | Static trace of React semantics | **Inferred** (high) |
| Production latency, live count/list divergence magnitude | **Not measured** — prod credentials intentionally not used | **Not verified** |

No application code, test, migration, or database state was read-modified during this audit. No production process was started.
