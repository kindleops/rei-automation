import { describe, expect, it } from 'vitest'
import {
  isProofTestQueueItem,
  metadataMarksProof,
  resolveQueueDeliveryTruth,
  resolveTouchStageDisplay,
  resolveDrawerCloseState,
  shouldReopenDossierFromContext,
} from '../../src/domain/queue/queue-status-truth'
import { resolveQueueDispatchTruth } from '../../src/domain/queue/queue-dispatch-truth'
import { resolveStatusPresentation } from '../../src/views/queue/queue-ui-helpers'
import type { QueueItem } from '../../src/domain/queue/queue.types'

const past = new Date(Date.now() - 60_000).toISOString()

// Minimal QueueItem factory for integration-level assertions.
function mkItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: 'q1', queueId: 'q1', sellerName: 'Seller', sellerDisplayName: 'Seller',
    propertyAddress: '1 Main St', market: 'Dallas', phone: '+15550000000',
    toPhoneNumber: '+15550000000', fromPhoneNumber: '+15551110000', agent: 'NEXUS',
    templateName: 'T', templateId: 't1', selectedTemplateId: 't1', templateSource: 'system',
    useCase: 'listing', stage: 'lead', stageBefore: null, stageAfter: null,
    stageCode: null, stageLabel: null, messageText: 'hi',
    scheduledForLocal: past, scheduledForUtc: past, timezone: 'America/Chicago',
    contactWindow: 'flexible', status: 'queued', statusLabel: 'Queued', priority: 'P2',
    touchNumber: 1, language: 'en', retryCount: 0, maxRetries: 3, failureReason: null,
    failedReason: null, pausedReason: null, blockedReason: null, deliveryStatus: 'pending',
    createdAt: past, updatedAt: past, sentAt: null, deliveredAt: null,
    approvedByOperator: null, requiresApproval: false, riskLevel: 'low', aiConfidence: 70,
    estimatedCost: 0.01, textgridNumber: '+15551110000', linkedInboxThreadId: null,
    linkedPropertyId: null, linkedOwnerId: null, propertyType: null, safetyStatus: null,
    routingAllowed: true, smsEligible: true, providerMessageId: null, textgridMessageId: null,
    messageEventId: null, missingMessageEvent: false, missingProviderMessageId: false,
    overdue: false, metadata: {}, sellerTemperature: 'unknown', currentStage: '',
    nextBestAction: null, memoryStatus: 'none', urgencyScore: 0, extractedIntent: null,
    routingReason: null, failureGroup: null, retryEligible: true, approvalReason: null,
    priorThreadSummary: null, campaignId: null, campaignName: null, campaignTargetId: null,
    campaignTargetStatus: null, sellerFirstName: null, sellerFullName: 'Seller',
    propertyCity: null, propertyState: null, propertyZip: null, routingTier: null,
    routingRuleName: null, lastEventType: null, lastEventAt: null, lastEventStatus: null,
    failureCategory: null, diagnosticFlags: [], rowSource: 'campaign', guardReason: null,
    automationSource: null, workflowId: null, queueKey: 'q1',
    ...overrides,
  }
}

describe('queue proof/test classification (§1)', () => {
  it('1. sms_eligible=false alone does NOT classify as Proof/Test', () => {
    const truth = resolveQueueDispatchTruth({ status: 'queued', scheduledForUtc: past, smsEligible: false, metadata: {} })
    expect(truth.category).not.toBe('proof')
    expect(truth.category).toBe('runnable')
    expect(isProofTestQueueItem({ metadata: {}, dispatchCategory: 'runnable' })).toBe(false)
  })

  it('2. dry_run=true classifies as Proof/Test', () => {
    expect(metadataMarksProof({ dry_run: true })).toBe(true)
    expect(resolveQueueDispatchTruth({ status: 'queued', scheduledForUtc: past, metadata: { dry_run: true } }).category).toBe('proof')
  })

  it('3. proof_mode=true classifies as Proof/Test', () => {
    expect(metadataMarksProof({ proof_mode: true })).toBe(true)
    expect(resolveQueueDispatchTruth({ status: 'queued', scheduledForUtc: past, metadata: { proof_mode: true } }).category).toBe('proof')
  })

  it('4. no_sms_transmit=true classifies as Proof/Test', () => {
    expect(metadataMarksProof({ no_sms_transmit: true })).toBe(true)
    expect(metadataMarksProof({ test_mode: 'true' })).toBe(true)
    expect(resolveQueueDispatchTruth({ status: 'queued', scheduledForUtc: past, metadata: { no_sms_transmit: true } }).category).toBe('proof')
  })

  it('10. proof/test rows are excluded from the default live queue predicate', () => {
    const items = [
      mkItem({ id: 'proof', metadata: { proof_hydration: true }, dispatchCategory: 'proof' }),
      mkItem({ id: 'live', metadata: {}, dispatchCategory: 'runnable' }),
    ]
    const live = items.filter((i) => !isProofTestQueueItem(i))
    expect(live.map((i) => i.id)).toEqual(['live'])
    const proofOnly = items.filter((i) => isProofTestQueueItem(i))
    expect(proofOnly.map((i) => i.id)).toEqual(['proof'])
  })
})

