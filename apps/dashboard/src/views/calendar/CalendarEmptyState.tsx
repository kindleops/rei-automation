type CalendarEmptyStateProps = {
  title: string
  description: string
  compact?: boolean
}

export function CalendarEmptyState({
  title,
  description,
  compact = false,
}: CalendarEmptyStateProps) {
  return (
    <div className={`nx-cal__empty${compact ? ' is-compact' : ''}`}>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  )
}
