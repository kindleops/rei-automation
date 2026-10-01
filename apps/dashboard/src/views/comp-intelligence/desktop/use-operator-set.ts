import { useCallback, useState } from 'react'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { sound } from '../../../shared/sound'

/**
 * THE OPERATOR SET (§23–24, §105–106).
 *
 * There is no canonical persistence for operator comp sets, so nothing here
 * is written to the database. The engine's system set is immutable; the
 * operator set forks from it on the first change, every change is a new
 * version (what changed, when), and the whole thing lives in this browser
 * session for this subject — reset returns to the system set.
 *
 * Each version stores keys; added comps are also kept as snapshots, so a
 * comp the operator added keeps pricing the same even after the search
 * radius or window moves and it is no longer in the loaded universe.
 */
export type OperatorChange =
  | { kind: 'include' | 'exclude'; key: string; address: string | null }
  | { kind: 'start'; count: number }

export interface OperatorVersion { v: number; at: number; keys: string[]; change: OperatorChange }

export interface OperatorState {
  propertyId: string
  /** what the first version forked from */
  base: 'system' | 'empty'
  versions: OperatorVersion[]
  snapshots: Record<string, EvidenceComp>
}

const STORE = 'lc.comps.operator.v1:'
const MAX_VERSIONS = 60

function read(pid: string | null): OperatorState | null {
  if (!pid) return null
  try {
    const raw = window.sessionStorage.getItem(STORE + pid)
    if (!raw) return null
    const parsed = JSON.parse(raw) as OperatorState
    return parsed?.propertyId === pid && Array.isArray(parsed.versions) && parsed.versions.length ? parsed : null
  } catch { return null }
}

function write(state: OperatorState | null, pid: string) {
  try {
    if (state) window.sessionStorage.setItem(STORE + pid, JSON.stringify(state))
    else window.sessionStorage.removeItem(STORE + pid)
  } catch { /* private mode / quota: the set still works for this view */ }
}

export function currentKeys(state: OperatorState | null): Set<string> | null {
  if (!state) return null
  return new Set(state.versions[state.versions.length - 1].keys)
}

export function useOperatorSet(propertyId: string | null, systemKeys: ReadonlySet<string>) {
  const [state, setState] = useState<OperatorState | null>(() => read(propertyId))
  const [seenPid, setSeenPid] = useState(propertyId)
  if (seenPid !== propertyId) {
    setSeenPid(propertyId)
    setState(read(propertyId))
  }

  const commit = useCallback((next: OperatorState | null) => {
    if (!propertyId) return
    write(next, propertyId)
    setState(next)
  }, [propertyId])

  const change = useCallback((c: EvidenceComp, include: boolean) => {
    if (!propertyId) return
    const keys = currentKeys(state) ?? new Set(systemKeys)
    if (include === keys.has(c.key)) return
    const nextKeys = new Set(keys)
    if (include) nextKeys.add(c.key)
    else nextKeys.delete(c.key)
    const base: OperatorState = state ?? { propertyId, base: systemKeys.size ? 'system' : 'empty', versions: [], snapshots: {} }
    const version: OperatorVersion = {
      v: (base.versions[base.versions.length - 1]?.v ?? 0) + 1,
      at: Date.now(),
      keys: [...nextKeys],
      change: { kind: include ? 'include' : 'exclude', key: c.key, address: c.address },
    }
    commit({
      ...base,
      versions: [...base.versions, version].slice(-MAX_VERSIONS),
      snapshots: include ? { ...base.snapshots, [c.key]: c } : base.snapshots,
    })
    sound.ui.select(include ? 'forward' : 'back')
  }, [commit, propertyId, state, systemKeys])

  /** With no engine set to fork from: start an operator set from explicit comps. */
  const start = useCallback((comps: EvidenceComp[]) => {
    if (!propertyId || !comps.length) return
    commit({
      propertyId,
      base: 'empty',
      versions: [{ v: 1, at: Date.now(), keys: comps.map((c) => c.key), change: { kind: 'start', count: comps.length } }],
      snapshots: Object.fromEntries(comps.map((c) => [c.key, c])),
    })
    sound.ui.select('forward')
  }, [commit, propertyId])

  /** Back to the system set: the operator set is discarded, the system set was never touched. */
  const reset = useCallback(() => {
    commit(null)
    sound.ui.select('back')
  }, [commit])

  const include = useCallback((c: EvidenceComp) => change(c, true), [change])
  const exclude = useCallback((c: EvidenceComp) => change(c, false), [change])

  return { state, keys: currentKeys(state), include, exclude, start, reset }
}
