# Lead Command — mobile visual system (liquid shell)

Direction for the phone experience: Apple-quality native software, an institutional
intelligence terminal, and a spatial liquid-glass material — calm, dense, tactile.
The frozen fullscreen geometry (viewport, safe areas, fixed/absolute architecture,
edge coverage, standalone PWA behaviour) is untouched. Everything below is paint.

## Where it lives

| Sheet | Scope |
| --- | --- |
| `apps/dashboard/src/modules/mobile/mobile-liquid-shell.css` | Tokens, top command area, bottom app dock |
| `apps/dashboard/src/modules/mobile/mobile-liquid-surfaces.css` | Map peek sheet, inbox thread cards, conversation header, bubbles, composer, top sheets, category tabs |

Both load last in `main.tsx` and are gated on `html.is-mobile-layout`, so desktop is
unaffected. Light theme is handled in each sheet under `html[data-nexus-theme='light']`.

## Tokens (`--lc-*`)

- Type: `-apple-system` / SF Pro first (native on iPhone), then Geist, Inter, system.
  Mono for figures: `ui-monospace`, SF Mono, Geist Mono, IBM Plex Mono. Tabular numerals on every number.
- Glass: `--lc-glass-bg` rgba(9,13,21,.80) dark / rgba(250,251,253,.86) light, blur 30px, saturate 1.7.
- Ink: `--lc-ink` #eef2f7, `--lc-ink-2` 70%, `--lc-ink-3` 46% (light: #0b1220 and its tints).
- Accent: `--lc-accent-rgb` follows the operator's accent palette (`--nexus-accent-rgb`).
- Shell radius 22px. Springs: `--lc-ease-out` (0.16,1,0.3,1), `--lc-ease-spring` (0.34,1.4,0.64,1).

## Shell

- **Top command area.** One `::before` slab inside the existing fixed container: it starts at
  the physical top edge (through the Dynamic Island band), has no top radius, rounds only its
  lower corners, and carries a faint accent bloom. Controls float free — no tile per icon;
  the workspace hub keeps a quiet accent tile; active state is an accent glass tile.
- **Bottom app dock.** One `::before` slab inside the existing fixed container that runs
  through the home-indicator band with rounded upper corners only. Pinned apps sit in the
  glass; the selected app pops in with a spring (`lc-dock-pop`), labels are 10.5px/600 with no
  uppercase. The collapsed phase is a slimmer, more transparent strip with an accent handle.

## Surfaces

- **Map peek.** The bottom sheet is the material; the seller card inside it is transparent.
  Street View hero 160px with identity rising into its lower gradient; badges are readable
  11px pills; ARV / MAO / equity are 16px mono figures in hairline columns; two 44px actions
  (glass follow-up, solid accent reply). Collapsed snap shows identity + numbers + actions;
  signals and operational state appear from the half snap up.
- **Inbox list.** Thread cards: 16px identity, 14px preview, unread = brighter surface + 3px
  accent edge, chips 11px/600, temperature chips coloured hot/warm/cold. Category tabs are
  36px segmented pills with tabular counts (emoji icons hidden on phone).
- **Conversation.** Header controls 36px glass; seller name 19px; intel strip as hairline
  columns with mono values. Bubbles 82% max width, 15px, glass inbound / solid accent
  outbound with soft tails; day separators as quiet mono pills. Composer is one 42px pill
  (text at 16px to stop iOS zoom, translate, voice) between the quick-actions and send
  controls; polish and schedule stay inside the quick-actions menu.
- **Top sheets.** Workspace launcher / queue intelligence / more sheets share the shell glass,
  lower corners only, 17px titles.

## Motion

- Shell slabs settle in (opacity) rather than slide; dock selection springs; pressed states
  scale 0.88–0.97 with 140–160ms ease-out; sheets keep their existing physics.
- `prefers-reduced-motion` removes the springs and settle.

## Not yet done (next passes)

- Map markers / clusters (rendered by the pin system, not DOM) — selected-marker spring and
  cluster styling need a pass in `universal-pin-system.ts`.
- Pipeline lanes, Queue panels, and the Deal Intelligence (property detail) mobile surfaces
  still use the previous material.
- Selected-app morph across the dock (a sliding indicator needs measurement in `PinnedAppDock.tsx`).
