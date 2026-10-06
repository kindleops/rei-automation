/**
 * Entry used by main.tsx for /wall paths: a tiny static module so the rest of
 * the Command Wall loads as its own chunk and the operator app never loads it.
 */
import { lazy, Suspense } from 'react'

const CommandWallApp = lazy(() => import('./CommandWallApp'))

export function CommandWallBoot() {
  return (
    <Suspense fallback={null}>
      <CommandWallApp />
    </Suspense>
  )
}
