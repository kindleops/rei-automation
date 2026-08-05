/**
 * In-page audit used by the Lane G responsive + accessibility gate.
 *
 * Everything in `runLcAudit` is serialised into the page by
 * `page.evaluate`, so it may not close over anything from module scope.
 */

export type LcOverflower = { selector: string; left: number; right: number; width: number }
export type LcTiny = { selector: string; fontSize: number; text: string }
export type LcSmallTarget = { selector: string; w: number; h: number }
export type LcContrastFail = {
  selector: string
  ratio: number
  required: number
  fontSize: number
  opacity: number
  color: string
  text: string
}

export type LcAuditResult = {
  width: number
  documentOverflowPx: number
  /**
   * R15.2 names `scrollWidth > clientWidth` as the enforcement test. In THIS
   * app that test can never fail: `html` and `body` both compute
   * `overflow-x: hidden`, so the document is structurally incapable of
   * scrolling sideways. Measured at 390px on the untouched baseline —
   * docScroll 390 === docClient 390 — while 26 elements on /queue and 25 on
   * /calendar genuinely sat past the right edge. The honest signals are
   * therefore the two below, not the document metric:
   *   overflowers       — escaped the viewport with nothing to clip or scroll
   *                       them. This is the real R15.2 failure. Must be 0.
   *   containedOverflow — sits past the edge INSIDE a scroller that itself
   *                       fits (a tab strip, a table). Legitimate under §15.6,
   *                       but reported so it is a visible decision rather than
   *                       something the audit silently swallows.
   */
  containedOverflow: number
  overflowers: LcOverflower[]
  tiny: LcTiny[]
  smallTargets: LcSmallTarget[]
  crowdedTargets: number
  unnamedButtons: string[]
  landmarks: { main: number; navigation: number; banner: number; complementary: number }
  h1Count: number
  dialogs: { selector: string; ariaModal: string | null; named: boolean }[]
  contrastFailures: LcContrastFail[]
  domNodes: number
  animatedAfterReducedMotion: number
}

/**
 * Two exclusions, both structural rather than convenient:
 *
 * 1. Dev-only overlays (`DevApiBanner`, `DevRuntimeDiagnostics`) are tagged
 *    `data-lc-dev-overlay` and never ship.
 *
 * 2. Google Maps / Street View chrome. The SDK injects its own attribution
 *    ("© 2026 Google", "Terms", "Report a problem") at 10px into `.gm-style`
 *    containers. Google's terms require the attribution to be displayed as
 *    served, we do not author it, and restyling it is not something ANY lane
 *    can do — so it is excluded here rather than parked in known-gaps.ts, which
 *    is for defects somebody eventually fixes. Caught on
 *    /deal-intelligence @mobile once Street View had resolved.
 */
