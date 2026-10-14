// Read-only listing of shadow decision records for the operator panel.
import { OUTCOMES } from './contract.js'

export const SHADOW_TABLE = 'conversation_ai_shadow_decisions'

/** @returns {Promise<{ ok: boolean, available: boolean, records: object[], code?: string }>} */
export async function listShadowRecords({ supabase, limit = 50, outcome = null }) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200)
  if (!supabase?.from) return { ok: false, available: false, records: [], code: 'NO_CLIENT' }
  try {
    let q = supabase.from(SHADOW_TABLE).select('record,created_at').order('created_at', { ascending: false }).limit(n)
    if (outcome && OUTCOMES.includes(outcome)) q = q.eq('outcome', outcome)
    const r = await q
    if (r?.error) {
      // 42P01 / PGRST205: the PROPOSED table is not applied yet
      const missing = /42P01|PGRST205|does not exist|schema cache/i.test(`${r.error.code || ''} ${r.error.message || ''}`)
      return { ok: missing, available: false, records: [], code: missing ? 'SHADOW_TABLE_NOT_APPLIED' : 'SHADOW_READ_FAILED' }
    }
    return { ok: true, available: true, records: (r.data || []).map((x) => x.record).filter(Boolean) }
  } catch {
    return { ok: false, available: false, records: [], code: 'SHADOW_READ_FAILED' }
  }
}
