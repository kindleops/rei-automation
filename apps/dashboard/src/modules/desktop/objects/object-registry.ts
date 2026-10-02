import type { AppId } from '../../../domain/app-registry/app-registry'
import type { PropertyLocator } from '../../../domain/locator/property-locator'
import type { IconName } from '../../../shared/icons'
import { inspectorFor } from '../inspector/inspector-registry'
import type { EntityRef } from '../inspector/inspector-store'
import { missionsFor, type MissionDef, type MissionSubject } from '../workspace/missions'
import '../inspector/register-inspectors'

/**
 * THE CANONICAL OBJECT ACTION REGISTRY (System Refinement 8.2 §2).
 *
 * One answer, for every surface, to "what is this object and what can I do
 * with it": which application owns it, how the Universal Inspector reads it,
 * what the Map does with it, which missions it can start, and the canonical
 * deep link that Open / Open beside navigate to.
 *
 * IDENTITY RULE: an object is named by its canonical id only — property_id,
 * thread_key, opportunity id, campaign id, workflow key, closing id. Address
 * and name strings are LABELS (what to call it before the read lands); they
 * are never parsed into identity and never used to match.
 *
 * The object reference IS the inspector's EntityRef (one identity grammar for
 * the whole OS). Build refs with the route-contract builders below, never by
 * hand, so every surface hands the shell the same shape for the same object.
 */

export type ObjectType = 'property' | 'seller' | 'deal' | 'campaign' | 'buyer' | 'company' | 'workflow' | 'closing'

export const OBJECT_TYPES: readonly ObjectType[] = ['property', 'seller', 'deal', 'campaign', 'buyer', 'company', 'workflow', 'closing']

export type ObjectRef = EntityRef & { type: ObjectType }

/** Where an action was taken — for the linked-context and the audit, never for identity. */
export type ObjectSource = 'inbox' | 'deal-intelligence' | 'comp-intelligence' | 'pipeline' | 'entity-graph' | 'analytics' | 'map' | 'command-deck' | 'notifications' | 'inspector' | 'buyer-match' | 'campaign-command' | 'closing-desk' | 'workflow-studio' | string

/**
 * How the Map treats an object:
 *   property      it IS a place: fly to the parcel
 *   via_property  it has a place through its property (seller, deal, closing)
 *   none          not spatial (campaign areas, buyers and companies have no
 *                 single canonical location the Map can focus)
 */
export type MapBehaviour = 'property' | 'via_property' | 'none'

export interface ObjectTypeSpec {
  type: ObjectType
  noun: string
  glyph: IconName
  /** the application that owns this object (Open lands here) */
  primaryApp: AppId
  mapBehaviour: MapBehaviour
  /** the canonical deep link into the owning app, or null when the ref lacks the id it needs */
  deepLink: (ref: ObjectRef) => string | null
  /** the path Open beside places in a new pane (same contract, by default) */
  besideLink: (ref: ObjectRef) => string | null
  /** what a mission can carry from this object (null = no mission subject) */
  missionSubject: (ref: ObjectRef) => MissionSubject | null
  /** the linked context this object publishes, when it has a property-shaped identity */
  locator: (ref: ObjectRef) => Partial<PropertyLocator> | null
}

/* ── helpers ──────────────────────────────────────────────────────────── */

const enc = encodeURIComponent
const s = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
/** A hint the caller put on the ref. */
export const hintOf = (ref: EntityRef, key: string): string | null => s(ref.hint?.[key])

/** The canonical property id an object can be placed by (itself, or its property). */
export function propertyIdOf(ref: EntityRef): string | null {
  if (ref.type === 'property') return hintOf(ref, 'property_id') ?? s(ref.id)
  return hintOf(ref, 'property_id')
}

function q(base: string, params: Record<string, string | null | undefined>): string {
  const parts = Object.entries(params).flatMap(([k, v]) => (v ? [`${k}=${enc(v)}`] : []))
  return parts.length ? `${base}?${parts.join('&')}` : base
}

