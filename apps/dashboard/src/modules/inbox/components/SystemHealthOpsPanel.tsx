export type ServiceStatus = 'LIVE' | 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'ERROR' | 'RATE LIMITED' | 'DISCONNECTED'

export interface ServiceHealth {
  name: string
  status: ServiceStatus
  latencyMs?: number
  lastUpdated: string
}

// Mocked live data for the Pre-Launch Ops Panel
const MOCK_SERVICES: ServiceHealth[] = [
  { name: 'Feeder', status: 'HEALTHY', latencyMs: 45, lastUpdated: new Date().toISOString() },
  { name: 'Queue Runner', status: 'LIVE', latencyMs: 120, lastUpdated: new Date().toISOString() },
  { name: 'Auto Reply', status: 'LIVE', latencyMs: 800, lastUpdated: new Date().toISOString() },
  { name: 'Webhooks', status: 'HEALTHY', latencyMs: 30, lastUpdated: new Date().toISOString() },
  { name: 'TextGrid', status: 'HEALTHY', latencyMs: 150, lastUpdated: new Date().toISOString() },
  { name: 'Supabase', status: 'HEALTHY', latencyMs: 12, lastUpdated: new Date().toISOString() },
  { name: 'Podio Sync', status: 'DEGRADED', latencyMs: 1500, lastUpdated: new Date().toISOString() },
  { name: 'AI Classification', status: 'LIVE', latencyMs: 950, lastUpdated: new Date().toISOString() },
]

const getStatusColor = (status: ServiceStatus) => {
  switch (status) {
    case 'LIVE':
    case 'HEALTHY':
      return 'var(--nexus-green, #10b981)'
    case 'DEGRADED':
    case 'RATE LIMITED':
    case 'PAUSED':
      return 'var(--nexus-yellow, #f59e0b)'
    case 'ERROR':
    case 'DISCONNECTED':
      return 'var(--nexus-red, #ef4444)'
    default:
      return 'var(--nexus-gray, #9ca3af)'
  }
}

export function SystemHealthOpsPanel() {
  return (
    <div style={{
      background: 'var(--nexus-bg-surface, #1e1e1e)',
      border: '1px solid var(--nexus-border, #333)',
      borderRadius: '8px',
      padding: '16px',
      marginTop: '16px',
      color: 'var(--nexus-text, #e5e5e5)',
      fontFamily: 'monospace'
    }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Live Ops Panel
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        {MOCK_SERVICES.map(service => (
          <div key={service.name} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--nexus-bg-elevated, #2a2a2a)',
            padding: '8px 12px',
            borderRadius: '4px'
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600 }}>{service.name}</div>
              <div style={{ fontSize: '10px', color: 'var(--nexus-text-muted, #999)' }}>
                {service.latencyMs ? `${service.latencyMs}ms` : '—'}
              </div>
            </div>
            <div style={{
              fontSize: '10px',
              fontWeight: 'bold',
              padding: '2px 6px',
              borderRadius: '12px',
              background: `${getStatusColor(service.status)}20`,
              color: getStatusColor(service.status),
              border: `1px solid ${getStatusColor(service.status)}40`
            }}>
              {service.status}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
