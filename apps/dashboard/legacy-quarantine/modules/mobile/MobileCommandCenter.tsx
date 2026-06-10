import React, { useState, useCallback } from 'react'
import './mobile.css'
import { MobileInboxTab } from './MobileInboxTab'
import { MobileQueueTab } from './MobileQueueTab'
import { MobileRepliesTab } from './MobileRepliesTab'
import { MobileAlertsTab } from './MobileAlertsTab'
import { MobileControlsTab } from './MobileControlsTab'

type Tab = 'inbox' | 'queue' | 'replies' | 'alerts' | 'controls'

const TAB_META: { id: Tab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'queue', label: 'Queue' },
  { id: 'replies', label: 'Replies' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'controls', label: 'Controls' },
]

const InboxIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 22, height: 22 }}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
  </svg>
)

const QueueIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 22, height: 22 }}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
)

const RepliesIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 22, height: 22 }}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
)

const AlertsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 22, height: 22 }}>
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
)

const ControlsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 22, height: 22 }}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.07 4.93L5.93 18.07M4.93 4.93l14.14 14.14" strokeWidth="0" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
)

const TAB_ICONS: Record<Tab, () => React.ReactElement> = {
  inbox: InboxIcon,
  queue: QueueIcon,
  replies: RepliesIcon,
  alerts: AlertsIcon,
  controls: ControlsIcon,
}


export const MobileCommandCenter = () => {
  const [activeTab, setActiveTab] = useState<Tab>('inbox')
  const [badges, setBadges] = useState<Partial<Record<Tab, number>>>({})

  const setInboxBadge = useCallback((count: number) => {
    setBadges(prev => count > 0 ? { ...prev, inbox: count } : { ...prev, inbox: undefined })
  }, [])

  const tabTitle: Record<Tab, string> = {
    inbox: 'Inbox',
    queue: 'Operations Queue',
    replies: 'Reply Center',
    alerts: 'System Alerts',
    controls: 'Command Controls',
  }

  return (
    <div className="nx-mobile">
      {/* Status bar */}
      <div className="nx-mobile-statusbar">
        <span className="nx-mobile-statusbar__brand">NEXUS MOBILE</span>
        <div className="nx-mobile-statusbar__right">
          <span className="nx-m-live-dot" />
          <span className="nx-mobile-statusbar__badge is-ok">LIVE</span>
        </div>
      </div>

      {/* Command bar */}
      <div className="nx-mobile-cmdbar">
        <span className="nx-mobile-cmdbar__title">{tabTitle[activeTab]}</span>
        {activeTab === 'inbox' && (
          <button className="nx-mobile-cmdbar__action is-primary" onClick={() => {}}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            Compose
          </button>
        )}
        {activeTab === 'queue' && (
          <button className="nx-mobile-cmdbar__action" onClick={() => window.dispatchEvent(new CustomEvent('mobile-queue-refresh'))}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
        )}
        {activeTab === 'alerts' && (
          <button className="nx-mobile-cmdbar__action is-danger" onClick={() => {}}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Ack All
          </button>
        )}
      </div>

      {/* Tab content */}
      <div className="nx-mobile-content">
        {activeTab === 'inbox' && <MobileInboxTab onNewReplyCount={setInboxBadge} />}
        {activeTab === 'queue' && <MobileQueueTab />}
        {activeTab === 'replies' && <MobileRepliesTab />}
        {activeTab === 'alerts' && <MobileAlertsTab />}
        {activeTab === 'controls' && <MobileControlsTab />}
      </div>

      {/* Bottom nav */}
      <nav className="nx-mobile-nav">
        {TAB_META.map(({ id, label }) => {
          const TabIcon = TAB_ICONS[id]
          const badge = badges[id]
          return (
            <button
              key={id}
              className={`nx-mobile-nav__item ${activeTab === id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(id)}
            >
              <div className="nx-mobile-nav__icon">
                <TabIcon />
                {badge && badge > 0 && (
                  <span className="nx-mobile-nav__badge">{badge > 99 ? '99+' : badge}</span>
                )}
              </div>
              <span className="nx-mobile-nav__label">{label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
