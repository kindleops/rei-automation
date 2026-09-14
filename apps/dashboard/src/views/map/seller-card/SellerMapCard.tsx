import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { ThreadContext } from '../../../lib/data/inboxData'
import { useStreetViewAvailability } from './use-street-view-availability'
import { Composer } from '../../../modules/inbox/components/Composer'
import { MobileBottomSheet, type BottomSheetSnap } from '../../../modules/mobile/MobileBottomSheet'
import { useBreakpoint } from '../../../modules/mobile/useBreakpoint'
import {
  LIFECYCLE_STAGE_META,
  OPERATIONAL_STATUS_META,
} from '../../../domain/lead-state/universal-lead-state-registry'
import { buildSellerMapCardViewModel } from './seller-map-card-view-model'
import { getSellerMapCardLayoutMode, getSellerMapCardStyle } from './seller-map-card-positioning'
import type { SellerMapCardMode } from './seller-map-card.types'
import { buildThreadFromViewModel, useSellerMapCardActions } from './useSellerMapCardActions'
import { useSellerMapCardConversation } from './useSellerMapCardConversation'
import { SellerMapCardThreadList } from './SellerMapCardThreadList'
import { SellerMapCardConversationSkeleton } from './SellerMapCardConversationSkeleton'
import {
  SellerMapCardBadgeRail,
  SellerMapCardDossierSections,
  SellerMapCardMetrics,
  SellerMapCardOperationalState,
  SellerMapCardWeightedTags,
} from './SellerMapCardDesktopSections'

import '../../../modules/inbox/conversation-composer-premium.css'
import '../../../modules/inbox/conversation-live.css'
import './seller-map-card.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/**
 * PEEK / DETAIL / FULL.
 *
 * Peek is a fixed px value, not a dvh fraction: it holds a known amount of content —
 * identity, address, state badges, two metrics — so its height is a property of that
 * content rather than of the device. 38dvh was 321px on a 390x844 phone and the card
 * then overran it to 420px anyway, which left the map 320px of 844.
 *
 * Detail and Full stay proportional because they scroll.
 */
const SELLER_SHEET_SNAP_HEIGHTS = {
  /**
   * 216px is MEASURED, not chosen: peek's content is a 32px state row, a 55px identity
   * block, a 60px two-metric row, a 14px contact-state line and the 20px handle band —
   * 213px. At 186px the property facts line was clipped mid-sentence, which is the
   * failure a fixed peek height exists to avoid.
   */
  collapsed: '216px',
  half: '56dvh',
  /**
   * Full stops BELOW the map toolbar rather than at 92dvh.
   *
   * At 92dvh the sheet's top landed at y=68 on an 844px screen, over the toolbar at
   * 47-91 — so Filters and Controls were visible and unpressable, and the operator's
   * way back out to the map was buried by the thing they wanted to leave. 104px is the
   * global header plus the toolbar plus a hairline.
   */
  expanded: 'calc(100dvh - 104px)',
} as const

const SELLER_COMPOSER_SHEET_SNAP_HEIGHTS = {
  collapsed: '38dvh',
  half: '52dvh',
  expanded: '72dvh',
} as const

/**
 * The DEFAULT detent for a card mode.
 *
 * `focus` maps to half — DETAIL — not to expanded. It mapped to expanded, and because
 * a render-time sync re-applies this whenever cardMode changes, every promotion out of
 * peek was rewritten to full: the middle detent was unreachable and the three-state
 * sheet was really two. Full is reached by cycling the grab handle, which is a
 * deliberate second action.
 */
const snapFromCardMode = (mode: SellerMapCardMode): BottomSheetSnap => (
  mode === 'peek' ? 'collapsed' : 'half'
)

const cardModeFromSnap = (snap: BottomSheetSnap, current: SellerMapCardMode): SellerMapCardMode => {
  if (current === 'conversation') return 'conversation'
  if (snap === 'collapsed') return 'peek'
  return 'focus'
}

