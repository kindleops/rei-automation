/**
 * Rate limits for pass-through stills (TxDOT, internal use): per operator and
 * one small global cap, over a sliding 60 s window. Only request timestamps
 * are held — never an image. An operator opening a preview and pressing
 * Refresh a few times stays well inside; anything faster is refused (429).
 */
import { createHash } from 'node:crypto'

export const PASSTHROUGH_LIMITS = Object.freeze({ windowMs: 60_000, perOperator: 8, global: 40 })

const hits = new Map() // key → number[] (ms)
let globalHits = []

export function _resetSnapshotLimits() { hits.clear(); globalHits = [] }

/** A stable, non-reversible operator key: the session credential if any, else the client address. */
export function operatorKeyFor(request) {
  const h = (k) => request?.headers?.get?.(k) || ''
  const cookie = request?.cookies?.get?.('ops_dashboard_session')?.value || ''
  const cred = h('authorization') || cookie || h('x-ops-dashboard-secret')
  const basis = cred ? `cred:${cred}` : `ip:${(h('x-forwarded-for').split(',')[0] || h('x-real-ip') || 'unknown').trim()}`
  return createHash('sha256').update(basis).digest('hex').slice(0, 20)
}

/** { ok:true } and records the hit, or { ok:false, retry_after_sec, scope }. */
export function takePassthroughSlot(key, now = Date.now(), limits = PASSTHROUGH_LIMITS) {
  const since = now - limits.windowMs
  globalHits = globalHits.filter((t) => t > since)
  const mine = (hits.get(key) || []).filter((t) => t > since)
  if (mine.length >= limits.perOperator) {
    hits.set(key, mine)
    return { ok: false, scope: 'operator', retry_after_sec: Math.max(1, Math.ceil((mine[0] + limits.windowMs - now) / 1000)) }
  }
  if (globalHits.length >= limits.global) {
    return { ok: false, scope: 'global', retry_after_sec: Math.max(1, Math.ceil((globalHits[0] + limits.windowMs - now) / 1000)) }
  }
  mine.push(now)
  globalHits.push(now)
  hits.set(key, mine)
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some((t) => t > since)) hits.delete(k)
  return { ok: true }
}
