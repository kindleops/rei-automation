export const TemplateVariableEditor = ({
  missingVariables,
  values,
  onChange,
}: {
  missingVariables: string[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
}) => {
  if (missingVariables.length === 0) return null

  return (
    <div className="nx-template-variable-editor">
      <h4>Missing Variables</h4>
      {missingVariables.map((variable) => (
        <label key={variable}>
          <span>{variable}</span>
          <input
            value={values[variable] ?? ''}
            onChange={(event) => onChange(variable, event.target.value)}
            placeholder={`Enter ${variable}`}
          />
        </label>
      ))}
    </div>
  )
}
