import { useEffect, useMemo, useRef } from 'react'
import { useAgentContextSnapshot } from '../../context/agent-context'
import { openLivePreflight, refreshLiveCapability, useLiveCapability } from '../../runtime/agent-store'
import { maskedPropertyLabel, MAX_CONTEXT_PROPERTIES, type MentionChip } from '../ask-model'
import { resetDismissedAuto, useAsk } from '../ask-store'

/**
 * What the composer attaches on its own: the linked property and the Entity
 * Graph row selection (published via lc:entity-graph-selection), each as a
 * removable chip. A removed auto chip stays removed until the selection
 * changes. Also: whether the $0 Quick Scan applies, and context suggestions.
 */
export function useAskContext() {
  const ctx = useAgentContextSnapshot()
  const cap = useLiveCapability()
  const s = useAsk()
  useEffect(() => { if (cap.status === 'unknown') void refreshLiveCapability() }, [cap.status])

  const pid = ctx.property?.id ?? null
  const label = ctx.property?.address ?? (pid ? s.labels[pid] ?? null : null)
  const sel = ctx.selection && ctx.selection.count > 1 ? ctx.selection : null
  const selKey = sel ? `selection:${sel.property_ids.slice(0, 3).join(',')}:${sel.count}` : null

  const autoChips = useMemo<MentionChip[]>(() => {
    const out: MentionChip[] = []
    if (sel) {
      const n = Math.min(sel.count, MAX_CONTEXT_PROPERTIES)
      out.push({ key: selKey!, kind: 'selection', id: 'eg-selection', label: `${sel.count} selected`, detail: sel.count > MAX_CONTEXT_PROPERTIES ? `Entity Graph rows · first ${n} read` : 'Entity Graph rows', property_ids: sel.property_ids.slice(0, MAX_CONTEXT_PROPERTIES), auto: true })
    } else if (pid) {
      out.push({ key: `property:${pid}`, kind: 'property', id: pid, label: label ?? maskedPropertyLabel(pid), detail: ctx.property?.sourceLabel ? `linked · ${ctx.property.sourceLabel}` : 'linked selection', property_ids: [pid], auto: true })
    }
    return out
  }, [pid, label, selKey, sel, ctx.property?.sourceLabel])

  // a new selection brings auto-attach back
  const lastKey = useRef<string | null>(null)
  const autoKey = autoChips.map((c) => c.key).join('|')
  useEffect(() => { if (lastKey.current !== null && lastKey.current !== autoKey) resetDismissedAuto(); lastKey.current = autoKey }, [autoKey])

  const liveReady = cap.status === 'available'
  const quickScan = {
    available: Boolean(pid) && liveReady,
    reason: !pid ? 'Link a property first (select one in Entity Graph)' : !liveReady ? cap.reason ?? 'Quick Scan is not available on this API' : null,
    run: () => { if (pid) openLivePreflight({ propertyIds: [pid], addresses: [label], originApp: ctx.property?.sourceApp ?? ctx.app, originLabel: `${ctx.property?.sourceLabel ?? ctx.appLabel ?? 'Linked'} selection` }) },
  }

  const suggestions = useMemo(() => {
    const out: Array<{ id: string; label: string; text: string }> = []
    if (sel) out.push({ id: 'cmp', label: `Compare the ${Math.min(sel.count, MAX_CONTEXT_PROPERTIES)} selected properties`, text: '/compare ' })
    if (pid || sel) {
      out.push({ id: 'inc', label: sel ? 'Find inconsistencies across the selection' : 'Find inconsistencies on this property', text: '/inconsistencies ' })
      out.push({ id: 'res', label: sel ? 'Which of these has the strongest distress evidence?' : 'What distress evidence does this property have?', text: sel ? '/research Which of these has the strongest distress evidence?' : '/research What distress evidence does this property have, and from which sources?' })
    }
    out.push({ id: 'cmp-campaign', label: 'Strongest targets in a campaign', text: '@campaign ' })
    out.push({ id: 'hot', label: 'Explain what makes my HOT LEADS hot', text: '/explain @hot' })
    return out.slice(0, 4)
  }, [sel, pid])

  return { ctx, autoChips, quickScan, suggestions }
}
