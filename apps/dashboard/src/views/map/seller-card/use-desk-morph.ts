/**
 * ONE OBJECT, EVOLVING — the desktop seller card's state transitions.
 *
 * The card keeps a single root element through PREVIEW → HALF → FULL, so a
 * transition is a FLIP over that element: its previous rect is recorded after
 * every commit, and when the state changes the new geometry is animated in
 * from the old one with transform + clip-path (compositor-only; no layout per
 * frame).
 *
 *  grow   PREVIEW → HALF/FULL: the card opens out of the capsule's footprint,
 *         and the hero opens out of the thumbnail's footprint.
 *  widen  HALF → FULL: the docked panel grows leftward, right edge fixed.
 *  shrink collapse: a glass ghost of the old panel contracts into the new
 *         geometry while the new face settles in.
 *  swap   same geometry (card ↔ conversation): the new face slides in.
 *
 * Reduced motion: no animation at all — the state simply changes. Every
 * settled geometry is announced (`nexus:smc-dock-geometry`) so the Map can
 * re-frame its camera beside the dock.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'

export const SMC_DOCK_GEOMETRY_EVENT = 'nexus:smc-dock-geometry'

type Box = { left: number; top: number; width: number; height: number }
type Recorded = { key: string; rank: number; rect: Box; hero: Box | null }

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height })
const relTo = (inner: DOMRect, outer: DOMRect): Box => ({
  left: inner.left - outer.left,
  top: inner.top - outer.top,
  width: inner.width,
  height: inner.height,
})

const announce = () => {
  if (typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    try { window.dispatchEvent(new CustomEvent(SMC_DOCK_GEOMETRY_EVENT)) } catch { /* non-DOM */ }
  })
}

export function useDeskMorph(
  rootRef: RefObject<HTMLElement>,
  key: string,
  rank: number,
  reducedMotion: boolean,
) {
  const prev = useRef<Recorded | null>(null)
  const running = useRef<Animation[]>([])

  // 1 — the transition. Declared before the recorder so it reads the PREVIOUS commit.
  useLayoutEffect(() => {
    const root = rootRef.current
    const before = prev.current
    announce()
    if (!root || !before || before.key === key || reducedMotion || typeof root.animate !== 'function') return

    for (const a of running.current) a.cancel()
    running.current = []
    const rootRect = root.getBoundingClientRect()
    const after = box(rootRect)
    const first = before.rect
    const face = root.querySelector<HTMLElement>('[data-morph="face"]')

    if (rank > before.rank) {
      const heroEl = root.querySelector<HTMLElement>('[data-morph="hero"]')
      const heroNow = heroEl ? relTo(heroEl.getBoundingClientRect(), rootRect) : null
      const dx = first.left - after.left
      const dy = first.top - after.top
      const clipR = Math.max(0, after.width - first.width)
      const clipB = Math.max(0, after.height - first.height)
      const duration = before.rank === 0 ? 480 : 420
      running.current.push(root.animate([
        { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0px ${clipR}px ${clipB}px 0px round 16px)` },
        { transform: 'translate(0px, 0px)', clipPath: 'inset(0px 0px 0px 0px round 18px)' },
      ], { duration, easing: EASE }))

      // The thumbnail's footprint becomes the hero.
      if (before.rank === 0 && before.hero && heroEl && heroNow) {
        const t = Math.max(0, before.hero.top - heroNow.top)
        const l = Math.max(0, before.hero.left - heroNow.left)
        const r = Math.max(0, heroNow.left + heroNow.width - (before.hero.left + before.hero.width))
        const b = Math.max(0, heroNow.top + heroNow.height - (before.hero.top + before.hero.height))
        running.current.push(heroEl.animate([
          { clipPath: `inset(${t}px ${r}px ${b}px ${l}px round 12px)` },
          { clipPath: 'inset(0px 0px 0px 0px round 0px)' },
        ], { duration, easing: EASE }))
      }
      if (face) {
        running.current.push(face.animate([
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0px)' },
        ], { duration: 300, delay: before.rank === 0 ? 120 : 90, easing: EASE, fill: 'backwards' }))
      }
      return
    }

    if (rank < before.rank) {
      const host = root.parentElement
      if (host) {
        const hostRect = host.getBoundingClientRect()
        const ghost = document.createElement('div')
        ghost.className = 'smcd-ghost'
        ghost.setAttribute('aria-hidden', 'true')
        Object.assign(ghost.style, {
          left: `${first.left - hostRect.left}px`,
          top: `${first.top - hostRect.top}px`,
          width: `${first.width}px`,
          height: `${first.height}px`,
        })
        host.appendChild(ghost)
        const sx = Math.max(0.2, after.width / Math.max(1, first.width))
        const sy = Math.max(0.12, after.height / Math.max(1, first.height))
        const anim = ghost.animate([
          { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 },
          { transform: `translate(${after.left - first.left}px, ${after.top - first.top}px) scale(${sx}, ${sy})`, opacity: 0 },
        ], { duration: 380, easing: EASE })
        const drop = () => ghost.remove()
        anim.onfinish = drop
        anim.oncancel = drop
        running.current.push(anim)
      }
      running.current.push(root.animate([
        { opacity: 0, transform: 'scale(0.97)' },
        { opacity: 1, transform: 'scale(1)' },
      ], { duration: 280, delay: 70, easing: EASE, fill: 'backwards' }))
      return
    }

    if (face) {
      running.current.push(face.animate([
        { opacity: 0, transform: 'translateX(10px)' },
        { opacity: 1, transform: 'translateX(0px)' },
      ], { duration: 260, easing: EASE }))
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // 2 — the recorder: the geometry every later transition starts from.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const hero = root.querySelector<HTMLElement>('[data-morph="hero"]')
    prev.current = { key, rank, rect: box(rect), hero: hero ? relTo(hero.getBoundingClientRect(), rect) : null }
  })

  useLayoutEffect(() => () => {
    for (const a of running.current) a.cancel()
    running.current = []
  }, [])
}
