// Entity Graph boundary — read tools (capability 1, 2). Wraps the same
// services the /api/cockpit/entity-graph routes call. No EG implementation
// file is modified; these are lazy references only.
import { readTool, obj, str, int, strList } from './_read-tool.js'

const MOD = '@/lib/domain/entity-graph/entity-graph-service.js'

export const entityGraphTools = [
  readTool({
    name: 'eg.list',
    capability: 1,
    app: 'entity-graph',
    label: 'Listing Entity Graph records',
    description: 'List Entity Graph records for a scope with server-side filters and indexed sorts (≤ 200 rows).',
    input_schema: obj({ scope: { type: 'string', enum: ['properties', 'owners', 'prospects', 'buyers', 'phones'] }, market: str(80), search: str(120), page: int(1, 1000), page_size: int(1, 200), sort: str(60) }, ['scope']),
    wraps: { module: MOD, export: 'browseEntityGraph', route: 'GET /api/cockpit/entity-graph' },
    to_model: ['property_id', 'address', 'market', 'property_type', 'counts'],
    invoke: (fn, input) => fn({ ...input, limit: Math.min(input.page_size || 50, 200) }),
  }),
  readTool({
    name: 'eg.counts',
    capability: 1,
    app: 'entity-graph',
    label: 'Counting Entity Graph records',
    description: 'Entity Graph universe counts by scope.',
    input_schema: obj({}),
    wraps: { module: MOD, export: 'getEntityGraphCounts', route: 'GET /api/cockpit/entity-graph/counts' },
    to_model: ['counts'],
    invoke: (fn) => fn(),
  }),
  readTool({
    name: 'eg.kpis',
    capability: 1,
    app: 'entity-graph',
    label: 'Reading Entity Graph KPIs',
    description: 'Entity Graph KPI tiles (the same figures the desk shows).',
    input_schema: obj({}),
    wraps: { module: '@/lib/domain/entity-graph/entity-graph-kpis.js', export: 'getEntityGraphKpis', route: 'GET /api/cockpit/entity-graph/kpis' },
    to_model: ['counts', 'kpis'],
    invoke: (fn) => fn(),
  }),
  readTool({
    name: 'eg.property_ids',
    capability: 1,
    app: 'entity-graph',
    label: 'Resolving the selected property set',
    description: 'Resolve a filtered property selection to ids (for cohort snapshots).',
    input_schema: obj({ market: str(80), filters: strList(40, 200), limit: int(1, 5000) }),
    wraps: { module: MOD, export: 'listEntityGraphPropertyIds', route: 'GET /api/cockpit/entity-graph?ids_only=1' },
    to_model: ['property_id', 'count'],
    limits: { rows_to_model: 50, max_rows: 5000 },
    invoke: (fn, input) => fn(input),
  }),
]
