# Arc UI in LeadCommand

Arc (https://uiarc.dev) is an approved source of **interaction**: scrubbing,
morphing between ranges, keyboard inspection, rolling numerals, calendar
range selection. It is not LeadCommand's visual identity. Every component
here renders inside `.lc-arc` (see `lc-arc.css`), which maps Arc's token
names onto LeadCommand's colour, type, glass and radius per theme. Arc's
global `foundation.css` is never imported: its `:root` tokens (`--accent`,
`--border`, `--text-muted`, `--success` …) collide with names LeadCommand
already uses hundreds of times.

Licence: free tier, MIT (`LICENSE.arc.md`). Installed through Arc's official
shadcn registry on 2026-10-01. **No Pro component is used** — this project has
no Pro seat, so Pro interactions are implemented independently, never
reconstructed from Arc's source.

## LeadCommand changes to every file

- `motion/react` → `framer-motion` (same engine, the one the app ships).
- `useReducedMotion` → `lib/reduced-motion` (OS preference **or** LeadCommand's
  animations switch).
- `"use client"` removed (Vite, not RSC).
- Date Range Picker: LeadCommand icons instead of `lucide-react`; React 18 has
  no boolean `inert` prop, so the attribute is set as an empty string.

## Evaluation (Analytics 4.0, 2026-10-01)

| LeadCommand need | Arc candidate | Decision | Why |
|---|---|---|---|
| Hero trend: scrub, prior period, metric morph, keyboard | Line Chart (free) | **ADAPT** | Exact interaction fit: crosshair `onActiveChange` drives the headline, dashed series for the prior period, range morphs, `role="slider"` inspection. LeadCommand adds the annotation layer and the glass plane. |
| Headline numbers that change meaningfully | Animated Counter (free) | **USE, sparingly** | Digit columns roll in the direction of change. One motion column per digit — never in tables. |
| Range presets + custom range | Date Range Picker (free) | **ADAPT** | Presets, two-month view, draft-until-Apply. |
| Ordered-time comparisons (volume per day) | Bar Chart (free) | **ADAPT, narrow** | Single-series vertical only; ranked categorical comparisons (markets, campaigns, senders) need horizontal ranked bars with selection, built natively. |
| Small part-to-whole (reply composition, failure classes, ownership) | Donut Chart (free) | **USE, ≤6 parts** | Arc morphs angles, pins segments → cross-filter. |
| Daily rhythm (replies, runs, failures by day) | Activity Heatmap (free) | **ADAPT** | Calendar grid with keyboard grid semantics and day selection. (Arc's registry lists a malformed dependency `" animate="`; files fetched from the same registry URL.) |
| Weekday × hour machine rhythm | Activity Terrain (Pro) | **REJECT (no licence)** | 2-D 7×24 heatmap implemented natively over the Lab `heatmap` view. 3-D adds nothing analytical. |
| Acquisition funnel | Funnel Chart (Pro) | **REJECT (no licence)** | Implemented natively: linear stages, % of first, % retained, drop-off, every stage a cohort. |
| Branching flows | Sankey Flow (Pro) | **REJECT (no licence)** | Built natively only where real branch data exists. |
| Dense cohort tables | Data Grid (Pro) / Sortable Data Table (free) | **REJECT / defer** | The Lab records drawer already pages server-side with handoffs; a client-sorted table would sort one page, which is wrong. |
| KPI drilldown, metrics dashboard | Pro blocks | **REJECT** | Drilldown lives in the Lab inspector; a metrics dashboard is the card grid Analytics 4.0 removes. |
| Metric Card | free | **REJECT** | Card grids are the anti-pattern. |
| Command Palette | free block | **REJECT here** | LeadCommand already has ⌘K. |
| Morph Select | — | **REJECT** | No documentation page (404); unverifiable. |
