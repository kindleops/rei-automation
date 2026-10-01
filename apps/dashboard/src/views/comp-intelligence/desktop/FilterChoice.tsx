import { LCSegmented } from '../../../shared/lc'

export type FilterOpt = { value: string; label: string }

/** One labelled choice inside the filter inspector. */
export function FilterChoice({ label, value, options, onChange }: { label: string; value: string; options: FilterOpt[]; onChange: (v: string) => void }) {
  return (
    <div className="ciw-fchoice">
      <span className="ciw-fchoice__label">{label}</span>
      <LCSegmented label={label} size="sm" value={value} onChange={onChange} options={options} />
    </div>
  )
}
