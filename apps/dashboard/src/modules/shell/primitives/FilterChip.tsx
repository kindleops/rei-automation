const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const FilterChip = ({
  label,
  active,
  onClick,
}: {
  label: string
  active?: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    className={cls('nx-shell-filter-chip', active && 'is-active')}
    onClick={onClick}
  >
    {label}
  </button>
)