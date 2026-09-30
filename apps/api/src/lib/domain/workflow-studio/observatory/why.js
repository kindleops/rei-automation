/**
 * WHY — a run explained in business language, from its own path and the
 * runtime's own reason codes. Never prose invented by a model, never a
 * chain of thought: it names the node that decided and the recorded reason.
 */
import { human } from './core.js'

export const WHY_HEAD = Object.freeze({
  completed: 'WHY IT COMPLETED', running: 'WHERE IT IS', waiting: 'WHY IT IS WAITING', held: 'WHY HELD',
  needs_you: 'WHY IT NEEDS YOU', failed: 'WHY IT FAILED', cancelled: 'WHY IT STOPPED',
})
export const WHY_TONE = Object.freeze({ completed: 'good', running: 'active', waiting: 'active', held: 'held', needs_you: 'human', failed: 'bad', cancelled: 'muted' })

export function whyOf(run, path, topology) {
  const label = (k) => topology.nodes.find((n) => n.key === k)?.label || human(k)
  const decisive = [...path.order].reverse().find((k) => ['failed', 'held', 'blocked', 'human', 'needs_review', 'waiting'].includes(path.nodes[k]?.status))
  const lines = []
  if (decisive) {
    const n = path.nodes[decisive]
    lines.push(`${label(decisive)}${n.reason ? ` — ${human(n.reason)}` : ''}`)
  }
  if (run.reason && !lines.some((l) => l.toLowerCase().includes(String(run.reason).toLowerCase()))) lines.push(human(run.reason))
  if (run.result) lines.push(run.result)
  const last = run.final_node || run.current_node
  if (last && last !== decisive) lines.push(`${run.status === 'completed' ? 'Finished at' : 'Now at'} ${label(last)}`)
  return { headline: WHY_HEAD[run.status] || 'WHAT HAPPENED', tone: WHY_TONE[run.status] || 'muted', lines: [...new Set(lines)].slice(0, 6) }
}
