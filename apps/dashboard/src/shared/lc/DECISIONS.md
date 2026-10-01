# LeadCommand Experience System 4.0 — component decision matrix

Internal. Written 2026-10-01 from a full inventory of `apps/dashboard/src`
(four parallel audits: overlays, controls/data, feedback/tokens, shell) and the
current official Arc registry (`uiarc.dev/r/catalog.json`: 223 items, 122 free,
101 Pro). App code depends on `shared/lc` — never on Arc or Radix directly.

**Arc licence position.** Free items are MIT (see `shared/arc/LICENSE.arc.md`).
Pro items (Data Grid, Funnel, Sankey, Sidebar rail, Workspace sidebar, Dock,
Glass tab bar, Sheet stack, Skeleton morph, KPI drilldown, Metric explorer …)
are NOT licensed here: no source fetched, nothing reconstructed. Where a Pro
item names the interaction we need, LeadCommand implements it natively.
"Morph Select" does not exist in the current catalog (free or Pro).

**Engine.** Arc's free overlays are built on Radix primitives; we install the
same seven Radix packages (popover, dropdown-menu, context-menu, tooltip,
dialog, select, hover-card — 47 lockfile additions, zero changes/removals) as
the accessibility + positioning engine. This replaces ~20 hand-written rect
math copies, 35 outside-click listeners, 98 Esc handlers and 11 scroll locks.
No focus trap existed anywhere before.

