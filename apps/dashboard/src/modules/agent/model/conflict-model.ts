/**
 * CONFLICT INSPECTOR MODEL (S3 directive P5) — pure.
 *
 * For each finding.conflict group: the competing claims, what supports each
 * (source, evidence class, retrieval date, confidence, freshness), and —
 * ONLY when the evidence is decisive — the best-supported conclusion with
 * the reason it is preferred. Otherwise the conflict is "Unresolved", with
 * the reason, the remaining uncertainty and the follow-up that would settle
 * it. Decisive means: the server resolved the group (by rule or operator)
 * and exactly one member stands uncontradicted. The UI never picks a winner
 * on its own.
 */
import type { EvidenceSourceClass } from '../contracts/contracts'
import type { ConflictView, FindingView, ResearchView, TaskRow } from './research-model'
import { EVIDENCE_CLASS_META, SERVER_CLASS, evidenceClassOf, findingTypeLabel, toSourceRef, type EvidenceClass, type SourceRef } from './evidence-class'

export interface ConflictClaim {
  finding_id: string
  /** null when the claim's finding has not arrived (rendered from the server's claim ref) */
  finding: FindingView | null
  text: string
  source: SourceRef | null
  cls: EvidenceClass
  role: 'preferred' | 'overruled' | 'competing' | 'agreeing'
  support: string[]
}

export interface ConflictAnalysis {
  id: string
  finding_type: string
  label: string
  status: 'resolved' | 'agree' | 'unresolved'
  claims: ConflictClaim[]
  conclusion: { finding_id: string; text: string; reason: string } | null
  unresolved_reason: string | null
  uncertainty: string[]
  follow_up: string[]
  opened_event_id: number
  event_id: number
}

export const CONFLICT_RULE_LABEL: Record<string, string> = {
  county_beats_vendor: 'The county system of record outranks a vendor snapshot for this finding.',
  recorded_beats_vendor: 'A recorded instrument outranks a vendor snapshot.',
  newer_official_beats_older: 'The newer official record supersedes the older one.',
  operator_choice: 'Resolved by an operator.',
  agreement: 'The sources agree.',
}