export function runLcAudit(): LcAuditResult {
  const IGNORE = '[data-lc-dev-overlay], .gm-style, .gmnoprint, .gm-style-cc, .gm-iv-address'
  const de = document.documentElement
  const vw = window.innerWidth

  const selectorOf = (el: Element): string => {
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
        : ''
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls
  }
  const skip = (el: Element) => !!el.closest(IGNORE)

  /* ── §15.2 overflow ─────────────────────────────────────────────────────
     R15.2 is about the PAGE never scrolling sideways. Content that sits inside
     a deliberate scroll/clip container which itself fits the viewport is not a
     violation — that is a table or a tab strip doing its job (§15.6). Only
     overflow that escapes to the page counts. */
  const isContained = (el: Element): boolean => {
    let node = el.parentElement
    while (node && node !== document.body) {
      const cs = getComputedStyle(node)
      const clipsX = ['auto', 'scroll', 'hidden', 'clip'].includes(cs.overflowX)
      if (clipsX && node.getBoundingClientRect().right <= vw + 2) return true
      node = node.parentElement
    }
    return false
  }

  const overflowers: LcOverflower[] = []
  let containedOverflow = 0
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (skip(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (getComputedStyle(el).visibility === 'hidden') continue
    if (r.right > vw + 2 || r.left < -2) {
      if (isContained(el)) {
        containedOverflow++
        continue
      }
      if (overflowers.length < 25) {
        overflowers.push({
          selector: selectorOf(el),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
        })
      }
    }
  }

  /* ── §2.1 type floor ────────────────────────────────────────────────── */
  const tiny: LcTiny[] = []
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (skip(el)) continue
    const hasDirectText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0,
    )
    if (!hasDirectText) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const fontSize = parseFloat(getComputedStyle(el).fontSize)
    if (fontSize && fontSize < 11) {
      tiny.push({
        selector: selectorOf(el),
        fontSize: Math.round(fontSize * 100) / 100,
        text: (el.textContent || '').trim().slice(0, 32),
      })
    }
  }

  /* ── §15.3 touch targets ────────────────────────────────────────────── */
  const interactive = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="tab"], input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => {
    if (skip(el)) return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false

    /**
     * SVG geometry is never the touch target. A `<path>` inside a chart link
     * measures 6x2 because it is a stroke; the thing the operator taps is the
     * `<a>`/`<button>` around it, which IS measured. Requiring a 44x44 chart
     * stroke is meaningless, and it made /deal-intelligence fail intermittently
     * depending on whether the chart had rendered.
     */
    const svgOwner = (el as unknown as SVGElement).ownerSVGElement
    if (svgOwner && el.tagName.toLowerCase() !== 'a') return false

    /**
     * WCAG 2.5.8 exempts a link whose target is INLINE in a sentence — you
     * cannot give a word in a paragraph a 44px hit box without destroying the
     * paragraph. The exception is display-based and therefore precise: a link
     * STYLED as a control (inline-flex, flex, inline-block, block) is not
     * inline text and is still held to 44px. `.nx-di25-action-btn` is
     * `display: flex`, so it is measured — and it was, and it was fixed.
     */
    if (el.tagName.toLowerCase() === 'a' && getComputedStyle(el).display === 'inline') return false

    return true
  })

  const smallTargets: LcSmallTarget[] = []
  const boxes: DOMRect[] = []
  for (const el of interactive) {
    const r = el.getBoundingClientRect()
    boxes.push(r)
    if (r.height < 44 || r.width < 44) {
      if (smallTargets.length < 40) {
        smallTargets.push({ selector: selectorOf(el), w: Math.round(r.width), h: Math.round(r.height) })
      }
    }
  }

  // §15.3 separation — two targets closer than 8px on both axes.
  let crowdedTargets = 0
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const gapX = Math.max(a.left - b.right, b.left - a.right)
      const gapY = Math.max(a.top - b.bottom, b.top - a.bottom)
      if (gapX < 8 && gapY < 8 && !(gapX < -1 && gapY < -1)) crowdedTargets++
    }
  }

  /* ── §16.4 / §16.6 names and landmarks ──────────────────────────────── */
  const unnamedButtons = Array.from(document.querySelectorAll('button'))
    .filter((b) => !skip(b))
    .filter((b) => {
      const r = b.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      const label = (b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim()
      const labelledBy = b.getAttribute('aria-labelledby')
      return label.length === 0 && !labelledBy
    })
    .map(selectorOf)
    .slice(0, 20)

  const landmarkCount = (implicit: string, role: string) =>
    Array.from(document.querySelectorAll(`${implicit}, [role="${role}"]`)).filter((el) => {
      if (skip(el)) return false
      // An explicit role overrides the implicit landmark (<nav role="tablist">).
      const explicit = el.getAttribute('role')
      return !explicit || explicit === role
    }).length

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
    selector: selectorOf(d),
    ariaModal: d.getAttribute('aria-modal'),
    named: !!(d.getAttribute('aria-label') || d.getAttribute('aria-labelledby')),
  }))

  /* ── §16.1 rendered contrast ────────────────────────────────────────── */
  /**
   * getComputedStyle can return `rgb()`, `rgba()` or `color(srgb r g b / a)`.
   * The `color()` form is 0–1 per channel, so it must be scaled — reading it as
   * 0–255 makes near-white text measure as near-black and invents failures.
   */
  const parse = (c: string): number[] | null => {
    const m = c.match(/[\d.]+/g)
    if (!m) return null
    const scale = /^color\(/.test(c.trim()) ? 255 : 1
    return [+m[0] * scale, +m[1] * scale, +m[2] * scale, m[3] === undefined ? 1 : +m[3]]
  }
  const lin = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const over = (fg: number[], bg: number[]) => {
    const a = fg[3]
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
  }
  const ratio = (a: number[], b: number[]) => {
    const l1 = lum(a)
    const l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  /**
   * Source-over composite of the accumulated (upper) stack onto a lower layer,
   * PRESERVING alpha. Collapsing alpha to 1 after the first translucent layer
   * — the obvious mistake — makes a `rgba(255,255,255,0.03)` row hover read as
   * solid white and reports every row as a contrast failure.
   */
  const stack = (top: number[], bottom: number[]): number[] => {
    const a = top[3] + bottom[3] * (1 - top[3])
    if (a === 0) return [0, 0, 0, 0]
    return [
      (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / a,
      (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / a,
      (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / a,
      a,
    ]
  }

  const bgOf = (el: Element): number[] => {
    let node: Element | null = el
    let acc: number[] = [0, 0, 0, 0]
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c[3] > 0) {
        acc = stack(acc, c)
        if (acc[3] >= 0.999) return [acc[0], acc[1], acc[2], 1]
      }
      node = node.parentElement
    }
    // Nothing opaque found: the page background is the app's base surface.
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor)
    const base = bodyBg && bodyBg[3] > 0 ? bodyBg : [0, 0, 0, 1]
    const final = stack(acc, [base[0], base[1], base[2], 1])
    return [final[0], final[1], final[2], 1]
  }

  const contrastFailures: LcContrastFail[] = []
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (skip(el)) continue
    const hasDirectText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0,
    )
    if (!hasDirectText) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden') continue

    /**
     * WCAG 1.4.3 exempts "inactive user interface components" from the contrast
     * minimum, and this is not a loophole — a disabled control that meets 4.5:1
     * is indistinguishable from an enabled one, which is a WORSE outcome for the
     * operator. Measured example: `.occ-page-btn:disabled { opacity: 0.35 }`
     * ("« First" at 1.91:1) is correct as drawn.
     */
    const inactive = el.closest(
      ':disabled, [disabled], [aria-disabled="true"], [data-disabled="true"]',
    )
    if (inactive) continue

    let opacity = 1
    let node: Element | null = el
    while (node && node !== document.body) {
      opacity *= parseFloat(getComputedStyle(node).opacity)
      node = node.parentElement
    }
    // Below 0.05 the element is a fade-in/decorative ghost, not readable text.
    if (opacity < 0.05) continue

    const fg = parse(cs.color)
    if (!fg) continue
    const bg = bgOf(el)
    const effective = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg)
    const fontSize = parseFloat(cs.fontSize)
    const weight = parseInt(cs.fontWeight, 10) || 400
    const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700)
    const required = large ? 3 : 4.5
    const cr = ratio(effective, bg)
    if (cr < required) {
      contrastFailures.push({
        selector: selectorOf(el),
        ratio: Math.round(cr * 100) / 100,
        required,
        fontSize,
        opacity: Math.round(opacity * 100) / 100,
        color: cs.color,
        text: (el.textContent || '').trim().slice(0, 32),
      })
    }
  }

  /* ── §16.9 reduced motion (meaningful only under emulation) ─────────── */
  let animatedAfterReducedMotion = 0
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (skip(el)) continue
      const cs = getComputedStyle(el)
      const dur = (v: string) => v.split(',').some((s) => parseFloat(s) > 0.01)
      if (
        (cs.animationName !== 'none' && dur(cs.animationDuration)) ||
        (cs.transitionProperty !== 'none' && dur(cs.transitionDuration))
      ) {
        animatedAfterReducedMotion++
      }
    }
  }

  return {
    width: vw,
    documentOverflowPx: Math.max(0, de.scrollWidth - de.clientWidth),
    containedOverflow,
    overflowers,
    tiny,
    smallTargets,
    crowdedTargets,
    unnamedButtons,
    landmarks: {
      main: landmarkCount('main', 'main'),
      navigation: landmarkCount('nav', 'navigation'),
      banner: landmarkCount('header', 'banner'),
      complementary: landmarkCount('aside', 'complementary'),
    },
    h1Count: document.querySelectorAll('h1').length,
    dialogs,
    contrastFailures,
    domNodes: document.querySelectorAll('*').length,
    animatedAfterReducedMotion,
  }
}
