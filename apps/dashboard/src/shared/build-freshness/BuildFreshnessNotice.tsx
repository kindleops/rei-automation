/** @jsxRuntime automatic */
import { useSyncExternalStore } from 'react'
import {
  dismissFreshnessNotice,
  getFreshnessNotice,
  subscribeFreshnessNotice,
  type ChunkRecoveryOutcome,
  type FreshnessNotice,
} from './build-freshness'
import './build-freshness.css'

export interface BuildFreshnessViewProps {
  notice: FreshnessNotice | null
  onReload: () => void
  onDismiss: () => void
}

/** Pure view — the reload toast or the quiet "new version" pill. */
export function BuildFreshnessView({ notice, onReload, onDismiss }: BuildFreshnessViewProps) {
  if (!notice) return null
  if (notice.kind === 'reloading') {
    return (
      <div className="lc-build-fresh lc-build-fresh--toast" role="status" aria-live="polite">
        <span className="lc-build-fresh__dot" aria-hidden="true" />
        <span>LeadCommand updated — reloading…</span>
      </div>
    )
  }
  const label =
    notice.kind === 'update-deferred' ? 'Update available — reload when ready' : 'New version available'
  return (
    <div className="lc-build-fresh lc-build-fresh--pill" role="status" aria-live="polite">
      <span className="lc-build-fresh__dot" aria-hidden="true" />
      <span>{label}</span>
      <button type="button" className="lc-build-fresh__action" onClick={onReload}>
        Reload
      </button>
      <button
        type="button"
        className="lc-build-fresh__close"
        aria-label="Dismiss update notice"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}

/** Mount once at the root. Explicit Reload is the operator's choice; nothing here forces one. */
export function BuildFreshnessNotice() {
  const notice = useSyncExternalStore(subscribeFreshnessNotice, getFreshnessNotice, () => null)
  return (
    <BuildFreshnessView
      notice={notice}
      onReload={() => window.location.reload()}
      onDismiss={dismissFreshnessNotice}
    />
  )
}

export interface ChunkLoadFallbackProps {
  outcome: Exclude<ChunkRecoveryOutcome, 'reloading'>
  onRetry: () => void
}

/** The app's route error state, for an app chunk that failed to download. */
export function ChunkLoadFallback({ outcome, onRetry }: ChunkLoadFallbackProps) {
  return (
    <div className="app-state" data-chunk-load-error={outcome}>
      <div className="app-state__panel">
        <span className="app-state__eyebrow">Load error</span>
        <h1>This app couldn’t load</h1>
        <p>
          {outcome === 'deferred'
            ? 'LeadCommand has been updated. Reload when your unsaved work is safe to load the new version.'
            : 'The app’s code didn’t download — usually a network interruption.'}
        </p>
        <button className="app-state__button" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}
