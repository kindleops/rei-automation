import { createContext, useContext } from 'react'
import type { MiMetric, MiRegistry, MiStatusPayload } from './mi-types'
import type { MiRouteState } from './mi-route-state'

export interface MiCtx {
  state: MiRouteState
  /** Patch the pane path (replace by default; push for a new geography so Back returns). */
  set: (patch: Partial<MiRouteState>, mode?: 'replace' | 'push') => void
  registry: MiRegistry | null
  metric: (id: string) => MiMetric | undefined
  status: MiStatusPayload | null
  /** The geography shown in the Inspector (null = closed). */
  inspect: string | null
  setInspect: (id: string | null) => void
  /** Make a geography the workspace subject (Overview of it). */
  openGeo: (id: string) => void
  addToCompare: (id: string) => void
}

export const MiContext = createContext<MiCtx | null>(null)

export function useMi(): MiCtx {
  const c = useContext(MiContext)
  if (!c) throw new Error('useMi outside Market Intelligence')
  return c
}
