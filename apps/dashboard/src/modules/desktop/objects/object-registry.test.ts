import { describe, expect, it } from 'vitest'
import { shapeProperty } from '../inspector/renderers/property'
import { shapeSeller } from '../inspector/renderers/seller'
import { shapeCampaign } from '../inspector/renderers/campaign'
import { shapeClosing } from '../inspector/renderers/closing'
import { shapeDeal } from '../inspector/renderers/deal'
import { shapeRun, shapeWorkflow } from '../inspector/renderers/workflow'
import { shapeBuyer } from '../inspector/renderers/buyer'
import propertySubject from '../inspector/renderers/__fixtures__/property-subject.json'
import sellerDossier from '../inspector/renderers/__fixtures__/seller-thread-dossier.json'
import campaignDetail from '../inspector/renderers/__fixtures__/campaign-detail.json'
import closingExecution from '../inspector/renderers/__fixtures__/closing-execution.json'
import dealStory from '../inspector/renderers/__fixtures__/deal-story.json'
import workflowRun from '../inspector/renderers/__fixtures__/workflow-run.json'
import workflowDefinition from '../inspector/renderers/__fixtures__/workflow-definition.json'
import buyerProfile from '../inspector/renderers/__fixtures__/buyer-profile.json'
import {
  OBJECT_TYPES, asObjectRef, buyerObject, campaignObject, closingObject, companyObject, dealObject,
  objectCapabilities, objectSpec, propertyObject, sellerObject, workflowObject,
} from './object-registry'

const NOW = Date.parse('2026-10-01T18:40:00Z')

describe('object registry — every type is complete', () => {
  it('declares a primary app, deep link, beside link and map behaviour for each type', () => {
    for (const t of OBJECT_TYPES) {
      const spec = objectSpec(t)!
      expect(spec, t).toBeTruthy()
      expect(spec.primaryApp).toBeTruthy()
      expect(['property', 'via_property', 'none']).toContain(spec.mapBehaviour)
    }
    expect(objectSpec('market')).toBeNull()
    expect(asObjectRef({ type: 'search_page', id: 'x' })).toBeNull()
  })
})

describe('route contracts — canonical ids, never labels', () => {
  it('property: propertyId (+ seller / deal / source as hints)', () => {
    const a = propertyObject({ propertyId: '273312064', label: '3635 Emerson Ave N', threadKey: 'tk-1', opportunityId: 'opp-1', source: 'inbox' })
    const b = propertyObject({ propertyId: '273312064', label: '3635 EMERSON AVENUE NORTH, MINNEAPOLIS', source: 'analytics' })
    const sa = objectSpec('property')!
    expect(sa.deepLink(a)).toBe('/deal-intelligence?property_id=273312064')
    // a different label (or source) is the same object
    expect(sa.deepLink(b)).toBe(sa.deepLink(a))
    expect(objectCapabilities(a).map.propertyId).toBe(objectCapabilities(b).map.propertyId)
    expect(a.hint).toMatchObject({ property_id: '273312064', thread_key: 'tk-1', opportunity_id: 'opp-1' })
  })

  it('seller: the thread is the identity — two prospects sharing a phone stay two sellers', () => {
    const one = sellerObject({ threadKey: '+15550100001::prospect-a', prospectId: 'prospect-a', label: 'Same Name' })
    const two = sellerObject({ threadKey: '+15550100001::prospect-b', prospectId: 'prospect-b', label: 'Same Name' })
    expect(objectSpec('seller')!.deepLink(one)).not.toBe(objectSpec('seller')!.deepLink(two))
    expect(objectSpec('seller')!.locator(one)).toMatchObject({ threadKey: '+15550100001::prospect-a', prospectId: 'prospect-a' })
  })

  it('deal: opportunity id + property / seller / stage', () => {
    const d = dealObject({ opportunityId: 'opp-9', propertyId: 'p-9', threadKey: 'tk-9', stage: 'S4' })
    expect(objectSpec('deal')!.deepLink(d)).toBe('/pipeline?opp=opp-9')
    expect(objectCapabilities(d).map.propertyId).toBe('p-9')
    expect(objectCapabilities(dealObject({ opportunityId: 'opp-10' })).map).toEqual({ propertyId: null, reason: 'No property is linked to this deal' })
  })

  it('campaign: id only — the name is never parsed', () => {
    const c = campaignObject({ campaignId: 'c-1', label: 'Minneapolis · Probate · Wave 2' })
    expect(objectSpec('campaign')!.deepLink(c)).toBe('/campaign-command?campaign=c-1')
    expect(objectCapabilities(c).map.propertyId).toBeNull()
  })

  it('company and buyer land in Entity Graph by id', () => {
    expect(objectSpec('company')!.deepLink(companyObject({ organizationId: 'org 7' }))).toBe('/entity-graph/organization/org%207')
    expect(objectSpec('buyer')!.deepLink(buyerObject({ buyerKey: 'company:us_ak:1' }))).toBe('/entity-graph?buyer=company%3Aus_ak%3A1')
  })
})

