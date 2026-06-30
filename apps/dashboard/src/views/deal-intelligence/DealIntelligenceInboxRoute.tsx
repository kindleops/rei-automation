import { useEffect } from 'react'
import { openInboxDealIntelligence } from '../../modules/mobile/mobile-inbox-bridge'

/** Redirect into the Deal Desk inbox workspace — do not mount InboxPage here (state would be lost on /inbox navigation). */
export function DealIntelligenceInboxRoute() {
  useEffect(() => {
    openInboxDealIntelligence()
  }, [])

  return (
    <div className="nx-route-redirect-shell" aria-busy="true" aria-live="polite">
      <p>Opening Deal Intelligence…</p>
    </div>
  )
}