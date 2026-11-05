// Shared zod building blocks (closed schemas; every string bounded).
import { z } from 'zod/v4'
import { ProvenanceSchema, PROVENANCE_KINDS } from '../provenance.mjs'

export const PropertyId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/, 'property_id: letters, digits, _ . : - only').describe('LeadCommand property id (from a search result or a prior call).')
export const Uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'must be a UUID')
export const Zip = z.string().regex(/^[0-9]{5}$/, '5-digit ZIP')
export const State = z.string().regex(/^[A-Za-z]{2}$/, '2-letter state')
export const Label = (max = 60) => z.string().min(1).max(max).regex(/^[A-Za-z0-9 ,.'&/_()-]+$/, 'letters, digits and basic punctuation only')
export const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'YYYY-MM-DD')
export const Limit = (max, dflt) => z.number().int().min(1).max(max).default(dflt).describe(`rows per page (1–${max}, default ${dflt})`)
export const Cursor = z.string().min(10).max(400).describe('opaque next_cursor from the previous page (bound to the same filters)')

export const Prov = ProvenanceSchema
export const ProvKind = z.enum(PROVENANCE_KINDS)

export const Page = z.object({
  limit: z.number().int(),
  returned: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  truncated_for_size: z.boolean().optional(),
}).strict()

/** Result envelope shared by every tool; `result` is the tool payload. */
export function envelope(result, { paged = false } = {}) {
  return z.object({
    tool: z.string(),
    data_mode: z.enum(['live', 'fixture']),
    fixture_notice: z.string().nullable(),
    correlation_id: z.string(),
    generated_at: z.string(),
    trust: z.object({ content: z.literal('data_only'), note: z.string() }).strict(),
    untrusted_fields: z.array(z.string()),
    result,
    ...(paged ? { page: Page } : {}),
  }).strict()
}

export const N = z.number().nullable()
export const S = z.string().nullable()
export const B = z.boolean().nullable()
export const loose = z.record(z.string(), z.any())
