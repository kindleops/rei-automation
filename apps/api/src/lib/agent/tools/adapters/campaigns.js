// Campaigns / Composer boundary — read tools (capability 5). Counts come from
// the campaign target graph via the Composer services (no sampling).
import { readTool, obj, str, strList } from './_read-tool.js'

const MOD = '@/lib/domain/campaigns/campaign-composer.js'

export const campaignTools = [
  readTool({
    name: 'composer.audience_preview',
    capability: 5,
    app: 'campaign-command',
    label: 'Previewing campaign audience eligibility',
    description: 'Ready / held / ineligible counts by reason for a composer spec, from the graph.',
    input_schema: obj({ markets: strList(20, 80), property_types: strList(10, 40), template_use_case: str(60), stage_code: str(20) }),
    wraps: { module: MOD, export: 'readComposerAudience', route: 'GET /api/cockpit/campaigns/composer?part=audience' },
    cost_class: 'db_heavy',
    to_model: ['counts', 'reasons', 'market'],
    invoke: (fn, input) => fn(input),
  }),
  readTool({
    name: 'composer.coverage',
    capability: 5,
    app: 'campaign-command',
    label: 'Checking sender coverage for markets',
    description: 'Sender coverage for the given markets (approved regional pools).',
    input_schema: obj({ markets: strList(20, 80) }, ['markets']),
    wraps: { module: MOD, export: 'readComposerCoverage', route: 'GET /api/cockpit/campaigns/composer?part=coverage' },
    to_model: ['market', 'coverage'],
    invoke: (fn, input) => fn(input.markets),
  }),
]
