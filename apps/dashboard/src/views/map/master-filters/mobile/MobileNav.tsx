import { useMasterFilters } from '../MasterFiltersProvider'
import type { MasterFiltersMobilePane } from '../types'
import { cls } from '../utils'

const TABS: Array<{ key: MasterFiltersMobilePane; label: string }> = [
  { key: 'discover', label: 'Discover' },
  { key: 'stack', label: 'Stack' },
  { key: 'results', label: 'Results' },
  { key: 'saved', label: 'Saved' },
]

export function MobileNav() {
  const { mobilePane, setMobilePane, activeRuleCount } = useMasterFilters()

  return (
    <nav className="mf-mobile-nav" aria-label="Master filters views">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={cls('mf-mobile-nav__btn', mobilePane === tab.key && 'is-active')}
          onClick={() => setMobilePane(tab.key)}
        >
          {tab.label}
          {tab.key === 'stack' && activeRuleCount > 0 ? (
            <span className="mf-mobile-nav__badge">{activeRuleCount}</span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}