const day = (iso: string | null) => (iso ? new Date(iso.length <= 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null)

function supportOf(f: FindingView | null, src: SourceRef | null, cls: EvidenceClass, asOf: string | null): string[] {
  const out: string[] = []
  out.push(`${EVIDENCE_CLASS_META[cls].label}${src ? ` · ${src.name}` : ''}`)
  const when = day(asOf ?? f?.observed_at ?? null)
  if (when) out.push(`As of ${when}`)
  if (f?.retrieved_at) out.push(`Retrieved ${day(f.retrieved_at)}`)
  if (f && f.confidence > 0) out.push(`Confidence ${f.confidence.toFixed(2)} (${f.confidence_band})`)
  if (f && f.freshness_state !== 'fresh') out.push(f.freshness_state === 'stale' ? 'Stale' : f.freshness_state === 'aging' ? 'Ageing' : 'Never refreshed')
  if (f?.citation) out.push(f.citation)
  return out
}

export function analyzeConflict(c: ConflictView, view: ResearchView, sources: Record<string, SourceRef>): ConflictAnalysis {
  const members = c.members.map((id) => view.findings[id] ?? null)
  const present = members.filter((f): f is FindingView => Boolean(f))
  const agree = c.rule === 'agreement'
  // decisive: the server named a best-supported claim, or (fixtures) resolved by rule with exactly one standing member
  const serverPick = c.best_supported?.finding_id ?? null
  const standing = present.filter((f) => !f.contradicted_by)
  const resolvedByServer = c.resolution_state === 'resolved_by_rule' || c.resolution_state === 'resolved_by_operator'
  const preferredId = agree ? null : serverPick ?? (resolvedByServer && standing.length === 1 && c.members.length > 1 ? standing[0].finding_id : null)
  const decisive = Boolean(preferredId)

  const claims: ConflictClaim[] = c.members.map((id, i) => {
    const f = members[i]
    const ref = c.claims?.[id] ?? null
    const srcId = f?.source_id ?? ref?.source_id ?? null
    const src = srcId ? sources[srcId] ?? (ref?.source_name ? toSourceRef({ source_id: srcId, name: ref.source_name, source_class: ref.source_class }) : null) : null
    const cls = f ? evidenceClassOf(f, src) : ref?.source_class && ref.source_class in SERVER_CLASS ? SERVER_CLASS[ref.source_class as EvidenceSourceClass] : 'derived'
    const role: ConflictClaim['role'] = agree ? 'agreeing' : preferredId ? (id === preferredId ? 'preferred' : 'overruled') : 'competing'
    return { finding_id: id, finding: f, text: ref?.claim ?? f?.display_value ?? '—', source: src, cls, role, support: supportOf(f, src, cls, ref?.as_of ?? null) }
  })
  const order: Record<EvidenceClass, number> = { official: 0, internal: 1, vendor: 2, derived: 3, unavailable: 4 }
  claims.sort((a, b) => (a.role === 'preferred' ? -1 : b.role === 'preferred' ? 1 : order[a.cls] - order[b.cls]))
  const preferred = claims.find((x) => x.role === 'preferred') ?? null

  const uncertainty: string[] = []
  const follow_up: string[] = []
  if (c.remaining_uncertainty) uncertainty.push(c.remaining_uncertainty)
  if (c.follow_up) follow_up.push(c.follow_up)
  const pf = preferred?.finding ?? null
  if (pf) {
    if (pf.freshness_state !== 'fresh') uncertainty.push(`The preferred record is ${pf.freshness_state === 'stale' ? 'stale' : 'ageing'} — it may have changed since retrieval.`)
    if (pf.confidence < 0.8) uncertainty.push(`Confidence in the preferred record is ${pf.confidence.toFixed(2)}, below the 0.80 “high” band.`)
  } else if (!agree && !c.remaining_uncertainty) {
    const classes = [...new Set(claims.map((x) => x.cls))]
    if (classes.length === 1) uncertainty.push(`Every claim is ${EVIDENCE_CLASS_META[classes[0]].label.toLowerCase()}; none outranks the others.`)
    if (present.some((x) => x.freshness_state !== 'fresh')) uncertainty.push('At least one claim is past or near its freshness window.')
  }
  if (!uncertainty.length && !agree) uncertainty.push(decisive ? 'None beyond the preferred source’s own limitations.' : 'Both claims are held; nothing is promoted while the conflict is open.')

  // follow-up from the run itself (questions waiting, blocked or unavailable reads of the same type)
  const pid = c.property_id ?? present[0]?.property_id ?? null
  const related = view.tasks.filter((t: TaskRow) => t.finding_type === c.finding_type && (!pid || t.property_id === pid))
  for (const t of related) {
    if (t.state === 'needs_input' && t.question) follow_up.push(`Answer: ${t.question}`)
    if (t.state === 'blocked') follow_up.push(t.alternatives.length ? `Blocked source — continue via ${t.alternatives.join(' · ')}` : `Blocked source (${t.label}) — check it manually`)
    if (t.state === 'unavailable' || t.state === 'failed') follow_up.push(`Re-check when available: ${t.label}`)
  }
  if (!decisive && !agree && !follow_up.length) follow_up.push(claims.some((x) => x.cls === 'official') ? 'Operator review: decide which record governs, with the citations above.' : `Pull the official ${findingTypeLabel(c.finding_type).toLowerCase()} record for this parcel.`)

  let unresolved_reason: string | null = null
  if (!decisive && !agree) {
    if (c.reason) unresolved_reason = c.reason
    else if (c.resolution_state === 'open') unresolved_reason = c.rule && CONFLICT_RULE_LABEL[c.rule] && c.rule !== 'agreement'
      ? `A ranking rule exists (${CONFLICT_RULE_LABEL[c.rule].replace(/\.$/, '')}), but the server has not applied it — the evidence is not yet decisive.`
      : 'No rule ranks these sources for this finding, so neither claim is preferred.'
    else unresolved_reason = standing.length ? `${standing.length} claims still stand uncontradicted.` : 'Every claim is contradicted; nothing stands.'
  }

  return {
    id: c.conflict_group_id,
    finding_type: c.finding_type,
    label: findingTypeLabel(c.finding_type),
    status: agree ? 'agree' : decisive ? 'resolved' : 'unresolved',
    claims,
    conclusion: preferred ? { finding_id: preferred.finding_id, text: c.best_supported?.claim ?? preferred.text, reason: c.reason ?? CONFLICT_RULE_LABEL[c.rule] ?? `Resolved by rule “${c.rule}”.` } : null,
    unresolved_reason,
    uncertainty: [...new Set(uncertainty)],
    follow_up: [...new Set(follow_up)],
    opened_event_id: c.opened_event_id,
    event_id: c.event_id,
  }
}

export function conflictsFor(view: ResearchView, sources: Record<string, SourceRef>, propertyId: string | null): ConflictAnalysis[] {
  return Object.values(view.conflicts)
    .filter((c) => !propertyId || c.property_id === propertyId || c.members.some((m) => view.findings[m]?.property_id === propertyId))
    .map((c) => analyzeConflict(c, view, sources))
    .sort((a, b) => (a.status === 'unresolved' ? -1 : 1) - (b.status === 'unresolved' ? -1 : 1) || a.opened_event_id - b.opened_event_id)
}
