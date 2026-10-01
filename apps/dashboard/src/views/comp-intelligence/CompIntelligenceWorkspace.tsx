import { lazy, Suspense, useEffect, useState } from 'react'
import {
  getUniversalEntityContextSnapshot,
  subscribeUniversalEntityContext,
} from '../../domain/entity-graph/universal-entity-context-store'
import { PROPERTY_LOCATOR_EVENT } from '../../domain/locator/property-locator'
import { readSelectedContext } from '../../domain/locator/active-context'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../lib/data/dealContext'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import './comp-intelligence.css'

interface Props {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  viewWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
  paneWidth?: ViewWidthPercent
  paused?: boolean
  /**
   * Set by the host: the modern product owns the screen (a phone OR the modern
   * desktop — useBreakpoint().isMobile). It cannot tell a phone from a
   * desktop on its own, so the device decision below reads isPhone.
   */
  isMobile?: boolean
}

const CompsEvidenceSurface = lazy(() =>
  import('./evidence/CompsEvidenceSurface').then((m) => ({ default: m.CompsEvidenceSurface })),
)

/**
 * The desktop is the spatial valuation workstation (Comp Intelligence 5.0):
 * map-first, the engine's set beside the operator's, every valuation figure
 * from the engine's own formula. Lazy, so a phone never loads the map stack.
 */
const CompsWorkstation = lazy(() =>
  import('./desktop/CompsWorkstation').then((m) => ({ default: m.CompsWorkstation })),
)

/**
 * Phones get the valuation-evidence surface (one bounded server read, the
 * engine's own verdicts) — unchanged. Every desktop composition (modern and
 * classic) gets the workstation. Separate components, so switching device
 * class can never change a component's hook order.
 */
export function CompIntelligenceWorkspace(props: Props) {
  const { isPhone } = useBreakpoint()
  if (props.isMobile && isPhone) return <CompsMobileEntry thread={props.thread} dealContext={props.dealContext ?? null} />
  return <CompsDesktopEntry thread={props.thread} dealContext={props.dealContext ?? null} />
}

/**
 * The host's own subject (classic Inbox multi-view passes its selected deal
 * context). The workstation prefers its pane's location and the linked
 * locator; this is only the fallback when neither names a property.
 */
function CompsDesktopEntry({ thread, dealContext }: { thread: InboxWorkflowThread | null; dealContext: DealContext | null }) {
  const threadPropertyId = (thread as unknown as { propertyId?: string; property_id?: string } | null)?.propertyId
    ?? (thread as unknown as { property_id?: string } | null)?.property_id ?? null
  const hostPropertyId = dealContext?.propertyId || dealContext?.property_id || threadPropertyId || null
  return (
    <Suspense fallback={<div className="ciw-boot" data-comp-intelligence="desktop-loading" />}>
      <CompsWorkstation hostPropertyId={hostPropertyId ? String(hostPropertyId) : null} />
    </Suspense>
  )
}

/** The property the global bar's context chip shows (readSelectedContext: URL → EG deep link → locator). */
function readChipPropertyId(): string | null {
  const selected = readSelectedContext()
  return selected?.kind === 'property' && selected.id ? selected.id : null
}

/**
 * Subject precedence: URL → deal context → the header chip's property →
 * universal context → thread. The chip is visible and clearable, so Comps is
 * never "No subject selected" while the chip names a property (the same bug
 * Buyer Match shipped with).
 */
function CompsMobileEntry({ thread, dealContext }: { thread: InboxWorkflowThread | null; dealContext: DealContext | null }) {
  const urlPropertyId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('property_id') : null
  const [globalContext, setGlobalContext] = useState(() => getUniversalEntityContextSnapshot())
  useEffect(() => subscribeUniversalEntityContext(setGlobalContext), [])
  const [chipPropertyId, setChipPropertyId] = useState<string | null>(() => readChipPropertyId())
  useEffect(() => {
    const onLocator = () => setChipPropertyId(readChipPropertyId())
    window.addEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
    window.addEventListener('popstate', onLocator)
    return () => {
      window.removeEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
      window.removeEventListener('popstate', onLocator)
    }
  }, [])
  const contextPropertyId = globalContext?.propertyId || (globalContext?.entityType === 'property' ? globalContext?.entityId : null) || null
  const threadPropertyId = (thread as unknown as { propertyId?: string; property_id?: string } | null)?.propertyId
    ?? (thread as unknown as { property_id?: string } | null)?.property_id ?? null
  const propertyId = urlPropertyId || dealContext?.propertyId || dealContext?.property_id || chipPropertyId || contextPropertyId || threadPropertyId || null
  if (!propertyId) {
    return (
      <div className="ci-workspace ci-workspace--empty" data-comp-intelligence="mobile">
        <div className="ci-empty-state">
          <div className="ci-empty-state__icon">⌖</div>
          <strong>No subject selected</strong>
          <p>Open a property from the Map, Pipeline, Deal Intelligence or Entity Graph to review its comparable sales.</p>
        </div>
      </div>
    )
  }
  return (
    <Suspense fallback={<div className="ci-workspace ci-workspace--empty" data-comp-intelligence="mobile-loading" />}>
      <CompsEvidenceSurface key={propertyId} propertyId={String(propertyId)} />
    </Suspense>
  )
}

export default CompIntelligenceWorkspace
