# Master Filters Rebuild Verification

Date: 2026-07-06

## Backend correctness (closed)

- Root cause: `apps/api/proof/map-filters/uncontacted-property-root-cause.md`
- Regression tests: `apps/api/tests/unit/map-filter-universe.test.mjs` (9/9 passing)
- Property baseline: **124,046** (`TABLE_ROW_BASELINES.properties`)

## UI rebuild (shipped)

| Commit | Scope |
|--------|-------|
| `f4ed514` | Canonical universe + contact-status semantics |
| `1bd5dcf` | Removed rejected UI |
| `a70d7c2` | Desktop wide workspace (`desktop-workspace/`) |
| `c603ef5` | Mobile full-screen workspace + Map Command integration |
| `b70f568` | System preset ordering + saved library metadata |

## Automated checks

- `apps/dashboard`: `npm run typecheck` — pass
- `apps/dashboard`: `npm run build` — pass
- `apps/api`: `node --test tests/unit/map-filter-universe.test.mjs` — pass

## Visual proof capture checklist

Capture via Map Command → Filters tab after deploy:

### Desktop (1280×800, 1440×900, 1728×1117, 1920×1080)

- [ ] Empty state — Results shows 124,046 properties
- [ ] Four-rule stack — center pane usable, not clipped
- [ ] Results pane always visible
- [ ] Saved Filters drawer
- [ ] Uncontacted preset applied
- [ ] Contacted preset applied
- [ ] Clear-all restored

### Mobile (375×812, 390×844, 430×932)

- [ ] Discover view
- [ ] Stack view
- [ ] Results view
- [ ] Saved view
- [ ] Footer: Clear | Show N Properties

### Map runtime

- [ ] Aggregates change when filter applied
- [ ] Clusters change when filter applied
- [ ] MVT tiles change when filter applied

Store captures under `apps/api/proof/map-filters/rebuild-screenshots/`.