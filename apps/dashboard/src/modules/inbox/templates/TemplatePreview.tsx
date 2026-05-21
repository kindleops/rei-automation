import type { SmsTemplate, TemplateRenderResult } from '../../../lib/data/templateData'
import { TemplateVariableEditor } from './TemplateVariableEditor'

export const TemplatePreview = ({
  template,
  renderResult,
  variableValues,
  onVariableChange,
  onInsert,
  onReplace,
  onSendNow,
  onQueue,
  onSchedule,
}: {
  template: SmsTemplate | null
  renderResult: TemplateRenderResult | null
  variableValues: Record<string, string>
  onVariableChange: (key: string, value: string) => void
  onInsert: () => void
  onReplace: () => void
  onSendNow: (template: SmsTemplate) => void
  onQueue: (template: SmsTemplate) => void
  onSchedule: (template: SmsTemplate) => void
}) => {
  if (!template || !renderResult) {
    return <div className="nx-template-preview-empty">Select a template to preview.</div>
  }

  return (
    <div className="nx-template-preview">
      <header>
        <h3>{template.useCase}</h3>
        <div className="nx-template-preview__chips">
          <span>{template.language}</span>
          {template.stageLabel && <span>{template.stageLabel}</span>}
          {template.agentStyle && <span>{template.agentStyle}</span>}
        </div>
      </header>
      <div className="nx-template-preview__body">{renderResult.renderedText}</div>
      {template.englishTranslation && (
        <div className="nx-template-preview__translation">
          <span>English Translation</span>
          <p>{template.englishTranslation}</p>
        </div>
      )}
      <TemplateVariableEditor
        missingVariables={renderResult.missingVariables}
        values={variableValues}
        onChange={onVariableChange}
      />
      <div className="nx-template-preview__actions">
        <button 
          type="button" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onInsert()
          }}
        >
          Insert
        </button>
        <button 
          type="button" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onReplace()
          }}
        >
          Replace Draft
        </button>
        <button 
          type="button" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSendNow(template)
          }}
        >
          Send Now
        </button>
        <button 
          type="button" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onQueue(template)
          }}
        >
          Queue Reply
        </button>
        <button 
          type="button" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSchedule(template)
          }}
        >
          Schedule
        </button>
      </div>
    </div>
  )
}