/* ── route contracts: the ONLY way to name an object ─────────────────── */

type Opt = string | null | undefined
const hint = (h: Record<string, Opt>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) { const t = s(v); if (t) out[k] = t }
  return out
}

/** property: propertyId + optional seller (thread) / deal / source. */
export function propertyObject(a: { propertyId: string; threadKey?: Opt; opportunityId?: Opt; masterOwnerId?: Opt; prospectId?: Opt; label?: Opt; source?: ObjectSource | null; lat?: number | null; lng?: number | null }): ObjectRef {
  const coords = Number.isFinite(a.lat) && Number.isFinite(a.lng) ? { lat: String(a.lat), lng: String(a.lng) } : {}
  return {
    type: 'property',
    id: String(a.propertyId),
    label: s(a.label),
    hint: hint({ property_id: a.propertyId, thread_key: a.threadKey, opportunity_id: a.opportunityId, master_owner_id: a.masterOwnerId, prospect_id: a.prospectId, source: a.source ?? null, ...coords }),
  }
}

/**
 * seller: the canonical conversation identity (thread_key) + the prospect it
 * belongs to. Two prospects that share a phone are two threads — never merged
 * by phone or name.
 */
export function sellerObject(a: { threadKey: string; prospectId?: Opt; masterOwnerId?: Opt; propertyId?: Opt; propertyLabel?: Opt; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  return {
    type: 'seller',
    id: String(a.threadKey),
    label: s(a.label),
    hint: hint({ thread_key: a.threadKey, prospect_id: a.prospectId, master_owner_id: a.masterOwnerId, property_id: a.propertyId, property_label: a.propertyLabel, source: a.source ?? null }),
  }
}

/** deal: opportunity id + property / seller / stage. */
export function dealObject(a: { opportunityId: string; propertyId?: Opt; threadKey?: Opt; masterOwnerId?: Opt; stage?: Opt; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  return {
    type: 'deal',
    id: String(a.opportunityId),
    label: s(a.label),
    hint: hint({ opportunity_id: a.opportunityId, property_id: a.propertyId, thread_key: a.threadKey, master_owner_id: a.masterOwnerId, stage: a.stage, source: a.source ?? null }),
  }
}

/** campaign: its id — never parsed from a name. */
export function campaignObject(a: { campaignId: string; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  return { type: 'campaign', id: String(a.campaignId), label: s(a.label), hint: hint({ campaign_id: a.campaignId, source: a.source ?? null }) }
}

/** buyer: the buyer key Entity Graph / Buyer Match read profiles by. */
export function buyerObject(a: { buyerKey: string; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  return { type: 'buyer', id: String(a.buyerKey), label: s(a.label), hint: hint({ buyer_key: a.buyerKey, source: a.source ?? null }) }
}

/** company: an organization node (Entity Graph's organization id). */
export function companyObject(a: { organizationId: string; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  return { type: 'company', id: String(a.organizationId), label: s(a.label), hint: hint({ organization_id: a.organizationId, source: a.source ?? null }) }
}

/** workflow: its key, or one run of it (`<key>:<run_id>`, the inspector's contract). */
export function workflowObject(a: { workflowKey: string; runId?: Opt; threadKey?: Opt; propertyId?: Opt; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  const run = s(a.runId)
  return {
    type: 'workflow',
    id: run ? `${a.workflowKey}:${run}` : String(a.workflowKey),
    label: s(a.label),
    hint: hint({ workflow_key: a.workflowKey, run_id: run, thread_key: a.threadKey, property_id: a.propertyId, source: a.source ?? null }),
  }
}

/** closing: the closing case id. */
export function closingObject(a: { closingId: string; propertyId?: Opt; threadKey?: Opt; opportunityId?: Opt; label?: Opt; source?: ObjectSource | null }): ObjectRef {
  return {
    type: 'closing',
    id: String(a.closingId),
    label: s(a.label),
    hint: hint({ closing_id: a.closingId, property_id: a.propertyId, thread_key: a.threadKey, opportunity_id: a.opportunityId, source: a.source ?? null }),
  }
}

/* ── the specs ────────────────────────────────────────────────────────── */

const workflowParts = (ref: ObjectRef) => {
  const key = hintOf(ref, 'workflow_key') ?? ref.id.split(':')[0]
  const run = hintOf(ref, 'run_id') ?? (ref.id.includes(':') ? ref.id.slice(ref.id.indexOf(':') + 1) : null)
  return { key, run }
}

const locatorFrom = (ref: ObjectRef, extra: Partial<PropertyLocator> = {}): Partial<PropertyLocator> | null => {
  const l: Partial<PropertyLocator> = {
    propertyId: propertyIdOf(ref),
    threadKey: hintOf(ref, 'thread_key'),
    opportunityId: hintOf(ref, 'opportunity_id'),
    masterOwnerId: hintOf(ref, 'master_owner_id'),
    prospectId: hintOf(ref, 'prospect_id'),
    address: ref.type === 'property' ? s(ref.label) : hintOf(ref, 'property_label'),
    ...extra,
  }
  return l.propertyId || l.threadKey || l.opportunityId ? l : null
}

const subjectFrom = (ref: ObjectRef, extra: Partial<MissionSubject> = {}): MissionSubject => ({
  label: s(ref.label) ?? hintOf(ref, 'property_label') ?? ref.id,
  propertyId: propertyIdOf(ref),
  threadKey: hintOf(ref, 'thread_key'),
  prospectId: hintOf(ref, 'prospect_id'),
  masterOwnerId: hintOf(ref, 'master_owner_id'),
  opportunityId: hintOf(ref, 'opportunity_id'),
  address: ref.type === 'property' ? s(ref.label) : hintOf(ref, 'property_label'),
  ...extra,
})

const SPECS: Record<ObjectType, ObjectTypeSpec> = {
  property: {
    type: 'property', noun: 'Property', glyph: 'home', primaryApp: 'deal-intelligence', mapBehaviour: 'property',
    // the decision room is where a property is worked (the inspector's first "Open")
    deepLink: (r) => { const id = propertyIdOf(r); return id ? q('/deal-intelligence', { property_id: id }) : null },
    besideLink: (r) => SPECS.property.deepLink(r),
    missionSubject: (r) => (propertyIdOf(r) ? subjectFrom(r) : null),
    locator: (r) => locatorFrom(r),
  },
  seller: {
    type: 'seller', noun: 'Seller', glyph: 'user', primaryApp: 'inbox', mapBehaviour: 'via_property',
    deepLink: (r) => { const tk = hintOf(r, 'thread_key') ?? s(r.id); return tk ? q('/inbox', { thread: tk }) : null },
    besideLink: (r) => SPECS.seller.deepLink(r),
    missionSubject: (r) => subjectFrom(r, { threadKey: hintOf(r, 'thread_key') ?? r.id, address: hintOf(r, 'property_label') }),
    locator: (r) => locatorFrom(r, { threadKey: hintOf(r, 'thread_key') ?? r.id }),
  },
  deal: {
    type: 'deal', noun: 'Deal', glyph: 'trending-up', primaryApp: 'pipeline', mapBehaviour: 'via_property',
    deepLink: (r) => q('/pipeline', { opp: hintOf(r, 'opportunity_id') ?? r.id }),
    besideLink: (r) => SPECS.deal.deepLink(r),
    missionSubject: (r) => subjectFrom(r, { opportunityId: hintOf(r, 'opportunity_id') ?? r.id }),
    locator: (r) => locatorFrom(r, { opportunityId: hintOf(r, 'opportunity_id') ?? r.id }),
  },
  campaign: {
    type: 'campaign', noun: 'Campaign', glyph: 'send', primaryApp: 'campaign-command', mapBehaviour: 'none',
    deepLink: (r) => q('/campaign-command', { campaign: hintOf(r, 'campaign_id') ?? r.id }),
    besideLink: (r) => SPECS.campaign.deepLink(r),
    missionSubject: (r) => ({ label: s(r.label) ?? 'Campaign', campaignId: hintOf(r, 'campaign_id') ?? r.id }),
    locator: () => null,
  },
  buyer: {
    type: 'buyer', noun: 'Buyer', glyph: 'briefcase', primaryApp: 'entity-graph', mapBehaviour: 'none',
    deepLink: (r) => q('/entity-graph', { buyer: hintOf(r, 'buyer_key') ?? r.id }),
    besideLink: (r) => SPECS.buyer.deepLink(r),
    missionSubject: () => null,
    locator: () => null,
  },
  company: {
    type: 'company', noun: 'Company', glyph: 'users', primaryApp: 'entity-graph', mapBehaviour: 'none',
    deepLink: (r) => `/entity-graph/organization/${enc(hintOf(r, 'organization_id') ?? r.id)}`,
    besideLink: (r) => SPECS.company.deepLink(r),
    missionSubject: () => null,
    locator: () => null,
  },
  workflow: {
    type: 'workflow', noun: 'Workflow', glyph: 'cpu', primaryApp: 'workflow-studio', mapBehaviour: 'none',
    deepLink: (r) => { const { key, run } = workflowParts(r); return q('/workflow-studio', { wf: key, run }) },
    besideLink: (r) => SPECS.workflow.deepLink(r),
    missionSubject: (r) => (hintOf(r, 'thread_key') ? subjectFrom(r) : null),
    locator: () => null,
  },
  closing: {
    type: 'closing', noun: 'Closing', glyph: 'key', primaryApp: 'closing-desk', mapBehaviour: 'via_property',
    deepLink: (r) => q('/closing-desk', { case: hintOf(r, 'closing_id') ?? r.id }),
    besideLink: (r) => SPECS.closing.deepLink(r),
    missionSubject: (r) => subjectFrom(r, { closingId: hintOf(r, 'closing_id') ?? r.id }),
    locator: (r) => locatorFrom(r),
  },
}

export const isObjectType = (t: unknown): t is ObjectType => typeof t === 'string' && (OBJECT_TYPES as readonly string[]).includes(t)

/** The registry entry for a type (null for inspector-only types like market or search). */
export function objectSpec(type: string): ObjectTypeSpec | null {
  return isObjectType(type) ? SPECS[type] : null
}

/** Narrow any EntityRef to an ObjectRef the registry understands. */
export function asObjectRef(ref: EntityRef | null | undefined): ObjectRef | null {
  return ref && ref.id && isObjectType(ref.type) ? (ref as ObjectRef) : null
}

/** Everything the shell knows about one object, resolved once. */
export interface ObjectCapabilities {
  spec: ObjectTypeSpec
  open: string | null
  beside: string | null
  inspectable: boolean
  /** the property the Map can focus, and why not when it cannot */
  map: { propertyId: string | null; reason: string | null }
  missions: MissionDef[]
  missionSubject: MissionSubject | null
}

export function objectCapabilities(ref: ObjectRef): ObjectCapabilities {
  const spec = SPECS[ref.type]
  const subject = spec.missionSubject(ref)
  const pid = spec.mapBehaviour === 'none' ? null : propertyIdOf(ref)
  const reason = spec.mapBehaviour === 'none'
    ? `A ${spec.noun.toLowerCase()} has no single place on the map`
    : pid ? null : `No property is linked to this ${spec.noun.toLowerCase()}`
  return {
    spec,
    open: spec.deepLink(ref),
    beside: spec.besideLink(ref),
    inspectable: Boolean(inspectorFor(ref.type)),
    map: { propertyId: pid, reason },
    missions: subject ? missionsFor(subject) : [],
    missionSubject: subject,
  }
}
