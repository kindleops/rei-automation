// UNIFIED MESSAGE-ORIGIN CONTRACT (8.5.16, owner directive 2026-10-15).
//
//   template         copy rendered from a real public.sms_templates row (template_id required)
//   ai_generated     original text written by the conversation engine; NO template id; an
//                    immutable public.ai_generated_messages record (body hash) is required
//   operator_manual  words an operator typed (composer / send now)
//
// send_queue.message_origin (PROPOSED column) is written ONLY by the AI path. Every existing
// producer leaves it NULL and is read through the LEGACY derivation below, so no existing
// row, writer or campaign payload changes.
import { isManualInboxSend } from '@/lib/domain/queue/is-manual-inbox-send.js'

export const MESSAGE_ORIGINS = Object.freeze(['template', 'ai_generated', 'operator_manual'])
export const MESSAGE_ORIGIN_VERSION = 'message-origin.v1'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

/** The stored origin (column first, then metadata), or null when the row predates the contract. */
export function storedMessageOrigin(row = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const v = lower(row?.message_origin) || lower(meta.message_origin)
  return MESSAGE_ORIGINS.includes(v) ? v : null
}

/**
 * The origin of any send_queue row. Stored origin wins; otherwise the legacy derivation:
 * manual composer / send-now rows are operator_manual, everything else is template.
 * @returns {{ origin: string, basis: 'stored'|'legacy_manual'|'legacy_template' }}
 */
export function resolveMessageOrigin(row = {}) {
  const stored = storedMessageOrigin(row)
  if (stored) return { origin: stored, basis: 'stored' }
  if (isManualInboxSend(row) || lower(row?.template_source) === 'manual_composer') return { origin: 'operator_manual', basis: 'legacy_manual' }
  return { origin: 'template', basis: 'legacy_template' }
}

export function isAiGeneratedOrigin(row = {}) {
  return storedMessageOrigin(row) === 'ai_generated'
}
