import type { ComparisonRow } from '../utils/comp-display'

interface Props {
  rows: ComparisonRow[]
}

export function CompComparisonTable({ rows }: Props) {
  return (
    <div className="ci-compare-table" role="table" aria-label="Subject versus comp comparison">
      <div className="ci-compare-table__head" role="row">
        <span role="columnheader">Attribute</span>
        <span role="columnheader">Subject</span>
        <span role="columnheader">Comp</span>
        <span role="columnheader">Difference</span>
      </div>
      {rows.map((row) => (
        <div key={row.label} className={`ci-compare-table__row is-${row.tone}`} role="row">
          <span className="ci-compare-table__attr" role="cell">{row.label}</span>
          <span className="ci-compare-table__val" role="cell">{row.subject}</span>
          <span className="ci-compare-table__val" role="cell">{row.comp}</span>
          <span className="ci-compare-table__diff" role="cell">{row.diff}</span>
        </div>
      ))}
    </div>
  )
}