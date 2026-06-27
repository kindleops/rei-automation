/**
 * Comp Intelligence V4 — DEV-ONLY standalone harness.
 *
 * Mounted only when `import.meta.env.DEV` at route `/dev/comp-v4`. Lets us drive
 * V4 against the live read-only projection for any property by id, and force a
 * theme / accent / pane width for deterministic screenshots — WITHOUT changing
 * the user's saved settings.
 *
 *   /dev/comp-v4?propertyId=242567952&radius=1&monthsBack=12&theme=light&pane=100
 *
 * This file is never imported in production builds (route is dev-gated).
 */

import { useEffect } from 'react'
import CompIntelligenceV4Workspace from './CompIntelligenceV4Workspace'

function useQuery(): URLSearchParams {
  return new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
}

export default function CompIntelligenceV4Harness() {
  const q = useQuery()
  const propertyId = q.get('propertyId') || q.get('property_id') || null
  const opportunityId = q.get('opportunity_id')
  const threadKey = q.get('thread_key')
  const theme = q.get('theme')
  const pane = (q.get('pane') as '25' | '50' | '75' | '100' | null) ?? '100'

  // Force a theme attribute for the screenshot session, restore on unmount.
  useEffect(() => {
    if (!theme) return
    const root = document.documentElement
    const prev = root.getAttribute('data-nexus-theme')
    root.setAttribute('data-nexus-theme', theme)
    return () => {
      if (prev) root.setAttribute('data-nexus-theme', prev)
    }
  }, [theme])

  return (
    <div className="civ4-harness" style={{ position: 'fixed', inset: 0 }}>
      <CompIntelligenceV4Workspace
        identity={{ propertyId, opportunityId, threadKey }}
        paneWidth={pane}
      />
    </div>
  )
}
