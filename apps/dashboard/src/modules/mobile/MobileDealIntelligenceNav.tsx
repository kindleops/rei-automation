import { SegmentedControl } from '../shell/primitives/SegmentedControl'

export type DealIntelligenceMobileSection =
  | 'overview'
  | 'property'
  | 'seller'
  | 'deal'
  | 'comps'
  | 'contact'
  | 'activity'

const SECTIONS: Array<{ id: DealIntelligenceMobileSection; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'property', label: 'Property' },
  { id: 'seller', label: 'Seller' },
  { id: 'deal', label: 'Deal' },
  { id: 'comps', label: 'Comps' },
  { id: 'contact', label: 'Contact' },
  { id: 'activity', label: 'Activity' },
]

interface MobileDealIntelligenceNavProps {
  active: DealIntelligenceMobileSection
  onChange: (section: DealIntelligenceMobileSection) => void
}

export const MobileDealIntelligenceNav = ({ active, onChange }: MobileDealIntelligenceNavProps) => (
  <div className="nx-di25-mobile-nav">
    <SegmentedControl
      options={SECTIONS.map((s) => ({ id: s.id, label: s.label }))}
      value={active}
      onChange={onChange}
      ariaLabel="Deal intelligence sections"
    />
  </div>
)