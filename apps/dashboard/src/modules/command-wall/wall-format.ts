/** Command Wall display formatting (TV distance: short, tabular, honest). */
import type { WallPart, WallState } from './wall-types'

export const fmtInt = (n: number | null | undefined) => (Number.isFinite(n) ? Math.round(n as number).toLocaleString('en-US') : '—')
export const fmtUsdK = (n: number | null | undefined) => (Number.isFinite(n) ? ((n as number) >= 1_000_000 ? `$${((n as number) / 1_000_000).toFixed(2)}M` : `$${Math.round((n as number) / 1000)}K`) : '—')
export const fmtPct = (n: number | null | undefined) => (Number.isFinite(n) ? `${Math.round((n as number) * 100)}%` : '—')

export function ageLabel(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return null
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

export interface RailCell { key: string; label: string; value: string; note: string | null; state: 'ok' | 'stale' | 'unavailable'; tone?: 'ok' | 'attn' | 'crit' | null }

const partState = (p: WallPart<unknown> | undefined | null): RailCell['state'] => (!p || p.status === 'unavailable' ? 'unavailable' : p.status === 'stale' ? 'stale' : 'ok')

/** Rail cells (§22, §57): "Unavailable", never 0; "Updated N min ago" when stale. */
export function railCells(state: WallState | null, keys: string[], now: number, staleAfterMs = 3 * 60_000): RailCell[] {
  const s = state
  const cell = (key: string, label: string, part: WallPart<unknown> | null | undefined, value: () => string, tone: RailCell['tone'] = null): RailCell => {
    let st = partState(part)
    const asOf = part && part.status !== 'unavailable' ? part.as_of : null
    if (st === 'ok' && asOf && now - Date.parse(asOf) > staleAfterMs) st = 'stale'
    return { key, label, value: st === 'unavailable' ? '—' : value(), note: st === 'unavailable' ? 'Unavailable' : st === 'stale' ? `Updated ${ageLabel(asOf, now) ?? 'earlier'}` : null, state: st, tone }
  }
  const m = s?.metrics
  const out: RailCell[] = []
  for (const k of keys) {
    if (k === 'sent') out.push(cell('sent', 'Sent today', m, () => fmtInt(m && m.status !== 'unavailable' ? m.sent : null)))
    else if (k === 'replies') out.push(cell('replies', 'Replies', m, () => fmtInt(m && m.status !== 'unavailable' ? m.replies : null)))
    else if (k === 'positive') out.push(cell('positive', 'Positive', m, () => fmtInt(m && m.status !== 'unavailable' ? m.positive : null)))
    else if (k === 'offers') out.push(cell('offers', 'Offers', s?.offers, () => fmtInt(s?.offers && s.offers.status !== 'unavailable' ? s.offers.today : null)))
    else if (k === 'campaigns') {
      const ok = s && s.campaigns_status !== 'unavailable'
      const n = s ? s.campaigns.filter((c) => c.status === 'active').length : null
      out.push({ key: 'campaigns', label: 'Active campaigns', value: ok ? fmtInt(n) : '—', note: ok ? null : 'Unavailable', state: ok ? 'ok' : 'unavailable' })
    } else if (k === 'queue') {
      const q = s?.queue
      const label = q && q.status !== 'unavailable' ? ({ idle: 'Idle', healthy: 'Healthy', attention: 'Attention', delayed: 'Delayed' } as const)[q.state] : '—'
      // a delayed queue is attention (amber); red is reserved for true blockers (Signal: queue stalled)
      const tone = q && q.status !== 'unavailable' ? (q.state === 'delayed' || q.state === 'attention' ? 'attn' : null) : null
      out.push(cell('queue', 'Queue', q, () => label, tone as RailCell['tone']))
    } else if (k === 'senders') {
      const f = s?.fleet
      out.push(cell('senders', 'Senders online', f, () => (f && f.status !== 'unavailable' ? `${f.online}/${f.total}` : '—')))
    }
  }
  return out
}

export function resolutionClass(innerHeight: number, dpr: number): 'hd' | 'qhd' | 'uhd' {
  const px = innerHeight * (dpr || 1)
  if (px >= 1900) return 'uhd'
  if (px >= 1300) return 'qhd'
  return 'hd'
}
