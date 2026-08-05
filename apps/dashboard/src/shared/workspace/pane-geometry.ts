/**
 * Workspace pane geometry — the pure math behind draggable split panes.
 *
 * Constitution §12. Nothing here touches the DOM or React, so every rule
 * (snapping, clamping, collapse, maximise, redistribution) is independently
 * checkable.
 *
 * Model
 * -----
 * A layout is an ordered list of panes, each holding a continuous `basis`
 * (percent of the *live* workspace) plus a collapsed flag and the basis to
 * return to when it is expanded again.
 *
 * `basis` is deliberately continuous. The legacy `ViewWidthPercent` union
 * ('25' | '50' | '75' | '100') is kept intact as the *label* quantizer —
 * `deriveWidthPercentFromFlex` still produces it from a continuous basis, so
 * every existing `is-width-*` consumer keeps working unchanged.
 */

export type PaneBasis = number

/** R12.1 — snap points. */
export const SNAP_POINTS: readonly number[] = [25, 50, 75, 100]

/** R12.1 — magnet band, in basis units (== percent). */
export const SNAP_MAGNET = 4

/** Narrowest a live (non-collapsed) pane may be dragged. Below this, collapse. */
export const MIN_PANE_BASIS = 12

/** Physical size of a drag gutter, in px. Wide enough for a 44px touch slop. */
export const GUTTER_PX = 12

/** Physical size of a collapsed pane's rail, in px. */
export const RAIL_PX = 44

export interface PaneGeometry {
  /** Continuous percent of the live workspace. */
  basis: PaneBasis
  collapsed: boolean
  /** Basis restored when the pane is expanded out of its rail. */
  restoreBasis: PaneBasis
}

export interface WorkspaceLayout {
  panes: Record<string, PaneGeometry>
  /** When set, this pane owns the full workspace and the rest are parked. */
  maximized: string | null
}

export const EMPTY_LAYOUT: WorkspaceLayout = { panes: {}, maximized: null }

const round2 = (value: number): number => Math.round(value * 100) / 100

export const clampBasis = (value: number, min = MIN_PANE_BASIS, max = 100): number =>
  Math.min(max, Math.max(min, value))

/**
 * R12.1 — pull `value` onto a snap point when it lands inside the magnet band.
 * Bounds are snap candidates too, so a drag to either extreme lands cleanly
 * instead of stopping one sub-pixel short.
 */
