// Shared adapter helpers. Adapters REUSE the existing agent / domain modules
// (projections, rules, services); this file only holds value coercion, the
// untrusted-text sanitizer and source-read error mapping.
import { err } from '../errors.mjs'

export const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
export const clean = (v) => (v == null ? null : String(v).trim() || null)
export const bool = (v) => (v === null || v === undefined || v === '' ? null : v === true || /^(true|t|yes|y|1)$/i.test(String(v)))
export const isoOrNull = (v) => {
  if (!v) return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
export const dayOrNull = (v) => (isoOrNull(v) ? isoOrNull(v).slice(0, 10) : null)

// control chars, zero-width, bidi overrides: stripped from untrusted text so it
// cannot hide content from a reviewer or fake structure in a transcript
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g

/**
 * Untrusted text (imported metadata, operator-entered names, vendor labels):
 * returned ONLY as a data value, sanitized and length-capped. Its path is
 * listed in the result's `untrusted_fields`.
 */
export function untrusted(v, max = 160) {
  const s = clean(v)
  if (!s) return null
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').slice(0, max)
}

/** A PostgREST read: error → typed gateway error (no upstream text forwarded). */
export async function read(query, what) {
  let res
  try {
    res = await query
  } catch (e) {
    if (e?.errorClass) throw e
    if (e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))) throw err('timeout', `${what}: read aborted at the time budget`, { code: 'SOURCE_TIMEOUT' })
    throw err('data_unavailable', `${what}: read failed`, { code: 'SOURCE_UNAVAILABLE' })
  }
  const { data, error, count } = res || {}
  if (error) {
    const code = String(error.code || '')
    if (code === 'PGRST205' || code === '42P01') throw err('data_unavailable', `${what} is not available in this database`, { code: 'SOURCE_NOT_APPLIED' })
    if (code === '57014') throw err('timeout', `${what}: statement timeout`, { code: 'SOURCE_TIMEOUT' })
    throw err('data_unavailable', `${what}: read failed`, { code: 'SOURCE_UNAVAILABLE' })
  }
  return { rows: Array.isArray(data) ? data : data ? [data] : [], count: count ?? null }
}

export const PROPERTY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/

const RPC_NOT_APPLIED = new Set(['PGRST202', '42883', '42P01', '42703', '3F000'])
/**
 * A read RPC through PostgREST (supabase-js rpc): error → typed gateway error, no upstream text.
 * A source the database does not have yet (function / table / column / schema missing) is
 * SOURCE_NOT_APPLIED; 22023 is the function refusing an out-of-bound input.
 */
export async function readRpc(query, what) {
  let res
  try {
    res = await query
  } catch (e) {
    if (e?.errorClass) throw e
    if (e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))) throw err('timeout', `${what}: read aborted at the time budget`, { code: 'SOURCE_TIMEOUT' })
    throw err('data_unavailable', `${what}: read failed`, { code: 'SOURCE_UNAVAILABLE' })
  }
  const { data, error } = res || {}
  if (error) {
    const code = String(error.code || '')
    if (RPC_NOT_APPLIED.has(code)) throw err('data_unavailable', `${what} is not available in this database`, { code: 'SOURCE_NOT_APPLIED' })
    if (code === '57014') throw err('timeout', `${what}: statement timeout`, { code: 'SOURCE_TIMEOUT' })
    if (code === '22023') throw err('invalid_input', `${what}: input refused by the read function`, { code: 'SOURCE_INPUT_REFUSED' })
    if (code === '42501') throw err('data_unavailable', `${what}: the read credential may not call it`, { code: 'SOURCE_NOT_PERMITTED' })
    throw err('data_unavailable', `${what}: read failed`, { code: 'SOURCE_UNAVAILABLE' })
  }
  return data ?? null
}
