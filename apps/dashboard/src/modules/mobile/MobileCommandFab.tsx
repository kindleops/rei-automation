import { Icon } from '../../shared/icons'

interface MobileCommandFabProps {
  onOpenSearch: () => void
  label?: string
}

export const MobileCommandFab = ({ onOpenSearch, label = 'Search' }: MobileCommandFabProps) => (
  <button
    type="button"
    className="nx-mobile-command-fab"
    aria-label={label}
    onClick={onOpenSearch}
  >
    <Icon name="search" />
  </button>
)