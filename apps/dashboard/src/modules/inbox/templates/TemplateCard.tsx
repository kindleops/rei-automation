import type { SmsTemplate } from '../../../lib/data/templateData'

const chipClass = (tone: string): string => `nx-template-chip nx-template-chip--${tone}`

export const TemplateCard = ({
  template,
  selected,
  recommended,
  onSelect,
}: {
  template: SmsTemplate
  selected: boolean
  recommended?: boolean
  onSelect: () => void
}) => {
  const preview = template.templateText.length > 160 ? `${template.templateText.slice(0, 160)}...` : template.templateText
  return (
    <button
      type="button"
      className={`nx-template-card ${selected ? 'is-selected' : ''}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onSelect()
      }}
    >
      <div className="nx-template-card__head">
        <strong>{template.useCase}</strong>
        {recommended && <span className={chipClass('recommended')}>Recommended</span>}
      </div>
      <p className="nx-template-card__text">{preview}</p>
      <div className="nx-template-card__chips">
        <span className={chipClass('language')}>{template.language}</span>
        {template.stageLabel && <span className={chipClass('stage')}>{template.stageLabel}</span>}
        {template.agentStyle && <span className={chipClass('style')}>{template.agentStyle}</span>}
        {template.isFirstTouch && <span className={chipClass('touch')}>First Touch</span>}
        {template.isFollowUp && <span className={chipClass('follow')}>Follow-Up</span>}
      </div>
    </button>
  )
}