| Need | Current (inventory) | Arc candidate | Decision | Why | Risk |
|---|---|---|---|---|---|
| Tokens: material / depth | `--lg-*` (operator glass), `--dsk-*` calm layer (only real shared layer, `--dsk-chip-bg` ×273), 30+ app families, `--k-*` kit copied ×9 with drifting values | Arc foundation (global, generic names) | **REPLACE (new `--lc-*`)**, chained from `--dsk-*` / `--lg-*` | One vocabulary without a second glass system; generic Arc names would repaint the app | App families keep working; migrate app vars to point at `--lc-*` per app |
| Semantic colour | 50 amber / 46 red / 19 green / 14 violet hexes on desktop; shared `--nx-success…` never used on desktop | — | **REPLACE** with `--lc-exec/ok/attn/crit/flow/neutral` (+ RedOps rule) | Theme accent can't repaint meaning | Per-app var re-pointing must keep contrast in Light |
| Typography | 56 sizes on desktop (12 / 12.5 / 13 / 11.5 dominate); `--dsk-font` vs reversed stack | — | **MERGE** into `--lc-t-*` scale on the dominant sizes | No invented sizes | Large-title apps (28px) keep `--dsk-title-size` |
| Motion | 26 durations (180ms ×245, 150 ×157), 45 easings, 160 reduced-motion blocks, Animations setting honoured in 4 places, no html flag | Arc motion tokens | **ADAPT** → `--lc-dur-*`, `LC_SPRING`, `data-lc-motion` on `<html>`, `useLcReducedMotion`, global MotionConfig | One reason-based scale; the setting finally works everywhere | Global reduce must not break Radix exit timing (uses animationend → instant) |
| z-index | 122 distinct values; shell 170–190; app overlays 9000–20000; `--nx-shell-z-*` 13000/14000/15000 | Arc 60–90 | **REPLACE** with `--lc-z-*` families aligned to the shell ladder (dialog 13500 < popover 14500 < toast 14900) | Popovers opened from dialogs stay on top | Legacy 20000 modals still cover LC popovers until migrated |
| Focus ring | No shared desktop rule; 111 selectors, 1px vs 2px, `outline:none` ×19 | `--focus-ring` | **REPLACE** with `:where()` desktop default + `--lc-focus-ring` | Never browser blue, never invisible; zero specificity so apps can refine | — |
| Button | 17 desktop families (~225 uses), legacy `nx-btn` defined twice; strongest `cpk-btn` | button, action-button | **ADAPT** → `LCButton` (primary/secondary/quiet/ghost/danger, loading morph) | Hierarchy + one danger | Apps migrate opportunistically |
| Icon button | 7 sizes (24–38px), mobile ::after hacks, `data-tip` with no CSS | action-button | **ADAPT** → `LCIconButton` (+ built-in LCTooltip, hit pad, dot/count) | Keyboard-visible labels | Hit pads ≤ half the toolbar gap |
| Tooltip | `title=` ×~1,000; CSS `data-tip` hover-only | tooltip (Radix) | **ADAPT** → `LCTooltip` (warm skip window) | One fast, keyboard-accessible tooltip | Don't wrap disabled buttons (no events) |
| Dropdown menu | ~20 inline menus, FilterMenu family copy-pasted ×8; no arrow keys/typeahead anywhere | dropdown-menu (Radix) | **ADAPT** → `LCMenu` (glide highlight, `reason` for disabled) | Accessibility + feel | — |
| Context menu | None (3 `onContextMenu` preventDefaults); "…" menus ×6 | context-menu (hand-rolled) | **REPLACE** with Radix ContextMenu → `LCContextMenu` (same rows as LCMenu) | Arc's hand-rolled positioning is weaker than Radix | Right-click must not hijack map canvas |
| Select | 128 native `<select>` (21 on desktop); GlassSelect/PiGlassSelect/GlassControl ×2; no arrow keys | select (Radix); no Morph Select | **ADAPT** → `LCSelect` (value roll + width morph, quiet/field/chip) | Morph where continuity is obvious | >30 options → LCCombobox |
| Combobox | FieldSearch (best), FlagPicker…; zero `role=combobox`; no entity pickers | combobox | **REPLACE** with native `LCCombobox` (async + abort + 1 retry, react-window virtualization, groups, recents) | Arc's is inline/static/non-virtual | Async callers own their endpoints |
| Popover | ~20 rect-math copies; LabUi Popover strongest | popover (Radix) | **ADAPT** → `LCPopover` | Collision + origin-aware motion | Pane-portaled popovers (Lab) keep closing on pane scroll |
| Hover card | MapEntityCard/SellerMapCard (map-specific timers); none keyboard-reachable | hover-card (Radix) | **ADAPT** → `LCHoverCard` (read-only previews) | — | Never fetch on hover |
| Dialog / confirm | 121 `role=dialog`, no focus trap; `window.confirm` ×5, `prompt` ×3, `alert` ×4 | dialog (Radix) | **ADAPT** → `LCDialog`, `LCConfirm` (effects list, Cancel-first) | Effect language, real modality | Replace native dialogs app by app |
| Sheet / drawer | MobileSheet, MobileBottomSheet, ~50 scrim variants | drawer, bottom-sheet | **ADAPT** → `LCSheet` (desktop modal sheet only) | Desktop prefers inspectors | Mobile sheets untouched (mobile boundary) |
| Inspector | 13 app inspectors; strongest `cpk-insp` (resize) + `cdx-insp` (focus) | — (Pro sheet-stack N/A) | **MERGE** → `LCInspector` (float/dock, resize+persist, stack/back, Esc ladder, no focus theft) | One spatial component, content varies | Apps adopt one by one |
| Tabs | ~35 tablists, indicator re-implemented ×5, arrow keys only in `bmc-seg` | tabs (Radix) | **ADAPT** natively → `LCTabs` (layoutId lens, roving, overflow fades, counts) | Radix Tabs couples panels; apps own panels | Route-like modes should use nav semantics later |
| Segmented | 4 `Segmented` + `DeskSeg` + 10 inline; 3 ARIA models | segmented-control | **ADAPT** → `LCSegmented` (radiogroup, roving) | One model | — |
| Search field | ~13 desktop fields; `cdx/emd-search` best | search-field | **ADAPT** → `LCSearch` | Esc clears, `/` hint | Global `/` vs local `/` conflict (shell fix) |
| Filter chips / bar | removable `lab-chip`, `mxd-chip`; no summary in Pipeline/Campaign/Comps | chip-group, filter-toolbar | **ADAPT** → `LCChip`, `LCFilterBar` (real count only) | One filter language | Saved views only where a store exists |
| Filter inspector | Analytics Lab + Map desk strongest | filter-toolbar | **MERGE** → `LCFilterInspector` (sections, search, cohort, Apply/Save only when supported) | Reusable grammar | Apps keep their own filter semantics |
| Data toolbar | per app | filter-toolbar | **NEW** `LCToolbar` | Search · filters · sort · group · view · density | — |
| Data grid | `egt` (features), `lab-rec` (semantics + virtual); no column resize anywhere | **Data Grid = Pro** · sortable-data-table (free, no virtualization) | **NATIVE** `LCDataGrid` (windowing, sticky frosted header, resize+persist, columns menu, keyboard, selection, grouping, context menu, infinite) | Pro not licensed; free table can't virtualize | Expanded rows disable windowing |
| Pagination | 2 pagers + 6 load-mores + legacy ×8 | pagination | **REPLACE** with grid infinite loading + "Showing x of y" | — | Server cursors stay per app |
| Activity feed | Home / Map / Queue / Workflow / Pipeline feeds, 5 grouping rules | timeline, notification-center | **MERGE** → `LCActivityFeed` + `groupActivity` (burst grouping, one arrival highlight) | "100 targets queued", not 100 rows | Apps map their events |
| Timeline | 60+ class roots (cdx/emd/cpk/qx/ws3/ddx/egx/c3…) | timeline | **ADAPT** → `LCTimeline` (past solid, now marked, future hollow) | Temporal honesty | — |
| Stepper / rail | Pipeline/Closing/Campaign/Analytics rails; 3 stage taxonomies | stepper | **ADAPT** → `LCRail` (mechanics only; S1–S10 meta stays canonical) | Shared mechanics, domain labels | Never computes conversion |
| Progress | no shared bar; 1 `role=progressbar` | progress, usage-meter | **ADAPT** → `LCProgress` (determinate / indeterminate / capacity / stacked) | Thin, accessible | — |
| Metric | 15+ local displays, 3 Delta implementations | metric-card (card) | **NATIVE** `LCMetric` + `LCDelta` (no card; basis + sample) | Composition-friendly | Never computes the number |
| Counter | 13 counters; shared CountUp ignores the Animations setting | animated-counter | **ADAPT** → `LCCounter` (Arc odometer, reduced-motion swap) | One counter | Keep CountUp until apps migrate |
| Sparkline | hand SVG per app | sparkline | **NATIVE** `LCSparkline` (gaps stay gaps) | Tiny, honest | Use sparingly |
| Charts | hand SVG/canvas; Arc Line/Bar/Donut/Heatmap adapted, 1 consumer | line, bar, donut, activity-heatmap, brush, treemap (free) · funnel/sankey (Pro) | **ADAPT** behind `.lc-arc` bridge; funnel/sankey native | Interaction quality | Every chart through LC styling |
| Skeleton / loading | 14 shimmer keyframes, 13 spinners, "Loading {app}" panel printing raw path | skeleton | **REPLACE** → `LCSkeleton` (layout-shaped) | No spinners, no "Loading…" | — |
| Empty | ~165 `*-empty` roots, 1 unused ShellEmptyState | empty-state | **ADAPT** → `LCEmpty` (product words) | — | — |
| Error + retry | raw `error.message` in ~25 places; `fetchWithRetry` unused | alert | **NATIVE** `LCError` (what failed · stale since · retry) + one GET retry in shared hooks | One coherent failure | Never auto-retry writes |
| Live | `LiveStateBadge` unused; 119 infinite animations on desktop | — | **NATIVE** `LCLive` (static, one ring on real arrival) | No blinking | Shell + apps migrate their pulses |
| Status | ~18 pill styles, 5 tone vocabularies | badge | **REPLACE** → `LCStatus` + `LC_STATES` (system handling, waiting on X, needs you, due, overdue, blocked, degraded…) | One language | — |
| Toast | `emitNotification` bus (100 calls) + 6 local toasts; z 1000 | toast, toast-stack | **KEEP bus, re-skin renderer** on desktop; local toasts → bus | No second toast system | z raised to `--lc-z-toast` |
| Resizable panes | DesktopWorkspace divider (no keyboard), CockpitInspector grip (best); `shared/SplitView.tsx` dead | resizable-panels | **ADAPT** mechanics into LCInspector grip + `LCSplit` where users benefit | Keyboard + persist + reset | Not every pane |
| Command palette | DesktopCommandBar (no option roles); InboxCommandPalette never opens; ⌘⇧K dead; campaigns/workflows/closings unsearchable | command-palette | **ADAPT** DesktopCommandBar in place (combobox/listbox roles, more providers, desktop recents) | Keep the one engine | No duplicate global search |
| Sidebar / rail | calm sidebar; badges only inbox/queue; Analytics shows notification count (wrong) | sidebar-rail / workspace-sidebar (Pro) | **NATIVE** upgrade of DesktopSidebar (real counts per app, attention dot, system tray plane) | Pro not licensed | Counts only from existing endpoints |
| Keyboard | global single-letter jumps in capture phase pre-empt app keys (`k` in Email); local `/` double-fires | shortcut-recorder | **FIX** global handler: bubble phase + respect `defaultPrevented` | No conflicting shortcuts | — |
| Date range | arc date-range-picker (0 consumers); native date pairs | date-range-picker | **ADAPT** (already adapted) → wrap as `LCDateRange` when adopted | — | — |

