// Market Intelligence boundary — read tools (capability 10). mi_* rollups.
import { readTool, obj, str } from './_read-tool.js'

export const marketIntelTools = [
  readTool({
    name: 'mi.market',
    capability: 10,
    app: 'market-intel',
    label: 'Reading market intelligence',
    description: 'Market rollups (sales, investor activity) for a geography and period, with sample sizes.',
    input_schema: obj({ geography: str(80), level: { type: 'string', enum: ['state', 'county', 'city', 'zip'] }, period: str(20), metric: str(60) }, ['geography']),
    wraps: { module: '@/lib/domain/market-intelligence/mi-service.js', export: 'marketIntelService', member: 'run', route: 'GET /api/cockpit/market-intel' },
    cost_class: 'db_heavy',
    to_model: ['geography', 'metric', 'value', 'sample_size', 'period'],
    invoke: (fn, input) => fn(input),
  }),
]
