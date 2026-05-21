import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'

type ThreadTranslateViewMode = 'original' | 'translated'

interface ComposerTranslationBarProps {
  sellerLanguageLabel: string
  sellerLanguageCode: string | null
  isSellerLanguageEnglish: boolean
  hasInboundMessages: boolean
  hasThreadTranslations: boolean
  threadViewMode: ThreadTranslateViewMode
  isThreadTranslating: boolean
  isDraftTranslating: boolean
  hasDraftText: boolean
  translatedDraftPreview: string | null
  translationError: string | null
  canRevertDraft: boolean
  onTranslateThread: () => void
  onTranslateDraft: () => void
  onSetThreadViewMode: (mode: ThreadTranslateViewMode) => void
  onUseDraftTranslation: () => void
  onRevertDraft: () => void
}

export const ComposerTranslationBar = ({
  sellerLanguageLabel,
  sellerLanguageCode,
  isSellerLanguageEnglish,
  hasInboundMessages,
  hasThreadTranslations,
  threadViewMode,
  isThreadTranslating,
  isDraftTranslating,
  hasDraftText,
  translatedDraftPreview,
  translationError,
  canRevertDraft,
  onTranslateThread,
  onTranslateDraft,
  onSetThreadViewMode,
  onUseDraftTranslation,
  onRevertDraft,
}: ComposerTranslationBarProps) => {

  return createPortal(
    <div className="nx-translation-strip" role="region" aria-label="Translation controls">
      <div className="nx-translation-strip__row">
        {/* Language indicator */}
        <div className="nx-translation-strip__lang">
          <span className="nx-translation-strip__lang-label">S:</span>
          <span className="nx-translation-strip__lang-value">{sellerLanguageCode?.toUpperCase() || sellerLanguageLabel}</span>
        </div>

        {/* Segmented view toggle */}
        <div className="nx-translation-toggle-seg" role="tablist" aria-label="Thread language view">
          <button
            type="button"
            role="tab"
            aria-selected={threadViewMode === 'original'}
            className={threadViewMode === 'original' ? 'is-active' : ''}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onSetThreadViewMode('original')
            }}
          >
            Orig
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={threadViewMode === 'translated'}
            className={threadViewMode === 'translated' ? 'is-active' : ''}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onSetThreadViewMode('translated')
            }}
            disabled={!hasThreadTranslations}
          >
            Trans
          </button>
        </div>

        {/* Action buttons */}
        <div className="nx-translation-strip__actions">
          <button
            type="button"
            className="nx-translation-strip__btn"
            disabled={isSellerLanguageEnglish || !hasInboundMessages || isThreadTranslating}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onTranslateThread()
            }}
          >
            {isThreadTranslating ? (
              <span className="nx-translation-strip__spinner" />
            ) : (
              <Icon name="spark" style={{ width: 12 }} />
            )}
            Thread
          </button>

          <button
            type="button"
            className="nx-translation-strip__btn"
            disabled={!hasDraftText || isDraftTranslating}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onTranslateDraft()
            }}
          >
            {isDraftTranslating ? (
              <span className="nx-translation-strip__spinner" />
            ) : (
              <Icon name="send" style={{ width: 12 }} />
            )}
            Draft
          </button>

          {canRevertDraft && (
            <button 
              type="button" 
              className="nx-translation-strip__btn is-quiet" 
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onRevertDraft()
              }}
            >
              Undo
            </button>
          )}
        </div>
      </div>

      {/* Draft preview */}
      {translatedDraftPreview && (
        <div className="nx-translation-draft-preview">
          <div className="nx-translation-draft-preview__header">
            <span>Translated draft ready</span>
            <button 
              type="button" 
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onUseDraftTranslation()
              }}
            >
              Use Translation
            </button>
          </div>
          <p>{translatedDraftPreview}</p>
        </div>
      )}

      {/* Error */}
      {translationError && (
        <div className="nx-translation-error" role="status">
          {translationError}
        </div>
      )}
    </div>,
    document.body
  )
}