const followUpButtonLabel = (
  state: string,
  eligibilityLabel: string,
  errorMessage?: string | null,
): string => {
  if (state === 'sending') return 'Sending…'
  if (state === 'sent') return 'Sent ✓'
  if (state === 'blocked') return errorMessage || eligibilityLabel
  if (state === 'failed') return errorMessage ? errorMessage.slice(0, 42) : 'Failed'
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
  detailLoading = false,
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
  detailLoading?: boolean
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
    followUpError,
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
  const [trackedSnapMode, setTrackedSnapMode] = useState(cardMode)

  if (cardMode !== trackedSnapMode) {
    setTrackedSnapMode(cardMode)
    setSheetSnap(snapFromCardMode(cardMode))
  }

  const stageColor = LIFECYCLE_STAGE_META[viewModel.operations.stage as keyof typeof LIFECYCLE_STAGE_META]?.color
  const statusColor = OPERATIONAL_STATUS_META[viewModel.operations.status as keyof typeof OPERATIONAL_STATUS_META]?.color

  const shellStyle = {
    ...cardStyle,
    '--smc-stage-color': stageColor ?? 'var(--map-accent, #64d2ff)',
    '--smc-status-color': statusColor ?? '#94a3b8',
  } as CSSProperties

  const isFocus = cardMode === 'focus'
  const signalLimit = isPeek ? 6 : 10
  const visibleSignals = viewModel.weightedSignals.slice(0, signalLimit)
  const hiddenSignalCount = Math.max(0, viewModel.weightedSignals.length - visibleSignals.length)
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

  const heroState = useStreetViewAvailability(viewModel.property.imageUrl)
  // The image endpoint returns an HTTP-200 apology JPEG when there is no panorama,
  // so the hero renders only after the metadata endpoint confirms real imagery.
  const closeButton = !isPeek && onClose ? (
    <button type="button" className="smc-close" onClick={onClose} aria-label="Close seller card">×</button>
  ) : null
  const heroClass = cls('smc-image', isPeek && 'is-peek', !isPeek && 'is-focus', isMobile && 'is-mobile-hero')

  /**
   * ── HERO IMAGE LOADING ────────────────────────────────────────────────────
   *
   * This used to render EITHER an <img> or a placeholder <div>, switching between
   * them on the metadata verdict. Three problems, which together are the reported
   * "choppy, loads sometimes, then cuts off":
   *
   *  1. SERIAL fetches. With no <img> in the tree during `loading`, the browser had
   *     not begun downloading the photo. The metadata round trip had to finish before
   *     the image request even started, so the hero took two sequential network hops.
   *  2. REMOUNT on promotion. Swapping the placeholder div for an img at the same
   *     position unmounts one and mounts the other, so any progress was discarded and
   *     the download restarted.
   *  3. decoding="sync" blocked the main thread while a full-width JPEG decoded,
   *     which is the stutter as the card opens.
   *
   * Now: one container, and the <img> mounts as soon as a URL exists so the download
   * runs CONCURRENTLY with the metadata probe. The metadata verdict still gates
   * VISIBILITY — that gate is load-bearing, because the image endpoint answers 200
   * with a grey "no imagery" apology JPEG that an <img> cannot distinguish from a real
   * photo. Decoding is async, and a failed request falls back to the placeholder
   * instead of leaving an empty frame.
   */
  const [heroFailed, setHeroFailed] = useState(false)
  const streetViewUrl = viewModel.property.imageUrl
  // Adjusting state during render (React's documented pattern, and the one
  // use-street-view-availability already uses here) rather than in an effect: a new
  // property's failure state is known immediately, and routing it through an effect
  // would render one frame still showing the previous property's fallback.
  const [trackedHeroUrl, setTrackedHeroUrl] = useState(streetViewUrl)
  if (streetViewUrl !== trackedHeroUrl) {
    setTrackedHeroUrl(streetViewUrl)
    setHeroFailed(false)
  }

  /**
   * When Street View reports no panorama — common on rural parcels, new builds and
   * gated streets — fall back to aerial imagery of the same coordinates rather than
   * an empty grey frame. The operator still sees the actual property.
   */
  const streetViewRejected = heroFailed || heroState === 'unavailable' || heroState === 'error'
  const usingFallback = streetViewRejected && Boolean(viewModel.property.fallbackImageUrl)
  const heroUrl = usingFallback ? viewModel.property.fallbackImageUrl : streetViewUrl

  const heroReady = Boolean(heroUrl) && (usingFallback || (heroState === 'available' && !heroFailed))
  const heroPlaceholderState = heroFailed ? 'error' : heroState

  const imageBlock = (
    <div
      className={cls(heroClass, !heroReady && 'is-placeholder', !heroReady && heroState === 'loading' && 'is-loading')}
      data-hero-state={heroReady ? 'available' : heroPlaceholderState}
    >
      {heroUrl ? (
        <img
          // Keyed on the URL so switching to the aerial fallback replaces the source
          // cleanly instead of leaving a half-decoded Street View frame behind.
          key={heroUrl}
          className={cls('smc-image__photo', heroReady && 'is-ready')}
          src={heroUrl}
          alt={viewModel.property.address}
          loading="eager"
          decoding="async"
          // No fetchPriority: React 18 does not recognise the camelCase prop and logs
          // a DOM warning for it on every card. `loading="eager"` already opts the
          // hero out of lazy loading, which is the part that mattered.
          onError={() => { if (!usingFallback) setHeroFailed(true) }}
        />
      ) : null}
      {heroReady ? <div className="smc-image__gradient" /> : (
        <span className="smc-image__empty">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 11.2 12 4l9 7.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5.6 10.2V19h12.8v-8.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <em>{heroState === 'loading' && !heroFailed ? 'Loading imagery' : 'No imagery'}</em>
        </span>
      )}
      {closeButton}
    </div>
  )

  const identityHeader = (
    <header className="smc-identity smc-identity--dossier">
      <div className="smc-identity__copy">
        <h3 className="smc-identity__name">{viewModel.headerDisplayName}</h3>
        <p className="smc-identity__address" title={viewModel.property.address}>{viewModel.property.address}</p>
        <p className="smc-identity__asset-line">{viewModel.assetSummaryLine}</p>
      </div>
    </header>
  )

  /**
   * Peek shows TWO metrics, Detail and Full show all of them.
   *
   * All four (estimated value, equity, repairs, loan balance) wrapped to two rows and
   * pushed peek's content to 213px inside a 185px box — the property facts line was
   * clipped mid-sentence. Peek is a glance: the two the operator actually triages on
   * lead, and the rest are one tap away. The view model's own ordering decides which
   * two, so this does not encode a second opinion about what matters.
   */
  const metricsBlock = (variant: 'peek' | 'focus') => (
    <SellerMapCardMetrics
      metrics={variant === 'peek' ? viewModel.peekMetrics.slice(0, 2) : viewModel.peekMetrics}
      variant={variant}
    />
  )

  const signalsBlock = visibleSignals.length > 0 ? (
    <SellerMapCardWeightedTags flags={visibleSignals} hiddenCount={hiddenSignalCount} />
  ) : null

  const stopPeekExpand = (event: MouseEvent) => {
    event.stopPropagation()
  }

  const openConversation = () => {
    setCardMode('conversation')
    setSheetSnap('expanded')
  }

  const handlePrimaryAction = () => {
    const action = viewModel.actionBar.primary.action
    if (action === 'reply') {
      openConversation()
      return
    }
    if (action === 'ownership_check' || action === 'follow_up') {
      void executeFollowUp()
    }
  }

  /**
   * SUPPRESSED CONTACTS GET A STATEMENT, NOT A DEAD BUTTON.
   *
   * When outreach was blocked the primary action rendered its own block reason as its
   * LABEL — a greyed button reading "Opted Out" — and the same words appeared again
   * directly above it as the operational-state line. So the card showed the operator a
   * contradictory pair: a contact marked NOT CONTACTED, and what looked like a broken
   * send button rather than a policy.
   *
   * Opting out is a compliance fact about the contact, not a temporarily unavailable
   * control. It is stated once, plainly, and the outreach CTA is not rendered at all —
   * there is nothing to press, so nothing can look like it failed.
   */
  const outreachBlockReason = viewModel.messagingBlocked || !viewModel.actionBar.primary.enabled
    ? (viewModel.actionBar.primary.disabledReason || viewModel.operationalState || null)
    : null

  const actionFooter = outreachBlockReason ? (
    <footer className="smc-actions smc-actions--sticky smc-actions--blocked" onClick={stopPeekExpand}>
      <p className="smc-blocked" role="status">
        <span className="smc-blocked__icon" aria-hidden>⊘</span>
        <span className="smc-blocked__copy">
          <strong>{outreachBlockReason}</strong>
          <em>Outreach is suppressed for this contact.</em>
        </span>
      </p>
    </footer>
  ) : (
    <footer className="smc-actions smc-actions--sticky" onClick={stopPeekExpand}>
      <button
        type="button"
        className={cls(
          'smc-action',
          'smc-action--follow',
          followUpState !== 'idle' && `is-${followUpState}`,
          !viewModel.actionBar.primary.enabled && 'is-disabled',
        )}
        disabled={!viewModel.actionBar.primary.enabled || followUpState === 'sending'}
        title={followUpError || viewModel.actionBar.primary.disabledReason || undefined}
        onClick={(event) => {
          stopPeekExpand(event)
          handlePrimaryAction()
        }}
      >
        {viewModel.actionBar.primary.enabled
          ? followUpButtonLabel(followUpState, viewModel.actionBar.primary.label, followUpError)
          : (viewModel.actionBar.primary.disabledReason || viewModel.actionBar.primary.label)}
      </button>
      {viewModel.actionBar.secondary.action !== 'none' ? (
        <button
          type="button"
          className="smc-action smc-action--message"
          disabled={!viewModel.actionBar.secondary.enabled || viewModel.messagingBlocked}
          onClick={(event) => {
            stopPeekExpand(event)
            openConversation()
          }}
        >
          {viewModel.actionBar.secondary.label}
        </button>
      ) : null}
    </footer>
  )

  const stickySummary = (
    <div className="smc-sticky-summary">
      <SellerMapCardBadgeRail badges={viewModel.headerBadges} />
      {identityHeader}
      {metricsBlock(isPeek ? 'peek' : 'focus')}
    </div>
  )

  /**
   * PEEK answers "who and where, and how live is this?" in one glance, and nothing
   * more. No hero: a 112px Street View image is the single largest thing in the card
   * and it is what the operator opens the sheet FOR, not what they need while reading
   * the map. Dropping it is most of the difference between a 420px peek and a 186px one.
   */
  const peekBody = (
    <>
      <div className="smc-body smc-body--peek smc-body--peek-dense">
        {stickySummary}
        {/* Suppressed the duplicate: when the operational state IS the block reason,
            the footer already states it, and the card said "Opted Out" twice. */}
        {outreachBlockReason ? null : (
          <SellerMapCardOperationalState state={viewModel.operationalState} />
        )}
      </div>
      {/* Desktop only: the mobile sheet shell owns its own sticky footer. Embedding it
          here as well is what rendered Send Ownership Check / Message twice in the
          expanded mobile states. */}
      {!isMobile ? actionFooter : null}
    </>
  )

  const focusBody = (
    <>
      <div className="smc-sticky-head">
        {imageBlock}
        <div className="smc-body smc-body--focus-head">
          {stickySummary}
        </div>
      </div>
      <div className="smc-body smc-body--focus smc-body--focus-dense smc-body--dossier-scroll">
        {/* Signals moved here from peek: they are supporting evidence, and peek has
            room for the headline only. */}
        {signalsBlock}
        {outreachBlockReason ? null : (
          <SellerMapCardOperationalState state={viewModel.operationalState} />
        )}
        <SellerMapCardDossierSections viewModel={viewModel} loading={detailLoading && !viewModel.dossierReady} />
      </div>
      {/* Desktop only — see peekBody. */}
      {!isMobile ? actionFooter : null}
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
            <SellerMapCardBadgeRail badges={viewModel.headerBadges} />
            {sendingNumber ? <div className="smc-conversation__meta"><span>{sendingNumber}</span></div> : null}
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
            emptyState={{
              hasMessages: messages.length > 0,
              recipientName: viewModel.headerDisplayName,
              canSendOwnershipCheck: viewModel.followUpEligibility.isUncontacted && viewModel.followUpEligibility.canExecute,
              blockedReason: viewModel.messagingBlockReason,
              onInsertOwnershipCheck: viewModel.followUpEligibility.canExecute
                ? () => { void executeFollowUp() }
                : undefined,
            }}
          />
        </div>
        <div className="smc-composer-wrap">
          <Composer
            draftText={localDraft}
            onSend={(text) => { void handleSend(text) }}
            onOpenSchedule={(draft) => {
              if (draft.trim()) setLocalDraft(draft)
            }}
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
        ) : (
          <>
            <div className="smc-mobile-sheet__scroll">
              {isPeek ? peekBody : focusBody}
            </div>
            {/*
              ACTIONS BELONG TO DETAIL, not to peek.
              Peek answers "who, where, how live" at a glance — 186px of it — and a
              sticky footer took 52px of that and then overlapped the identity block,
              clipping the property facts line mid-sentence. Committing to an outreach
              action is not something the operator does from a glance anyway: one tap
              promotes to Detail, where the footer is the primary affordance.
            */}
            {!isPeek ? actionFooter : null}
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
            // Step DOWN one detent rather than collapsing all the way: dismissing a
            // full sheet should land on detail, and only a second dismiss on peek.
            if (sheetSnap === 'expanded') {
              setSheetSnap('half')
              return
            }
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
            if (isPeek && !isConversation) {
              /**
               * Peek promotes to DETAIL, not straight to full.
               *
               * It used to jump to `expanded`, which collapsed the three-detent sheet
               * into two states and handed 92dvh to a card the operator had only
               * glanced at. Detail is the answer to "tell me more"; full is the answer
               * to "show me everything", and they are different questions.
               */
              setCardMode('focus')
              setSheetSnap('half')
              onPeekToFocus?.()
            }
          }}
          role={isPeek && !isConversation ? 'button' : 'region'}
          aria-label={isPeek && !isConversation ? 'Seller property preview' : isConversation ? 'Seller message composer' : 'Seller property card'}
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
        if (isPeek && !isConversation) onPeekToFocus?.()
      }}
      role={isPeek && !isConversation ? 'button' : 'region'}
      aria-label={isPeek && !isConversation ? 'Seller property preview' : isConversation ? 'Seller message composer' : 'Seller property card'}
    >
      {shellInner}
    </article>
  )
}