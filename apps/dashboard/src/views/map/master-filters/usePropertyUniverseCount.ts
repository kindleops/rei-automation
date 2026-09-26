/**
 * The real size of the property universe, read live from public.properties.
 *
 * Replaces a hard-coded "verified baseline" (124,046) that had gone stale —
 * the table holds ~170k — and that the filter sheet showed as "matching
 * properties" whenever no filter was active or the preview call failed.
 */
import { useEffect, useState } from 'react'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'

let cached: number | null = null
let inflight: Promise<number | null> | null = null

export function loadPropertyUniverseCount(): Promise<number | null> {
  if (cached !== null) return Promise.resolve(cached)
  if (inflight) return inflight
  if (!shouldUseSupabase()) return Promise.resolve(null)
  inflight = (async () => {
    try {
      const { count, error } = await getSupabaseClient()
        .from('properties')
        .select('property_id', { count: 'exact', head: true })
      if (error || typeof count !== 'number') return null
      cached = count
      return count
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function usePropertyUniverseCount(): number | null {
  const [count, setCount] = useState<number | null>(cached)
  useEffect(() => {
    let alive = true
    void loadPropertyUniverseCount().then((n) => { if (alive && n !== null) setCount(n) })
    return () => { alive = false }
  }, [])
  return count
}
