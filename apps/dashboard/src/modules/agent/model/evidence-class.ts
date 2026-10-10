/**
 * EVIDENCE CLASSES (S3 directive P4) — five visually distinct classes:
 *
 *   official    official public record (county / city system of record)
 *   internal    internal LeadCommand records (our own tables)
 *   vendor      third-party vendor / licensed provider data
 *   derived     derived or inferred (a rule or model output from cited inputs)
 *   unavailable unavailable / blocked — never evidence of absence
 *
 * The class is derived from what the finding's evidence_status says it is
 * AND what the source's authority class says it came from — never from the
 * value. Each class carries what that kind of evidence can and cannot prove,
 * so a source is never treated as correct just because it answered.
 */
import {
  EXTENDED_EVIDENCE_STATUS_META, SOURCE_AUTHORITY_CLASSES, findingTypeMeta,
  type EvidenceSourceClass, type ExtendedEvidenceStatus, type Finding, type FindingType, type FreshnessState, type SourceAuthorityClass, type SourceDescriptor,
} from '../contracts/contracts'

export type EvidenceClass = 'official' | 'internal' | 'vendor' | 'derived' | 'unavailable'
export const EVIDENCE_CLASSES: readonly EvidenceClass[] = ['official', 'internal', 'vendor', 'derived', 'unavailable']

export const EVIDENCE_CLASS_META: Record<EvidenceClass, { label: string; short: string; proves: string; limits: string }> = {
  official: { label: 'Official public record', short: 'Official', proves: 'What the county or city system of record shows for this parcel on the retrieval date.', limits: 'Only as current as the office’s own posting; a parcel match is required before it applies to this property.' },
  internal: { label: 'Internal LeadCommand record', short: 'LeadCommand', proves: 'What LeadCommand’s own tables hold for this property, and when they were last refreshed.', limits: 'Internal records mirror upstream imports — they are not independently verified against the county.' },
  vendor: { label: 'Third-party vendor data', short: 'Vendor', proves: 'What a vendor snapshot reported at its snapshot date.', limits: 'Not independently verified; vendor flags lag and can be wrong. Corroborate before relying on it.' },
  derived: { label: 'Derived / inferred', short: 'Derived', proves: 'A conclusion computed from the cited inputs by a rule or model.', limits: 'Never stronger than its weakest input; inferences are capped at 0.6 confidence and labelled.' },
  unavailable: { label: 'Unavailable / blocked', short: 'Unavailable', proves: 'Nothing about the property — the record was not read.', limits: 'Not evidence of absence. A blocked or unavailable source is never retried around.' },
}

/** The server's P4 source class (live findings carry one) → the UI class. */
export const SERVER_CLASS: Record<EvidenceSourceClass, EvidenceClass> = {
  official_public_record: 'official', internal_record: 'internal', third_party_vendor: 'vendor', derived_inferred: 'derived', unavailable_blocked: 'unavailable',
}

/** A source as the UI may render it — live descriptors can be partial, so unknowns stay unknown. */
export interface SourceRef {
  source_id: string
  name: string
  authority_class: SourceAuthorityClass | 'unknown'
  access_mode: string | null
  host: string | null
  jurisdiction: string | null
  supports_negative: boolean
  billable: boolean
  test_data: boolean
  finding_types: string[]
  /** server-declared P4 class + provenance (live registry) */
  source_class: EvidenceSourceClass | null
  provenance: string | null
  limitations: string[]
}

type SourceInput = Omit<Partial<SourceDescriptor>, 'authority_class' | 'access_mode' | 'host' | 'jurisdiction' | 'name' | 'finding_types'> & { source_id: string; name?: string | null; authority_class?: string | null; access_mode?: string | null; host?: string | null; jurisdiction?: string | null; finding_types?: string[]; source_class?: string | null; provenance?: string | null; limitations?: string[] }

export function toSourceRef(s: SourceInput): SourceRef {
  const ac = (SOURCE_AUTHORITY_CLASSES as readonly string[]).includes(String(s.authority_class)) ? (s.authority_class as SourceAuthorityClass) : 'unknown'
  return {
    source_id: s.source_id,
    name: s.name || s.source_id,
    authority_class: ac,
    access_mode: s.access_mode ?? null,
    host: s.host ?? null,
    jurisdiction: s.jurisdiction ?? null,
    supports_negative: Boolean(s.supports_negative),
    billable: Boolean(s.billable),
    test_data: Boolean(s.test_data),
    finding_types: Array.isArray(s.finding_types) ? s.finding_types.map(String) : [],
    source_class: s.source_class && s.source_class in SERVER_CLASS ? (s.source_class as EvidenceSourceClass) : null,
    provenance: s.provenance ?? null,
    limitations: Array.isArray(s.limitations) ? s.limitations.map(String) : [],
  }
}

