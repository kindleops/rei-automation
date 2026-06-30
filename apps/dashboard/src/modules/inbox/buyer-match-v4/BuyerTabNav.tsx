import type { BuyerMatchV4Tab } from './buyer-match-v4.types'
import { TAB_LABELS } from './buyer-match-v4.types'

const TABS: BuyerMatchV4Tab[] = ['MARKET', 'BUYERS', 'INSTITUTIONS', 'PURCHASE_ACTIVITY', 'SHORTLIST']

interface Props {
  activeTab: BuyerMatchV4Tab
  shortlistCount: number
  onSelectTab: (tab: BuyerMatchV4Tab) => void
}

export function BuyerTabNav({ activeTab, shortlistCount, onSelectTab }: Props) {
  return (
    <nav className="bmv4-nav" aria-label="Buyer Match navigation">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          data-bmv4-tab={tab}
          className={`bmv4-nav__tab${activeTab === tab ? ' is-active' : ''}`}
          onClick={() => onSelectTab(tab)}
        >
          {TAB_LABELS[tab]}
          {tab === 'SHORTLIST' && shortlistCount > 0 && (
            <span className="bmv4-nav__count">{shortlistCount}</span>
          )}
        </button>
      ))}
    </nav>
  )
}