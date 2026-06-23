import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowTemplateVariant } from './workflow.types'

interface TemplateTranslationManagerProps {
  variant: WorkflowTemplateVariant | null
  languages: Array<{ code: string; label: string }>
  busy?: boolean
  onSaveTranslation: (variantId: string, payload: Record<string, unknown>) => Promise<void>
}

export const TemplateTranslationManager = ({
  variant,
  languages,
  busy,
  onSaveTranslation,
}: TemplateTranslationManagerProps) => {
  const [language, setLanguage] = useState('es')
  const [status, setStatus] = useState('pending')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const translationsByLanguage = useMemo(() => {
    const map = new Map<string, string>()
    for (const translation of variant?.translations ?? []) {
      map.set(translation.language, translation.translation_status)
    }
    return map
  }, [variant?.translations])

  const save = async () => {
    if (!variant) return
    await onSaveTranslation(variant.id, {
      language,
      translated_subject: subject,
      translated_body: body,
      translation_status: status,
    })
    setSubject('')
    setBody('')
  }

  return (
    <section className="wfs-section">
      <header className="wfs-section__header">
        <div>
          <span className="wfs-kicker">Translations</span>
          <h3>{variant?.variant_key ?? 'No Variant Selected'}</h3>
        </div>
      </header>
      <div className="wfs-language-grid">
        {languages.map((item) => (
          <button
            key={item.code}
            type="button"
            className={language === item.code ? 'is-active' : ''}
            onClick={() => setLanguage(item.code)}
          >
            <span>{item.label}</span>
            <strong>{translationsByLanguage.get(item.code) ?? 'pending'}</strong>
          </button>
        ))}
      </div>

      <div className="wfs-form-grid">
        <label>
          <span>Language</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            {languages.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label>
          <span>Subject</span>
          <input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>
      </div>
      <label className="wfs-textarea-label">
        <span>Body</span>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} />
      </label>
      <button type="button" className="wfs-primary-btn" disabled={busy || !variant || !body.trim()} onClick={save}>
        <Icon name="check" /> Save Translation
      </button>
    </section>
  )
}
