import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { subscribeKey } from '../lib/resource'
import type { LiveResponse, SystemMapResponse, Traversal } from '../lib/types'
import type { Pulse } from './GraphCanvas'

/**
 * ONE EVENT · ONE PULSE · THEN REST.
 *
 * Pulses come only from evidence that arrived since the last read: a recorded
 * traversal (live) or a measured increase in an edge's traffic (system map).
 * The first read of any source is history — it never animates. Reduced motion
 * replaces travel with an instant edge highlight that fades.
 */

const toneOf = (status: string): Pulse['tone'] => (status === 'failed' ? 'crit' : ['held', 'blocked', 'human', 'needs_review'].includes(status) ? 'attn' : ['waiting', 'current', 'running'].includes(status) ? 'exec' : 'ok')
const tid = (t: Traversal) => `${t.run_id}:${t.edge_id}:${t.at}`

export interface PulseState { pulses: Pulse[]; flash: ReadonlySet<string>; arrived: ReadonlySet<string>; done: (id: string) => void }

export function useTraversalPulses(liveKey: string | null, workflowKey: string, reduced: boolean, mapEdge: (topologyEdgeId: string) => string | null): PulseState {
  const [pulses, setPulses] = useState<Pulse[]>([])
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set())
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set())
  const map = useRef(mapEdge)
  useLayoutEffect(() => { map.current = mapEdge })

  useEffect(() => {
    if (!liveKey) return
    const seen = new Set<string>()
    let primed = false
    let flashT = 0
    let arriveT = 0
    const off = subscribeKey<LiveResponse>(liveKey, (snap) => {
      if (!snap.data) return
      const list = (snap.data.traversals || []).filter((t) => t.workflow_key === workflowKey)
      const fresh = list.filter((t) => !seen.has(tid(t)))
      for (const t of list) seen.add(tid(t))
      if (!primed) { primed = true; return }
      if (!fresh.length) return
      const batch = fresh.slice(-24)
      const edges = batch.map((t) => ({ t, edge: map.current(t.edge_id) })).filter((x): x is { t: Traversal; edge: string } => Boolean(x.edge))
      if (reduced) {
        setFlash(new Set(edges.map((x) => x.edge)))
        window.clearTimeout(flashT)
        flashT = window.setTimeout(() => setFlash(new Set()), 1400)
      } else {
        // recorded order, compressed into a short sequence: the order is real, the spacing is presentation
        setPulses((cur) => [...cur, ...edges.map((x, i) => ({ id: `${tid(x.t)}:${Date.now()}`, edge: x.edge, tone: toneOf(x.t.status), delay: Math.min(i * 140, 2400) }))].slice(-80))
      }
      setArrived(new Set(batch.map((t) => t.to)))
      window.clearTimeout(arriveT)
      arriveT = window.setTimeout(() => setArrived(new Set()), 1800)
    })
    return () => { off(); window.clearTimeout(flashT); window.clearTimeout(arriveT) }
  }, [liveKey, reduced, workflowKey])

  const done = useCallback((id: string) => setPulses((cur) => cur.filter((p) => p.id !== id)), [])
  return { pulses, flash, arrived, done }
}

/** System map: a measured increase in an edge's traffic since the last read → up to three pulses. */
export function useTrafficPulses(mapKey: string | null, reduced: boolean): PulseState {
  const [pulses, setPulses] = useState<Pulse[]>([])
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set())
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!mapKey) return
    let prev: Map<string, number> | null = null
    let flashT = 0
    let arriveT = 0
    const off = subscribeKey<SystemMapResponse>(mapKey, (snap) => {
      if (!snap.data) return
      const now = new Map(snap.data.edges.map((e) => [e.id, e.traffic.count ?? 0]))
      const before = prev
      prev = now
      if (!before) return
      const grew = snap.data.edges.filter((e) => (e.traffic.count ?? 0) > (before.get(e.id) ?? 0))
      if (!grew.length) return
      if (reduced) {
        setFlash(new Set(grew.map((e) => e.id)))
        window.clearTimeout(flashT)
        flashT = window.setTimeout(() => setFlash(new Set()), 1400)
      } else {
        const stamp = Date.now()
        const next: Pulse[] = []
        grew.forEach((e, i) => {
          const n = Math.min(3, (e.traffic.count ?? 0) - (before.get(e.id) ?? 0))
          for (let j = 0; j < n; j++) next.push({ id: `${e.id}:${stamp}:${j}`, edge: e.id, tone: e.kind === 'external' ? 'exec' : e.kind === 'subworkflow' ? 'flow' : 'exec', delay: Math.min(i * 90 + j * 220, 2200) })
        })
        setPulses((cur) => [...cur, ...next].slice(-60))
      }
      setArrived(new Set(grew.map((e) => e.to)))
      window.clearTimeout(arriveT)
      arriveT = window.setTimeout(() => setArrived(new Set()), 1800)
    })
    return () => { off(); window.clearTimeout(flashT); window.clearTimeout(arriveT) }
  }, [mapKey, reduced])
  const done = useCallback((id: string) => setPulses((cur) => cur.filter((p) => p.id !== id)), [])
  return { pulses, flash, arrived, done }
}
