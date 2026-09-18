import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import { fetchCanonicalSubjectProperty } from '../../domain/comp-intelligence/comp-intelligence-api'
import { PROPERTY_LOCATOR_EVENT } from '../../domain/locator/property-locator'
import { EntityGraphPropertyVisual } from '../../modules/entity-graph/mobile/EntityGraphPropertyVisual'
import { Icon } from '../../shared/icons'
import { resolveBuyerMatchSubject, type BuyerMatchSubject } from './buyer-match-subject'
import { BuyerMatchMobile } from './mobile/BuyerMatchMobile'
import './mobile/buyer-match-mobile.css'

/**
 * THE PRODUCTION BUYER MATCH ROUTE.
 *
 * WHAT THIS REPLACED. `/buyer-match` rendered `BuyerIntelPage`, whose entire
 * dataset was `referenceCommandCenterData` — a hardcoded reference fixture of
 * demo buyers and demo properties with synthetic `minutesAgo()` activity. It
 * then computed its OWN match score in a loop over buyers x demo properties and
 * sorted by it, and it had no property subject at all. So the production Buyer
 * Match route answered a question nobody asked, about buyers who do not exist.
 *
 * Meanwhile the canonical product already existed and was good:
 * `BuyerMatchWorkspace` against `/api/cockpit/buyer-match/property/{id}/candidates`,
 * `buyer_match_candidates`, `get_buyer_match_candidates`, over 26,390
 * `buyer_entities_v2` and 55,479 `buyer_purchase_events_v2`. It was only ever
 * mounted inside the Inbox workspace, so the dock never reached it.
 *
 * This page routes the canonical product and scopes it to the operator's
 * property. The desktop workspace is rendered UNCHANGED (§5); mobile gets a
 * lens over the same endpoint and the same canonical fields (§6).
 *
 * `referenceCommandCenterData` is deliberately NOT deleted — other reference
 * surfaces still import it. It is simply no longer the Buyer Match product.
 */

const BuyerMatchWorkspace = lazy(() =>
  import('../../modules/inbox/components/BuyerMatchWorkspace').then((m) => ({ default: m.BuyerMatchWorkspace })),
)

