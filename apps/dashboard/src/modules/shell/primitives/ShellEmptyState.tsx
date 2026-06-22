import { Icon } from '../../../shared/icons'

export const ShellEmptyState = ({
  title,
  detail,
  icon = 'activity',
}: {
  title: string
  detail?: string
  icon?: Parameters<typeof Icon>[0]['name']
}) => (
  <div className="nx-shell-empty">
    <span className="nx-shell-empty__icon" aria-hidden>
      <Icon name={icon} />
    </span>
    <strong>{title}</strong>
    {detail ? <p>{detail}</p> : null}
  </div>
)