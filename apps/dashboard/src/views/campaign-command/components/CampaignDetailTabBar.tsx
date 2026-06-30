import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { CampaignDetailTab } from '../campaigns.types'
import { cls } from '../campaign-formatters'

export type CampaignDetailTabDef = {
  id: CampaignDetailTab
  label: string
  group?: 'primary' | 'more'
}

interface CampaignDetailTabBarProps {
  tabs: CampaignDetailTabDef[]
  activeTab: CampaignDetailTab
  onTabChange: (tab: CampaignDetailTab) => void
  isMobileLayout?: boolean
}

export function CampaignDetailTabBar({
  tabs,
  activeTab,
  onTabChange,
  isMobileLayout = false,
}: CampaignDetailTabBarProps) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const activeLabel = tabs.find((t) => t.id === activeTab)?.label ?? 'Overview'
  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(200, Math.min(window.innerHeight - top - margin, 360))
    setPanelStyle({
      position: 'fixed',
      top,
      left: margin,
      right: margin,
      maxHeight,
      zIndex: 1200,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePanelPosition()
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)
    return () => {
      window.removeEventListener('resize', updatePanelPosition)
      window.removeEventListener('scroll', updatePanelPosition, true)
    }
  }, [open, updatePanelPosition])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (isMobileLayout) {
    const panel = open ? createPortal(
      <>
        <button type="button" className="occ-liquid-filter__backdrop" aria-label="Close sections" onClick={close} />
        <div
          id={panelId}
          role="dialog"
          aria-label="Campaign sections"
          className="occ-liquid-filter__panel is-portaled ccc-liquid-panel"
          style={panelStyle}
        >
          <div className="occ-liquid-filter__panel-head">
            <strong>Campaign sections</strong>
            <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="occ-liquid-filter__body ccc-detail-tab-picker">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={cls('ccc-detail-tab-picker__item', activeTab === tab.id && 'is-active')}
                onClick={() => {
                  onTabChange(tab.id)
                  close()
                }}
              >
                {tab.label}
                {activeTab === tab.id && <Icon name="check" size={12} />}
              </button>
            ))}
          </div>
        </div>
      </>,
      document.body,
    ) : null

    return (
      <div className="ccc__detail-tabs ccc__detail-tabs--glass ccc__detail-tabs--mobile">
        <div className={cls('occ-liquid-filter', 'ccc-liquid-filter', 'ccc-detail-tab-filter', open && 'is-open')}>
          <button
            ref={triggerRef}
            type="button"
            className="occ-liquid-filter__trigger"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="occ-liquid-filter__trigger-icon" aria-hidden="true">
              <Icon name="layers" size={15} />
            </span>
            <span className="occ-liquid-filter__trigger-copy">
              <span className="occ-liquid-filter__trigger-title">Section</span>
              <span className="occ-liquid-filter__trigger-sub">{activeLabel}</span>
            </span>
            <span className={cls('occ-liquid-filter__chev', open && 'is-open')} aria-hidden="true">
              <Icon name="chevron-down" size={14} />
            </span>
          </button>
        </div>
        {panel}
      </div>
    )
  }

  const primaryTabs = tabs.filter((t) => t.group !== 'more')
  const moreTabs = tabs.filter((t) => t.group === 'more')
  const moreActive = moreTabs.some((t) => t.id === activeTab)

  return (
    <div className="ccc__detail-tabs ccc__detail-tabs--glass">
      <div className="ccc__detail-tab-rail">
        {primaryTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cls('ccc__detail-tab', 'ccc__detail-tab--pill', activeTab === tab.id && 'is-active')}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        {moreTabs.length > 0 && (
          <div className="ccc__detail-tab-more">
            <button
              type="button"
              className={cls('ccc__detail-tab', 'ccc__detail-tab--pill', 'ccc__detail-tab--more', moreActive && 'is-active')}
              onClick={() => {
                if (!moreActive && moreTabs[0]) onTabChange(moreTabs[0].id)
              }}
            >
              More
              <Icon name="chevron-down" size={10} />
            </button>
            <div className="ccc__detail-tab-more-menu">
              {moreTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cls('ccc__detail-tab-more-item', activeTab === tab.id && 'is-active')}
                  onClick={() => onTabChange(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}