import { useRef, useEffect } from 'react'
import type { CopilotState } from './copilot-state'

interface CopilotLargeOrbProps {
  state: CopilotState
  amplitude: number
  intensity?: number
  speed?: number
  className?: string
}

function parseAccent(): [number, number, number] {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--nx-accent').trim() || '#38d0f0'
    if (raw.startsWith('rgb')) {
      const nums = raw.replace(/rgba?\(|\)/g, '').split(',').map(s => parseInt(s.trim(), 10))
      return [nums[0] || 56, nums[1] || 208, nums[2] || 240]
    }
    const hex = raw.replace('#', '')
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return [r, g, b]
  } catch (_) {
    return [56, 208, 240]
  }
}

export function CopilotLargeOrb({ state, amplitude, intensity = 1, speed = 1, className = '' }: CopilotLargeOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number>(Date.now())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.max(1, window.devicePixelRatio || 1)

    function resize() {
      const rect = wrap!.getBoundingClientRect()
      canvas!.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas!.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas!.style.width = `${rect.width}px`
      canvas!.style.height = `${rect.height}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const ResizeObserverCtor = (window as any).ResizeObserver
    const ro = ResizeObserverCtor ? new ResizeObserverCtor(() => resize()) : null
    try { ro?.observe(wrap) } catch (_) { /* ignore */ }

    const accentRgb = parseAccent()

    // local beat state for command/typing pulses
    let beat = 0
    let lastBeatAt = 0

    const onCommand = () => { beat = Math.max(beat, 0.9); lastBeatAt = Date.now() }
    const onTyping = (ev: Event) => {
      const d = (ev as CustomEvent<{ amplitude?: number }>).detail
      const amp = typeof d?.amplitude === 'number' ? d.amplitude : 0.25
      beat = Math.max(beat, Math.min(1, amp * 0.9))
      lastBeatAt = Date.now()
    }
    try {
      window.addEventListener('nx:copilot-command', onCommand)
      window.addEventListener('nx:copilot-typing', onTyping)
    } catch (_) { /* ignore in some test envs */ }

    function draw() {
      const now = Date.now()
      const decayFactor = Math.max(0, 1 - (now - lastBeatAt) / 700)
      const extra = beat * decayFactor
      const t = ((now - startRef.current) / 1000) * speed * (1 + extra * 0.9)
      const rect = wrap!.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      ctx!.clearRect(0, 0, w, h)

      // Lighting blend
      ctx!.globalCompositeOperation = 'lighter'

      // draw several drifting blobs
      for (let i = 0; i < 3; i++) {
        const effAmp = Math.min(1, amplitude + extra)
        const ox = w * 0.5 + Math.cos(t * (0.2 + i * 0.12) + i * 1.2) * (w * 0.18 + effAmp * 80)
        const oy = h * (0.45 + Math.sin(t * (0.15 + i * 0.08) + i * 0.9) * 0.12)
        const baseR = Math.max(48, Math.min(w, h) * (0.22 + i * 0.06) + effAmp * 60)
        const grad = ctx!.createRadialGradient(ox, oy, 0, ox, oy, baseR)
        const alphaA = 0.12 * intensity + 0.06 * i + extra * 0.08
        const alphaB = 0.02 * intensity + extra * 0.02
        grad.addColorStop(0, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${alphaA + 0.08 * Math.sin(t * (0.6 + i * 0.2))})`)
        grad.addColorStop(0.6, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${alphaB})`)
        grad.addColorStop(1, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0)`)
        ctx!.fillStyle = grad
        ctx!.beginPath()
        ctx!.ellipse(ox, oy, baseR * (1 + 0.06 * Math.sin(t * (1.2 + i * 0.3))), baseR * 0.7, Math.sin(t * (0.2 + i * 0.1)) * 0.4, 0, Math.PI * 2)
        ctx!.fill()
      }

      // center glow overlay
      const cx = w * 0.5
      const cy = h * 0.5
      const effAmpCenter = Math.min(1, amplitude + extra)
      const g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6)
      g.addColorStop(0, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${0.06 * intensity + effAmpCenter * 0.06})`)
      g.addColorStop(1, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0)`)
      ctx!.fillStyle = g
      ctx!.fillRect(0, 0, w, h)

      ctx!.globalCompositeOperation = 'source-over'
      // slight decay of beat so it doesn't persist
      if (beat > 0 && Date.now() - lastBeatAt > 900) beat = 0
      rafRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      try { ro?.disconnect() } catch (_) { }
      try {
        window.removeEventListener('nx:copilot-command', onCommand)
        window.removeEventListener('nx:copilot-typing', onTyping)
      } catch (_) { }
    }
  }, [intensity, speed, amplitude, state])

  return (
    <div ref={wrapRef} className={`co-large-orb-wrap ${className}`} aria-hidden>
      <canvas ref={canvasRef} className="co-large-orb-canvas" />
    </div>
  )
}

export default CopilotLargeOrb
