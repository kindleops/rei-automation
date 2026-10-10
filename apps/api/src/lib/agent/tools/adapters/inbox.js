// Inbox boundary — read tools (capability 7). Message text is UNTRUSTED
// content: it is wrapped, recorded into the turn's untrusted spans and can
// never create intent, select recipients, or approve anything. Seller-message
// text may only reach a model after the O1 processor review (gateway refuses).
import { readTool, obj, str, int } from './_read-tool.js'

const MOD = '@/lib/domain/inbox/live-inbox-service.js'

export const inboxTools = [
  readTool({
    name: 'inbox.threads',
    capability: 7,
    app: 'inbox',
    label: 'Listing inbox threads',
    description: 'Inbox threads for a bucket via the inbox_bucket predicate.',
    input_schema: obj({ bucket: str(40), market: str(80), page: int(1, 500), limit: int(1, 100) }),
    wraps: { module: MOD, export: 'getLiveInbox', route: 'GET /api/cockpit/inbox/live' },
    to_model: ['thread_id', 'bucket', 'market', 'language', 'last_activity_at'],
    never: ['seller_name', 'owner_name', 'body', 'message_body'],
    invoke: (fn, input) => fn({ ...input, limit: Math.min(input.limit || 50, 100) }),
  }),
  readTool({
    name: 'inbox.thread_messages',
    capability: 7,
    app: 'inbox',
    label: 'Reading thread messages',
    description: 'Messages of one thread (untrusted content; scrubbed before any model use).',
    input_schema: obj({ thread_id: str(120), limit: int(1, 50) }, ['thread_id']),
    wraps: { module: MOD, export: 'getThreadMessages', route: 'GET /api/cockpit/inbox/thread-messages' },
    to_model: ['direction', 'at', 'language'],
    never: ['seller_name', 'owner_name'],
    invoke: (fn, input) => fn(input.thread_id, { limit: Math.min(input.limit || 20, 50) }),
  }),
]
