import { createContext, useContext } from 'react'
import type { ExceptionsResponse, Period, RegistryEntry, RegistryResponse, RunsDrill } from './lib/types'

export type Mode = 'overview' | 'canvas' | 'live' | 'runs' | 'activity' | 'analytics'
export const MODES: ReadonlyArray<{ id: Mode; label: string; key: string }> = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'canvas', label: 'Canvas', key: '2' },
  { id: 'live', label: 'Live', key: '3' },
  { id: 'runs', label: 'Runs', key: '4' },
  { id: 'activity', label: 'Activity', key: '5' },
  { id: 'analytics', label: 'Analytics', key: '6' },
]

export interface ReadState<T> { data: T | null; error: string | null; at: number | null; stale: boolean; loading: boolean; reload: () => void }

/** What every mode shares: the selection (workflow · run · node), the period, and the navigation verbs. */
export interface Studio {
  mode: Mode
  setMode: (m: Mode) => void
  workflows: RegistryEntry[]
  registry: ReadState<RegistryResponse>
  exceptions: ReadState<ExceptionsResponse>
  wfKey: string
  setWorkflow: (key: string) => void
  runId: string | null
  nodeKey: string | null
  setRun: (id: string | null) => void
  setNode: (key: string | null) => void
  period: Period
  setPeriod: (p: Period) => void
  /** open a run where it lives: its workflow's canvas, centred on the node that holds it */
  openRun: (workflowKey: string, runId: string, nodeKey?: string | null) => void
  /** the runs ledger, pre-filtered (a branch cohort, a reason, the human cohort…) */
  openRuns: (workflowKey: string, drill: RunsDrill | null) => void
  drill: RunsDrill | null
  setDrill: (d: RunsDrill | null) => void
  /** reduced motion (OS or the Animations setting) */
  still: boolean
  /** container width class for in-component decisions */
  narrow: boolean
  /** the studio's own pane width (px) */
  width: number
}

export const StudioContext = createContext<Studio | null>(null)

export function useStudio(): Studio {
  const s = useContext(StudioContext)
  if (!s) throw new Error('useStudio outside the studio')
  return s
}

export const findWorkflow = (workflows: RegistryEntry[], key: string | null | undefined) => (key ? workflows.find((w) => w.workflow_key === key) || null : null)
