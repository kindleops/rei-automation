// A CEO directive → its mission title. ONE definition for both entry points that open a mission: the Workforce
// routes (a directive typed in Workforce) and the Action Gateway's workforce_open_mission (a directive relayed by an
// operator-directed Agntei agent) — so the two missions have the same canonical shape (docs/WORKFORCE-AGNTEI.md §2).
import { label } from '../coo/interpret.js'

export function missionTitle(interp) {
  const where = interp.markets?.length ? ` · ${interp.markets.join(', ')}` : ''
  const n = interp.intent === 'opportunity_triage' && interp.count ? ` (top ${interp.count})` : ''
  return `${label(interp.intent)}${n}${where}`.slice(0, 120)
}
/** The mission priority both entry points open with. */
export const DIRECTIVE_MISSION_PRIORITY = 50
