// Queue boundary — read tools (capability 11). Reads the dashboard snapshot
// only; nothing in lib/domain/queue (the send engine) is wrapped or touched.
import { readTool, obj, str, int } from './_read-tool.js'

export const queueTools = [
  readTool({
    name: 'queue.snapshot',
    capability: 11,
    app: 'queue',
    label: 'Reading queue status',
    description: 'Queue snapshot (masked phones) for diagnosis. failed_transport is never rendered as scheduled.',
    input_schema: obj({ status: str(30), campaign_id: str(80), page: int(1, 500), limit: int(1, 100) }),
    wraps: { module: '@/lib/dashboard/ops-service.js', export: 'getOpsQueueSnapshot', route: 'GET /api/cockpit/queue/page' },
    to_model: ['status', 'counts', 'market', 'scheduled_for_utc'],
    never: ['to_phone', 'from_phone', 'body', 'message_body'],
    invoke: (fn, input) => fn({ ...input, limit: Math.min(input.limit || 50, 100) }),
  }),
]
