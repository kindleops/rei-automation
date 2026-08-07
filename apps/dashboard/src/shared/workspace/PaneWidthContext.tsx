/**
 * PaneWidthProvider — publishes a pane's geometry to its subtree.
 *
 * The contract, the context object and the `usePaneWidth` / `usePaneAtLeast`
 * hooks live in `./usePaneWidth.ts`. This file exports only the component so
 * fast refresh keeps working; import the hook from `./usePaneWidth`.
 */

import { useMemo, type ReactNode } from 'react'
import { BAND_INTENT, resolveBandFromWidth } from './pane-geometry'
import { PaneWidthContext, type PaneWidthContextValue } from './usePaneWidth'
import {
  deriveWidthPercentFromFlex,
  getViewLayoutMode,
} from '../../domain/inbox/view-layout'

export interface PaneWidthProviderProps {
  paneId: string
  basis: number
  widthPx: number
  collapsed: boolean
  maximized: boolean
  stacked: boolean
  isActive: boolean
  /**
   * Width to report while the pane is parked at zero. A parked pane keeps its
   * content composed for the width it will return to, so nothing re-lays-out
   * on the way back.
   */
  frozenWidthPx?: number
  children: ReactNode
}

export const PaneWidthProvider = ({
  paneId,
  basis,
  widthPx,
  collapsed,
  maximized,
  stacked,
  isActive,
  frozenWidthPx,
  children,
}: PaneWidthProviderProps) => {
  const value = useMemo<PaneWidthContextValue>(() => {
    const effectiveWidth = collapsed || !isActive ? (frozenWidthPx ?? widthPx) : widthPx
    const band = collapsed ? 'rail' : resolveBandFromWidth(effectiveWidth)
    const widthLabel = deriveWidthPercentFromFlex(basis)
    return {
      paneId,
      basis,
      widthPx: effectiveWidth,
      band,
      bandIntent: BAND_INTENT[band],
      widthLabel,
      layoutMode: getViewLayoutMode(widthLabel),
      collapsed,
      maximized,
      stacked,
      isActive,
    }
  }, [paneId, basis, widthPx, frozenWidthPx, collapsed, maximized, stacked, isActive])

  return <PaneWidthContext.Provider value={value}>{children}</PaneWidthContext.Provider>
}
