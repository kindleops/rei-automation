# Supabase Data Wiring (No-Redesign Pass)

This project now supports optional live data loading from Supabase for:
- Home
- Queue
- Dossier
- Inbox
- Live Map (Live Dashboard market/map hydration)

UI structure and styling were intentionally left unchanged.

## Feature Flag

Enable Supabase data wiring with:

```bash
VITE_USE_SUPABASE_DATA=true
```

If the flag is not enabled, all modules continue using existing mock/reference data paths.

## Required Environment Variables

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

If these are missing while the feature flag is enabled, each module gracefully falls back to its existing local/mock loader behavior.

## Service Layer

New service modules:
- `src/lib/data/dashboardData.ts`
- `src/lib/data/queueData.ts`
- `src/lib/data/sellerData.ts`
- `src/lib/data/inboxData.ts`
- `src/lib/data/mapData.ts`
- `src/lib/data/realtime.ts` (subscription scaffold)

Supporting infrastructure:
- `src/lib/supabaseClient.ts`
- `src/lib/data/shared.ts`
- `src/types/supabaseData.ts`

## Adapter/Loader Wiring

Updated to call Supabase services when enabled:
- `src/modules/home/home.adapter.ts`
- `src/modules/queue/queue.adapter.ts`
- `src/modules/dossier/dossier.adapter.ts`
- `src/modules/inbox/inbox.adapter.ts`
- `src/modules/dashboard/live/load-live-dashboard.ts`

## Error Handling and Fallback

Each Supabase-backed loader:
1. Checks feature flag + env
2. Attempts live query path
3. On any error, logs warning in development and falls back to existing mock/static data model

This preserves current UX and prevents runtime breakage when data source is unavailable.

## Realtime Scaffold

`src/lib/data/realtime.ts` contains reusable subscription helpers:
- `subscribeToTableChanges(table, onChange)`
- `subscribeToCoreData(onChange)`

This file is intentionally scaffold-only and can be connected to route revalidation or module refresh cycles in a later pass.

## Notes

- Column mappings are defensive and support alias field names where possible.
- Queries are read-only in this pass.
- No route/component redesign was done.
