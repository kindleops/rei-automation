import { useEffect, useMemo, useState } from 'react'
import type { DealContext } from '../../../lib/data/dealContext'
import type { BuyerMatchPaneWidth } from './buyer-match-v4.types'
import { buildBuyerMatchSubjectContext } from './buildSubjectContext'
import { useBuyerMatchV4Projection } from './useBuyerMatchV4Projection'
import { PROJECTION_LOAD_TIMEOUT_MS } from './buyer-match-v4.types'
import { BuyerMatchV4Shell } from './BuyerMatchV4Shell'
import './buyer-match-v4.css'

export interface BuyerMatchV4WorkspaceProps {
  dealContext?: DealContext | null
  paneWidth?: BuyerMatchPaneWidth
  paused?: boolean
  onOpenFull?: () => void
}

export function BuyerMatchV4Workspace({
  dealContext = null,
  paneWidth = '100',
  paused = false,
  onOpenFull,
}: BuyerMatchV4WorkspaceProps) {
  const subject = useMemo(() => buildBuyerMatchSubjectContext(dealContext), [dealContext])
  const { projection, loading, refreshing, error, refresh } = useBuyerMatchV4Projection(subject, paused)
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (!loading) {
      setTimedOut(false)
      return
    }
    const t = window.setTimeout(() => setTimedOut(true), PROJECTION_LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [loading])

  if (!subject.propertyId) {
    return (
      <div className="bmv4-shell bmv4-shell--empty">
        <p>Select a property to open Buyer Match.</p>
      </div>
    )
  }

  return (
    <BuyerMatchV4Shell
      key={subject.propertyId ?? subject.threadKey ?? subject.canonicalAddress}
      subject={subject}
      projection={projection}
      loading={loading}
      refreshing={refreshing}
      error={error}
      timedOut={timedOut}
      paneWidth={paneWidth}
      onOpenFull={onOpenFull}
      onRetry={refresh}
    />
  )
}

export default BuyerMatchV4Workspace