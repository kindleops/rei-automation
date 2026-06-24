interface IntelligenceRailData {
  tracked_templates?: number
  healthy?: number
  watch?: number
  degraded?: number
  critical?: number
  current_winner?: string | null
  highest_opt_out_risk?: string | null
  strongest_stage_advancement?: string | null
  largest_delivery_decline?: string | null
  lacking_attribution?: number
  recommended_actions?: string[]
}

interface TemplateIntelligenceRailProps {
  data: IntelligenceRailData | null
  loading?: boolean
  onFilter?: (patch: Record<string, string>) => void
}

const Row = ({ label, value, tone, onClick }: { label: string; value: React.ReactNode; tone?: string; onClick?: () => void }) => (
  <button type="button" className="occ-tpl-rail__row" onClick={onClick} disabled={!onClick}>
    <span className="occ-tpl-rail__label">{label}</span>
    <span className={tone ? `is-${tone}` : ''}>{value ?? '—'}</span>
  </button>
)

export function TemplateIntelligenceRail({ data, loading, onFilter }: TemplateIntelligenceRailProps) {
  if (loading) return <aside className="occ-tpl-rail"><p className="occ-tpl-rail__note">Loading intelligence…</p></aside>
  if (!data) return null

  return (
    <aside className="occ-tpl-rail">
      <header className="occ-tpl-rail__head">Command Intelligence</header>
      <div className="occ-tpl-rail__body">
        <Row label="Tracked templates" value={data.tracked_templates} onClick={() => onFilter?.({})} />
        <Row label="Healthy" value={data.healthy} tone="green" />
        <Row label="Watch" value={data.watch} tone="amber" />
        <Row label="Degraded" value={data.degraded} tone="amber" />
        <Row label="Critical" value={data.critical} tone="red" />
        <Row label="Current winner" value={data.current_winner} />
        <Row label="Highest opt-out risk" value={data.highest_opt_out_risk} tone="red" />
        <Row label="Strongest stage advancement" value={data.strongest_stage_advancement} tone="green" />
        <Row label="Largest delivery decline" value={data.largest_delivery_decline} tone="amber" />
        <Row label="Lacking attribution" value={data.lacking_attribution} onClick={() => onFilter?.({ tpl_perf: 'insufficient_data' })} />
        {(data.recommended_actions ?? []).map((action) => (
          <p key={action} className="occ-tpl-rail__action">{action}</p>
        ))}
      </div>
    </aside>
  )
}