import { createContext, useContext } from 'react'
import type { WfEmployee } from '../api/wf-types'

export type WfSection = 'command' | 'organization' | 'employees' | 'missions' | 'operations' | 'queue' | 'intelligence' | 'finance' | 'authority' | 'reports'

/** In-app navigation for refs that live inside Workforce (missions, employees, assignments). */
export interface WfNav {
  section: WfSection
  go: (s: WfSection) => void
  openMission: (id: string) => void
  openEmployee: (id: string) => void
  /** the assignment's mission, with the assignment focused */
  openAssignment: (id: string, missionId?: string | null) => void
  /** prefill the Executive Command composer (and go there) */
  askCoo: (text: string) => void
  employees: ReadonlyMap<string, WfEmployee>
  now: number
}

const noop = () => {}
export const WfNavContext = createContext<WfNav>({ section: 'command', go: noop, openMission: noop, openEmployee: noop, openAssignment: noop, askCoo: noop, employees: new Map(), now: Date.now() })
export const useWfNav = () => useContext(WfNavContext)
