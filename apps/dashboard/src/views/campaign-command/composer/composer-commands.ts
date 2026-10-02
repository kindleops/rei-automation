import type { CommandResult } from '../../../domain/command-center/command.types'

/**
 * Command Deck entries for the Composer. Pure: the deck matches what was typed
 * and routes; ⌘↵ opens the same path beside (the bar's own split gesture).
 *
 *   "new campaign"                      → /campaign-command?compose=1
 *   "new campaign from selection"       → …&property_ids=<linked property>  (only when a
 *                                          property was selected in THIS session)
 */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function composerCommands(query: string, ctx: { selection: { propertyId: string | null; address: string | null } | null }): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const wants = /^(?:new|create|compose|start|launch)(?: a)? ?(?:campaign|camp|outbound)?/.test(q) || /^campaign compos/.test(q) || /^compos/.test(q)
  if (!wants || !(/camp|compos|outbound/.test(q) || q.startsWith('new c'))) return []
  const out: CommandResult[] = [{
    id: 'composer:new',
    type: 'system_action',
    title: 'New campaign',
    subtitle: 'Campaign Composer — audience, strategy, delivery, schedule, launch',
    icon: 'send',
    score: 1100,
    route: '/campaign-command?compose=1',
    meta: { provider: 'composer', groupLabel: 'Campaign', hint: 'Compose' },
  }]
  const pid = ctx.selection?.propertyId
  if (pid) {
    const label = ctx.selection?.address || 'selected property'
    out.push({
      id: 'composer:selection',
      type: 'system_action',
      title: 'New campaign from current selection',
      subtitle: `Audience: ${label}`,
      icon: 'target',
      score: 1090,
      route: `/campaign-command?compose=1&property_ids=${encodeURIComponent(pid)}&label=${encodeURIComponent(label)}`,
      meta: { provider: 'composer', groupLabel: 'Campaign', hint: 'Compose' },
    })
  }
  return out
}