/** The class of a source by itself (for source rows that have no finding yet). */
export function sourceClass(src: SourceRef | null): EvidenceClass | null {
  if (!src) return null
  if (src.source_class) return SERVER_CLASS[src.source_class]
  switch (src.authority_class) {
    case 'official': return 'official'
    case 'internal': return 'internal'
    case 'licensed': case 'commercial': case 'search': return 'vendor'
    default: return null
  }
}

/** The evidence class of one finding. */
export function evidenceClassOf(f: Pick<Finding, 'evidence_status' | 'is_inference' | 'source_class'>, src: SourceRef | null): EvidenceClass {
  // a live finding's class is assigned by the server (CHANGELOG S3) — never re-derived
  if (f.source_class && f.source_class in SERVER_CLASS) return SERVER_CLASS[f.source_class]
  const s = f.evidence_status
  if (s === 'internal_record') return 'internal'
  if (s === 'derived') return 'derived'
  if (s === 'unavailable' || s === 'blocked') return 'unavailable'
  if (s === 'model_inference' || f.is_inference) return 'derived'
  if (s === 'vendor_reported' || s === 'licensed_provider') return 'vendor'
  if (s === 'county_confirmed') return 'official'
  const bysource = sourceClass(src)
  if (s === 'recorded') return bysource ?? 'internal'
  // unverified / stale: the source decides where it came from; an unsourced claim is derived
  return bysource ?? 'derived'
}

/** What a finding of this type can — and cannot — establish (P4: what the evidence actually proves). */
const TYPE_LIMITS: Partial<Record<FindingType, string>> = {
  ownership: 'Owner of record ≠ who controls the decision; entity owners need their principal resolved separately.',
  parcel: 'A parcel match ties the record to this address; it says nothing about condition or value.',
  tax_status: 'Shows the posted tax status; a payment in transit may not be reflected yet.',
  tax_delinquency: 'A delinquency flag is not a tax-sale or tax-deed filing; the amount can change daily.',
  lien: 'A recorded lien proves an instrument was recorded — not that it is still unpaid.',
  mortgage: 'A recorded mortgage proves the instrument and original amount; it does not prove the current balance.',
  foreclosure: 'A filing proves a case was opened; check the docket for dismissal or sale status.',
  probate: 'A probate case proves a filing; it does not prove who has authority to sell.',
  code_violation: 'An open case proves a violation was cited; severity and cure status need the case file.',
  condemnation: 'A condemnation order is serious; verify it has not been lifted.',
  listing_status: 'Listing status is point-in-time; it can change after retrieval.',
  comparable_sales: 'Comps describe the market lane they were drawn from; they do not price this property by themselves.',
  investor_demand: 'Buyer activity near the property is a demand signal, not a commitment.',
  acquisition_economics: 'Economics are estimates in a named valuation lane — never an authorized offer.',
  physical_condition: 'Condition evidence describes what was observed or reported, not an inspection.',
}

export function limitationsOf(f: Pick<Finding, 'finding_type' | 'evidence_status' | 'is_inference' | 'freshness_state' | 'is_negative_claim' | 'source_class' | 'limitations' | 'unavailable_reason'>, src: SourceRef | null): string[] {
  const out: string[] = []
  const cls = evidenceClassOf(f, src)
  // the server's own limitations for this finding / source come first
  for (const l of f.limitations ?? []) out.push(l)
  if (!f.limitations?.length) for (const l of src?.limitations ?? []) out.push(l)
  if (f.unavailable_reason) out.push(`Unavailable: ${f.unavailable_reason.replace(/_/g, ' ')}.`)
  out.push(EVIDENCE_CLASS_META[cls].limits)
  const t = TYPE_LIMITS[f.finding_type as FindingType]
  if (t && cls !== 'unavailable') out.push(t)
  if (f.freshness_state === 'stale') out.push('Past its freshness window — re-check before relying on it.')
  if (f.freshness_state === 'aging') out.push('Ageing — nearing the end of its freshness window.')
  if (f.is_negative_claim) out.push(src?.supports_negative ? '“None found” is claimed because this source is registered as complete for this type.' : '“None found” cannot be claimed from this source.')
  if (src?.authority_class === 'unknown') out.push('The source’s authority class was not reported by the server.')
  return [...new Set(out)]
}

export const FRESHNESS_LABEL: Record<FreshnessState, string> = { fresh: 'Fresh', aging: 'Ageing', stale: 'Stale', never: 'Never refreshed' }

