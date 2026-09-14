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

  /**
   * AN UNRESOLVED VARIABLE MUST NOT REACH A SELLER.
   *
   * renderTemplate leaves a missing variable as `[[variable]]` so the operator
   * can see it. Nothing stopped Send Now / Queue / Schedule from acting on that
   * text, and the transport guard only knew the `{{ }}` form -- so "Hey
   * [[seller_first_name]], ..." could go out verbatim. Insert/Replace stay
   * enabled: putting the text in the composer so the operator can fix it is the
   * point. It is SENDING it that is refused, with the missing variables named.
   */
  const unresolved = renderResult.missingVariables
  const blocked = unresolved.length > 0
  const blockedReason = blocked
    ? `Fill in ${unresolved.join(', ')} before sending — the seller would receive the placeholder.`
    : undefined

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
      {blocked && (
        <div className="nx-template-preview__blocked" role="alert">{blockedReason}</div>
      )}
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
          disabled={blocked}
          title={blockedReason}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (blocked) return
            onSendNow(template)
          }}
        >
          Send Now
        </button>
        <button 
          type="button" 
          disabled={blocked}
          title={blockedReason}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (blocked) return
            onQueue(template)
          }}
        >
          Queue Reply
        </button>
        <button 
          type="button" 
          disabled={blocked}
          title={blockedReason}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (blocked) return
            onSchedule(template)
          }}
        >
          Schedule
        </button>
      </div>
    </div>
  )
}
