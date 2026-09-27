import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Motion primitives for Home.
 *
 * Everything here animates transform, opacity or a single text node — the
 * properties a phone can move at 60fps — and every one of them stands still when
 * the operator has asked for reduced motion or switched animations off.
 */

export const STILL_CLASS = 'is-still'

export function prefersStill(): boolean {
  if (typeof window === 'undefined') return true
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true
  return Boolean(document.querySelector(`.nx-home.${STILL_CLASS}`))
}

// ── Reveal on scroll ────────────────────────────────────────────────────────

/**
 * True once the element has scrolled into view. One-way: a card that has been
 * revealed does not re-hide, so scrolling back up never replays the choreography.
 */
export function useRevealed<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null)
  // Without an observer there is nothing to wait for: reveal immediately.
  const [revealed, setRevealed] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const node = ref.current
    if (!node || revealed) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRevealed(true)
        observer.disconnect()
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [revealed])

  return [ref, revealed]
}

// ── Touch light and ripple ──────────────────────────────────────────────────

const RIPPLE_HOSTS = '.nx-home-focus__item, .nx-home-stage, .nx-home-chip, .nx-home-action, .nx-home-feed__text, .nx-home-leaders button, .nx-home-bubble, .nx-home-big'

const setLight = (card: HTMLElement, event: PointerEvent) => {
  const rect = card.getBoundingClientRect()
  card.style.setProperty('--mx', `${event.clientX - rect.left}px`)
  card.style.setProperty('--my', `${event.clientY - rect.top}px`)
}

/**
 * The glass responds to the finger: a specular light follows the touch across the
 * card, and the pressed control blooms a liquid ripple from the exact point of
 * contact. Delegated from the Home root, so it costs three listeners in total.
 */
export function useLiquidTouch(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = root.current
    if (!node) return
    let active: HTMLElement | null = null

    const release = () => {
      active?.classList.remove('is-lit')
      active = null
    }

    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const card = target?.closest<HTMLElement>('.nx-home-card.is-tile') ?? null
      if (card) {
        release()
        active = card
        setLight(card, event)
        card.classList.add('is-lit')
      }
      if (prefersStill()) return
      const hit = target?.closest<HTMLElement>(RIPPLE_HOSTS)
      if (!hit) return
      // Actions ripple inside their glass tile; the badge stays unclipped outside it.
      const host = hit.classList.contains('nx-home-action')
        ? hit.querySelector<HTMLElement>('.nx-home-action__well') ?? hit
        : hit
      const rect = host.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height) * 2.2
      const ripple = document.createElement('span')
      ripple.className = 'nx-home-ripple'
      if (host.classList.contains('nx-home-action__well')) ripple.style.zIndex = '0'
      ripple.style.width = ripple.style.height = `${size}px`
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`
      host.appendChild(ripple)
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true })
    }

    const onMove = (event: PointerEvent) => {
      if (active) setLight(active, event)
    }

    node.addEventListener('pointerdown', onDown, { passive: true })
    node.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', release, { passive: true })
    window.addEventListener('pointercancel', release, { passive: true })
    return () => {
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [root])
}

// ── Scroll choreography ─────────────────────────────────────────────────────

/**
 * Scroll-linked depth: the ambient field drifts slower than the content, the large
 * greeting lifts and dissolves, and a compact glass header condenses in its place.
 *
 * Written straight to `transform` / `opacity` on three elements inside one rAF per
 * frame. Setting a custom property on the root instead would restyle the whole Home
 * subtree on every scroll frame.
 */
export function useScrollDepth(
  scroller: RefObject<HTMLElement | null>,
  root: RefObject<HTMLElement | null>,
  ambientLayer: RefObject<HTMLElement | null>,
  heroLayer: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const node = scroller.current
    const home = root.current
    const ambient = ambientLayer.current
    const hero = heroLayer.current
    if (!node) return
    let frame = 0
    let condensed = false

    const apply = () => {
      frame = 0
      const y = Math.max(0, node.scrollTop)
      const still = prefersStill()
      ambient?.style.setProperty('transform', still ? '' : `translate3d(0, ${(-y * 0.12).toFixed(1)}px, 0)`)
      if (hero) {
        const p = Math.min(1, y / 150)
        hero.style.setProperty('opacity', String(1 - p * 0.9))
        hero.style.setProperty('transform', still ? '' : `translate3d(0, ${(y * 0.28).toFixed(1)}px, 0) scale(${(1 - p * 0.06).toFixed(3)})`)
      }
      const next = y > 96
      if (next !== condensed) {
        condensed = next
        home?.classList.toggle('is-condensed', next)
      }
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    apply()
    return () => {
      node.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scroller, root, ambientLayer, heroLayer])
}
