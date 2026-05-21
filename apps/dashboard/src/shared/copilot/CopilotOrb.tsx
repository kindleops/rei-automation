/**
 * NEXUS CopilotOrb — Floating Neural Core Trigger
 *
 * Canvas-rendered animated intelligence nucleus with 6 visual layers.
 * Reflects copilot state through hue, speed, intensity, and waveform.
 * Long-press activates push-to-talk; click opens sidecar/console.
 */

import { useRef, useEffect, useCallback, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CopilotState } from './copilot-state'
import { STATE_META } from './copilot-state'

interface CopilotOrbProps {
  state: CopilotState
  amplitude: number
  onClick: () => void
  onPushToTalk: () => void
  onPushToTalkRelease: () => void
  className?: string
  textOverlay?: string | null
  textInterim?: boolean
}

export function CopilotOrb({ state, amplitude, onClick, onPushToTalk, onPushToTalkRelease, className, textOverlay = null, textInterim = false }: CopilotOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const startRef = useRef(Date.now())
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isHolding, setIsHolding] = useState(false)
  const prevStateRef = useRef(state)
  const currentStateRef = useRef(state)
  const flashRef = useRef(0)
  const meta = STATE_META[state]
  const metaRef = useRef(meta)
  const ampRef = useRef(amplitude)
  metaRef.current = meta
  ampRef.current = amplitude

  useEffect(() => {
    currentStateRef.current = state
  }, [state])

  // Flash on state transitions
  useEffect(() => {
    if (state !== prevStateRef.current) {
      flashRef.current = 1.0
      prevStateRef.current = state
    }
  }, [state])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const size = 72
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.scale(dpr, dpr)
    const cx = size / 2
    const cy = size / 2

    const draw = () => {
      const t = (Date.now() - startRef.current) / 1000
      const m = metaRef.current
      const amp = ampRef.current
      const flash = flashRef.current
      ctx.clearRect(0, 0, size, size)

      // subtle canvas translation when speaking for a tactile vibration
      const isSpeaking = currentStateRef.current === 'speaking'
      if (isSpeaking && amp > 0.01) {
        const dx = Math.sin(t * 18) * amp * 1.6
        const dy = Math.cos(t * 14) * amp * 1.0
        ctx.save()
        ctx.translate(dx, dy)
      } else {
        ctx.save()
      }

      // Decay flash
      if (flash > 0) flashRef.current = Math.max(0, flash - 0.02)

      // ── Layer 1: Outer halo ──
      const haloR = 32 + Math.sin(t * m.orbSpeed * 0.8) * 2 + amp * 6 + flash * 4
      const haloGrad = ctx.createRadialGradient(cx, cy, haloR * 0.2, cx, cy, haloR)
      haloGrad.addColorStop(0, `rgba(${m.hue},${0.08 + m.orbIntensity * 0.15 + amp * 0.12 + flash * 0.2})`)
      haloGrad.addColorStop(0.5, `rgba(${m.hue},${0.03 + m.orbIntensity * 0.05})`)
      haloGrad.addColorStop(1, `rgba(${m.hue},0)`)
      ctx.beginPath()
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2)
      ctx.fillStyle = haloGrad
      ctx.fill()

      // ── Layer 2: 4 concentric neural rings ──
      for (let i = 0; i < 4; i++) {
        const phase = t * m.orbSpeed * (1.2 + i * 0.35) + i * 1.8
        const r = 7 + i * 5 + Math.sin(phase) * (1.5 + amp * 2.5)
        const alpha = Math.min(0.65, (0.10 + m.orbIntensity * 0.18 - i * 0.03) * (1 + amp * 0.6))
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${m.hue},${alpha})`
        ctx.lineWidth = 1.0 - i * 0.15
        ctx.stroke()
      }

      // ── Layer 3: Waveform bars (listening/active states) — deterministic, amplitude-driven
      if (m.orbSpeed >= 1.0 && amp > 0.01) {
        const barCount = 16
        const baseR = 22
        ctx.lineCap = 'round'
        for (let i = 0; i < barCount; i++) {
          const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2
          // deterministic per-bar phase (no Math.random for stable waveform)
          const phase = t * (4 + i * 0.08) + i * 0.6
          const noise = Math.abs(Math.sin(phase))
          const barH = 2 + amp * 12 * noise
          const x1 = cx + Math.cos(angle) * baseR
          const y1 = cy + Math.sin(angle) * baseR
          const x2 = cx + Math.cos(angle) * (baseR + barH)
          const y2 = cy + Math.sin(angle) * (baseR + barH)
          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.strokeStyle = `rgba(${m.hue},${Math.min(0.9, 0.12 + amp * 0.5 + noise * 0.12)})`
          ctx.lineWidth = 1.4
          ctx.stroke()
        }
      }

      // ── Layer 4: 4 orbital particles ──
      for (let i = 0; i < 4; i++) {
        const orbitR = 15 + i * 3
        const speed = m.orbSpeed * (0.6 + i * 0.3)
        const angle = t * speed + i * (Math.PI * 2 / 4) + Math.sin(t * 0.5 + i) * 0.3
        const px = cx + Math.cos(angle) * orbitR * (1 + amp * 0.4)
        const py = cy + Math.sin(angle) * orbitR * (1 + amp * 0.3)
        const dotR = 1.2 + amp * 0.8 + Math.sin(t * 3 + i) * 0.3
        ctx.beginPath()
        ctx.arc(px, py, dotR, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${m.hue},${0.2 + m.orbIntensity * 0.25})`
        ctx.fill()
      }

      // ── Layer 5: Scanning beams (processing states) ──
      if (m.orbSpeed > 1.0) {
        const arcAngle = t * m.orbSpeed * 3
        ctx.beginPath()
        ctx.arc(cx, cy, 20, arcAngle, arcAngle + Math.PI * 0.35)
        ctx.strokeStyle = `rgba(${m.hue},${0.18 + amp * 0.12})`
        ctx.lineWidth = 1.8
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(cx, cy, 14, arcAngle + Math.PI, arcAngle + Math.PI + Math.PI * 0.25)
        ctx.strokeStyle = `rgba(${m.hue},${0.10 + amp * 0.08})`
        ctx.lineWidth = 1.2
        ctx.stroke()
      }

      // ── Layer 6: Center nucleus with glow ──
      const nucleusR = 3.5 + Math.sin(t * m.orbSpeed * 2.5) * 0.8 + amp * 2.8 + (isSpeaking ? amp * 1.2 : 0)
      const nGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, nucleusR * 1.8)
      nGrad.addColorStop(0, `rgba(${m.hue},${0.6 + m.orbIntensity * 0.35 + amp * 0.2 + flash * 0.3})`)
      nGrad.addColorStop(0.6, `rgba(${m.hue},${0.15 + m.orbIntensity * 0.1})`)
      nGrad.addColorStop(1, `rgba(${m.hue},0)`)
      ctx.beginPath()
      ctx.arc(cx, cy, nucleusR * 1.8, 0, Math.PI * 2)
      ctx.fillStyle = nGrad
      ctx.fill()
      ctx.beginPath()
      ctx.arc(cx, cy, nucleusR * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${m.hue},${0.8 + flash * 0.2})`
      ctx.fill()

      // ── Flash overlay ──
      if (flash > 0.01) {
        const fGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30)
        fGrad.addColorStop(0, `rgba(${m.hue},${flash * 0.3})`)
        fGrad.addColorStop(1, `rgba(${m.hue},0)`)
        ctx.beginPath()
        ctx.arc(cx, cy, 30, 0, Math.PI * 2)
        ctx.fillStyle = fGrad
        ctx.fill()
      }

      ctx.restore()
      rafRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const handlePointerDown = useCallback(() => {
    holdTimerRef.current = setTimeout(() => {
      setIsHolding(true)
      onPushToTalk()
    }, 300)
  }, [onPushToTalk])

  const handlePointerUp = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
    if (isHolding) { setIsHolding(false); onPushToTalkRelease() }
    else { onClick() }
  }, [isHolding, onClick, onPushToTalkRelease])

  const handlePointerLeave = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
    if (isHolding) { setIsHolding(false); onPushToTalkRelease() }
  }, [isHolding, onPushToTalkRelease])

  return (
    <button
      type="button"
      className={`nx-copilot-orb ${className ?? ''} ${isHolding ? 'is-holding' : ''} ${state === 'listening' ? 'is-listening' : ''} ${state === 'speaking' ? 'is-speaking' : ''}`}
      style={{
        // CSS variables consumed by styles for glow/vibration
        ['--nx-orb-rgb' as any]: meta.hue,
        ['--nx-orb-amp' as any]: amplitude,
        ['--nx-orb-vspeed' as any]: `${Math.max(60, 160 - amplitude * 120)}ms`,
      } as CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      aria-label="NEXUS Copilot"
    >
      <div className="nx-copilot-orb__live-glow" />
      <canvas ref={canvasRef} className="nx-copilot-orb__canvas" />
      <div className={`nx-copilot-orb__overlay ${textInterim ? 'is-interim' : ''}`} aria-hidden>
        {textOverlay ? <span className="nx-copilot-orb__overlay-text">{textOverlay}</span> : null}
      </div>
      <span className="nx-copilot-orb__label">{meta.label}</span>
    </button>
  )
}
