export interface TemplateFilterState {
  search: string
  stage: string
  agentStyle: string
  includeInactive: boolean
}

export const TemplateFilters = ({
  value,
  stageOptions,
  agentStyles,
  onChange,
}: {
  value: TemplateFilterState
  stageOptions: string[]
  agentStyles: string[]
  onChange: (patch: Partial<TemplateFilterState>) => void
}) => (
  <div className="nx-template-filters">
    <label>
      <span>Search</span>
      <input
        value={value.search}
        onChange={(event) => onChange({ search: event.target.value })}
        placeholder="Search templates"
      />
    </label>
    <label>
      <span>Stage</span>
      <select value={value.stage} onChange={(event) => onChange({ stage: event.target.value })}>
        {stageOptions.map((stage) => (
          <option key={stage} value={stage}>{stage}</option>
        ))}
      </select>
    </label>
    <label>
      <span>Agent Style</span>
      <select value={value.agentStyle} onChange={(event) => onChange({ agentStyle: event.target.value })}>
        {agentStyles.map((style) => (
          <option key={style} value={style}>{style}</option>
        ))}
      </select>
    </label>
    <label className="nx-template-filters__toggle">
      <input
        type="checkbox"
        checked={value.includeInactive}
        onChange={(event) => onChange({ includeInactive: event.target.checked })}
      />
      Show inactive templates
    </label>
  </div>
)
