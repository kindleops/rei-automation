/**
 * Pairing screen (§6, §61). The TV never types a credential: it shows a short
 * code; a signed-in operator enters it in Settings → Displays. The code
 * renews itself when it expires; polling runs only while this screen is up.
 *
 * QR code: not shown — it would need a new dependency (owner approval pending).
 */
import { useEffect, useRef, useState } from 'react'
import { PAIRING_KEY, WallHttpError, type WallApi } from './wall-api'
import type { WallSession } from './wall-types'

interface Pending { pairing_id: string; code: string; poll_secret: string; expires_at: string; poll_interval_ms: number }

function loadPending(): Pending | null {
  try {
    const p = JSON.parse(window.sessionStorage.getItem(PAIRING_KEY) || 'null') as Pending | null
    return p && Date.parse(p.expires_at) > Date.now() + 15_000 ? p : null
  } catch { return null }
}
function savePending(p: Pending | null) {
  try { if (p) window.sessionStorage.setItem(PAIRING_KEY, JSON.stringify(p)); else window.sessionStorage.removeItem(PAIRING_KEY) } catch { /* private mode */ }
}

export function WallPairing({ api, client, onPaired }: { api: WallApi; client: Record<string, unknown>; onPaired: (s: WallSession) => void }) {
  const [pending, setPending] = useState<Pending | null>(() => (typeof window === 'undefined' ? null : loadPending()))
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const pairedRef = useRef(false)

  // obtain a code (and renew it when it expires)
  useEffect(() => {
    if (pending && Date.parse(pending.expires_at) > Date.now() + 5_000) return undefined
    let live = true
    let retry: ReturnType<typeof setTimeout> | null = null
    const go = async () => {
      try {
        const p = await api.pairStart(client)
        if (!live) return
        savePending(p)
        setProblem(null)
        setPending(p)
      } catch (error) {
        if (!live) return
        const e = error instanceof WallHttpError ? error : null
        setProblem(e?.unprovisioned ? 'Display pairing is not enabled on this server yet.' : e?.status === 429 ? 'Too many pairing attempts. Trying again shortly…' : 'Can’t reach LeadCommand. Retrying…')
        retry = setTimeout(go, e?.unprovisioned ? 5 * 60_000 : Math.max(15_000, e?.retryAfterMs ?? 0))
      }
    }
    void go()
    return () => { live = false; if (retry) clearTimeout(retry) }
  }, [api, client, pending])

  // poll for the operator's claim
  useEffect(() => {
    if (!pending) return undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      setNow(Date.now())
      if (Date.parse(pending.expires_at) <= Date.now()) { savePending(null); setPending(null); return }
      try {
        const out = await api.pairPoll({ pairing_id: pending.pairing_id, poll_secret: pending.poll_secret })
        if (!live) return
        if (out.paired && !pairedRef.current) {
          pairedRef.current = true
          savePending(null)
          onPaired(out.display)
          return
        }
      } catch (error) {
        const e = error instanceof WallHttpError ? error : null
        if (e && (e.status === 410 || e.status === 404)) { savePending(null); setPending(null); return }
      }
      if (live) timer = setTimeout(tick, pending.poll_interval_ms || 4_000)
    }
    timer = setTimeout(tick, 1_500)
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [api, pending, onPaired])

  const minutes = pending ? Math.max(0, Math.ceil((Date.parse(pending.expires_at) - now) / 60_000)) : null
  return (
    <div className="cw-pair">
      <div className="cw-pair__card">
        <div className="cw-pair__brand"><img src="/favicon.svg" alt="" /> LeadCommand <span>·</span> Command Wall</div>
        <div className="cw-pair__k">Pair this display</div>
        <div className="cw-pair__code" aria-live="polite">{pending ? pending.code.split('').map((ch, i) => <span key={i} className={ch === '-' ? 'is-dash' : ''}>{ch === '-' ? '–' : ch}</span>) : <span className="cw-pair__wait">· · · ·</span>}</div>
        <div className="cw-pair__how">On your computer, open <b>Settings → Displays → Add display</b> and enter this code.</div>
        <div className="cw-pair__meta">{problem ? problem : minutes !== null ? `Code renews in ${minutes} min · single use` : 'Requesting a code…'}</div>
      </div>
    </div>
  )
}
