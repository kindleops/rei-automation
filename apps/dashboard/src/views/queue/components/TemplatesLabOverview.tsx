const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface TemplateOverviewData {
  id: string
  name: string
  health: string
  healthLabel: string
  sent: number
  usage: number
  deliveryPct: number
  failPct: number
}

interface TemplatesLabOverviewProps {
  templates: TemplateOverviewData[]
}

export function TemplatesLabOverview({ templates }: TemplatesLabOverviewProps) {
  const stats = {
    total: templates.length,
    healthy: templates.filter(t => t.health === 'healthy').length,
    watch: templates.filter(t => t.health === 'watch').length,
    degraded: templates.filter(t => t.health === 'degraded' || t.health === 'critical').length,
    lowSample: templates.filter(t => t.health === 'insufficient' || t.sent < 5).length,
    idle: templates.filter(t => t.usage === 0).length,
  }

  return (
    <div className="occ-tpl-overview">
      <header className="occ-tpl-overview__head">
        <span>Template Performance Lab</span>
        <span>{stats.total} tracked</span>
      </header>
      <div className="occ-tpl-overview__grid">
        {[
          { label: 'Healthy', val: stats.healthy, tone: 'green' },
          { label: 'Watch', val: stats.watch, tone: 'amber' },
          { label: 'Degraded', val: stats.degraded, tone: 'red' },
          { label: 'Low Sample', val: stats.lowSample, tone: 'muted' },
          { label: 'No Usage', val: stats.idle, tone: 'muted' },
        ].map(s => (
          <div key={s.label} className={cls('occ-tpl-overview__stat', `is-${s.tone}`)}>
            <span className="occ-tpl-overview__val">{s.val}</span>
            <span className="occ-tpl-overview__lbl">{s.label}</span>
          </div>
        ))}
      </div>
      <p className="occ-tpl-overview__note">Health reflects sample size — low volume is never labeled elite.</p>
    </div>
  )
}