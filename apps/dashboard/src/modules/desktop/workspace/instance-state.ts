import * as L from './layout'
import { browserSidOf, copyPath, releasePath, sweepSessions } from '../../browser/session-snapshot'

/**
 * PER-INSTANCE STATE THAT LIVES OUTSIDE THE LAYOUT — owned by the workspace
 * instance that names it, never shared between workspaces.
 *
 * Some apps keep a document keyed by an id carried in their instance path
 * (Browser: `/browser?s=<sid>` → its tabs). A layout copied by reference
 * would make two workspaces write the same document, so the store runs these
 * hooks whenever a layout changes owner:
 *
 *   copy     save (snapshot), restore (fork), duplicate — a new id, same contents
 *   release  delete — the snapshot's document goes with it
 *   key      the id, so a migration can find layouts that share one
 */
export interface InstanceStateHook {
  key: (path: string) => string | null
  copy: (path: string) => string
  release: (path: string) => void
  /** bounded cleanup of stored state no layout references */
  sweep?: (referenced: ReadonlySet<string>) => void
}

const HOOKS: Record<string, InstanceStateHook> = {
  browser: { key: browserSidOf, copy: copyPath, release: releasePath, sweep: sweepSessions },
}

function mapInstances(layout: L.Layout, fn: (inst: L.Instance, hook: InstanceStateHook) => string): L.Layout {
  let next = layout
  for (const inst of Object.values(layout.instances)) {
    const hook = HOOKS[inst.app]
    if (!hook || !hook.key(inst.path)) continue
    const path = fn(inst, hook)
    if (path !== inst.path) next = L.updateInstance(next, inst.id, { path })
  }
  return next
}

/** A layout whose external instance state is a fresh copy (save, restore, duplicate). */
export const copyInstanceState = (layout: L.Layout): L.Layout => mapInstances(layout, (inst, hook) => hook.copy(inst.path))

/** The state keys a layout owns. */
export function instanceStateKeys(layout: L.Layout): string[] {
  const out: string[] = []
  for (const inst of Object.values(layout.instances)) {
    const k = HOOKS[inst.app]?.key(inst.path)
    if (k) out.push(`${inst.app}:${k}`)
  }
  return out
}

/** Release the state a layout owns, except keys still referenced elsewhere. */
export function releaseInstanceState(layout: L.Layout, keep: Set<string>) {
  for (const inst of Object.values(layout.instances)) {
    const hook = HOOKS[inst.app]
    const k = hook?.key(inst.path)
    if (hook && k && !keep.has(`${inst.app}:${k}`)) hook.release(inst.path)
  }
}

/**
 * Migration: layouts that share a state key (saved before ownership existed,
 * or a copied layout) each get their own copy. The first owner (the live
 * workspace, then saved order) keeps the original. Returns null when nothing
 * was shared.
 */
export function isolateShared<T extends { layout: L.Layout }>(live: L.Layout, saved: T[]): T[] | null {
  const seen = new Set(instanceStateKeys(live))
  let changed = false
  const out = saved.map((w) => {
    const layout = mapInstances(w.layout, (inst, hook) => {
      const key = `${inst.app}:${hook.key(inst.path)}`
      if (!seen.has(key)) { seen.add(key); return inst.path }
      changed = true
      const copied = hook.copy(inst.path)
      seen.add(`${inst.app}:${hook.key(copied)}`)
      return copied
    })
    return layout === w.layout ? w : { ...w, layout }
  })
  return changed ? out : null
}

/** Sweep orphaned per-instance state: anything the live layout or a saved workspace references is kept. */
export function sweepInstanceState(live: L.Layout, saved: Array<{ layout: L.Layout }>) {
  const keys = [...instanceStateKeys(live), ...saved.flatMap((w) => instanceStateKeys(w.layout))]
  for (const [app, hook] of Object.entries(HOOKS)) {
    if (!hook.sweep) continue
    const prefix = `${app}:`
    hook.sweep(new Set(keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))))
  }
}