interface HydratedProperty {
  property_id: string
  address: string
  market: string
  zip: string
  state?: string
  county?: string
  property_type: string
  asset_class?: string
  estimated_value?: number | null
  arv?: number | null
  latitude?: number | null
  longitude?: number | null
  /** §4 — the header states the facts the match actually used. */
  bedrooms?: number | null
  bathrooms?: number | null
  square_feet?: number | null
  year_built?: number | null
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function BuyerMatchSubjectPage() {
  const { isMobile } = useBreakpoint()
  const [subject, setSubject] = useState<BuyerMatchSubject | null>(() => resolveBuyerMatchSubject())
  const [property, setProperty] = useState<HydratedProperty | null>(null)
  const [hydrationFailed, setHydrationFailed] = useState<string | null>(null)
  /**
   * §21 — LOADING AND FAILED ARE DIFFERENT CLAIMS.
   *
   * The header's address fell back to the literal string 'Loading property…'
   * whenever `property` was null, and a FAILED hydration with no address hint
   * leaves it null. So a property whose context read had already failed sat on
   * "Loading property…" for as long as the operator looked at it, while a
   * separate block below said the details were unavailable. Measured against a
   * cold API: the header never stopped claiming it was loading.
   */
  const [hydrating, setHydrating] = useState(false)

  /**
   * §4 — A -> B. The locator broadcasts on selection, so switching subject in
   * another surface updates this one without a reload, and the effect below
   * re-hydrates and re-queries against the NEW property id.
   */
  useEffect(() => {
    const onLocator = () => setSubject(resolveBuyerMatchSubject())
    window.addEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
    window.addEventListener('popstate', onLocator)
    return () => {
      window.removeEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
      window.removeEventListener('popstate', onLocator)
    }
  }, [])

  const hydrate = useCallback(async (propertyId: string, addressHint: string | null) => {
    setProperty(null)
    setHydrationFailed(null)
    setHydrating(true)
    try {
      // Same envelope shape: res.data is the BODY, so the payload is one level
      // deeper. Reading res.data directly yielded "Property address unavailable"
      // for a property whose context loads fine.
      /**
       * §5 — ONE PROPERTY AUTHORITY.
       *
       * This read `fetchDealContextByProperty`, which is a SELLER-DEAL view: it
       * only has a row where a thread or opportunity exists. Buyer Match is
       * property-scoped and needs no seller conversation, so for exactly the
       * properties it is most useful on — a disposition subject nobody has
       * texted — the header failed. Measured on the Houston acceptance subject:
       * `deal-context/property/2130387643` returns 404 `deal_context_not_found`
       * while the analysis itself ran fine, which is why the page showed
       * "Property details unavailable" above 25 real ranked buyers.
       *
       * `/properties/:id/subject` is the canonical property authority and is
       * already what Comp Intelligence uses. Same id, same facts, one source.
       */
      // fetchCanonicalSubjectProperty already unwraps the envelope and returns
      // the subject itself, so there is no res.data.data to dig through here.
      const data = (await fetchCanonicalSubjectProperty(propertyId)) as unknown as Record<string, unknown> | null
      if (!data) {
        // A missing subject must not silently become a blank property header.
        setHydrationFailed('Property could not be loaded')
        setProperty(addressHint ? {
          property_id: propertyId, address: addressHint, market: '', zip: '', property_type: '',
        } : null)
        return
      }

      /** The canonical subject wraps evidenced fields as { value, source, ... }. */
      const field = (key: string): unknown => {
        const raw = data[key]
        return raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
          ? (raw as { value: unknown }).value
          : raw
      }
      const coords = (data.coordinates ?? {}) as Record<string, unknown>

      setProperty({
        property_id: propertyId,
        address: str(field('canonical_address')) || addressHint || 'Property address unavailable',
        market: str(field('market')),
        zip: str(field('zip')),
        state: str(field('state')),
        county: str(field('county')),
        property_type: str(field('property_type')) || str(field('asset_type')),
        asset_class: str(field('asset_type')) || str(field('property_type')),
        estimated_value: numOrNull(field('estimated_value')),
        arv: numOrNull(field('estimated_arv')) ?? numOrNull(field('estimated_value')),
        latitude: numOrNull(coords.latitude ?? coords.lat),
        longitude: numOrNull(coords.longitude ?? coords.lng),
        bedrooms: numOrNull(field('bedrooms')),
        bathrooms: numOrNull(field('bathrooms')),
        square_feet: numOrNull(field('square_feet')),
        year_built: numOrNull(field('year_built')),
      })
    } catch (error) {
      setHydrationFailed(error instanceof Error ? error.message : 'Property context request failed')
      setProperty(addressHint ? {
        property_id: propertyId, address: addressHint, market: '', zip: '', property_type: '',
      } : null)
    } finally {
      setHydrating(false)
    }
  }, [])

  /**
   * What the header may claim about the subject, in order of what is known:
   * the real address, the locator's hint, an honest in-flight state, or an
   * honest failure naming the id that could not be resolved.
   */
  const headerAddress = property?.address
    ?? subject?.addressHint
    ?? (hydrating
      ? 'Loading property…'
      : hydrationFailed
        ? `Property ${subject?.propertyId ?? ''} — address unavailable`.trim()
        : 'Loading property…')

  useEffect(() => {
    if (!subject?.propertyId) return
    void hydrate(subject.propertyId, subject.addressHint)
  }, [subject?.propertyId, subject?.addressHint, hydrate])

  /**
   * §3 — no subject means no buyers. Never the first property, the last
   * property, a demo property, or the most recent match run.
   */
  if (!subject?.propertyId) {
    return (
      <section className="bmm">
        <div className="bmm__state">
          <Icon name="users" size={20} />
          <strong>Select a property to find matching buyers.</strong>
          <p>
            Buyer Match is scoped to one property. Open it from a property in Pipeline,
            Deal Intelligence or Entity Graph, and its buyers will appear here.
          </p>
        </div>
      </section>
    )
  }

  /**
   * §12 — ONE selected property's visual, and only on mobile where it earns its
   * space. There is deliberately no imagery on buyer cards: 25 cards would mean
   * 25 Street View requests, which is the fan-out rule this codebase has
   * already paid for on Inbox and the Pipeline board.
   */
  const propertyVisual = property?.address && isMobile ? (
    <EntityGraphPropertyVisual
      address={property.address}
      lat={property.latitude ?? null}
      lng={property.longitude ?? null}
    />
  ) : null

  if (isMobile) {
    return (
      <>
        <BuyerMatchMobile
          key={subject.propertyId}
          propertyId={subject.propertyId}
          address={headerAddress}
          market={property?.market}
          propertyType={property?.property_type}
          estimatedValue={property?.estimated_value ?? null}
          propertyVisual={propertyVisual}
        />
        {hydrationFailed ? (
          <div className="bmm__state is-error" role="status">
            <strong>Property details unavailable</strong>
            <p>{hydrationFailed}. Buyer matches below are still scoped to {subject.propertyId}.</p>
          </div>
        ) : null}
      </>
    )
  }

  // ── Desktop: the existing canonical workspace, unchanged (§5).
  return (
    <Suspense fallback={<div className="bmm__state">Loading Buyer Match…</div>}>
      <BuyerMatchWorkspace
        key={subject.propertyId}
        paneWidth="100"
        // This route answers "who should buy this property?" — land on the
        // buyer list, not the property overview. The Inbox mounting keeps its
        // own default.
        initialTab="buyers"
        propertySnapshot={{
          property_id: subject.propertyId,
          address: property?.address ?? subject.addressHint ?? 'Property Unknown',
          market: property?.market ?? '',
          zip: property?.zip ?? '',
          state: property?.state,
          county: property?.county,
          property_type: property?.property_type ?? '',
          asset_class: property?.asset_class,
          estimated_value: property?.estimated_value ?? null,
          arv: property?.arv ?? null,
        }}
      />
    </Suspense>
  )
}
