import React, { useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'

interface TimelineIntelligencePanelProps {
  thread: InboxWorkflowThread | null
}

type TabName = 'Timeline' | 'Thread' | 'Property' | 'Owner' | 'AI' | 'Activity'

interface TimelineEventDef {
  id: string
  threadId: string
  entityType: string
  eventType: string
  title: string
  summary: string
  timestamp: string
  source: string
  severity: string
  icon: IconName
}

export const TimelineIntelligencePanel: React.FC<TimelineIntelligencePanelProps> = ({ thread }) => {
  const [activeTab, setActiveTab] = useState<TabName>('Timeline')

  if (!thread) {
    return (
      <div className="nx-timeline-panel nx-timeline-panel--empty">
        <Icon name="inbox" />
        <p>Select a thread to view timeline intelligence</p>
      </div>
    )
  }

  const events: TimelineEventDef[] = [
    {
      id: '1', threadId: thread.id, entityType: 'operator', eventType: 'First Touch Sent',
      title: 'First Touch Sent', summary: 'Template: Local Investor Intro | Agent: Aaron',
      timestamp: new Date(Date.now() - 86400000).toISOString(),
      source: 'Operator', severity: 'neutral', icon: 'send'
    },
    {
      id: '2', threadId: thread.id, entityType: 'sms', eventType: 'Delivered',
      title: 'Delivered', summary: 'Carrier confirmed delivered',
      timestamp: new Date(Date.now() - 86300000).toISOString(),
      source: 'TextGrid', severity: 'positive', icon: 'check'
    },
    {
      id: '3', threadId: thread.id, entityType: 'sms', eventType: 'Seller Replied',
      title: 'Seller Replied', summary: '"Are you still buying duplexes?"',
      timestamp: new Date(Date.now() - 82000000).toISOString(),
      source: 'TextGrid', severity: 'positive', icon: 'message'
    },
    {
      id: '4', threadId: thread.id, entityType: 'ai', eventType: 'AI Classification',
      title: 'AI Classification', summary: 'Warm Seller • Confidence: 91%',
      timestamp: new Date(Date.now() - 81900000).toISOString(),
      source: 'AI Router', severity: 'neutral', icon: 'brain'
    },
    {
      id: '5', threadId: thread.id, entityType: 'stage', eventType: 'Stage Updated',
      title: 'Stage Updated', summary: 'S1 → S2',
      timestamp: new Date(Date.now() - 81900000).toISOString(),
      source: 'Workflow Engine', severity: 'positive', icon: 'trending-up'
    },
    {
      id: '6', threadId: thread.id, entityType: 'ai', eventType: 'AI Notes',
      title: 'AI Notes', summary: 'Seller responded quickly. Asked engagement question. Likely active owner.',
      timestamp: new Date(Date.now() - 81800000).toISOString(),
      source: 'Context Engine', severity: 'neutral', icon: 'file-text'
    },
    {
      id: '7', threadId: thread.id, entityType: 'queue', eventType: 'Follow-Up Scheduled',
      title: 'Follow-Up Scheduled', summary: 'Next Day 9:00 AM',
      timestamp: new Date(Date.now() - 81800000).toISOString(),
      source: 'Queue', severity: 'warning', icon: 'clock'
    },
  ]

  const getEventColor = (ev: TimelineEventDef): string => {
    if (ev.eventType === 'Seller Replied') return 'nx-timeline-node--green'
    if (ev.eventType.includes('Sent') || ev.eventType === 'Delivered') return 'nx-timeline-node--blue'
    if (ev.entityType === 'ai') return 'nx-timeline-node--purple'
    if (ev.severity === 'warning') return 'nx-timeline-node--yellow'
    if (ev.severity === 'critical') return 'nx-timeline-node--red'
    return 'nx-timeline-node--neutral'
  }

  return (
    <div className="nx-timeline-panel">
      <header className="nx-timeline-panel__header">
        <div className="nx-timeline-panel__header-top">
          <h3>{(thread as any).sellerName || (thread as any).ownerName || 'Unknown Seller'}</h3>
          <button className="nx-timeline-panel__action"><Icon name="more" /></button>
        </div>
        <nav className="nx-timeline-panel__tabs">
          {(['Timeline', 'Thread', 'Property', 'Owner', 'AI', 'Activity'] as TabName[]).map(tab => (
            <button
              key={tab}
              className={`nx-timeline-panel__tab ${activeTab === tab ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>
      </header>

      <div className="nx-timeline-panel__body">
        {activeTab === 'Timeline' && (
          <div className="nx-timeline-feed">
            {events.map((ev, i) => (
              <div key={ev.id} className="nx-timeline-item">
                <div className={`nx-timeline-node ${getEventColor(ev)}`}>
                  <Icon name={ev.icon} />
                </div>
                <div className="nx-timeline-content">
                  <div className="nx-timeline-content-header">
                    <strong>{ev.title}</strong>
                    <time>{new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </div>
                  <p>{ev.summary}</p>
                </div>
                {i < events.length - 1 && <div className={`nx-timeline-connector ${getEventColor(ev)}`} />}
              </div>
            ))}
          </div>
        )}
        {activeTab !== 'Timeline' && (
          <div className="nx-timeline-panel__placeholder">
            <Icon name="grid" />
            <p>{activeTab} Intelligence coming soon...</p>
          </div>
        )}
      </div>
    </div>
  )
}
