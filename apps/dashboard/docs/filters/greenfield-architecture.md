# Master Filters — Greenfield Architecture

Generated: 2026-07-06  
Branch: `claude/map-filters-pr3-runtime-integration`  
Base: `origin/main` @ `d86915a`

## Mission

Replace the rejected Map Command → Filters tab with a four-domain property-universe engine. Every filter stack resolves to **distinct `property_id` values** shown on the map.

Domains: **Properties**, **Prospects**, **Master Owners**, **Phones**.

## Legacy product inventory (DELETE)

The legacy Filters product is embedded in `InboxCommandMap.tsx` — no standalone module files.

| Artifact | Location | Action |
|----------|----------|--------|
| `MapFilterState` type | `InboxCommandMap.tsx` ~382–401 | Remove |
| `FILTER_CATEGORIES` (incl. Buyer tab) | ~833–839 | Remove |
| `FILTER_PRESETS` hardcoded chips | ~841–854 | Remove |
| `filterSearch` (unused fake search) | ~4217, ~9541 | Remove |
| `matchesFilters()` client pin filter | ~1900–1944 | Remove |
| Filters tab JSX | ~9532–9813 | Replace with `MasterFiltersWorkspace` |
| Legacy filter CSS | `inbox-premium.css`, `index.css`, `nexus-theme.css` | Remove filter selectors |

**Preserve:** Modes, Style, Intel, Performance tabs; buyer demand dock (`buyerCommandData.ts`); command palette inbox filters.

## Canonical relationship graph

```
Property ──master_owner_id──► Master Owner
Property ──map_filter_property_prospect_links──► Prospect
Property ──map_filter_property_phone_links──► Phone
Phone ──primary_prospect_id / canonical_prospect_id──► Prospect
Phone ──master_owner_id──► Master Owner
```

All runtime predicates use **EXISTS** via bridge tables — no hot-path JSON expansion.

## Backend modules (extend, do not rewrite)

| Layer | Path | PR3 change |
|-------|------|------------|
| Registry | `active-field-registry-source.js` | Add `phone` entity fields |
| Compiler | `map-filter-compiler.js` | Add `phone_rule` AST node |
| Predicate SQL | `map-filter-predicate-sql.js` | Phone bridge EXISTS modes |
| Counts | `map-filter-count-service.js` | `matchingPhones` count |
| Tokens | `map-filter-token-store.js` | Phone metadata in referenced entities |
| Resolver | `map-filter-token-resolver.js` | **New** — single auth entry |
| Property predicate | `map-filter-property-predicate.js` | **New** — shared map SQL helper |
| Bridges | migrations | `map_filter_property_phone_links` |
| Saved filters | migration + routes | `map_filter_saved_filters` |

Registry version bump: `2026-07-06.1` after verified phone fields.

## Map runtime integration

| Source | Route | Filter param |
|--------|-------|--------------|
| National aggregates | `GET /ops/map` (z < 6) | `?filter=<token>` |
| Spatial clusters | `GET /ops/map` (z 6–8.99) | `?filter=<token>` |
| Bounds accounting | `GET /ops/map/accounting` | `?filter=<token>` |
| MVT tiles | `GET /ops/map/tiles/{z}/{x}/{y}` | `?filter=<token>` |

Token failure → structured error. **Never** fall back to unfiltered data.

Cache keys must include: public token, organization, permission scope, schema/registry version, zoom, bounds/tile coords.

## Frontend architecture

```
apps/dashboard/src/views/map/master-filters/
  MasterFiltersWorkspace.tsx      # Shell (desktop + mobile)
  MasterFiltersProvider.tsx       # Draft/applied state, preview, token
  desktop/
    MasterFiltersDesktop.tsx
    DiscoverPane.tsx
    FilterStackPane.tsx
    ResultsPane.tsx
  mobile/
    MasterFiltersMobile.tsx
    MobileNav.tsx
  shared/
    EntityRail.tsx
    FieldSearch.tsx
    FieldCatalog.tsx
    RuleCard.tsx
    GroupCard.tsx
    QuickFilters.tsx
    ExpressionSummary.tsx
    ResultsPanel.tsx
    SavedFiltersLibrary.tsx
    controls/                     # Liquid-glass input controls by data type
  hooks/
    useMapFilterRegistry.ts
    useMapFilterPreview.ts
    useMapFilterToken.ts
    useFieldSearch.ts
    useSavedFilters.ts
  styles/
    master-filters.css
```

### State model

| State | Purpose |
|-------|---------|
| `draftExpression` | Editable stack (AdvancedMapFilterNode tree) |
| `appliedExpression` | Controls map after Apply |
| `appliedToken` | Public scoped token passed to map sources |
| `previewCounts` | Debounced live preview from `/filters/preview` |
| `savedFilters` | Persisted library |

### Map integration (`InboxCommandMap.tsx`)

- `appliedMapFilterToken: string | null` passed to `fetchMapProperties`, tile URL, accounting
- Token change → cancel stale requests, replace MVT source, preserve camera

## Saved filters model

Table: `map_filter_saved_filters`

- `id`, `organization_id`, `created_by`, `name`, `description`
- `expression_json`, `summary`, `is_favorite`, `is_system`, `scope` (personal|organization)
- `filter_schema_version`, `registry_version`
- `active_rule_count`, `last_known_property_count`, `use_count`, `last_used_at`

## Verification artifacts

`apps/api/proof/map-filters/pr3/` — no-filter regression, filtered accounting, dense markets, security, cache isolation, timings.

## Commit sequence

1. This document + legacy inventory
2. Four-domain engine (phones + bridges)
3. Map runtime token integration
4. Desktop Master Filters UI
5. Mobile Master Filters UI
6. Saved filter library
7. E2E verification + polish