/**
 * Queue dispatch (mobile) — model + render contract.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { QueueItem } from '../../../domain/queue/queue.types'
import {
  SEGMENTS,
  assetLine,
  dispatchReason,
  dispatchRecovery,
  dispatchStatus,
  dispatchWhen,
  localWhen,
  segmentOf,
  summarySentence,
} from './queue-dispatch-model'
import { QueueDispatchCard, QueueDispatchMobile } from './QueueDispatchMobile'

;(globalThis as any).React = React

const row = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 'q1', queueId: 'q1', sellerName: 'Jerline Jacobs', sellerDisplayName: 'Jerline Jacobs', propertyAddress: '3407 Breckenridge Dr',
  propertyCity: 'Houston', propertyState: 'TX', toPhoneNumber: '+18329284333', phone: '+18329284333', fromPhoneNumber: '+18325550100',
  status: 'scheduled', queueStatusRaw: 'scheduled', timezone: 'America/Chicago', touchNumber: 1, retryCount: 0, maxRetries: 3,
  messageText: 'Hi Jerline, my name is Alex. Came across 3407 Breckenridge Dr, are you still the owner?',
  scheduledForUtc: '2026-09-25T17:10:00Z', scheduledForLocal: '2026-09-25T17:10:00Z', updatedAt: '2026-09-25T07:00:00Z',
  sentAt: null, deliveredAt: null, metadata: {}, market: 'Houston, TX', templateName: '', linkedPropertyId: null,
  ...over,
} as unknown as QueueItem)

const NOW = new Date('2026-09-25T08:00:00Z')

describe('segments come from the real status vocabulary', () => {
  it('maps every production status into exactly one segment', () => {
    const cases: Array<[string, string]> = [
      ['queued', 'ready'], ['ready', 'ready'], ['pending', 'ready'], ['approved', 'ready'],
      ['scheduled', 'scheduled'],
      ['sending', 'sending'], ['processing', 'sending'],
      ['failed', 'attention'], ['failed_transport', 'attention'], ['blocked', 'attention'],
      ['blocked_by_health_guard', 'attention'], ['paused_operator_review', 'attention'], ['approval', 'attention'],
      ['sent', 'history'], ['delivered', 'history'], ['cancelled', 'history'], ['expired', 'history'], ['replied_before_send', 'history'],
    ]
    for (const [raw, seg] of cases) expect(segmentOf(row({ queueStatusRaw: raw }))).toBe(seg)
  })

  it('offers five segments in operator order', () => {
    expect(SEGMENTS.map((s) => s.key)).toEqual(['ready', 'scheduled', 'sending', 'attention', 'history'])
  })
})

describe('reasons are human, and specific', () => {
  it('names the asset/template guard "Template mismatch"', () => {
    const r = dispatchReason(row({ status: 'blocked', queueStatusRaw: 'blocked', guardReason: 'template_asset_incompatible' }))
    expect(r?.title).toBe('Template mismatch')
    expect(r?.code).toBe('template_asset_incompatible')
  })
  it('reads the raw status when the reason columns are empty', () => {
    expect(dispatchReason(row({ status: 'blocked', queueStatusRaw: 'blocked_by_health_guard' }))?.title).toBe('Sender cooling down')
  })
  it('marks compliance outcomes permanent', () => {
    const r = dispatchReason(row({ status: 'failed', queueStatusRaw: 'failed', failedReason: 'Blacklist rule 21610' }))
    expect(r?.permanent).toBe(true)
  })
  it('does not call blocked_sender_number a missing template', () => {
    expect(dispatchReason(row({ status: 'blocked', queueStatusRaw: 'blocked', blockedReason: 'blocked_sender_number' }))?.title).toBe('No eligible sender')
  })
  it('live rows carry no failure reason', () => {
    expect(dispatchReason(row())).toBeNull()
  })
})

describe('recovery is one communication', () => {
  it('a content-filter failover that delivered reads "Recovered automatically"', () => {
    const r = dispatchRecovery(row({ status: 'delivered', queueStatusRaw: 'delivered', metadata: { same_stage_failover: true } }))
    expect(r?.kind).toBe('recovered')
  })
  it('an asset reselection reads "Template corrected"', () => {
    expect(dispatchRecovery(row({ metadata: { template_reselection_reason: 'asset_type_incompatible' } }))?.title).toBe('Template corrected')
  })
})

describe('time is the property’s local time, with the zone named', () => {
  it('Chicago and Los Angeles rows show their own clocks', () => {
    expect(localWhen('2026-09-25T17:10:00Z', 'America/Chicago', NOW)).toBe('Today 12:10 PM CDT')
    expect(localWhen('2026-09-25T17:10:00Z', 'America/Los_Angeles', NOW)).toBe('Today 10:10 AM PDT')
    expect(localWhen('2026-09-26T15:00:00Z', 'America/New_York', NOW)).toBe('Tomorrow 11:00 AM EDT')
  })
  it('a scheduled row leads with when, then how long until', () => {
    const w = dispatchWhen(row(), NOW)
    expect(w.primary).toBe('Today 12:10 PM CDT')
    expect(w.secondary).toBe('in 9h 10m')
  })
})

describe('status + summary', () => {
  it('failed_transport is Failed, blocked is Held', () => {
    expect(dispatchStatus(row({ status: 'failed', queueStatusRaw: 'failed_transport' })).label).toBe('Failed')
    expect(dispatchStatus(row({ status: 'blocked', queueStatusRaw: 'blocked' })).label).toBe('Held')
  })
  it('header sentence omits empty buckets', () => {
    expect(summarySentence({ ready: 0, scheduled: 34, sending: 0, attention: 105, history: 23 })).toBe('34 scheduled · 105 attention')
    expect(summarySentence({ ready: 0, scheduled: 0, sending: 0, attention: 0, history: 3 })).toBe('Nothing waiting to send')
  })
  it('asset line includes units when known', () => {
    expect(assetLine(row({ assetLabel: 'Apartment Building', unitsCount: 8 }))).toBe('Apartment Building · 8 units')
  })
})

describe('render', () => {
  it('a card shows who, where, what, when, from and status', () => {
    const html = renderToStaticMarkup(<QueueDispatchCard item={row()} isOpen={false} onOpen={() => {}} />)
    expect(html).toContain('Jerline Jacobs')
    expect(html).toContain('3407 Breckenridge Dr · Houston, TX')
    expect(html).toContain('are you still the owner?')
    expect(html).toContain('Scheduled')
    expect(html).toContain('··0100')
  })
  it('a template-mismatch row says so on the card', () => {
    const html = renderToStaticMarkup(<QueueDispatchCard item={row({ status: 'blocked', queueStatusRaw: 'blocked', guardReason: 'template_asset_incompatible' })} isOpen={false} onOpen={() => {}} />)
    expect(html).toContain('Template mismatch')
    expect(html).toContain('Held')
  })
  it('segment tabs carry the server counts; the empty Ready state points at scheduled work', () => {
    const html = renderToStaticMarkup(
      <QueueDispatchMobile
        items={[]} segment="ready" counts={{ ready: 0, scheduled: 34, sending: 0, attention: 105, history: 23 }}
        totalCount={0} loading={false} search="" rangeLabel="7d" activeFilters={0} openId={null}
        hasMore={false} loadingMore={false} onSegment={() => {}} onSearch={() => {}} onOpen={() => {}}
        onOpenFilters={() => {}} onOpenViews={() => {}} onRefresh={() => {}} onLoadMore={() => {}}
      />,
    )
    for (const key of ['ready', 'scheduled', 'sending', 'attention', 'history']) expect(html).toContain(`data-queue-segment="${key}"`)
    expect(html).toContain('34 scheduled · 105 attention')
    expect(html).toContain('Nothing waiting on the processor')
    expect(html).toContain('34 scheduled')
  })
})

// ── Analytics views ──────────────────────────────────────────────────────────
import { deriveFailureCause, buildFailureStats } from '../failure-taxonomy-stats'
import { QueueFailuresView, QueueEventsView } from './QueueSections'
import { QueueShell } from './QueueShell'

const shell = { onView: () => {}, counts: { ready: 0, scheduled: 34, sending: 0, attention: 3, history: 1 }, loading: false, onRefresh: () => {} }
const failedManual = row({ id: 'm1', status: 'failed', queueStatusRaw: 'failed_transport', failureCategory: 'missing_template', diagnosticFlags: [], failedReason: 'timeout', metadata: { manual_inbox_send: true }, templateId: null } as any)
const heldHealth = row({ id: 'h1', status: 'blocked', queueStatusRaw: 'blocked_by_health_guard', failureCategory: null, diagnosticFlags: [] } as any)
const failedPlain = row({ id: 'f1', status: 'failed', queueStatusRaw: 'failed', failureCategory: 'textgrid_content_filter', diagnosticFlags: [] } as any)

describe('failures count every failed or held row', () => {
  it('a failed manual send is classified from what happened, not dropped as "missing template"', () => {
    expect(deriveFailureCause(failedManual)).toBe('carrier_failure')
    expect(deriveFailureCause(heldHealth)).toBe('blocked_sender_ineligible')
    expect(deriveFailureCause(failedPlain)).toBe('textgrid_content_filter')
  })
  it('the Failures total equals the failed + held rows it was given', () => {
    const stats = buildFailureStats([failedManual, heldHealth, failedPlain, row()])
    expect(stats.reduce((n, s) => n + s.count, 0)).toBe(3)
    const html = renderToStaticMarkup(
      <QueueFailuresView shell={shell} items={[failedManual, heldHealth, failedPlain, row()]} loading={false} rangeLabel="7d" onOpenItem={() => {}} onViewRows={() => {}} />,
    )
    expect(html).toContain('Failed or held')
    expect(html).toContain('Across 4 queue rows · 7d')
  })
})

describe('one shell for every Queue view', () => {
  it('renders the six views on the rail and marks the active one', () => {
    const html = renderToStaticMarkup(<QueueShell {...shell} view="events"><div /></QueueShell>)
    for (const v of ['dispatch', 'events', 'failures', 'market', 'senders', 'templates']) expect(html).toContain(`data-queue-view="${v}"`)
    expect(html).toMatch(/aria-selected="true"[^>]*data-queue-view="events"/)
    expect(html).toContain('34 scheduled · 3 attention')
  })
  it('events read the rows handed to them, not a page', () => {
    const html = renderToStaticMarkup(
      <QueueEventsView shell={shell} items={[failedPlain, heldHealth, row({ id: 'd1', status: 'delivered', queueStatusRaw: 'delivered', deliveredAt: '2026-09-25T07:00:00Z' } as any)]} loading={false} rangeLabel="7d" openId={null} onOpen={() => {}} />,
    )
    expect(html).toContain('3 events · 7d')
    expect(html).toContain('data-section-row')
  })
})
