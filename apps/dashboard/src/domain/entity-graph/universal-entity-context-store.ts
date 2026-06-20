import type { UniversalEntityContext } from './entity-graph.types'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from './universal-entity-context'

export const UNIVERSAL_ENTITY_CONTEXT_EVENT = 'nx:universal-entity-context'

type Listener = (context: UniversalEntityContext) => void

let context: UniversalEntityContext = { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT }
const listeners = new Set<Listener>()

function emit(): void {
  const snapshot = { ...context }
  for (const listener of listeners) listener(snapshot)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: snapshot }))
  }
}

export function getUniversalEntityContextSnapshot(): UniversalEntityContext {
  return { ...context }
}

export function setUniversalEntityContextSnapshot(
  next: UniversalEntityContext,
  options: { silent?: boolean } = {},
): void {
  context = { ...next }
  if (!options.silent) emit()
}

export function patchUniversalEntityContextSnapshot(
  patch: Partial<UniversalEntityContext>,
  options: { silent?: boolean } = {},
): UniversalEntityContext {
  context = { ...context, ...patch }
  if (!options.silent) emit()
  return { ...context }
}

export function subscribeUniversalEntityContext(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}