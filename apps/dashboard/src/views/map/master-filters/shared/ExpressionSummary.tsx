import { useMasterFilters } from '../MasterFiltersProvider'
import { countActiveRules } from '../expression-utils'

export function ExpressionSummary() {
  const { draftExpression, appliedToken, isDraftDirty } = useMasterFilters()
  const rules = countActiveRules(draftExpression)

  return (
    <div className="mf-expression-summary">
      <div className="mf-expression-summary__row">
        <span className="mf-expression-summary__label">Expression</span>
        <span className="mf-expression-summary__value">
          {rules === 0 ? 'All authorized properties' : `${rules} active rule${rules === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="mf-expression-summary__row">
        <span className="mf-expression-summary__label">Map state</span>
        <span className="mf-expression-summary__value">
          {appliedToken ? (isDraftDirty ? 'Draft differs from applied' : 'Applied to map') : 'Unfiltered universe'}
        </span>
      </div>
    </div>
  )
}