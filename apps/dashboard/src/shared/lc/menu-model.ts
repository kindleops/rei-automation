import type { ReactNode } from 'react'
import type { IconName } from '../icons'

export type LCMenuEntry =
  | {
      kind?: 'item'
      id: string
      label: string
      icon?: IconName | ReactNode
      /** second line, quiet */
      hint?: string
      shortcut?: string
      tone?: 'danger'
      disabled?: boolean
      /** why a disabled action can't run — shown instead of a dead row */
      reason?: string
      /** a toggle row: renders a check and role=menuitemcheckbox */
      checked?: boolean
      onSelect?: () => void
    }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string }
  | { kind: 'sub'; id: string; label: string; icon?: IconName | ReactNode; items: LCMenuEntry[] }

/** Builds entries without the noise of ids for simple menus. */
export function lcMenu(...groups: Array<Array<Omit<Extract<LCMenuEntry, { kind?: 'item' }>, 'id'> & { id?: string }>>): LCMenuEntry[] {
  const out: LCMenuEntry[] = []
  groups.filter((g) => g.length).forEach((g, gi) => {
    if (gi > 0) out.push({ kind: 'separator', id: `sep-${gi}` })
    g.forEach((item, ii) => out.push({ ...item, id: item.id || `${gi}-${ii}-${item.label}` } as LCMenuEntry))
  })
  return out
}