describe('registry ↔ Universal Inspector agree on where each object opens', () => {
  it('property', () => {
    const ref = propertyObject({ propertyId: '273312064' })
    expect(objectCapabilities(ref).open).toBe(shapeProperty(propertySubject.data as never, ref).open![0].path)
  })
  it('seller', () => {
    const m = shapeSeller(sellerDossier as never, { type: 'seller', id: '+15550100001' }, NOW)
    expect(objectCapabilities(sellerObject({ threadKey: m.mission!.threadKey! })).open).toBe(m.open![0].path)
  })
  it('campaign', () => {
    const m = shapeCampaign(campaignDetail as never, { type: 'campaign', id: 'c963defc-5672-4419-b494-807d453f8d18' }, NOW)
    expect(objectCapabilities(campaignObject({ campaignId: m.mission!.campaignId! })).open).toBe(m.open![0].path)
  })
  it('closing', () => {
    const m = shapeClosing(closingExecution.data.closing as never, { type: 'closing', id: 'closing:2b3c261d-f3dd-494a-a60c-3437cbdf39b8' })
    expect(objectCapabilities(closingObject({ closingId: m.mission!.closingId! })).open).toBe(m.open![0].path)
  })
  it('deal', () => {
    const m = shapeDeal(dealStory.data as never, { type: 'deal', id: '2b3c261d-f3dd-494a-a60c-3437cbdf39b8' })
    expect(objectCapabilities(dealObject({ opportunityId: m.mission!.opportunityId! })).open).toBe(m.open![0].path)
  })
  it('workflow run and workflow', () => {
    const run = shapeRun(workflowRun as never, { type: 'workflow', id: 'seller_inbound:3004ae79-99a0-49ff-909f-7de5b03ad129' })
    expect(objectCapabilities(workflowObject({ workflowKey: 'seller_inbound', runId: '3004ae79-99a0-49ff-909f-7de5b03ad129' })).open).toBe(run.open![0].path)
    const wf = shapeWorkflow(workflowDefinition as never, { type: 'workflow', id: 'seller_inbound' })
    expect(objectCapabilities(workflowObject({ workflowKey: 'seller_inbound' })).open).toBe(wf.open![0].path)
  })
  it('buyer', () => {
    const m = shapeBuyer(buyerProfile.profile as never, { type: 'buyer', id: 'company:us_ak:10043936' })
    expect(objectCapabilities(buyerObject({ buyerKey: 'company:us_ak:10043936' })).open).toBe(m.open![0].path)
  })
})

describe('capabilities', () => {
  it('property carries the property missions and is inspectable', () => {
    const cap = objectCapabilities(propertyObject({ propertyId: 'p1', threadKey: 'tk', label: '1 Main St' }))
    expect(cap.inspectable).toBe(true)
    expect(cap.missions.map((m) => m.kind)).toEqual(['work_seller', 'move_deal'])
    expect(cap.map).toEqual({ propertyId: 'p1', reason: null })
  })
  it('company has no inspector renderer yet and says so through the action list', () => {
    expect(objectCapabilities(companyObject({ organizationId: 'o1' })).inspectable).toBe(false)
  })
})
