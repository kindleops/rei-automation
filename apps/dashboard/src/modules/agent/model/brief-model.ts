/**
 * OWNER-ORDER BRIEF (S3 directive P6) — pure. Re-composes what the run
 * emitted (brief.section claims, findings, conflicts, tasks, brief.completed)
 * into the owner's seven sections, in this order:
 *
 *   1 Acquisition recommendation
 *   2 Supporting findings
 *   3 Confidence + verification gaps
 *   4 Economics + assumptions
 *   5 Evidence + citations
 *   6 Conflicts + unavailable information
 *   7 Next recommended actions
 *
 * Nothing is written here that the run did not say. The recommendation is
 * the server's opportunity / contact-readiness classification and summary;
 * when the run did not classify, the section says so instead of guessing.
 * Actions are UI handoffs only — no production action can be taken here.
 */
import { BRIEF_SECTIONS, type BriefClaim, type BriefSectionKey, type ContactReadinessClass, type OpportunityClass } from '../contracts/contracts'
import type { FindingView, PropertyView, ResearchView, TaskRow } from './research-model'
import { conflictsFor, type ConflictAnalysis } from './conflict-model'
import { evidenceClassOf, type EvidenceClass, type SourceRef } from './evidence-class'

export const OWNER_BRIEF_ORDER = [
  { key: 'recommendation', n: 1, label: 'Acquisition recommendation' },
  { key: 'findings', n: 2, label: 'Supporting findings' },
  { key: 'confidence', n: 3, label: 'Confidence & verification gaps' },
  { key: 'economics', n: 4, label: 'Economics & assumptions' },
  { key: 'evidence', n: 5, label: 'Evidence & citations' },
  { key: 'conflicts', n: 6, label: 'Conflicts & unavailable information' },
  { key: 'next', n: 7, label: 'Next recommended actions' },
] as const
export type OwnerSectionKey = typeof OWNER_BRIEF_ORDER[number]['key']

const FINDING_SECTIONS: BriefSectionKey[] = ['property_ownership', 'physical_condition', 'taxes_liens', 'foreclosure_legal', 'listing_history', 'comparable_sales', 'investor_demand']

export interface EvidenceEntry { finding: FindingView; source: SourceRef | null; cls: EvidenceClass }

export interface OwnerBrief {
  status: 'final' | 'writing' | 'not_started'
  recommendation: { opportunity: OpportunityClass | null; readiness: ContactReadinessClass | null; summary: string | null; discoveries: FindingView[] }
  findings: Array<{ key: BriefSectionKey; label: string; claims: BriefClaim[]; arrived: boolean; event_id: number | null }>
  confidence: { lowest: number | null; verified: number; awaiting: number; contradicted: number; unavailable: number; inferred: number; gaps: string[] }
  economics: { applicable: boolean; claims: BriefClaim[]; assumptions: string[]; note: string }
  evidence: EvidenceEntry[]
  byClass: Record<EvidenceClass, number>
  conflicts: ConflictAnalysis[]
  unavailable: Array<{ task: TaskRow; reason: string }>
  risks: BriefClaim[]
  next: BriefClaim[]
  sections_present: number
}

export function composeOwnerBrief(view: ResearchView, property: PropertyView | null, sources: Record<string, SourceRef>, terminal: boolean): OwnerBrief {
  const pid = property?.property_id ?? null
  const sections = property?.sections ?? {}
  const done = property?.brief_completed ?? null
  const writing = view.phase === 'synthesizing' || view.phase === 'complete' || Object.keys(sections).length > 0
  const findings = view.findingOrder.map((id) => view.findings[id]).filter((f) => !pid || f.property_id === pid)
  const tasks = view.tasks.filter((t) => !pid || t.property_id === pid)

  const evidence: EvidenceEntry[] = findings.map((f) => { const src = f.source_id ? sources[f.source_id] ?? null : null; return { finding: f, source: src, cls: evidenceClassOf(f, src) } })
  const byClass: Record<EvidenceClass, number> = { official: 0, internal: 0, vendor: 0, derived: 0, unavailable: 0 }
  for (const e of evidence) byClass[e.cls] += 1

  const valued = findings.filter((f) => f.evidence_status !== 'unavailable' && f.evidence_status !== 'blocked')
  const standing = valued.filter((f) => !f.contradicted_by)
  const verified = standing.filter((f) => ['county_confirmed', 'recorded', 'licensed_provider', 'internal_record'].includes(f.evidence_status)).length
  const inferred = standing.filter((f) => f.is_inference || f.evidence_status === 'model_inference' || f.evidence_status === 'derived').length
  const contradicted = valued.length - standing.length
  const unavailableFindings = findings.length - valued.length
  const lowest = standing.length ? Math.min(...standing.map((f) => f.confidence)) : null

  const unavailable = tasks.filter((t) => ['blocked', 'unavailable', 'failed'].includes(t.state)).map((t) => ({ task: t, reason: t.message ?? t.reason ?? t.state }))
  const gaps: string[] = []
  if (done?.sections_missing.length) gaps.push(`Not covered in this pass: ${done.sections_missing.map((k) => BRIEF_SECTIONS.find((s) => s.key === k)?.label ?? k).join(', ')}`)
  if (unavailable.length) gaps.push(`${unavailable.length} operation${unavailable.length === 1 ? '' : 's'} returned no value (blocked, unavailable or failed) — not evidence of absence`)
  const awaiting = standing.length - verified
  if (awaiting > 0) gaps.push(`${awaiting} standing claim${awaiting === 1 ? ' rests' : 's rest'} on vendor or derived evidence and await${awaiting === 1 ? 's' : ''} independent verification`)
  if (tasks.some((t) => t.state === 'needs_input')) gaps.push('Waiting on your answer to an open question')
  if (lowest !== null && lowest < 0.5) gaps.push(`Lowest standing confidence is ${lowest.toFixed(2)} (low band)`)

  const econ = sections.acquisition_economics
  const economics = view.depth === 'diligence'
    ? { applicable: true, claims: econ?.claims ?? [], assumptions: (econ?.claims ?? []).filter((c) => c.is_inference).map((c) => c.text), note: econ ? 'Lane-labelled estimate — never an authorized offer.' : terminal ? 'Not written in this pass.' : 'Pending — written at synthesis.' }
    : { applicable: false, claims: [], assumptions: [], note: view.depth === 'quick' ? 'Quick Scan does not compute acquisition economics (read-only, $0). Valuation lanes are an Acquisition Diligence output.' : 'Acquisition economics are an Acquisition Diligence output; this pass did not compute them.' }

  return {
    status: terminal ? 'final' : writing ? 'writing' : 'not_started',
    recommendation: { opportunity: done?.opportunity_class ?? property?.opportunity_class ?? null, readiness: done?.contact_readiness_class ?? property?.contact_readiness_class ?? null, summary: terminal ? view.summary : null, discoveries: standing.filter((f) => f.is_discovery) },
    findings: FINDING_SECTIONS.map((key) => { const sec = sections[key]; return { key, label: BRIEF_SECTIONS.find((s) => s.key === key)!.label, claims: sec?.claims ?? [], arrived: Boolean(sec), event_id: sec?.event_id ?? null } }),
    confidence: { lowest, verified, awaiting, contradicted, unavailable: unavailableFindings, inferred, gaps },
    economics,
    evidence,
    byClass,
    conflicts: conflictsFor(view, sources, pid),
    unavailable,
    risks: sections.risks_unresolved?.claims ?? [],
    next: sections.next_investigation?.claims ?? [],
    sections_present: Object.keys(sections).length,
  }
}
