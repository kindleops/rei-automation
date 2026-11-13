import { useEffect, useState } from 'react'

/**
 * Installs the dev fetch double before anything reads, ONLY in a dev server
 * started with VITE_LC_IC_FIXTURES=1. The guard is inlined at the import so a
 * production build (DEV = false) folds it away and the fixture chunk is never
 * emitted. Everywhere else this resolves immediately with `on: false`.
 */
let ready = !(import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1')
let loading: Promise<void> | null = null

export function ensureIcDevFixtures(): Promise<void> {
  if (ready) return Promise.resolve()
  if (!loading) {
    loading = (import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1')
      ? import('../fixtures/ic-dev-fixtures').then((m) => { m.installIcDevFixtures(); ready = true })
      : Promise.resolve().then(() => { ready = true })
  }
  return loading
}

export function useIcDevFixtures(): { ready: boolean; on: boolean } {
  const [ok, setOk] = useState(ready)
  useEffect(() => { if (!ok) void ensureIcDevFixtures().then(() => setOk(true)) }, [ok])
  return { ready: ok, on: import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1' }
}
