import type { LCMenuEntry } from '../../../shared/lc'
import { objectActions, type ObjectActionsOptions } from './object-actions'
import type { ObjectRef } from './object-registry'

/** The rows of the one object menu (for surfaces that own a menu already, e.g. an LCDataGrid rowMenu). */
export function objectMenuEntries(ref: ObjectRef | null, opts: ObjectActionsOptions & { extra?: LCMenuEntry[] } = {}): LCMenuEntry[] {
  if (!ref) return opts.extra ?? []
  const actions = objectActions(ref, opts)
  const nav = actions.filter((a) => a.id === 'open' || a.id === 'beside' || a.id === 'inspect' || a.id === 'map' || a.id === 'pin')
  const missions = actions.filter((a) => a.id.startsWith('mission:'))
  const row = (a: (typeof actions)[number]): LCMenuEntry => ({ id: a.id, label: a.label, icon: a.icon, shortcut: a.shortcut, disabled: a.disabled, reason: a.reason, onSelect: () => { a.run() } })
  const out: LCMenuEntry[] = nav.map(row)
  if (missions.length) out.push({ kind: 'separator', id: 'sep-missions' }, ...missions.map(row))
  if (opts.extra?.length) out.push({ kind: 'separator', id: 'sep-extra' }, ...opts.extra)
  return out
}