export const findingTypeLabel = (t: string) => findingTypeMeta(t)?.label ?? t.replace(/_/g, ' ')

export const evidenceStatusCopy = (s: ExtendedEvidenceStatus | string) => (EXTENDED_EVIDENCE_STATUS_META as Record<string, { label: string; description: string }>)[s] ?? { label: s, description: '' }

/* ── entity-owned contact readiness (S3, owner 10-09) ─────────────────── */

export type ContactReadinessState = 'held_suppressed' | 'relationship_unresolved' | 'vendor_associated_phone' | 'confirmed_relationship' | 'no_contact_found' | 'unknown'

export const CONTACT_READINESS_META: Record<ContactReadinessState, { label: string; tone: 'hold' | 'review' | 'vendor' | 'ok' | 'none' | 'unknown'; means: string }> = {
  held_suppressed: { label: 'Held / suppressed', tone: 'hold', means: 'A suppression, opt-out or do-not-contact blocks outreach.' },
  relationship_unresolved: { label: 'Contact found — relationship unresolved', tone: 'review', means: 'People or phones exist; the entity-contact relationship needs review. This is not missing contact data.' },
  vendor_associated_phone: { label: 'Vendor-associated phone', tone: 'vendor', means: 'Phones are tied to the property by the vendor only; the owner identity is not resolved.' },
  confirmed_relationship: { label: 'Confirmed relationship', tone: 'ok', means: 'The person / phone is the resolved owner’s, with no review flag.' },
  no_contact_found: { label: 'No contact found', tone: 'none', means: 'Every contact read succeeded and found no person or phone.' },
  unknown: { label: 'Contact evidence unavailable', tone: 'unknown', means: 'A contact read failed — not evidence that no contact exists.' },
}

export interface ContactReadinessView {
  state: ContactReadinessState
  label: string
  people: number
  phones: number
  masked_phones: string[]
  resolved_people: number
  vendor_linked_people: number
  requires_review: boolean | null
  review_reasons: string[]
  review_checked: boolean
  suppressed_by: string[]
  campaign_eligible: boolean | null
  campaign_reason: string | null
  finding_id: string
}

export const ENTITY_REVIEW_REASON_LABELS: Record<string, string> = {
  ENT_NO_REGISTRY_LINK: 'No state-registry link for the entity',
  ENT_ROLE_UNCORROBORATED: 'The person’s role at the entity is not corroborated',
  ENT_NO_COMPLIANT_CHANNEL: 'No compliant channel for the selected person',
  ENT_NO_HUMAN_CANDIDATE: 'No human candidate behind the entity',
  ENT_DISSOLVED: 'The entity is dissolved',
}

/** The contact-readiness finding for a property (outreach_state · contact_readiness), or null. */
export function contactReadinessOf(findings: Record<string, Pick<Finding, 'finding_id' | 'property_id' | 'finding_type' | 'key' | 'value' | 'evidence_status'>>, order: string[], propertyId: string | null): ContactReadinessView | null {
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const f = findings[order[i]]
    if (!f || f.finding_type !== 'outreach_state' || f.key !== 'contact_readiness') continue
    if (propertyId && f.property_id !== propertyId) continue
    if (f.value === null || f.evidence_status === 'unavailable') return { state: 'unknown', label: CONTACT_READINESS_META.unknown.label, people: 0, phones: 0, masked_phones: [], resolved_people: 0, vendor_linked_people: 0, requires_review: null, review_reasons: [], review_checked: false, suppressed_by: [], campaign_eligible: null, campaign_reason: null, finding_id: f.finding_id }
    const v = f.value as Partial<ContactReadinessView>
    const state = (v.state && v.state in CONTACT_READINESS_META ? v.state : 'unknown') as ContactReadinessState
    return {
      state, label: CONTACT_READINESS_META[state].label, people: Number(v.people ?? 0), phones: Number(v.phones ?? 0), masked_phones: Array.isArray(v.masked_phones) ? v.masked_phones.map(String) : [],
      resolved_people: Number(v.resolved_people ?? 0), vendor_linked_people: Number(v.vendor_linked_people ?? 0), requires_review: typeof v.requires_review === 'boolean' ? v.requires_review : null,
      review_reasons: Array.isArray(v.review_reasons) ? v.review_reasons.map(String) : [], review_checked: Boolean(v.review_checked), suppressed_by: Array.isArray(v.suppressed_by) ? v.suppressed_by.map(String) : [],
      campaign_eligible: typeof v.campaign_eligible === 'boolean' ? v.campaign_eligible : null, campaign_reason: typeof v.campaign_reason === 'string' ? v.campaign_reason : null, finding_id: f.finding_id,
    }
  }
  return null
}
