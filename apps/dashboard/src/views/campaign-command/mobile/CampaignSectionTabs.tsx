/**
 * CAMPAIGN SECTIONS — mobile.
 *
 * Replaces a "Section · Overview ⌄" trigger that opened a floating panel. With
 * the old pinned hero above it, the trigger sat at y≈517 on an 844pt screen, the
 * panel was sized `min(innerHeight − top − 10, 360)`, and nine sections were
 * squeezed into ~311px — Replies was cut in half and Failures, Geography,
 * Templates and Logs were simply not visible, with nothing to say they existed.
 *
 * A horizontal strip is one tap instead of two, shows where you are, and shows
 * that there is more. It sticks to the top of the scroll area once reached.
 *
 * Labels are operator language; the section ids underneath are unchanged:
 *   targets → Audience · failures → Exceptions · logs → Activity
 */
import { useEffect, useRef } from 'react'
import type { CampaignDetailTab } from '../campaigns.types'

export type SectionTab = { id: CampaignDetailTab; label: string; badge?: number | null }

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export function CampaignSectionTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: SectionTab[]
  active: CampaignDetailTab
  onChange: (id: CampaignDetailTab) => void
}) {
  const railRef = useRef<HTMLDivElement | null>(null)

  // Keep the active tab visible when it changes from outside (e.g. "Review
  // blockers" jumping to Overview) as well as from a tap.
  useEffect(() => {
    const rail = railRef.current
    const el = rail?.querySelector<HTMLElement>(`[data-section="${active}"]`)
    if (!rail || !el) return
    const left = el.offsetLeft - 16
    const right = el.offsetLeft + el.offsetWidth - rail.clientWidth + 16
    if (rail.scrollLeft > left) rail.scrollTo({ left, behavior: 'smooth' })
    else if (rail.scrollLeft < right) rail.scrollTo({ left: right, behavior: 'smooth' })
  }, [active])

  return (
    <nav className="cst" aria-label="Campaign sections">
      <div className="cst__rail" ref={railRef} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-section={t.id}
            aria-selected={t.id === active}
            className={cls('cst__tab', t.id === active && 'is-on')}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && <span className="cst__badge">{t.badge > 99 ? '99+' : t.badge}</span>}
          </button>
        ))}
      </div>
    </nav>
  )
}

export default CampaignSectionTabs
