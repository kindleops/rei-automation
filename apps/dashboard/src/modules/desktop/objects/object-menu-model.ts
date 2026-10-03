import type { LCMenuEntry } from '../../../shared/lc'
import { objectActions, type ObjectActionsOptions } from './object-actions'
import type { ObjectRef } from './object-registry'
import { researchMenuEntries } from '../../browser/research-launch'

/** The rows of the one object menu (for surfaces that own a menu already, e.g. an LCDataGrid rowMenu). */
export function objectMenuEntries(ref: ObjectRef | null, opts: ObjectActionsOptions & { extra?: LCMenuEntry[] } = {}): LCMenuEntry[] {
  if (!ref) return opts.extra ?? []
  const actions = objectActions(ref, opts)
  const nav = actions.filter((a) => a.id === 'open' || a.id === 'beside' || a.id === 'inspect' || a.id === 'map' || a.id === 'pin')
  const missions = actions.filter((a) => a.id.startsWith('mission:'))
  const row = (a: (typeof actions)[number]): LCMenuEntry => ({ id: a.id, label: a.label, icon: a.icon, shortcut: a.shortcut, disabled: a.disabled, reason: a.reason, onSelect: () => { a.run() } })
  const out: LCMenuEntry[] = nav.map(row)
  // Research (Browser 1.0): property → assessor / county records / GIS / recorder / web; company → state corporate / web
  const research = researchMenuEntries(ref)
  if (research.length) out.push({ kind: 'separator', id: 'sep-research' }, ...research)
  if (missions.length) out.push({ kind: 'separator', id: 'sep-missions' }, ...missions.map(row))
  if (opts.extra?.length) out.push({ kind: 'separator', id: 'sep-extra' }, ...opts.extra)
  return out
}