export const snapBasis = (value: number, min: number, max: number): number => {
  const candidates = [...SNAP_POINTS, min, max]
  let best = value
  let bestDistance = SNAP_MAGNET
  for (const candidate of candidates) {
    if (candidate < min || candidate > max) continue
    const distance = Math.abs(candidate - value)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return round2(best)
}

/** Panes that currently occupy proportional space. */
export const livePaneIds = (order: string[], layout: WorkspaceLayout): string[] => {
  if (layout.maximized && order.includes(layout.maximized)) return [layout.maximized]
  return order.filter((id) => !layout.panes[id]?.collapsed)
}

/**
 * Force the live bases to sum to 100 without disturbing their ratios, and make
 * sure every pane in `order` has an entry. Idempotent.
 */
export const normalizeLayout = (order: string[], layout: WorkspaceLayout): WorkspaceLayout => {
  if (order.length === 0) return { panes: {}, maximized: null }

  const evenBasis = round2(100 / order.length)
  const panes: Record<string, PaneGeometry> = {}
  for (const id of order) {
    const existing = layout.panes[id]
    panes[id] = existing
      ? {
          basis: Number.isFinite(existing.basis) ? existing.basis : evenBasis,
          collapsed: Boolean(existing.collapsed),
          restoreBasis: Number.isFinite(existing.restoreBasis) && existing.restoreBasis > 0
            ? existing.restoreBasis
            : evenBasis,
        }
      : { basis: evenBasis, collapsed: false, restoreBasis: evenBasis }
  }

  const maximized = layout.maximized && order.includes(layout.maximized) ? layout.maximized : null

  // Never collapse every pane — the last live pane refuses to fold.
  const live = order.filter((id) => !panes[id].collapsed)
  if (live.length === 0 && order.length > 0) {
    panes[order[0]] = { ...panes[order[0]], collapsed: false, basis: 100 }
  }

  // While a pane is maximised the stored bases are left completely untouched —
  // the maximised pane is rendered at 100% by the split, not by rewriting state.
  // Rescaling here would flatten the layout the operator returns to.
  if (maximized) return { panes, maximized }

  const liveIds = order.filter((id) => !panes[id].collapsed)
  const sum = liveIds.reduce((total, id) => total + Math.max(0, panes[id].basis), 0)

  if (liveIds.length === 1) {
    panes[liveIds[0]] = { ...panes[liveIds[0]], basis: 100 }
  } else if (sum > 0) {
    const scale = 100 / sum
    let running = 0
    liveIds.forEach((id, index) => {
      const scaled = index === liveIds.length - 1
        ? round2(100 - running)
        : round2(Math.max(0, panes[id].basis) * scale)
      running = round2(running + scaled)
      panes[id] = { ...panes[id], basis: scaled }
    })
  } else {
    const each = round2(100 / liveIds.length)
    liveIds.forEach((id, index) => {
      panes[id] = {
        ...panes[id],
        basis: index === liveIds.length - 1 ? round2(100 - each * (liveIds.length - 1)) : each,
      }
    })
  }

  return { panes, maximized }
}

export const evenLayout = (order: string[]): WorkspaceLayout =>
  normalizeLayout(order, {
    panes: Object.fromEntries(
      order.map((id) => [id, { basis: 100 / order.length, collapsed: false, restoreBasis: 100 / order.length }]),
    ),
    maximized: null,
  })

/** Seed a layout from the legacy flex-basis map so first paint never jumps. */
export const layoutFromBases = (
  order: string[],
  bases: Partial<Record<string, number>>,
): WorkspaceLayout =>
  normalizeLayout(order, {
    panes: Object.fromEntries(
      order.map((id) => {
        const basis = Number(bases[id]) || 100 / order.length
        return [id, { basis, collapsed: false, restoreBasis: basis }]
      }),
    ),
    maximized: null,
  })

export interface ResizePairResult {
  layout: WorkspaceLayout
  /** The committed basis of the pane on the left of the divider. */
  leftBasis: number
  snapped: boolean
}

/**
 * Move the divider between two adjacent live panes. Their combined basis is
 * conserved, so no other pane in the workspace moves — R12.6.
 */
export const resizePair = (
  // Unused, but kept in the signature so every geometry mutator shares the same
  // (order, layout, …) shape and callers stay positional. Underscore-prefixed so
  // `noUnusedParameters` accepts it — without this the production build (`tsc -b`)
  // fails. It fails on ui/lane-b-workspace too: this file is byte-identical there,
  // so Lane B's branch was never production-built either.
  _order: string[],
  layout: WorkspaceLayout,
  leftId: string,
  rightId: string,
  nextLeftBasis: number,
  options?: { snap?: boolean },
): ResizePairResult => {
  const left = layout.panes[leftId]
  const right = layout.panes[rightId]
  if (!left || !right) return { layout, leftBasis: left?.basis ?? 0, snapped: false }

  const pairTotal = round2(left.basis + right.basis)
  const min = MIN_PANE_BASIS
  const max = round2(pairTotal - MIN_PANE_BASIS)
  if (max <= min) return { layout, leftBasis: left.basis, snapped: false }

  const clamped = clampBasis(nextLeftBasis, min, max)
  const committed = options?.snap === false ? round2(clamped) : snapBasis(clamped, min, max)

  return {
    layout: {
      ...layout,
      panes: {
        ...layout.panes,
        [leftId]: { ...left, basis: committed, restoreBasis: committed },
        [rightId]: { ...right, basis: round2(pairTotal - committed), restoreBasis: round2(pairTotal - committed) },
      },
    },
    leftBasis: committed,
    snapped: committed !== round2(clamped),
  }
}

/** R12.2 — fold a pane to its rail, or restore it to the basis it left. */
export const toggleCollapse = (
  order: string[],
  layout: WorkspaceLayout,
  paneId: string,
): WorkspaceLayout => {
  const pane = layout.panes[paneId]
  if (!pane) return layout

  const maximized = layout.maximized === paneId ? null : layout.maximized

  if (!pane.collapsed) {
    // Folding. The freed basis is absorbed by the remaining live panes in
    // proportion — `normalizeLayout` rescales, which preserves their ratios.
    if (livePaneIds(order, layout).length <= 1) return layout // never fold the last pane
    return normalizeLayout(order, {
      maximized,
      panes: {
        ...layout.panes,
        [paneId]: { ...pane, collapsed: true, restoreBasis: pane.basis || pane.restoreBasis },
      },
    })
  }

  // Unfolding. Take exactly `restoreBasis` back out of the other live panes, in
  // proportion to what they currently hold. Normalizing from an inflated sum
  // instead would silently flatten a 50/25/25 workspace to 33/33/33.
  const others = order.filter((id) => id !== paneId && !layout.panes[id]?.collapsed)
  const ceiling = Math.max(MIN_PANE_BASIS, 100 - MIN_PANE_BASIS * others.length)
  const target = clampBasis(pane.restoreBasis, MIN_PANE_BASIS, ceiling)
  const otherSum = others.reduce((total, id) => total + layout.panes[id].basis, 0)

  const panes: Record<string, PaneGeometry> = {
    ...layout.panes,
    [paneId]: { ...pane, collapsed: false, basis: target, restoreBasis: target },
  }
  if (others.length > 0 && otherSum > 0) {
    const scale = (100 - target) / otherSum
    for (const id of others) {
      panes[id] = { ...panes[id], basis: round2(panes[id].basis * scale) }
    }
  }

  return normalizeLayout(order, { maximized, panes })
}

/** R12.2 — one pane owns the workspace; the rest are parked, not unmounted. */
export const toggleMaximize = (
  order: string[],
  layout: WorkspaceLayout,
  paneId: string,
): WorkspaceLayout => {
  if (!layout.panes[paneId]) return layout
  return normalizeLayout(order, {
    ...layout,
    maximized: layout.maximized === paneId ? null : paneId,
  })
}

export const expandPane = (
  order: string[],
  layout: WorkspaceLayout,
  paneId: string,
): WorkspaceLayout => {
  const pane = layout.panes[paneId]
  if (!pane || !pane.collapsed) return layout
  return toggleCollapse(order, layout, paneId)
}

/* ── Width bands (R12.5) ─────────────────────────────────────────────────── */

export type PaneWidthBand = 'rail' | 'compact' | 'medium' | 'expanded' | 'full'

/**
 * Measured-pixel band thresholds, generalised from the one component in the
 * repo that already did real measured-width composition
 * (`views/queue/hooks/useQueueLayout.ts`).
 */
export const PANE_BAND_THRESHOLDS = { rail: 120, compact: 520, medium: 860, expanded: 1180 } as const

export const resolveBandFromWidth = (widthPx: number): PaneWidthBand => {
  if (widthPx < PANE_BAND_THRESHOLDS.rail) return 'rail'
  if (widthPx < PANE_BAND_THRESHOLDS.compact) return 'compact'
  if (widthPx < PANE_BAND_THRESHOLDS.medium) return 'medium'
  if (widthPx < PANE_BAND_THRESHOLDS.expanded) return 'expanded'
  return 'full'
}

/** The composition intent table from §12.5, keyed by band. */
export const BAND_INTENT: Record<PaneWidthBand, string> = {
  rail: 'Collapsed rail. Identity only.',
  compact: 'One decision surface. Identity, one verdict, one action.',
  medium: 'Adds supporting evidence and secondary actions.',
  expanded: 'Full working surface: multi-column, inline detail.',
  full: 'Purpose-built workspace, not a stretched panel.',
}

export const isLayoutEqual = (a: WorkspaceLayout, b: WorkspaceLayout): boolean => {
  if (a.maximized !== b.maximized) return false
  const aKeys = Object.keys(a.panes)
  const bKeys = Object.keys(b.panes)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => {
    const pa = a.panes[key]
    const pb = b.panes[key]
    return Boolean(pb) && pa.basis === pb.basis && pa.collapsed === pb.collapsed && pa.restoreBasis === pb.restoreBasis
  })
}
