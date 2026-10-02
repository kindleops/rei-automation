import { describe, expect, it } from 'vitest'
import { ledgerRowObject } from '../../inbox/desk/ledger-object'
import { diLinks } from '../../../views/deal-intelligence/desktop/di-links'
import { compObject } from '../../../views/comp-intelligence/desktop/comp-object'
import { deskDealObject, deskPropertyObject } from '../../../views/pipeline/desk/desk-objects'
import { egObject } from '../../entity-graph/eg-objects'
import { handoffPointObject, moneyDealObject, recordRowObject } from '../../../views/analytics/intelligence/intel-objects'
import { objectCapabilities, type ObjectRef } from './object-registry'

/**
 * 8.2 §2 acceptance: the same property clicked from Inbox, Deal Intelligence,
 * Comps, Pipeline, Entity Graph and Analytics gives the same canonical focus —
 * built with each surface's OWN object builder (the code the click runs), not
 * with a hand-made ref.
 */
const PID = '273312064'
const TK = '+15550100001'
const OPP = '2b3c261d-f3dd-494a-a60c-3437cbdf39b8'

const fromEverySurface: Record<string, ObjectRef | null> = {
  'inbox row (seller thread)': ledgerRowObject({ threadKey: TK, propertyId: PID, street: '3635 Emerson Ave N', name: 'Seller' }),
  'deal intelligence subject': diLinks({
    subject: { propertyId: PID, address: '3635 Emerson Ave N, Minneapolis, MN 55412', lat: 45.0193, lng: -93.2943 },
    contact: { threadKey: TK }, pipeline: { opportunityId: OPP }, comps: { top: [] },
  } as never).object,
  'comps row': compObject({ key: 'k1', propertyId: PID, address: '3635 EMERSON AVE N', lat: 45.0193, lng: -93.2943 } as never),
  'pipeline deal': deskDealObject({ id: OPP, propertyId: PID, threadKey: TK, address: '3635 Emerson' }),
  'pipeline property': deskPropertyObject({ id: OPP, propertyId: PID, address: '3635 Emerson' }),
  'entity graph node': egObject('property', PID, 'Property 273312064'),
  'analytics deal': moneyDealObject({ id: OPP, propertyId: PID, threadKey: TK, stage: 'S4', address: null }),
  'analytics cohort place': handoffPointObject({ id: PID, lat: 45.0193, lng: -93.2943 }, 0),
}

describe('one property, every surface, one canonical focus', () => {
  it.each(Object.entries(fromEverySurface))('%s → Show on Map focuses property 273312064', (_surface, ref) => {
    expect(ref).not.toBeNull()
    expect(objectCapabilities(ref!).map).toEqual({ propertyId: PID, reason: null })
  })

  it('every property-typed object opens the same canonical destination', () => {
    const opens = Object.values(fromEverySurface).filter((r) => r!.type === 'property').map((r) => objectCapabilities(r!).open)
    expect(new Set(opens)).toEqual(new Set([`/deal-intelligence?property_id=${PID}`]))
  })

  it('labels differ by surface — identity does not', () => {
    const labels = new Set(Object.values(fromEverySurface).map((r) => r!.label))
    expect(labels.size).toBeGreaterThan(2)
  })

  it('a records row without a deal or thread is not an object (no guessed identity)', () => {
    expect(recordRowObject({ key: 'x', address: '3635 Emerson' })).toBeNull()
    expect(egObject('master_owner', 'mo-1')).toBeNull()
    expect(compObject({ key: 'k2', propertyId: null, address: '1 Main' } as never)).toBeNull()
  })
})
