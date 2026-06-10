import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowDetail, WorkflowTemplateVariant } from './workflow.types'
import { TemplateSpinEditor } from './TemplateSpinEditor'
import { TemplateTranslationManager } from './TemplateTranslationManager'

interface WorkflowTemplatesPanelProps {
  detail: WorkflowDetail
  busy?: boolean
  onCreateTemplateSet: (payload: Record<string, unknown>) => Promise<void>
  onCreateTemplateVariant: (templateSetId: string, payload: Record<string, unknown>) => Promise<void>
  onRenderVariant: (variantId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  onSaveTranslation: (variantId: string, payload: Record<string, unknown>) => Promise<void>
}

const statusClass = (status?: string) =>
  `is-${String(status ?? 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

export const WorkflowTemplatesPanel = ({
  detail,
  busy,
  onCreateTemplateSet,
  onCreateTemplateVariant,
  onRenderVariant,
  onSaveTranslation,
}: WorkflowTemplatesPanelProps) => {
  const [setName, setSetName] = useState('Owner Check Templates')
  const [language, setLanguage] = useState(detail.workflow.language_scope?.[0] ?? 'en')
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)

  const variants = useMemo(
    () => detail.template_sets.flatMap((set) => set.variants ?? []),
    [detail.template_sets],
  )
  const selectedVariant =
    variants.find((variant) => variant.id === selectedVariantId) ??
    variants[0] ??
    null
  const selectedSet = detail.template_sets.find((set) =>
    (set.variants ?? []).some((variant) => variant.id === selectedVariant?.id),
  )
  const languageInventory = useMemo(() => {
    const languages = new Map<string, number>()
    for (const variant of variants) {
      languages.set(variant.language, (languages.get(variant.language) ?? 0) + 1)
      for (const translation of variant.translations ?? []) {
        languages.set(translation.language, (languages.get(translation.language) ?? 0) + 1)
      }
    }
    return Array.from(languages.entries())
  }, [variants])

  const createSet = async () => {
    await onCreateTemplateSet({
      name: setName,
      channel: detail.workflow.channel === 'multichannel' ? 'sms' : detail.workflow.channel,
      language,
      use_case: detail.workflow.workflow_key,
      stage_code: 'S1',
    })
  }

  const saveTranslation = async (variantId: string, payload: Record<string, unknown>) => {
    await onSaveTranslation(variantId, payload)
    setSelectedVariantId(variantId)
  }

  return (
    <div className="wfs-template-studio">
      <section className="wfs-section wfs-template-inventory">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Template Studio</span>
            <h3>Sets</h3>
          </div>
          <span className="wfs-count">{variants.length}</span>
        </header>

        <div className="wfs-template-list">
          {detail.template_sets.length === 0 ? (
            <div className="wfs-command-empty is-compact">
              <Icon name="message" />
              <strong>No template sets</strong>
              <span>Create a set to unlock variants, spin syntax, and previews.</span>
            </div>
          ) : detail.template_sets.map((set) => (
            <article key={set.id} className={selectedSet?.id === set.id ? 'wfs-template-set is-active' : 'wfs-template-set'}>
              <header>
                <div>
                  <strong>{set.name}</strong>
                  <span>{set.channel} / {set.language} / {set.rotation_mode}</span>
                </div>
                <span className={set.is_active ? 'wfs-status-pill is-scale' : 'wfs-status-pill is-draft'}>
                  {set.is_active ? 'Scale' : 'Draft'}
                </span>
              </header>
              <div className="wfs-variant-list">
                {(set.variants ?? []).map((variant) => (
                  <button
                    key={variant.id}
                    type="button"
                    className={selectedVariant?.id === variant.id ? 'is-active' : ''}
                    onClick={() => setSelectedVariantId(variant.id)}
                  >
                    <Icon name="message" />
                    <span>{variant.variant_key}</span>
                    <strong className={statusClass(variant.status)}>{variant.status}</strong>
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="wfs-template-create">
          <label>
            <span>Set Name</span>
            <input value={setName} onChange={(event) => setSetName(event.target.value)} />
          </label>
          <label>
            <span>Language</span>
            <input value={language} onChange={(event) => setLanguage(event.target.value)} />
          </label>
          <button type="button" className="wfs-primary-btn" disabled={busy} onClick={createSet}>
            <Icon name="check" /> Add Set
          </button>
        </div>
      </section>

      <TemplateSpinEditor
        templateSets={detail.template_sets}
        selectedVariant={selectedVariant as WorkflowTemplateVariant | null}
        tokens={detail.personalization_tokens ?? []}
        busy={busy}
        onCreateVariant={onCreateTemplateVariant}
        onRenderVariant={onRenderVariant}
      />

      <aside className="wfs-template-side">
        <section className="wfs-section wfs-template-preview-card">
          <header className="wfs-section__header">
            <div>
              <span className="wfs-kicker">Preview</span>
              <h3>{selectedVariant?.variant_key ?? 'No Variant'}</h3>
            </div>
            {selectedVariant && <span className={`wfs-status-pill ${statusClass(selectedVariant.status)}`}>{selectedVariant.status}</span>}
          </header>
          <div className="wfs-template-preview-message">
            <p>{selectedVariant?.body ?? 'Select or create a variant to preview message body, token coverage, status, and performance.'}</p>
            <div>
              <span><Icon name="hash" /> {(selectedVariant?.personalization_tokens ?? []).length} tokens</span>
              <span><Icon name="globe" /> {selectedVariant?.translations?.length ?? 0} translations</span>
              <span><Icon name="activity" /> {selectedVariant?.weight ?? 1} weight</span>
            </div>
          </div>
        </section>

        <section className="wfs-section wfs-template-inventory-card">
          <header className="wfs-section__header">
            <div>
              <span className="wfs-kicker">Inventory</span>
              <h3>Languages</h3>
            </div>
          </header>
          <div className="wfs-language-inventory">
            {languageInventory.length === 0 ? (
              <span>No languages yet</span>
            ) : languageInventory.map(([code, count]) => (
              <span key={code}><strong>{code.toUpperCase()}</strong>{count}</span>
            ))}
          </div>
        </section>

        <section className="wfs-section wfs-template-performance">
          <header className="wfs-section__header">
            <div>
              <span className="wfs-kicker">Performance</span>
              <h3>Placeholder</h3>
            </div>
          </header>
          <div className="wfs-performance-placeholder">
            <span><Icon name="stats" /> Reply Rate</span>
            <strong>Pending data</strong>
            <p>Performance will populate after real workflow runs are connected to template analytics.</p>
          </div>
        </section>

        <TemplateTranslationManager
          variant={selectedVariant}
          languages={detail.translation_languages ?? []}
          busy={busy}
          onSaveTranslation={saveTranslation}
        />
      </aside>
    </div>
  )
}
