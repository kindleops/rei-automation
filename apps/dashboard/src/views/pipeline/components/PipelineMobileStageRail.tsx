const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface StageRailItem {
  id: string
  label: string
  tone: string
  count: number
}

interface PipelineMobileStageRailProps {
  stages: StageRailItem[]
  activeId: string
  onSelect: (id: string) => void
}

export function PipelineMobileStageRail({ stages, activeId, onSelect }: PipelineMobileStageRailProps) {
  const active = stages.find((s) => s.id === activeId) ?? stages[0]

  return (
    <div className="plv-mobile-stage-rail">
      {active && (
        <div className={cls('plv-mobile-stage-hero', `is-${active.tone}`)}>
          <div>
            <span className="plv-mobile-stage-hero__kicker">Current lane</span>
            <strong>{active.label}</strong>
          </div>
          <em>{active.count}</em>
        </div>
      )}

      <div className="plv-mobile-stage-scroll" role="tablist" aria-label="Pipeline stages">
        {stages.map((stage) => (
          <button
            key={stage.id}
            type="button"
            role="tab"
            aria-selected={stage.id === activeId}
            className={cls(
              'plv-mobile-stage-pill',
              `is-${stage.tone}`,
              stage.count === 0 && 'is-empty',
              stage.id === activeId && 'is-active',
            )}
            onClick={() => onSelect(stage.id)}
          >
            <span>{stage.label}</span>
            <em>{stage.count}</em>
          </button>
        ))}
      </div>
    </div>
  )
}