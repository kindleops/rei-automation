// Notifications boundary — read tools (capability 12).
import { readTool, obj, str, int } from './_read-tool.js'

export const notificationTools = [
  readTool({
    name: 'notifications.list',
    capability: 12,
    app: 'notifications',
    label: 'Listing notifications',
    description: 'Notification events (read-only; listing never marks anything read).',
    input_schema: obj({ status: str(20), severity: str(20), limit: int(1, 100) }),
    wraps: { module: '@/lib/domain/notifications/notification-intelligence-service.js', export: 'listNotificationEvents', route: 'GET /api/cockpit/notifications' },
    to_model: ['event_type', 'severity', 'title', 'created_at'],
    invoke: (fn, input) => fn({ ...input, limit: Math.min(input.limit || 50, 100) }),
  }),
]
