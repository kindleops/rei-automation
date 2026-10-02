import type { ReactElement } from 'react'
import { LCContextMenu, LCIconButton, LCMenu, type LCMenuEntry } from '../../../shared/lc'
import type { ObjectActionsOptions } from './object-actions'
import { objectMenuEntries } from './object-menu-model'
import { objectSpec, type ObjectRef } from './object-registry'

/**
 * THE ONE OBJECT MENU — the full actions of any object, from the registry.
 *
 *   <ObjectMenu object={ref}><button …/></ObjectMenu>   right-click / Shift+F10
 *   <ObjectMenuButton object={ref} />                     an explicit ⋯ trigger
 *   objectMenuEntries(ref)                                rows for a surface that
 *                                                         already owns a menu
 *                                                         (LCDataGrid rowMenu)
 *
 * Actions that cannot run are shown with the reason, never as dead rows.
 */

const titleOf = (ref: ObjectRef) => {
  const spec = objectSpec(ref.type)
  return [spec?.noun, ref.label].filter(Boolean).join(' · ')
}

export function ObjectMenu({ object, children, extra, ...opts }: ObjectActionsOptions & { object: ObjectRef | null; children: ReactElement; extra?: LCMenuEntry[] }) {
  if (!object) return children
  return (
    <LCContextMenu items={objectMenuEntries(object, { ...opts, extra })} label={`${objectSpec(object.type)?.noun ?? 'Object'} actions`} title={titleOf(object)}>
      {children}
    </LCContextMenu>
  )
}

export function ObjectMenuButton({ object, extra, size = 'sm', ...opts }: ObjectActionsOptions & { object: ObjectRef | null; extra?: LCMenuEntry[]; size?: 'sm' | 'md' }) {
  if (!object) return null
  return (
    <LCMenu
      trigger={<LCIconButton icon="more" size={size} label={`${objectSpec(object.type)?.noun ?? 'Object'} actions`} data-inspect="" />}
      items={objectMenuEntries(object, { ...opts, extra })}
      label={`${objectSpec(object.type)?.noun ?? 'Object'} actions`}
      title={titleOf(object)}
    />
  )
}
