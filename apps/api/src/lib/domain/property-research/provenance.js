// ─── PROPERTY RESEARCH — PROVENANCE CONTRACT (8.5.20-b) ──────────────────────
// Every important input in a property dossier, comp set, area brief or offer plan
// is a FIELD:
//
//   { value, source, as_of, confidence, kind }
//
//   value       the datum (number | string | boolean | object | null — null = unknown,
//               never a guess; unknown is unknown, it is never 0 or "none")
//   source      where it came from: '<schema>.<table>[.<column>]', 'engine:<name>',
//               'web:<host>' or 'seller:<message ref>'. Never empty.
//   as_of       ISO date/time the source was observed / computed / recorded, or null
//               when the source carries no date (then confidence is capped at 0.6)
//   confidence  0..1
//   kind        recorded      a public-record / MLS / internal record fact
//               derived       computed deterministically from recorded fields by an
//                             existing engine (lane, MAO, medians …)
//               inferred      model- or heuristic-inferred (web answer, text parse)
//               seller_stated what the seller said in the thread (fact ledger)
//
// A dossier is VALID only when every field obeys this contract (validateDossier).
// Listings are never sales: evidence items carry evidence_kind 'sale' | 'listing'
// and only 'sale' items may feed a value (see comps-area.js).
export const PROVENANCE_VERSION = 'property-research.provenance.v1'
export const FIELD_KINDS = Object.freeze(['recorded', 'derived', 'inferred', 'seller_stated'])
export const UNDATED_CONFIDENCE_CAP = 0.6

const isoOrNull = (v) => {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(Number(n)) ? Number(n) : 0))

/**
 * Build one provenance field. A null/undefined value stays null (unknown) and its
 * confidence is 0 — an absent fact is never presented as known.
 */
export function field(value, { source, as_of = null, confidence = 0.5, kind = 'recorded' } = {}) {
  if (!source || typeof source !== 'string') throw Object.assign(new Error('PROVENANCE_SOURCE_REQUIRED'), { code: 'PROVENANCE_SOURCE_REQUIRED' })
  if (!FIELD_KINDS.includes(kind)) throw Object.assign(new Error(`PROVENANCE_KIND_INVALID:${kind}`), { code: 'PROVENANCE_KIND_INVALID' })
  const v = value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value
  const at = isoOrNull(as_of)
  let c = v == null ? 0 : clamp01(confidence)
  if (at == null) c = Math.min(c, UNDATED_CONFIDENCE_CAP)
  return Object.freeze({ value: v, source: source.slice(0, 160), as_of: at, confidence: Math.round(c * 1000) / 1000, kind })
}

/** True when `f` has exactly the provenance shape. */
export function isField(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false
  const keys = Object.keys(f).sort().join(',')
  if (keys !== 'as_of,confidence,kind,source,value') return false
  if (typeof f.source !== 'string' || !f.source) return false
  if (!FIELD_KINDS.includes(f.kind)) return false
  if (!(typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1)) return false
  if (f.as_of !== null && !Number.isFinite(Date.parse(f.as_of))) return false
  if (f.value == null && f.confidence !== 0) return false
  if (f.as_of == null && f.confidence > UNDATED_CONFIDENCE_CAP) return false
  return true
}

/**
 * Walk a section map ({ section: { name: field } }) and report every violation.
 * @returns {{ ok: boolean, violations: string[], fields: number, known: number }}
 */
export function validateFieldMap(sections = {}) {
  const violations = []
  let fields = 0
  let known = 0
  for (const [sec, map] of Object.entries(sections || {})) {
    if (!map || typeof map !== 'object') { violations.push(`${sec}:not_an_object`); continue }
    for (const [name, f] of Object.entries(map)) {
      fields += 1
      if (!isField(f)) violations.push(`${sec}.${name}:not_a_provenance_field`)
      else if (f.value != null) known += 1
    }
  }
  return { ok: violations.length === 0, violations, fields, known }
}

/** Coverage = known / total fields per section (honest evidence coverage). */
export function coverage(sections = {}) {
  const out = {}
  let t = 0
  let k = 0
  for (const [sec, map] of Object.entries(sections || {})) {
    const fs = Object.values(map || {})
    const kn = fs.filter((f) => f?.value != null).length
    out[sec] = { known: kn, total: fs.length, share: fs.length ? Math.round((kn / fs.length) * 1000) / 1000 : 0 }
    t += fs.length
    k += kn
  }
  return { by_section: out, known: k, total: t, share: t ? Math.round((k / t) * 1000) / 1000 : 0 }
}
