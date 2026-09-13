import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPropertyLocator,
  readPropertyLocator,
  setPropertyLocator,
} from '../locator/property-locator'
import {
  findOpportunityForActiveContext,
  opportunityMatchesActiveContext,
} from '../entity-graph/universal-sync'
import type { PipelineOpportunity } from '../pipeline/pipeline-opportunity.types'
import type { ActiveInboxContext } from '../inbox/inbox-layout-state'

/**
 * THE GLOBAL ENTITY-CONTEXT CONTRACT.
 *
 * `propertyId` is the durable anchor for property-centric navigation. Everything else
 * the locator carries — thread key, opportunity id, owner/prospect id, address — is a
 * convenience for destinations that need a different identifier, and any of them may
 * legitimately be absent.
 *
 * Two behaviours in this file could not be proven in the browser against the current
 * QA data, so they are pinned here with realistic identifiers instead:
 *
 *   BIDIRECTIONAL SELECTION  Map publishes a newly tapped property to the global
 *                            context. The live environment renders a single seller pin
 *                            ("LIVE MAP 1"), and a ~950-point sweep of the map canvas
 *                            never reached a second property, so there was no way to
 *                            select a different subject by hand.
 *
 *   PIPELINE RESOLUTION      The pipeline endpoint returns zero opportunities in this
 *                            environment, so there is nothing for the resolver to match
 *                            and no safe way to manufacture one — production data is
 *                            not a UI fixture.
 *
 * Both remain browser-unproven and are reported as such; these tests pin the contract
 * they depend on so a regression in the resolver itself cannot pass silently.
 */

// Real identifiers from the verified QA subject, so the shapes are not invented.
const SUBJECT = {
  propertyId: '232714379',
  threadKey: '+13053516081',
  masterOwnerId: 'mo_f861b7c79f891da7516d490f',
  prospectId: 'pros1_582ed9540fb2505a09924380',
  address: '1115 Nw 64th St, Miami, Fl 33150',
}

const OTHER = {
  propertyId: '118920355',
  threadKey: '+12063359131',
  masterOwnerId: 'mo_0c41b7a2d1f8804bb2c1ea77',
  address: '5115 Michigan Ave, Kansas City, Mo 64130',
}

const opportunity = (patch: Partial<PipelineOpportunity>): PipelineOpportunity => ({
  id: 'opp_default',
  acquisition_stage: 'ownership_confirmation',
  primary_property_id: null,
  primary_thread_key: null,
  master_owner_id: null,
  ...patch,
} as unknown as PipelineOpportunity)

const context = (patch: Partial<ActiveInboxContext>): ActiveInboxContext =>
  ({ sourceView: 'map', ...patch } as ActiveInboxContext)

/**
 * The locator is sessionStorage-backed and this suite runs in the node environment
 * (no jsdom or happy-dom in the project). Rather than add a DOM dependency for four
 * assertions, stub the exact surface the module touches: session storage plus event
 * dispatch. Anything the locator reaches for that is NOT stubbed here would throw,
 * which is the right failure — it would mean the module grew a dependency this
 * contract does not describe.
 */
const installStorageStub = () => {
  const store = new Map<string, string>()
  const stub = {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
    dispatchEvent: () => true,
  }
  ;(globalThis as unknown as { window: unknown }).window = stub
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
    ;(globalThis as { CustomEvent?: unknown }).CustomEvent = class {
      constructor(public type: string, public init?: unknown) {}
    }
  }
}

