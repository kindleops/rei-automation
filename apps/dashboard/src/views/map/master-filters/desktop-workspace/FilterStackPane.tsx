import { useMasterFilters } from '../MasterFiltersProvider'
import { GroupCard } from '../shared/GroupCard'

export function FilterStackPane() {
  const { draftExpression } = useMasterFilters()

  return (
    <main className="mf-pane mf-pane--stack">
      <h3 className="mf-pane__title">Filter stack</h3>
      <div className="mf-pane__scroll">
        <GroupCard group={draftExpression} isRoot depth={0} />
      </div>
    </main>
  )
}