const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const StatusBadge = ({
  label,
  tone = 'neutral',
  pulse,
}: {
  label: string
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'info'
  pulse?: boolean
}) => (
  <span className={cls('nx-shell-status-badge', `is-${tone}`, pulse && 'is-pulse')}>
    {label}
  </span>
)