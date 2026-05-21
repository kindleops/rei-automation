/**
 * NEXUS Briefing Panel — Operator Briefing Mode
 *
 * A cinematic full-screen overlay that summarizes what changed,
 * what's hot, what needs attention, and recommended next moves.
 *
 * Activated via `⌘.` or the briefing button in the command strip.
 * Auto-generates a briefing digest from the current data context.
 */

import { useEffect, useRef } from 'react'
import { Icon } from './icons'
import { playSound } from './sounds'

export interface BriefingDigest {
  timestamp: Date
  sections: BriefingSection[]
}

export interface BriefingSection {
  id: string
  label: string
  icon: string
  tone: 'nominal' | 'elevated' | 'critical'
  items: BriefingItem[]
}

export interface BriefingItem {
  id: string
  text: string
  detail?: string
  metric?: string
  tone?: 'good' | 'warn' | 'bad' | 'neutral'
}

interface BriefingPanelProps {
  open: boolean
  digest: BriefingDigest | null
  onClose: () => void
}

const toneClass: Record<BriefingSection['tone'], string> = {
  nominal: 'is-nominal',
  elevated: 'is-elevated',
  critical: 'is-critical',
}

const itemToneClass: Record<NonNullable<BriefingItem['tone']>, string> = {
  good: 'is-good',
  warn: 'is-warn',
  bad: 'is-bad',
  neutral: 'is-neutral',
}

export const BriefingPanel = ({ open, digest, onClose }: BriefingPanelProps) => {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    playSound('notification')

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    if (open) panelRef.current?.scrollTo({ top: 0 })
  }, [open])

  if (!open || !digest) return null

  return (
    <div className="nx-briefing-overlay">
      <div className="nx-briefing" ref={panelRef} role="dialog" aria-label="Operator Briefing">
        <header className="nx-briefing__header">
          <div className="nx-briefing__title-row">
            <Icon name="radar" className="nx-briefing__icon" />
            <div>
              <h1 className="nx-briefing__title">Operator Briefing</h1>
              <span className="nx-briefing__time">
                {digest.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {digest.timestamp.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
          <button type="button" className="nx-briefing__close" onClick={onClose}>
            <Icon name="close" className="nx-briefing__close-icon" />
            <kbd>ESC</kbd>
          </button>
        </header>

        <div className="nx-briefing__body">
          {digest.sections.map((section) => (
            <section key={section.id} className={`nx-briefing-section ${toneClass[section.tone]}`}>
              <div className="nx-briefing-section__header">
                <Icon name={section.icon as Parameters<typeof Icon>[0]['name']} className="nx-briefing-section__icon" />
                <h2 className="nx-briefing-section__label">{section.label}</h2>
                <span className={`nx-briefing-section__tone ${toneClass[section.tone]}`}>
                  {section.tone.toUpperCase()}
                </span>
              </div>
              <div className="nx-briefing-section__items">
                {section.items.map((item) => (
                  <div key={item.id} className={`nx-briefing-item ${item.tone ? itemToneClass[item.tone] : ''}`}>
                    <span className="nx-briefing-item__text">{item.text}</span>
                    {item.detail && <span className="nx-briefing-item__detail">{item.detail}</span>}
                    {item.metric && <span className="nx-briefing-item__metric">{item.metric}</span>}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="nx-briefing__footer">
          <span className="nx-briefing__hint">Press <kbd>ESC</kbd> to dismiss</span>
          <button type="button" className="nx-briefing__action" onClick={onClose}>
            Dashboard
          </button>
        </footer>
      </div>
    </div>
  )
}

// ── Briefing digest builder ───────────────────────────────────────────────
// Constructs a BriefingDigest from live dashboard data.

export function buildBriefingDigest(data: {
  hotLeadCount: number
  warmLeadCount: number
  totalLeads: number
  activeAlerts: number
  criticalAlerts: number
  activeMarkets: number
  healthLabel: string
  pipelineValue: string
  agentsActive: number
  autopilotActions: number
  unreadInbox: number
}): BriefingDigest {
  const sections: BriefingSection[] = []

  // Operations overview
  sections.push({
    id: 'ops',
    label: 'Operations Overview',
    icon: 'shield',
    tone: data.criticalAlerts > 0 ? 'critical' : data.activeAlerts > 3 ? 'elevated' : 'nominal',
    items: [
      { id: 'health', text: 'System Health', detail: data.healthLabel, tone: 'good' },
      { id: 'markets', text: 'Active Markets', metric: `${data.activeMarkets}`, tone: 'neutral' },
      { id: 'pipeline', text: 'Pipeline Value', metric: data.pipelineValue, tone: 'good' },
      { id: 'agents', text: 'AI Agents Active', metric: `${data.agentsActive}`, tone: 'neutral' },
    ],
  })

  // Lead intelligence
  sections.push({
    id: 'leads',
    label: 'Lead Intelligence',
    icon: 'target',
    tone: data.hotLeadCount > 5 ? 'elevated' : 'nominal',
    items: [
      { id: 'hot', text: 'Hot Leads', metric: `${data.hotLeadCount}`, tone: data.hotLeadCount > 0 ? 'warn' : 'good' },
      { id: 'warm', text: 'Warm Leads', metric: `${data.warmLeadCount}`, tone: 'neutral' },
      { id: 'total', text: 'Total Pipeline', metric: `${data.totalLeads}`, tone: 'neutral' },
    ],
  })

  // Threat assessment
  if (data.activeAlerts > 0) {
    sections.push({
      id: 'threats',
      label: 'Threat Assessment',
      icon: 'alert',
      tone: data.criticalAlerts > 0 ? 'critical' : 'elevated',
      items: [
        { id: 'critical', text: 'Critical Alerts', metric: `${data.criticalAlerts}`, tone: data.criticalAlerts > 0 ? 'bad' : 'good' },
        { id: 'active', text: 'Active Alerts', metric: `${data.activeAlerts}`, tone: data.activeAlerts > 5 ? 'warn' : 'neutral' },
      ],
    })
  }

  // AI & Automation
  sections.push({
    id: 'ai',
    label: 'AI & Automation',
    icon: 'spark',
    tone: 'nominal',
    items: [
      { id: 'autopilot', text: 'Autopilot Actions', detail: 'Pending review', metric: `${data.autopilotActions}`, tone: data.autopilotActions > 0 ? 'warn' : 'good' },
      { id: 'inbox', text: 'Unread Comms', metric: `${data.unreadInbox}`, tone: data.unreadInbox > 10 ? 'warn' : 'neutral' },
    ],
  })

  return {
    timestamp: new Date(),
    sections,
  }
}
