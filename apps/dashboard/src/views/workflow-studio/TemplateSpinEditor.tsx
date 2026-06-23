import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowTemplateSet, WorkflowTemplateVariant } from './workflow.types'

interface TemplateSpinEditorProps {
  templateSets: WorkflowTemplateSet[]
  selectedVariant: WorkflowTemplateVariant | null
  tokens: string[]
  busy?: boolean
  onCreateVariant: (templateSetId: string, payload: Record<string, unknown>) => Promise<void>
  onRenderVariant: (variantId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
}

interface TemplatePreviewResult {
  rendered?: {
    sms?: {
      character_count: number
      segment_count: number
    }
  }
  previews?: Array<{
    body?: string
  }>
}

export const TemplateSpinEditor = ({
  templateSets,
  selectedVariant,
  tokens,
  busy,
  onCreateVariant,
  onRenderVariant,
}: TemplateSpinEditorProps) => {
  const [templateSetId, setTemplateSetId] = useState(templateSets[0]?.id ?? '')
  const [variantKey, setVariantKey] = useState('draft_b')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('Hi {first_name}, this is {agent_name}. {Are you the owner?|Do I have the right person?}')
  const [preview, setPreview] = useState<TemplatePreviewResult | null>(null)
  const activeTemplateSetId = templateSetId || templateSets[0]?.id || ''
  const previewItems = preview?.previews ?? []
  const activeBody = selectedVariant?.body || body
  const characterCount = preview?.rendered?.sms?.character_count ?? activeBody.length
  const segmentCount = preview?.rendered?.sms?.segment_count ?? Math.max(1, Math.ceil(characterCount / 160))
  const previewRows = useMemo(() => {
    if (previewItems.length > 0) return previewItems.slice(0, 10)
    return Array.from({ length: 10 }, (_, index) => ({
      body: selectedVariant?.body
        ? selectedVariant.body
        : index === 0
          ? body
          : 'Generate previews to inspect spin syntax and token rendering.',
    }))
  }, [body, previewItems, selectedVariant?.body])

  const selectedSet = useMemo(
    () => templateSets.find((set) => set.id === activeTemplateSetId) ?? templateSets[0],
    [activeTemplateSetId, templateSets],
  )

  const appendToken = (token: string) => {
    setBody((current) => `${current}${current.endsWith(' ') || current.length === 0 ? '' : ' '}{${token}}`)
  }

  const createVariant = async () => {
    if (!selectedSet) return
    await onCreateVariant(selectedSet.id, {
      variant_key: variantKey,
      subject,
      body,
      language: selectedSet.language,
      spin_syntax_enabled: true,
      personalization_tokens: tokens.filter((token) => body.includes(`{${token}}`) || subject.includes(`{${token}}`)),
      status: 'draft',
    })
  }

  const renderPreview = async () => {
    if (!selectedVariant) return
    const result = await onRenderVariant(selectedVariant.id, {
      preview_count: 10,
      context: {
        conversation_thread_id: 'preview-thread-001',
        first_name: 'Jordan',
        seller_display_name: 'Jordan Seller',
        property_address: '123 Main St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        market: 'default',
        agent_name: 'Nexus Operator',
        property_type: 'SFR',
        unit_count: '1',
        asking_price: '$250,000',
        offer_price: '$210,000',
      },
    })
    setPreview(result as TemplatePreviewResult)
  }

  return (
    <section className="wfs-section wfs-template-editor">
      <header className="wfs-section__header">
        <div>
          <span className="wfs-kicker">Template Studio</span>
          <h3>Spin Editor</h3>
        </div>
        <span className="wfs-count">{characterCount}/{segmentCount}</span>
      </header>

      <div className="wfs-template-editor__layout">
        <div className="wfs-template-composer">
          <div className="wfs-form-grid">
            <label>
              <span>Template Set *</span>
              <select value={activeTemplateSetId} onChange={(event) => setTemplateSetId(event.target.value)}>
                {templateSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
              </select>
            </label>
            <label>
              <span>Variant Key *</span>
              <input value={variantKey} onChange={(event) => setVariantKey(event.target.value)} />
            </label>
            <label>
              <span>Subject</span>
              <input value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
          </div>

          <label className="wfs-textarea-label">
            <span>Body *</span>
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={7} />
          </label>

          <div className="wfs-spin-helper">
            <span><Icon name="spark" /> Spin syntax</span>
            <code>{'{option A|option B|option C}'}</code>
            <small>Use guarded variation while preserving required tokens.</small>
          </div>

          <div className="wfs-token-row">
            {tokens.map((token) => (
              <button key={token} type="button" onClick={() => appendToken(token)}>
                <Icon name="hash" /> {token}
              </button>
            ))}
          </div>

          <div className="wfs-template-meter">
            <span>SMS characters</span>
            <strong>{characterCount}</strong>
            <span>segments</span>
            <strong>{segmentCount}</strong>
          </div>

          <div className="wfs-actions">
            <button type="button" disabled={busy || !selectedSet} onClick={createVariant}><Icon name="check" /> Save Variant</button>
            <button type="button" disabled={busy || !selectedVariant} onClick={renderPreview}><Icon name="activity" /> Generate 10 Previews</button>
          </div>
        </div>

        <div className="wfs-preview-stack">
          <header>
            <span>Generated Previews</span>
            <strong>{previewItems.length > 0 ? previewItems.length : 10}</strong>
          </header>
          {previewRows.map((item, index) => (
            <div key={`${item.body}-${index}`} className="wfs-preview-line">
              <span>{index + 1}</span>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
