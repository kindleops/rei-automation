// Provenance vocabulary. Every value group a tool returns carries ONE of:
//
//   fact     read verbatim from a LeadCommand record or a recorded document
//   derived  computed by an existing LeadCommand rule from facts (rule named)
//   inferred a probabilistic / heuristic link (rule named, never presented as fact)
//   missing  the source has no value — NEVER rendered as 0, false or "none"
//   stale    a value exists but its source date is older than the freshness window
//
// plus { source, as_of, rule?, reason?, window_days? }.
import { z } from 'zod/v4'

export const PROVENANCE_KINDS = Object.freeze(['fact', 'derived', 'inferred', 'missing', 'stale'])

export const ProvenanceSchema = z.object({
  kind: z.enum(PROVENANCE_KINDS),
  source: z.string().max(200),
  as_of: z.string().max(40).nullable(),
  rule: z.string().max(120).nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
  window_days: z.number().int().nullable().optional(),
}).strict()

const iso = (v) => {
  if (!v) return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * Build a provenance block. A value older than window_days becomes `stale`
 * (kind 'fact'/'derived' only); an absent value becomes `missing`.
 */
export function prov({ kind = 'fact', source, as_of = null, rule = null, reason = null, window_days = null, present = true, now = new Date() }) {
  const at = iso(as_of)
  if (!present) return { kind: 'missing', source, as_of: at, rule, reason: reason || 'no_value_in_source', window_days }
  if ((kind === 'fact' || kind === 'derived') && at && window_days != null) {
    const ageDays = (now.getTime() - Date.parse(at)) / 86_400_000
    if (ageDays > window_days) return { kind: 'stale', source, as_of: at, rule, reason: reason || `older_than_${window_days}_days`, window_days }
  }
  return { kind, source, as_of: at, rule, reason, window_days }
}

export const missing = (source, reason) => ({ kind: 'missing', source, as_of: null, rule: null, reason, window_days: null })