describe('global entity context', () => {
  beforeEach(() => {
    installStorageStub()
    clearPropertyLocator()
  })

  describe('the locator is the shared anchor', () => {
    it('carries the property as the durable anchor plus the derived identifiers', () => {
      setPropertyLocator({ ...SUBJECT, opportunityId: null })
      const held = readPropertyLocator()
      expect(held?.propertyId).toBe(SUBJECT.propertyId)
      expect(held?.threadKey).toBe(SUBJECT.threadKey)
      expect(held?.masterOwnerId).toBe(SUBJECT.masterOwnerId)
      expect(held?.address).toBe(SUBJECT.address)
      // Absent identifiers stay absent rather than becoming empty strings.
      expect(held?.opportunityId).toBeNull()
    })

    it('accepts a property with no thread — a property is not required to have one', () => {
      setPropertyLocator({ propertyId: SUBJECT.propertyId })
      expect(readPropertyLocator()?.propertyId).toBe(SUBJECT.propertyId)
    })

    it('ignores a payload with no identity rather than wiping a good subject', () => {
      setPropertyLocator(SUBJECT)
      // Views emit partial contexts while clearing their own state; that must not
      // erase the operator's subject.
      setPropertyLocator({ address: 'Somewhere', propertyId: null, threadKey: null })
      expect(readPropertyLocator()?.propertyId).toBe(SUBJECT.propertyId)
    })
  })

  describe('bidirectional selection', () => {
    it('replaces the subject when another app selects a different property', () => {
      setPropertyLocator(SUBJECT)
      expect(readPropertyLocator()?.propertyId).toBe(SUBJECT.propertyId)

      // The shape Map emits from a pin tap, via handleMapSellerContext →
      // setActiveContext → setPropertyLocator.
      setPropertyLocator({
        propertyId: OTHER.propertyId,
        masterOwnerId: OTHER.masterOwnerId,
        threadKey: null,
        address: null,
      })

      const held = readPropertyLocator()
      expect(held?.propertyId).toBe(OTHER.propertyId)
      // The previous subject's thread must NOT survive onto the new property — that is
      // how a jump to Deal Intelligence ends up on the wrong conversation.
      expect(held?.threadKey).toBeNull()
    })
  })

  describe('pipeline resolution', () => {
    const opportunities = [
      opportunity({ id: 'opp_unrelated_a', primary_property_id: '999000111' }),
      opportunity({ id: 'opp_subject', primary_property_id: SUBJECT.propertyId, primary_thread_key: SUBJECT.threadKey, master_owner_id: SUBJECT.masterOwnerId }),
      opportunity({ id: 'opp_unrelated_b', primary_property_id: '999000222' }),
    ]

    it('locates the opportunity for the active property', () => {
      const match = findOpportunityForActiveContext(opportunities, context({ propertyId: SUBJECT.propertyId }))
      expect(match?.id).toBe('opp_subject')
    })

    it('prefers an explicit opportunity id over the property', () => {
      const match = findOpportunityForActiveContext(
        opportunities,
        context({ opportunityId: 'opp_unrelated_b', propertyId: SUBJECT.propertyId }),
      )
      expect(match?.id).toBe('opp_unrelated_b')
    })

    it('falls back to thread, then owner, when there is no property match', () => {
      const byThread = findOpportunityForActiveContext(
        [opportunity({ id: 'opp_thread', primary_thread_key: SUBJECT.threadKey })],
        context({ propertyId: 'no-such-property', threadKey: SUBJECT.threadKey }),
      )
      expect(byThread?.id).toBe('opp_thread')

      const byOwner = findOpportunityForActiveContext(
        [opportunity({ id: 'opp_owner', master_owner_id: SUBJECT.masterOwnerId })],
        context({ masterOwnerId: SUBJECT.masterOwnerId }),
      )
      expect(byOwner?.id).toBe('opp_owner')
    })

    it('returns NOTHING for a property with no opportunity — never an unrelated default', () => {
      const match = findOpportunityForActiveContext(opportunities, context({ propertyId: OTHER.propertyId }))
      // The whole point: silently showing opp_unrelated_a here would put the operator
      // on somebody else's deal while the header said theirs.
      expect(match).toBeUndefined()
    })

    it('returns nothing when the pipeline is empty rather than inventing a row', () => {
      expect(findOpportunityForActiveContext([], context({ propertyId: SUBJECT.propertyId }))).toBeUndefined()
    })

    it('returns nothing when the context carries no anchor at all', () => {
      expect(findOpportunityForActiveContext(opportunities, context({}))).toBeUndefined()
    })

    it('does not consider an unrelated opportunity a match', () => {
      const subjectOpp = opportunities[1]
      expect(opportunityMatchesActiveContext(subjectOpp, context({ propertyId: SUBJECT.propertyId }))).toBe(true)
      expect(opportunityMatchesActiveContext(subjectOpp, context({ propertyId: OTHER.propertyId }))).toBe(false)
    })
  })
})
