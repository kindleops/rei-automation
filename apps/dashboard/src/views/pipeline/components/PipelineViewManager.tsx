import { useState } from 'react'
import type { PipelineViewState } from '../../../domain/pipeline/pipeline-card-design.types'
import type { PipelineSavedView } from '../../../domain/pipeline/pipeline-opportunity.types'
import { viewStateToSavePayload } from '../../../domain/pipeline/pipeline-view-state'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface PipelineViewManagerProps {
  open: boolean
  onClose: () => void
  viewState: PipelineViewState
  savedViews: PipelineSavedView[]
  onApplyView: (view: PipelineSavedView) => void
  onSaveView: (payload: Partial<PipelineSavedView>) => Promise<void>
  onDuplicateView: (view: PipelineSavedView) => Promise<void>
}

export function PipelineViewManager({
  open,
  onClose,
  viewState,
  savedViews,
  onApplyView,
  onSaveView,
  onDuplicateView,
}: PipelineViewManagerProps) {
  const [saveName, setSaveName] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  if (!open && !menuOpen) {
    return (
      <div className="plv-view-menu">
        <button type="button" className="plv-filter-chip nx-glass-menu" onClick={() => setMenuOpen(true)}>
          View ▾
        </button>
        {menuOpen && (
          <div className="plv-view-menu__dropdown nx-glass-menu">
            <button type="button" onClick={() => { setMenuOpen(false); onClose(); }}>Configure View</button>
            <button type="button" onClick={() => setMenuOpen(false)}>Customize Cards</button>
            <hr />
            {savedViews.map((v) => (
              <button key={v.id} type="button" onClick={() => { onApplyView(v); setMenuOpen(false) }}>
                {v.label}{v.is_system ? ' 🔒' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!open) return null

  const systemViews = savedViews.filter((v) => v.is_system)
  const userViews = savedViews.filter((v) => !v.is_system)

  return (
    <div className="plv-view-manager-overlay" onClick={onClose}>
      <div className="plv-view-manager nx-glass-menu" onClick={(e) => e.stopPropagation()}>
        <header className="plv-view-manager__header">
          <strong>Saved Views</strong>
          <button type="button" onClick={onClose}>×</button>
        </header>

        <section>
          <h4>System Presets</h4>
          <div className="plv-view-manager__list">
            {systemViews.map((v) => (
              <div key={v.id} className="plv-view-manager__item">
                <button type="button" className="plv-view-manager__apply" onClick={() => onApplyView(v)}>
                  {v.label}
                </button>
                <button type="button" className="plv-glass-btn plv-glass-btn--ghost" onClick={() => void onDuplicateView(v)}>Duplicate</button>
              </div>
            ))}
          </div>
        </section>

        {userViews.length > 0 && (
          <section>
            <h4>Your Views</h4>
            <div className="plv-view-manager__list">
              {userViews.map((v) => (
                <div key={v.id} className="plv-view-manager__item">
                  <button type="button" className="plv-view-manager__apply" onClick={() => onApplyView(v)}>
                    {v.label}{v.is_pinned ? ' 📌' : ''}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="plv-view-manager__save">
          <input
            className="plv-glass-input"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="View name"
          />
          <button
            type="button"
            className="plv-glass-btn plv-glass-btn--primary"
            disabled={!saveName.trim()}
            onClick={() => void onSaveView(viewStateToSavePayload(viewState, saveName.trim())).then(() => setSaveName(''))}
          >
            Save View
          </button>
          <button
            type="button"
            className="plv-glass-btn"
            disabled={!saveName.trim()}
            onClick={() => void onSaveView(viewStateToSavePayload(viewState, saveName.trim(), `${saveName.trim()}_${Date.now()}`)).then(() => setSaveName(''))}
          >
            Save As
          </button>
        </section>
      </div>
    </div>
  )
}