/** @jsxRuntime automatic */
import { lazy, useSyncExternalStore, type ComponentProps, type ComponentType, type LazyExoticComponent } from 'react'
import type { ChunkRecoveryOutcome } from './build-freshness'
import { ChunkLoadFallback } from './BuildFreshnessNotice'
import { recoverChunkFailureInBrowser } from './install'

const NEVER = new Promise<never>(() => undefined)

/**
 * React.lazy with stale-deploy recovery. On an import failure it asks whether a
 * newer build explains it: if so the page reloads once (suspense holds until
 * then); otherwise the route shows Retry, which re-attempts the import with a
 * fresh lazy instance (React.lazy caches its rejection forever).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRecovery<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  recover: () => Promise<ChunkRecoveryOutcome> = recoverChunkFailureInBrowser,
): ComponentType<ComponentProps<T>> {
  let generation = 0
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const retry = () => {
    current = make()
    generation += 1
    for (const listener of listeners) listener()
  }

  const make = (): LazyExoticComponent<T> =>
    lazy(async () => {
      try {
        return await factory()
      } catch {
        const outcome = await recover().catch((): ChunkRecoveryOutcome => 'retry')
        if (outcome === 'reloading') return NEVER
        const Fallback = () => <ChunkLoadFallback outcome={outcome} onRetry={retry} />
        return { default: Fallback as unknown as T }
      }
    })

  let current = make()

  function Recoverable(props: ComponentProps<T>) {
    useSyncExternalStore(subscribe, () => generation, () => generation)
    const Current = current as unknown as ComponentType<ComponentProps<T>>
    return <Current {...props} />
  }
  return Recoverable
}
