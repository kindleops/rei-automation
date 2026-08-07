/**
 * usePaneWidth — the width-threshold signal Lane B delivers to Lanes C / D / E.
 *
 * Constitution R12.5: "Content recomposes at width thresholds — it never merely
 * squeezes. Each pane declares its composition per band and gets its width via
 * context, not via a global mode flag."
 *
 * Lane B owns delivering this signal. It does NOT own what recomposes — the
 * pane's own module decides that from `band`.
 *
 * Contract
 * --------
 *   const { band, widthPx, basis, collapsed } = usePaneWidth()
 *
 *   band  'rail' | 'compact' | 'medium' | 'expanded' | 'full'
 *         Derived from the pane's MEASURED pixel width, so it stays honest in a
 *         900px browser window as well as at 1728px. Branch on this.
 *
 *   widthPx   Measured CSS pixels, quantized to a 16px grid. Quantizing is what
 *             stops a virtualised child from oscillating the observer.
 *   basis     Continuous percent of the live workspace (not quantized).
 *   widthLabel '25' | '50' | '75' | '100' — the legacy quantization, kept so the
 *             ~15 components that branch on `is-width-*` keep working unchanged.
 *   collapsed / maximized / stacked / isActive — geometry state.
 *
 * The same signal is mirrored onto the pane element as `data-pane-band` and the
 * `--lc-pane-basis` / `--lc-pane-width` custom properties, so CSS and container
 * queries can respond without a React subscription.
 */

import { createContext, useContext } from 'react'
import { BAND_INTENT, type PaneWidthBand } from './pane-geometry'
import type { ViewLayoutMode, ViewWidthPercent } from '../../domain/inbox/view-layout'

export interface PaneWidthContextValue {
  /** Workspace view key this pane renders, e.g. 'thread' | 'sms_thread'. */
  paneId: string
  /** Continuous percent of the live workspace this pane holds. */
  basis: number
  /** Measured CSS pixels, on a 16px grid. 0 before the first observer frame. */
  widthPx: number
  /** Recomposition band, from measured width. THIS is what panes should branch on. */
  band: PaneWidthBand
  /** Plain-language intent for this band (§12.5 table). */
  bandIntent: string
  /** Legacy quantization — keeps every existing `is-width-*` consumer working. */
  widthLabel: ViewWidthPercent
  /** Legacy layout mode, derived from `widthLabel`. */
  layoutMode: ViewLayoutMode
  /** Folded to a rail. Content stays mounted and its scroll position is intact. */
  collapsed: boolean
  /** This pane owns the whole workspace. */
  maximized: boolean
  /** Workspace is a vertical stack (below 1024px) and this pane is the visible one. */
  stacked: boolean
  /** False when the pane is parked: mounted and scroll-preserved, but given no space. */
  isActive: boolean
}

const FALLBACK: PaneWidthContextValue = {
  paneId: 'unknown',
  basis: 100,
  widthPx: 0,
  band: 'full',
  bandIntent: BAND_INTENT.full,
  widthLabel: '100',
  layoutMode: 'full',
  collapsed: false,
  maximized: false,
  stacked: false,
  isActive: true,
}

export const PaneWidthContext = createContext<PaneWidthContextValue | null>(null)

/**
 * Read the pane's live geometry. Safe outside a provider — a pane rendered
 * standalone (fullscreen route, test, isolation) reports itself as a full-width
 * active pane rather than throwing.
 */
export const usePaneWidth = (): PaneWidthContextValue =>
  useContext(PaneWidthContext) ?? FALLBACK

const BAND_ORDER: PaneWidthBand[] = ['rail', 'compact', 'medium', 'expanded', 'full']

/** True when this pane has room for the given band or wider. */
export const usePaneAtLeast = (band: PaneWidthBand): boolean => {
  const current = usePaneWidth().band
  return BAND_ORDER.indexOf(current) >= BAND_ORDER.indexOf(band)
}

export type { PaneWidthBand }