## Findings that shaped the system

- **Nested backdrop blur does not run inside a desktop pane.** `.dsk-pane__body`
  owns a backdrop-filter, and Chromium does not apply a descendant's
  backdrop-filter inside one (verified with a probe: in-pane blur renders crisp
  text, root-level blur frosts). So in-pane "glass" is a translucent fill.
  Floating in-pane surfaces (inspector, sticky bars, grid header) use the
  near-opaque `--lc-mat-float-bg`; portaled surfaces keep real blur.
- The Animations setting reached 4 surfaces; `data-lc-motion` on `<html>` +
  a global `MotionConfig` now make it reach all of them.
- `tslib` is aliased to a shim; the overlay engine needs `__assign` /
  `__spreadArray`, now provided (the dev optimizer crashed without them).

## Phases (status 2026-10-01)

1. Tokens + material + motion — built
2. Menus / selects / popovers / tooltips / hover cards / combobox — built
3. Inspector / sheet / dialog / confirm — built
4. Filters / search / toolbar — built
5. Data grid — built
6. Activity / timeline / rail / progress — built
7. Metric / counter / sparkline (+ Arc charts behind the bridge) — built

Phases 1–7 are verified on the DEV-only reference surface `/dev/experience`
(sample data) in Dark, Light, True Black and Red Ops at 1440, including the
transient surfaces (menu, select, combobox, tooltip, inspector, confirm).

8. Sidebar rail + top bar + palette + keyboard — next
9. App adoption: Analytics → Home → Pipeline → Campaign → Queue → Workflow → Closing, then the rest — next
