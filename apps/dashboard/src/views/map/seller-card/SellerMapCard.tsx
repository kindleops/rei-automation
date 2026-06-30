import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { ThreadContext } from '../../../lib/data/inboxData'
import { Composer } from '../../../modules/inbox/components/Composer'
import { MobileBottomSheet, type BottomSheetSnap } from '../../../modules/mobile/MobileBottomSheet'
import { useBreakpoint } from '../../../modules/mobile/useBreakpoint'
import {
  LIFECYCLE_STAGE_META,
  LEAD_TEMPERATURE_META,
  OPERATIONAL_STATUS_META,
} from '../../../domain/lead-state/universal-lead-state-registry'
import { buildSellerMapCardViewModel } from './seller-map-card-view-model'
import { getSellerMapCardLayoutMode, getSellerMapCardStyle } from './seller-map-card-positioning'
import type { SellerMapCardMode } from './seller-map-card.types'
import { buildThreadFromViewModel, useSellerMapCardActions } from './useSellerMapCardActions'
import { useSellerMapCardConversation } from './useSellerMapCardConversation'
import { SellerMapCardPriorityRing } from './SellerMapCardPriorityRing'
import { SellerMapCardThreadList } from './SellerMapCardThreadList'
import { SellerMapCardConversationSkeleton } from './SellerMapCardConversationSkeleton'
import '../../../modules/inbox/conversation-composer-premium.css'
import '../../../modules/inbox/conversation-live.css'
import './seller-map-card.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const SELLER_SHEET_SNAP_HEIGHTS = {
  collapsed: '31dvh',
  half: '46dvh',
  expanded: '60dvh',
} as const

const SELLER_COMPOSER_SHEET_SNAP_HEIGHTS = {
  collapsed: '31dvh',
  half: '46dvh',
  expanded: '72dvh',
} as const

const snapFromCardMode = (mode: SellerMapCardMode): BottomSheetSnap => (
  mode === 'peek' ? 'collapsed' : 'expanded'
)

const cardModeFromSnap = (snap: BottomSheetSnap, current: SellerMapCardMode): SellerMapCardMode => {
  if (current === 'conversation') return 'conversation'
  if (snap === 'collapsed') return 'peek'
  return 'focus'
}

const followUpButtonLabel = (
  state: string,
  eligibilityLabel: string,
): string => {
  if (state === 'sending') return 'Sending…'
  if (state === 'sent') return 'Sent ✓'
  if (state === 'blocked') return eligibilityLabel
  if (state === 'failed') return 'Failed'
  return eligibilityLabel
}

