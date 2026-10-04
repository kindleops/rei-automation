/**
 * Is the shared archive (lead_visibility_sync_enabled) live? The server says
 * (lib/data/leadVisibilityData, cached 5 min; any failure → off, today's path).
 * Pipeline only reads it to pick honest archive copy and to show the Archived lens.
 */
import { useEffect, useState } from 'react'
import { isLeadVisibilityEnabled } from '../../../lib/data/leadVisibilityData'

export function useLeadVisibilityOn(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    void isLeadVisibilityEnabled().then((v) => { if (live) setOn(v) })
    return () => { live = false }
  }, [])
  return on
}
