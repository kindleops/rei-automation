const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const SegmentedControl = <T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ id: T; label: string }>
  value: T
  onChange: (id: T) => void
  ariaLabel: string
}) => (
  <div className="nx-shell-segmented" role="tablist" aria-label={ariaLabel}>
    {options.map((option) => (
      <button
        key={option.id}
        type="button"
        role="tab"
        aria-selected={value === option.id}
        className={cls('nx-shell-segmented__btn', value === option.id && 'is-active')}
        onClick={() => onChange(option.id)}
      >
        {option.label}
      </button>
    ))}
  </div>
)