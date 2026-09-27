/**
 * The landing's living constellation: a gold owner core, three orbits of
 * glass nodes in the relationship colours, threads to the core, and light
 * running inward along them. Pure decoration — pointer-events none, paused
 * when hidden, absent under reduced motion.
 */
import { useEffect, useRef } from 'react'

const TONES = ['#5ee7ff', '#a98bff', '#3ee6a4', '#ffb35c', '#ff7a9c', '#7cc4ff']

export function LandingFx() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const light = document.documentElement.getAttribute('data-nexus-theme') === 'light'
    let w = 0, h = 0, dpr = 1
    const resize = () => { const r = canvas.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1); w = r.width; h = r.height; canvas.width = w * dpr; canvas.height = h * dpr }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(canvas)
    const nodes = Array.from({ length: 26 }, (_, i) => ({ ring: i % 3, a: Math.random() * Math.PI * 2, s: (0.08 + Math.random() * 0.12) * (i % 2 ? 1 : -1), r: 2 + Math.random() * 3.2, tone: TONES[i % TONES.length], p: Math.random() }))
    let raf = 0
    let last = performance.now()
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden) return
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const cx = w * 0.8, cy = h * 0.16
      const R = [w * 0.16, w * 0.27, w * 0.38]
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
      for (const r of R) { ctx.globalAlpha = light ? 0.12 : 0.1; ctx.strokeStyle = light ? '#334155' : '#9fd8ff'; ctx.setLineDash([2, 6]); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke() }
      ctx.setLineDash([])
      for (const n of nodes) {
        n.a += n.s * dt * 0.5
        n.p = (n.p + dt * 0.35) % 1
        const x = cx + Math.cos(n.a) * R[n.ring], y = cy + Math.sin(n.a) * R[n.ring] * 0.62
        const g = ctx.createLinearGradient(cx, cy, x, y)
        g.addColorStop(0, 'rgba(247,199,91,0.35)'); g.addColorStop(1, n.tone + '40')
        ctx.globalAlpha = 0.7; ctx.strokeStyle = g; ctx.lineWidth = 0.8
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke()
        const t = n.p, px = x + (cx - x) * t, py = y + (cy - y) * t
        ctx.globalAlpha = Math.sin(Math.PI * t) * 0.9; ctx.fillStyle = n.tone
        ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill()
        const halo = ctx.createRadialGradient(x, y, 0, x, y, n.r * 4)
        halo.addColorStop(0, n.tone); halo.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = 0.5; ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, n.r * 4, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 1; ctx.fillStyle = light ? n.tone : '#ffffff'; ctx.beginPath(); ctx.arc(x, y, n.r * 0.55, 0, Math.PI * 2); ctx.fill()
      }
      const pulse = 0.5 + 0.5 * Math.sin(now / 700)
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34 + pulse * 8)
      core.addColorStop(0, 'rgba(255,240,200,1)'); core.addColorStop(0.3, 'rgba(247,199,91,0.85)'); core.addColorStop(1, 'rgba(247,199,91,0)')
      ctx.globalAlpha = 1; ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, 42, 0, Math.PI * 2); ctx.fill()
      for (let i = 0; i < 2; i++) {
        const t = ((now / 2600) + i * 0.5) % 1
        ctx.globalAlpha = (1 - t) * 0.45; ctx.strokeStyle = '#f7c75b'; ctx.lineWidth = 1.2
        ctx.beginPath(); ctx.ellipse(cx, cy, 18 + t * R[2], (18 + t * R[2]) * 0.62, 0, 0, Math.PI * 2); ctx.stroke()
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])
  return <canvas ref={ref} className="egx-landing-fx" aria-hidden="true" />
}
