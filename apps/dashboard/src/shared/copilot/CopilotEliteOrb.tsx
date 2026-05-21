import { useRef, useEffect, useState } from 'react'
import type { CopilotState } from './copilot-state'

interface CopilotEliteOrbProps {
  state: CopilotState
  amplitude: number
  intensity?: number
  speed?: number
  className?: string
  containerRef?: React.RefObject<HTMLElement | null>
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

export default function CopilotEliteOrb({ state, amplitude, intensity = 1, speed = 1, className = '', containerRef }: CopilotEliteOrbProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number>(Date.now())
  const posRef = useRef({ x: 0.5, y: 0.2, tx: 0.5, ty: 0.2 })
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const container = containerRef?.current ?? wrap?.parentElement
    if (!wrap || !canvas) return
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

    const accent = parseAccent()

    // interactive beat state
    let beat = 0
    let lastBeatAt = 0
    let ttsAmp = 0

    const onCommand = () => { beat = Math.max(beat, 1.0); lastBeatAt = Date.now() }
    const onTyping = (ev: Event) => {
      const d = (ev as CustomEvent<{ amplitude?: number }>).detail
      const amp = typeof d?.amplitude === 'number' ? d.amplitude : 0.25
      beat = Math.max(beat, Math.min(1, amp * 1.0))
      lastBeatAt = Date.now()
    }

    const onTtsAmp = (ev: Event) => {
      const d = (ev as CustomEvent<{ amplitude?: number }>).detail
      ttsAmp = typeof d?.amplitude === 'number' ? d.amplitude : 0
      lastBeatAt = Date.now()
    }

    try {
      window.addEventListener('nx:copilot-command', onCommand)
      window.addEventListener('nx:copilot-typing', onTyping)
      window.addEventListener('nx:copilot-tts-amplitude', onTtsAmp)
    } catch (_) { /* ignore in some envs */ }

    // pointer tracking within container
    const onPointer = (ev: PointerEvent) => {
      const rect = (container ?? wrap).getBoundingClientRect()
      const x = (ev.clientX - rect.left) / rect.width
      const y = (ev.clientY - rect.top) / rect.height
      posRef.current.tx = Math.max(0, Math.min(1, x))
      posRef.current.ty = Math.max(0, Math.min(1, y))
    }

    const onEnter = () => setHovered(true)
    const onLeave = () => setHovered(false)

    try {
      ;(container ?? wrap).addEventListener('pointermove', onPointer)
      ;(container ?? wrap).addEventListener('pointerenter', onEnter)
      ;(container ?? wrap).addEventListener('pointerleave', onLeave)
    } catch (_) { /* ignore */ }

    function draw() {
      const now = Date.now()
      const rect = wrap!.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      ctx!.clearRect(0, 0, w, h)

      // ease position
      posRef.current.x += (posRef.current.tx - posRef.current.x) * 0.16
      posRef.current.y += (posRef.current.ty - posRef.current.y) * 0.16
      const cx = posRef.current.x * w
      const cy = posRef.current.y * h

      // decay beat
      const decay = Math.max(0, 1 - (now - lastBeatAt) / 800)
      const extra = beat * decay

      // base amplitude combines voice amplitude + tts amp + beat
      const effAmp = Math.min(1, amplitude * 0.9 + ttsAmp * 1.2 + extra * 0.9)

      // ambient glow
      ctx!.globalCompositeOperation = 'lighter'
      const radius = Math.max(28, Math.min(w, h) * 0.24 + effAmp * 36)
      const g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.6)
      g.addColorStop(0, `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${0.28 * intensity + effAmp * 0.28})`)
      g.addColorStop(0.5, `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${0.06 * intensity + effAmp * 0.06})`)
      g.addColorStop(1, `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0)`) 
      ctx!.fillStyle = g
      ctx!.beginPath()
      ctx!.arc(cx, cy, radius * (1 + 0.04 * Math.sin((now - startRef.current) / 200 * speed)), 0, Math.PI * 2)
      ctx!.fill()

      // glossy core
      ctx!.globalCompositeOperation = 'source-over'
      const coreR = Math.max(10, radius * 0.36 + effAmp * 6)
      const coreGrad = ctx!.createRadialGradient(cx - coreR * 0.33, cy - coreR * 0.33, 0, cx, cy, coreR * 1.2)
      coreGrad.addColorStop(0, `rgba(255,255,255,${0.9 - effAmp * 0.2})`)
      coreGrad.addColorStop(0.5, `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${0.85 * intensity})`)
      coreGrad.addColorStop(1, `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0)`) 
      ctx!.fillStyle = coreGrad
      ctx!.beginPath()
      ctx!.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx!.fill()

      // small highlight
      ctx!.fillStyle = 'rgba(255,255,255,0.26)'
      ctx!.beginPath()
      ctx!.ellipse(cx - coreR * 0.35, cy - coreR * 0.45, coreR * 0.38, coreR * 0.22, -0.6, 0, Math.PI * 2)
      ctx!.fill()

      // gentle decay of beat
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
        window.removeEventListener('nx:copilot-tts-amplitude', onTtsAmp)
      } catch (_) { }
      try {
        ;(container ?? wrap).removeEventListener('pointermove', onPointer)
        ;(container ?? wrap).removeEventListener('pointerenter', onEnter)
        ;(container ?? wrap).removeEventListener('pointerleave', onLeave)
      } catch (_) { }
    }
  }, [intensity, speed, amplitude, state, containerRef])

  return (
    <div ref={wrapRef} className={`co-elite-orb-wrap ${className}`} aria-hidden>
      <canvas ref={canvasRef} className="co-elite-orb-canvas" />
      <div className={`co-elite-orb-overlay ${hovered ? 'is-hover' : ''}`}>
        <div className="co-elite-orb-overlay__line">{state.toUpperCase()}</div>
      </div>
    </div>
  )
}
