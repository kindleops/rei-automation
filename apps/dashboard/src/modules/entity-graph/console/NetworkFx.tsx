/**
 * Live FX under the constellation — one canvas, screen-space, DPR-aware.
 *
 *   packets     light travelling along every relationship (owner → out), a
 *               comet with a tail, in the colour of where it is going; lit
 *               (focused) relationships run faster and brighter
 *   shockwaves  the owner hub breathes out a ring every few seconds
 *   sweep       a radar sweep from the hub when a network opens
 *   dust        slow parallax motes, so the field is never dead
 *
 * Reads the stage's view (a ref, updated without React) every frame, so pan
 * and pinch stay perfectly locked. Pauses when the tab is hidden; renders
 * nothing when the operator prefers reduced motion.
 */
import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { NetworkEdge, NetworkNode } from './entity-network-api'
import type { Placed } from './network-layout'

type View = { x: number; y: number; k: number }

const TYPE_VAR: Record<string, string> = {
  owner: '--egx-owner', property: '--egx-property', entity: '--egx-entity', person: '--egx-person',
  phone: '--egx-contact', email: '--egx-contact', mailing: '--egx-mailing', related_owner: '--egx-related', conversation: '--egx-convo',
  mortgage: '--egx-debt', lien: '--egx-lien', sale: '--egx-sale', buyer: '--egx-buyer',
}

function sprite(color: string, size = 48): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const r = size / 2
  const grad = g.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.18, color)
  grad.addColorStop(0.45, color.startsWith('#') ? `${color}55` : color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}

interface Props {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
  placed: Map<string, Placed>
  lit: Set<string> | null
  view: MutableRefObject<View>
  epoch: string
  reducedMotion?: boolean
}

export function NetworkFx({ nodes, edges, placed, lit, view, epoch, reducedMotion }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const state = useRef({ nodes, edges, placed, lit })
  state.current = { nodes, edges, placed, lit }
  const openedAt = useRef(0)

  useEffect(() => { openedAt.current = performance.now() }, [epoch])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || reducedMotion) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const root = canvas.closest('.egx') as HTMLElement | null
    const css = getComputedStyle(root ?? document.documentElement)
    const colorOf = (type: string) => css.getPropertyValue(TYPE_VAR[type] ?? '--egx-property').trim() || '#5ee7ff'
    const sprites = new Map<string, HTMLCanvasElement>()
    const spriteFor = (type: string) => {
      let s = sprites.get(type)
      if (!s) { s = sprite(colorOf(type)); sprites.set(type, s) }
      return s
    }
    const gold = colorOf('owner')
    const light = document.documentElement.getAttribute('data-nexus-theme') === 'light'

    let w = 0, h = 0, dpr = 1
    const resize = () => {
      const r = canvas.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = r.width; h = r.height
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const typeCache = new WeakMap<NetworkNode[], Map<string, string>>()
    const dust = Array.from({ length: 64 }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, s: 0.4 + Math.random() * 1.4, p: Math.random() * Math.PI * 2 }))
    // A packet per edge, phase-staggered so the network never pulses in unison.
    const phase = new Map<string, number>()

    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const { edges: E, nodes: N, placed: P, lit: L } = state.current
      const typeOf = typeCache.get(N) ?? (() => { const m = new Map(N.map((n) => [n.id, n.type])); typeCache.set(N, m); return m })()
      const v = view.current
      const toScreen = (x: number, y: number) => ({ x: v.x + x * v.k, y: v.y + y * v.k })

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'

      // Dust — parallax against the camera.
      for (const d of dust) {
        d.p += dt * 0.4
        const px = ((d.x * w + v.x * 0.06 * d.z + Math.sin(d.p) * 6) % w + w) % w
        const py = ((d.y * h + v.y * 0.06 * d.z + now * 0.004 * d.z) % h + h) % h
        ctx.globalAlpha = (light ? 0.18 : 0.28) * d.z * (0.6 + 0.4 * Math.sin(d.p * 1.7))
        ctx.fillStyle = light ? '#64748b' : '#cfe8ff'
        ctx.beginPath()
        ctx.arc(px, py, d.s, 0, Math.PI * 2)
        ctx.fill()
      }

      const hub = N.find((n) => n.type === 'owner')
      const hp = hub ? P.get(hub.id) : null

      // Opening sweep: a radar arm and a bright front ring, first 1.8s.
      const since = (now - openedAt.current) / 1000
      if (hp && since > 0.02 && since < 1.8) {
        const c = toScreen(hp.x, hp.y)
        const t = since / 1.8
        const rad = Math.max(w, h) * 0.9 * t
        const ang = -Math.PI / 2 + t * Math.PI * 2.2
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad)
        g.addColorStop(0, 'rgba(0,0,0,0)')
        g.addColorStop(0.9, 'rgba(94,231,255,0.12)')
        g.addColorStop(1, 'rgba(94,231,255,0)')
        ctx.globalAlpha = 1 - t
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.moveTo(c.x, c.y)
        ctx.arc(c.x, c.y, rad, ang - 0.9, ang)
        ctx.closePath()
        ctx.fill()
        ctx.globalAlpha = (1 - t) * 0.6
        ctx.strokeStyle = '#5ee7ff'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(c.x, c.y, rad, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Hub shockwaves.
      if (hp) {
        const c = toScreen(hp.x, hp.y)
        for (let i = 0; i < 2; i++) {
          const t = ((now / 3200) + i * 0.5) % 1
          ctx.globalAlpha = (1 - t) * (light ? 0.35 : 0.5)
          ctx.strokeStyle = gold
          ctx.lineWidth = 1.4 * (1 - t) + 0.3
          ctx.beginPath()
          ctx.arc(c.x, c.y, (hp.size / 2 + t * 150) * v.k, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // Packets along edges.
      for (let i = 0; i < E.length; i++) {
        const e = E[i]
        const a = P.get(e.from)
        const b = P.get(e.to)
        if (!a || !b) continue
        const on = L ? L.has(e.from) && L.has(e.to) : false
        if (L && !on && i % 3) continue // with a focus, most of the field goes quiet
        const key = `${e.from}>${e.to}`
        let ph = phase.get(key)
        if (ph === undefined) { ph = Math.random(); phase.set(key, ph) }
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        ph = (ph + dt * (on ? 1.15 : 0.32) * (140 / Math.max(80, len)) * 1.6) % 1
        phase.set(key, ph)
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        const cx = mx - (b.y - a.y) * 0.12, cy = my + (b.x - a.x) * 0.12
        const spr = spriteFor(typeOf.get(e.to) ?? 'property')
        const count = on ? 2 : 1
        for (let k = 0; k < count; k++) {
          const t0 = (ph + k * 0.5) % 1
          for (let tail = 0; tail < 5; tail++) {
            const t = t0 - tail * 0.028
            if (t < 0) continue
            const u = 1 - t
            const x = u * u * a.x + 2 * u * t * cx + t * t * b.x
            const y = u * u * a.y + 2 * u * t * cy + t * t * b.y
            const s = toScreen(x, y)
            const size = (on ? 22 : 15) * (1 - tail * 0.16) * Math.max(0.55, Math.min(1.3, v.k))
            ctx.globalAlpha = (on ? 1 : 0.55) * (1 - tail * 0.2) * Math.sin(Math.PI * t0) * (light ? 0.7 : 1)
            ctx.drawImage(spr, s.x - size / 2, s.y - size / 2, size, size)
          }
        }
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [view, reducedMotion])

  return <canvas ref={ref} className="egx-fx" aria-hidden="true" />
}
