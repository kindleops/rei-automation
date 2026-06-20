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
    degraded: templates.filter(t => t.health === 'degraded').length,
    critical: templates.filter(t => t.health === 'critical').length,
    lowSample: templates.filter(t => t.health === 'insufficient' || t.sent < 5).length,
    idle: templates.filter(t => t.usage === 0).length,
  }

  const tiles = [
    { label: 'Tracked', val: stats.total, tone: 'primary' },
    { label: 'Healthy', val: stats.healthy, tone: 'green' },
    { label: 'Watch', val: stats.watch, tone: 'amber' },
    { label: 'Degraded', val: stats.degraded, tone: 'amber' },
    { label: 'Critical', val: stats.critical, tone: 'red' },
    { label: 'Low Sample', val: stats.lowSample, tone: 'muted' },
    { label: 'No Usage', val: stats.idle, tone: 'muted' },
  ]

  return (
    <div className="occ-metric-strip occ-metric-strip--templates">
      <span className="occ-metric-strip__title">Template Performance Lab</span>
      <div className="occ-metric-strip__tiles">
        {tiles.map(t => (
          <div key={t.label} className={cls('occ-metric-strip__tile', `is-${t.tone}`)}>
            <span className="occ-metric-strip__val">{t.val}</span>
            <span className="occ-metric-strip__lbl">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}