describe('canonical queue status priority (§2/§3)', () => {
  it('5. sent + failed_reason displays Failed, not Sent', () => {
    const t = resolveQueueDeliveryTruth({ status: 'sent', failedReason: 'carrier_error' })
    expect(t.status).toBe('Failed')
    expect(t.isFailed).toBe(true)
    expect(t.isDelivered).toBe(false)
    expect(t.diagnostics).toContain('sent_with_failed_reason')
    // Integration: render layer surfaces the same truth.
    const pres = resolveStatusPresentation(mkItem({ status: 'sent', failedReason: 'carrier_error', providerMessageId: 'pm1' }))
    expect(pres.primary).toBe('Failed')
  })

  it('5b. content-filter failure is shown as Blocked / Content Filter', () => {
    const t = resolveQueueDeliveryTruth({ status: 'sent', failedReason: 'Blocked by TextGrid content filter', failureCategory: 'textgrid_content_filter' })
    expect(t.status).toBe('Blocked / Content Filter')
    expect(t.isBlocked).toBe(true)
  })

  it('6. delivered provider receipt displays Delivered', () => {
    expect(resolveQueueDeliveryTruth({ status: 'sent', lastEventStatus: 'delivered' }).status).toBe('Delivered')
    expect(resolveQueueDeliveryTruth({ status: 'delivered', deliveredAt: past }).isDelivered).toBe(true)
  })

  it('7. provider failed receipt overrides queue_status sent', () => {
    const t = resolveQueueDeliveryTruth({ status: 'sent', lastEventStatus: 'failed', providerMessageId: 'pm1' })
    expect(t.status).toBe('Failed')
    expect(t.isFailed).toBe(true)
  })

  it('8. missing provider id is a diagnostic, not delivery success', () => {
    const t = resolveQueueDeliveryTruth({ status: 'sent', providerMessageId: null, textgridMessageId: null })
    expect(t.status).toBe('Missing Provider ID')
    expect(t.isDelivered).toBe(false)
    expect(t.severity).toBe('diagnostic')
    expect(t.diagnostics).toContain('provider_id_missing')
  })

  it('9. missing message_event surfaces as a diagnostic, not delivered', () => {
    const t = resolveQueueDeliveryTruth({ status: 'sent', providerMessageId: 'pm1', missingMessageEvent: true })
    expect(t.isDelivered).toBe(false)
    expect(t.diagnostics).toContain('message_event_missing')
  })
})

describe('touch/stage display truth (§1.6)', () => {
  it('11. does not assert T1/ownership when canonical stage says negotiation', () => {
    const d = resolveTouchStageDisplay({
      stageCode: 'S1', stageLabel: null, stage: 'lead', currentStage: 'Negotiation',
      touchNumber: 1, useCase: 'listing', metadata: { seller_stage: 'offer_negotiation' }, extractedIntent: null,
    })
    expect(d.stageLabel).not.toBe('Ownership Confirmation')
    expect(d.stageLabel).toBe('Offer & Negotiation')
    expect(d.touchLabel).not.toBe('T1')
    expect(d.ambiguous).toBe(true)
  })

  it('11b. trusts an explicit ownership-check touch number', () => {
    const d = resolveTouchStageDisplay({
      stageCode: 'S1', stageLabel: 'Ownership Confirmation', stage: 'ownership', currentStage: '',
      touchNumber: 1, useCase: 'ownership_check',
      metadata: { action: 'send_ownership_check', source: 'map_command', touch_number: 1 }, extractedIntent: null,
    })
    expect(d.stageLabel).toBe('Ownership Confirmation')
    expect(d.touchLabel).toBe('T1')
  })
})

describe('queue drawer close (§7)', () => {
  it('12. close clears the selected item and collapses the dossier', () => {
    expect(resolveDrawerCloseState()).toEqual({ selectedId: null, expandedId: null, dossierOpen: false })
  })

  it('12b. a dismissed row is not reopened by the context effect', () => {
    expect(shouldReopenDossierFromContext('row-1', 'row-1')).toBe(false)
    expect(shouldReopenDossierFromContext('row-1', 'row-2')).toBe(true)
    expect(shouldReopenDossierFromContext(null, 'row-2')).toBe(true)
    expect(shouldReopenDossierFromContext('row-1', null)).toBe(false)
  })
})