export const SellerMapCard = ({
  record,
  mode,
  anchor,
  containerSize,
  draftText = '',
  onDraftChange,
  onClose,
  onPeekToFocus,
  onMouseEnter,
  onMouseLeave,
  onActivityRefresh,
}: {
  record: Record<string, unknown>
  mode: SellerMapCardMode
  anchor: { x: number; y: number } | null
  containerSize: { width: number; height: number }
  messages?: never
  messagesLoading?: never
  draftText?: string
  onDraftChange?: (value: string) => void
  threadContext?: never
  onClose?: () => void
  onPeekToFocus?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onActivityRefresh?: () => void
}) => {
  const { isMobile } = useBreakpoint()
  const [cardMode, setCardMode] = useState<SellerMapCardMode>(mode)
  const [trackedMode, setTrackedMode] = useState(mode)
  const [localDraft, setLocalDraft] = useState(draftText)
  const [trackedDraftText, setTrackedDraftText] = useState(draftText)
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

  if (mode !== trackedMode) {
    setTrackedMode(mode)
    setCardMode(mode)
  }
  if (draftText !== trackedDraftText) {
    setTrackedDraftText(draftText)
    setLocalDraft(draftText)
  }

  const viewModel = useMemo(() => buildSellerMapCardViewModel(record), [record])
  const conversationCacheKey = viewModel.threadKey || viewModel.propertyId
  const isConversation = cardMode === 'conversation'

  const conversationThread = useMemo(
    () => buildThreadFromViewModel(viewModel, record),
    [record, viewModel],
  )

  const {
    messages,
    threadContext,
    loading: conversationLoading,
    error: conversationError,
    refresh: refreshConversation,
  } = useSellerMapCardConversation({
    enabled: isConversation,
    thread: conversationThread,
    cacheKey: conversationCacheKey,
  })

  const {
    thread,
    followUpState,
    isSending,
    isTranslatingDraft,
    executeFollowUp,
    sendMessage,
    sendTemplate,
    queueTemplate,
    translateDraft,
  } = useSellerMapCardActions({
    viewModel,
    record,
    threadContext,
    onActivityRefresh,
    onMessagesRefresh: () => { void refreshConversation() },
  })

  const layoutMode = getSellerMapCardLayoutMode(cardMode)
  const cardStyle = getSellerMapCardStyle(layoutMode, anchor, containerSize, isMobile)
  const isPeek = cardMode === 'peek'
  const [sheetSnap, setSheetSnap] = useState<BottomSheetSnap>(() => snapFromCardMode(cardMode))

  useEffect(() => {
    setSheetSnap(snapFromCardMode(cardMode))
  }, [cardMode])

  const stageColor = LIFECYCLE_STAGE_META[viewModel.operations.stage as keyof typeof LIFECYCLE_STAGE_META]?.color
  const statusColor = OPERATIONAL_STATUS_META[viewModel.operations.status as keyof typeof OPERATIONAL_STATUS_META]?.color
  const tempColor = LEAD_TEMPERATURE_META[viewModel.operations.temperature as keyof typeof LEAD_TEMPERATURE_META]?.color

  const shellStyle = {
    ...cardStyle,
    '--smc-stage-color': stageColor ?? 'var(--map-accent, #64d2ff)',
    '--smc-status-color': statusColor ?? '#94a3b8',
    '--smc-temp-color': tempColor ?? '#94a3b8',
  } as CSSProperties

  const isFocus = cardMode === 'focus'
  const visibleFlags = isPeek ? viewModel.flags.slice(0, 3) : viewModel.flags
  const hiddenFlagCount = isPeek ? Math.max(0, viewModel.flags.length - visibleFlags.length) : 0
  const followUpEligibility = viewModel.followUpEligibility
  const sendingNumber = thread.canonicalE164 || thread.phoneNumber || null

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (isConversation) {
        setCardMode('focus')
        return
      }
      onClose?.()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isConversation, onClose])

  const handleSend = async (text: string) => {
    const result = await sendMessage(text)
    if (result.ok) {
      setLocalDraft('')
      onDraftChange?.('')
    }
  }

  const handleTranslateDraft = async (text: string) => {
    const translated = await translateDraft(text)
    if (translated) {
      setLocalDraft(translated)
      onDraftChange?.(translated)
    }
  }

  const stateBadges = (
    <div className="smc-state-row" aria-label="Canonical lead state">
      <span className="smc-badge smc-badge--stage">{viewModel.operations.stageLabel}</span>
      <span className="smc-badge smc-badge--status">{viewModel.operations.statusLabel}</span>
      <span className="smc-badge smc-badge--temp">{viewModel.operations.temperatureLabel}</span>
      <span className="smc-badge smc-badge--asset">{viewModel.property.assetType}</span>
      {viewModel.property.units != null && viewModel.property.units > 1 ? (
        <span className="smc-badge smc-badge--units">{viewModel.property.units} units</span>
      ) : null}
    </div>
  )

  const mobilePeekPriorityRing = isMobile && isPeek ? (
    <div className="smc-image__priority-glass" aria-label="Seller priority score">
      <SellerMapCardPriorityRing
        score={viewModel.masterOwner.priorityScore}
        tier={null}
        classification={viewModel.masterOwner.priorityClassification}
        size={32}
        showUnscoredLabel={false}
        compact
      />
    </div>
  ) : null

  const imageBlock = viewModel.property.imageUrl ? (
    <div className={cls(
      'smc-image',
      isPeek && 'is-peek',
      !isPeek && 'is-focus',
      isMobile && isPeek && 'is-mobile-hero',
    )}>
      <img src={viewModel.property.imageUrl} alt={viewModel.property.address} loading="lazy" decoding="async" />
      <div className="smc-image__gradient" />
      {mobilePeekPriorityRing}
      {!isPeek && onClose ? (
        <button type="button" className="smc-close" onClick={onClose} aria-label="Close seller card">×</button>
      ) : null}
    </div>
  ) : (
    <div className={cls(
      'smc-image',
      'is-placeholder',
      isPeek && 'is-peek',
      !isPeek && 'is-focus',
      isMobile && isPeek && 'is-mobile-hero',
    )}>
      <span>Property Preview</span>
      {mobilePeekPriorityRing}
      {!isPeek && onClose ? (
        <button type="button" className="smc-close" onClick={onClose} aria-label="Close seller card">×</button>
      ) : null}
    </div>
  )

  const identityHeader = (
    <header className="smc-identity">
      <div className="smc-identity__copy">
        <h3 className="smc-identity__name">{viewModel.masterOwner.displayName}</h3>
        <p className="smc-identity__address" title={viewModel.property.address}>{viewModel.property.address}</p>
      </div>
    </header>
  )

  const metricsBlock = (metrics: typeof viewModel.peekMetrics, variant: 'peek' | 'focus') => (
    <div className={cls('smc-metrics', variant === 'focus' && 'smc-metrics--focus')} aria-label="Primary metrics">
      {metrics.map((metric) => (
        <div key={metric.label} className={cls('smc-metric', metric.emphasis === 'primary' && 'is-primary')}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </div>
      ))}
    </div>
  )

  const intelligenceSection = (
    <section className="smc-intel-section" aria-label="Property intelligence">
      <div className="smc-intel-head">
        <svg className="smc-intel-head__icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.5l5.5 2.2v4.1c0 3.1-2.2 5.4-5.5 6.7C4.7 13.2 2.5 10.9 2.5 7.8V3.7L8 1.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
        <span className="smc-intel-head__label">Property Intelligence</span>
      </div>
      <div className="smc-intel-strip">
        {viewModel.intelligenceStrip.slice(0, 3).map((field) => (
          <div key={field.label} className="smc-intel-strip__cell">
            <span>{field.label}</span>
            <strong>{field.value}</strong>
          </div>
        ))}
        <div className="smc-intel-strip__priority">
          <span>Priority</span>
          <SellerMapCardPriorityRing
            score={viewModel.masterOwner.priorityScore}
            tier={null}
            classification={viewModel.masterOwner.priorityClassification}
            size={44}
            showUnscoredLabel={viewModel.masterOwner.priorityScore == null}
          />
        </div>
      </div>
    </section>
  )

  const contextualLine = viewModel.contextualLine ? (
    <p className="smc-context-line">{viewModel.contextualLine}</p>
  ) : null

  const flagsBlock = visibleFlags.length > 0 ? (
    <div className="smc-flags">
      {visibleFlags.map((flag) => (
        <span key={flag.key} className={cls('smc-flag', `is-${flag.severity}`)}>{flag.label}</span>
      ))}
      {hiddenFlagCount > 0 ? <span className="smc-flag is-more">+{hiddenFlagCount}</span> : null}
    </div>
  ) : null

  const activityBlock = (
    <section className={cls('smc-activity', `is-${viewModel.activity.kind}`)}>
      <div className="smc-activity__head">{viewModel.activity.headline}</div>
      {viewModel.activity.detail ? <p className="smc-activity__copy">{viewModel.activity.detail}</p> : null}
    </section>
  )

  const actionFooter = (
    <footer className="smc-actions">
      {followUpEligibility.visible ? (
        <button
          type="button"
          className={cls(
            'smc-action',
            'smc-action--follow',
            followUpState !== 'idle' && `is-${followUpState}`,
          )}
          disabled={
            !followUpEligibility.canExecute
            || followUpState === 'sending'
          }
          title={followUpEligibility.disabledReason || undefined}
          onClick={() => void executeFollowUp()}
        >
          {followUpButtonLabel(followUpState, followUpEligibility.label)}
        </button>
      ) : (
        <span className="smc-action smc-action--spacer" aria-hidden="true" />
      )}
      <button
        type="button"
        className="smc-action smc-action--message"
        disabled={viewModel.messagingBlocked}
        onClick={() => {
          setCardMode('conversation')
          setSheetSnap('expanded')
        }}
      >
        Message
      </button>
    </footer>
  )

  const peekBody = (
    <>
      {imageBlock}
      <div className="smc-body smc-body--peek">
        {stateBadges}
        {identityHeader}
        <p className="smc-summary">{viewModel.assetSummaryLine}</p>
        {metricsBlock(viewModel.peekMetrics, 'peek')}
        {intelligenceSection}
        {contextualLine}
        {flagsBlock}
        {activityBlock}
      </div>
    </>
  )

  const mobilePeekBody = (
    <>
      {imageBlock}
      <div className="smc-body smc-body--peek smc-body--mobile-peek">
        {identityHeader}
        {viewModel.assetSummaryLine ? (
          <p className="smc-summary smc-summary--physical">{viewModel.assetSummaryLine}</p>
        ) : null}
        {metricsBlock(viewModel.peekMetrics, 'peek')}
      </div>
    </>
  )

  const focusSections = (
    <div className="smc-focus-scroll">
      <section className="smc-section">
        <h4>Property Profile</h4>
        <div className="smc-kv-grid">
          {viewModel.focusProfileFields.map((field) => (
            <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
          ))}
        </div>
      </section>
      {viewModel.focusFinancialFields.length > 0 ? (
        <section className="smc-section">
          <h4>Financial Profile</h4>
          <div className="smc-kv-grid">
            {viewModel.focusFinancialFields.map((field) => (
              <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
            ))}
          </div>
        </section>
      ) : null}
      {viewModel.focusOwnerFields.length > 0 ? (
        <section className="smc-section">
          <h4>Master Owner</h4>
          <div className="smc-kv-grid">
            {viewModel.focusOwnerFields.map((field) => (
              <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
            ))}
          </div>
        </section>
      ) : null}
      {viewModel.focusOperationFields.length > 0 ? (
        <section className="smc-section">
          <h4>Conversation & Automation</h4>
          <div className="smc-kv-grid">
            {viewModel.focusOperationFields.map((field) => (
              <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )

  const focusScrollBody = (
    <>
      <div className="smc-sticky-head">
        {imageBlock}
        <div className="smc-body smc-body--focus-head">
          {stateBadges}
          {identityHeader}
          <p className="smc-summary">{viewModel.assetSummaryLine}</p>
        </div>
      </div>
      <div className="smc-body smc-body--focus">
        {metricsBlock(viewModel.focusMetrics, 'focus')}
        {intelligenceSection}
        {contextualLine}
        {flagsBlock}
        {activityBlock}
        {focusSections}
      </div>
    </>
  )

  const focusBody = (
    <>
      {focusScrollBody}
      {actionFooter}
    </>
  )

  const conversationBody = conversationLoading ? (
    <SellerMapCardConversationSkeleton />
  ) : (
    <div className="smc-sms-pane nx-workspace-pane-surface--sms-thread">
      <div className="smc-conversation nx-conv-live nx-chat-container is-layout-full">
        <header className="smc-conversation__head">
          <div className="smc-conversation__identity">
            <div className="smc-conversation__name">{viewModel.masterOwner.displayName}</div>
            <div className="smc-conversation__addr">{viewModel.property.address}</div>
            <div className="smc-conversation__badges">
              <span className="smc-badge smc-badge--stage">{viewModel.operations.stageLabel}</span>
              <span className="smc-badge smc-badge--status">{viewModel.operations.statusLabel}</span>
              <span className="smc-badge smc-badge--temp">{viewModel.operations.temperatureLabel}</span>
              <span className="smc-badge smc-badge--asset">{viewModel.property.assetType}</span>
            </div>
            <div className="smc-conversation__meta">
              {viewModel.operations.automationState !== 'none' ? (
                <span>{viewModel.operations.automationState}</span>
              ) : null}
              {sendingNumber ? <span>{sendingNumber}</span> : null}
            </div>
          </div>
          <div className="smc-conversation__controls">
            <button
              type="button"
              className="smc-icon-btn"
              onClick={() => {
                setCardMode('focus')
                setSheetSnap('expanded')
              }}
              aria-label="Back to property card"
            >
              ←
            </button>
            {onClose ? <button type="button" className="smc-icon-btn" onClick={onClose} aria-label="Close">×</button> : null}
          </div>
        </header>
        <div className="smc-thread">
          <SellerMapCardThreadList
            messages={messages}
            loading={conversationLoading}
            error={conversationError}
            onRetry={() => { void refreshConversation() }}
          />
        </div>
        <div className="smc-composer-wrap">
          <Composer
            draftText={localDraft}
            onSend={(text) => { void handleSend(text) }}
            onOpenSchedule={() => {}}
            onAI={() => {}}
            thread={thread}
            threadContext={threadContext as ThreadContext | null}
            onSendTemplate={(payload) => { void sendTemplate(payload) }}
            onQueueTemplate={(payload) => { void queueTemplate(payload) }}
            onScheduleTemplate={() => {}}
            isSending={isSending}
            disabled={viewModel.messagingBlocked}
            disabledReason={viewModel.messagingBlockReason || undefined}
            isTranslatingDraft={isTranslatingDraft}
            onTranslateDraft={(text) => { void handleTranslateDraft(text) }}
            layoutMode="full"
          />
        </div>
      </div>
    </div>
  )

  const shellClassName = cls(
    'smc-shell',
    `is-${cardMode}`,
    `is-accent-${viewModel.edgeAccent}`,
    isMobile && 'is-mobile',
    isMobile && 'is-mobile-sheet',
    prefersReducedMotion && 'is-reduced-motion',
    !isMobile && isConversation && 'is-flipped-shell is-flipping',
    !isMobile && (isFocus || isConversation) && 'is-size-locked',
  )

  const shellInner = (
    <>
      <div className="smc-glass-noise" aria-hidden="true" />
      <div className="smc-glass-glow" aria-hidden="true" />
      {isMobile ? (
        isConversation ? (
          <div className="smc-mobile-sheet__content is-composer">{conversationBody}</div>
        ) : isPeek ? (
          <div className="smc-mobile-sheet__content is-peek">{mobilePeekBody}</div>
        ) : (
          <>
            <div className="smc-mobile-sheet__scroll">{focusScrollBody}</div>
            {actionFooter}
          </>
        )
      ) : (
        <div className={cls('smc-flip', isConversation && 'is-flipped')}>
          <div className="smc-flip__front">
            {isPeek ? peekBody : focusBody}
          </div>
          <div className="smc-flip__back smc-flip__back--sms">
            {conversationBody}
          </div>
          <div className="smc-flip__sheen" aria-hidden="true" />
        </div>
      )}
    </>
  )

  if (isMobile && typeof document !== 'undefined') {
    return createPortal(
      <MobileBottomSheet
        open
        snap={sheetSnap}
        snapHeights={isConversation ? SELLER_COMPOSER_SHEET_SNAP_HEIGHTS : SELLER_SHEET_SNAP_HEIGHTS}
        showBackdrop={false}
        elevated={isConversation}
        className={cls('smc-mobile-bottom-sheet', isConversation && 'is-composer')}
        onSnapChange={(nextSnap) => {
          setSheetSnap(nextSnap)
          const nextMode = cardModeFromSnap(nextSnap, cardMode)
          if (nextMode === cardMode) return
          setCardMode(nextMode)
          if (nextMode === 'focus' && cardMode === 'peek') onPeekToFocus?.()
        }}
        onClose={() => {
          if (isConversation) {
            setCardMode('focus')
            setSheetSnap('expanded')
            return
          }
          if (isFocus) {
            setCardMode('peek')
            setSheetSnap('collapsed')
            return
          }
          onClose?.()
        }}
      >
        <article
          className={shellClassName}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onClick={(event) => {
            event.stopPropagation()
            if (isPeek) {
              setCardMode('focus')
              setSheetSnap('expanded')
              onPeekToFocus?.()
            }
          }}
          role={isPeek ? 'button' : 'region'}
          aria-label={isPeek ? 'Seller property preview' : isConversation ? 'Seller message composer' : 'Seller property card'}
        >
          {shellInner}
        </article>
      </MobileBottomSheet>,
      document.body,
    )
  }

  return (
    <article
      className={shellClassName}
      style={shellStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event) => {
        event.stopPropagation()
        if (isPeek) onPeekToFocus?.()
      }}
      role={isPeek ? 'button' : 'region'}
      aria-label={isPeek ? 'Seller property preview' : 'Seller property card'}
    >
      {shellInner}
    </article>
  )
}