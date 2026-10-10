// Pipeline boundary — read tools (capability 9). Stage is a projection of
// offer/contract/closing events; the agent reads it, never derives it.
import { readTool, obj, str, int } from './_read-tool.js'

export const pipelineTools = [
  readTool({
    name: 'pipeline.list',
    capability: 9,
    app: 'pipeline',
    label: 'Listing pipeline opportunities',
    description: 'Opportunities for a stage lens (opportunities-only predicate).',
    input_schema: obj({ stage: str(40), market: str(80), temperature: str(20), page: int(1, 500), limit: int(1, 100) }),
    wraps: { module: '@/lib/domain/opportunity/opportunity-service.js', export: 'listOpportunities', route: 'GET /api/cockpit/pipeline/opportunities' },
    to_model: ['opportunity_id', 'property_id', 'stage', 'temperature', 'market', 'next_follow_up_at'],
    never: ['seller_name', 'owner_name'],
    invoke: (fn, input) => fn({ ...input, limit: Math.min(input.limit || 50, 100) }),
  }),
]
