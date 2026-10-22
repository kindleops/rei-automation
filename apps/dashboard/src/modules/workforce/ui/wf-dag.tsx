import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../../../shared/lc'
import type { WfAssignment, WfPlan } from '../api/wf-types'
import { capabilityLabel, planDag, roleLabel, type DagNode } from '../model/wf-model'
import { useWfNav } from './wf-context'

const STATE_LABEL: Record<DagNode['state'], string> = {
  idle: 'Not started', queued: 'Queued', active: 'Working', waiting: 'Waiting', blocked: 'Blocked', failed: 'Failed', done: 'Done', unavailable: 'Not in Phase A',
}

interface Edge { d: string; state: DagNode['state'] }

/**
 * The plan as a DAG: layers by dependency depth, one node per step with its
 * assignments' live state, edges drawn from the measured layout (so they stay
 * true at every pane width). A step the playbook names but Phase A cannot run
 * is shown, dashed, with its reason: never hidden, never faked.
 */
export function WfPlanDag({ plan, assignments, selected, onSelect }: { plan: WfPlan | null; assignments: ReadonlyArray<WfAssignment>; selected?: string | null; onSelect?: (stepKey: string) => void }) {
  const nav = useWfNav()
  const layers = useMemo(() => planDag(plan, assignments), [plan, assignments])
  const host = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<Edge[]>([])
  const [box, setBox] = useState({ w: 0, h: 0 })
  // side by side only when every layer gets a readable column; otherwise the plan reads top-down
  const [vertical, setVertical] = useState(false)
  const sig = layers.map((l) => l.map((n) => `${n.step.step_key}:${n.state}`).join(',')).join('|')

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const measure = () => {
      const wantVertical = (el.parentElement?.clientWidth ?? el.clientWidth) < layers.length * 196
      if (wantVertical !== el.classList.contains('is-vertical')) { setVertical(wantVertical); return }
      const base = el.getBoundingClientRect()
      const pos = new Map<string, DOMRect>()
      el.querySelectorAll<HTMLElement>('[data-step]').forEach((n) => pos.set(n.dataset.step!, n.getBoundingClientRect()))
      const out: Edge[] = []
      const vertical = el.classList.contains('is-vertical')
      for (const layer of layers) for (const n of layer) for (const dep of n.step.depends_on) {
        const a = pos.get(dep)
        const b = pos.get(n.step.step_key)
        if (!a || !b) continue
        if (vertical) {
          const x1 = a.left + a.width / 2 - base.left, y1 = a.bottom - base.top, x2 = b.left + b.width / 2 - base.left, y2 = b.top - base.top
          const my = (y1 + y2) / 2
          out.push({ d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, state: n.state })
        } else {
          const x1 = a.right - base.left, y1 = a.top + a.height / 2 - base.top, x2 = b.left - base.left, y2 = b.top + b.height / 2 - base.top
          const mx = (x1 + x2) / 2
          out.push({ d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, state: n.state })
        }
      }
      setEdges(out)
      setBox({ w: el.scrollWidth, h: el.scrollHeight })
    }
    // the observer fires once on observe, then on every resize
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [sig, layers, vertical])

  if (!layers.length) return <p className="wf-quiet">No plan recorded yet.</p>
  return (
    <div className={cx('wf-dag', vertical && 'is-vertical')} ref={host} style={{ ['--wf-layers' as string]: layers.length }}>
      <svg className="wf-dag__edges" width={box.w} height={box.h} aria-hidden="true">
        {edges.map((e, i) => <path key={i} d={e.d} data-state={e.state} />)}
      </svg>
      {layers.map((layer, i) => (
        <div className="wf-dag__layer" key={i}>
          {layer.map((n) => {
            const owner = n.assignments[0]?.assignee_employee_id ? nav.employees.get(n.assignments[0].assignee_employee_id!)?.display_name : null
            return (
              <button
                type="button"
                key={n.step.step_key}
                data-step={n.step.step_key}
                data-state={n.state}
                className={cx('wf-node', selected === n.step.step_key && 'is-on')}
                onClick={() => onSelect?.(n.step.step_key)}
                title={n.step.unavailable_reason ?? `${capabilityLabel(n.step.capability_key)} · ${n.step.capability_key}`}
              >
                <span className="wf-node__h">
                  <i className="wf-node__dot" aria-hidden="true" />
                  <span className="wf-node__s">{STATE_LABEL[n.state]}</span>
                  {n.progress.total ? <span className="wf-node__n lc-num">{n.progress.done}/{n.progress.total - n.progress.cancelled}</span> : null}
                </span>
                <span className="wf-node__t">{n.step.label ?? capabilityLabel(n.step.capability_key)}</span>
                <span className="wf-node__m">{owner ?? (n.step.assignee_role ? roleLabel(n.step.assignee_role) : 'Unassigned')}{n.step.fan_out ? ' · per candidate' : ''}</span>
                {n.step.unavailable_reason ? <span className="wf-node__why">{n.step.unavailable_reason}</span> : null}
                {n.progress.total > 1 ? (
                  <span className="wf-node__bar" aria-hidden="true">
                    <i data-tone="ok" style={{ flexGrow: n.progress.done }} />
                    <i data-tone="exec" style={{ flexGrow: n.progress.active }} />
                    <i data-tone="neutral" style={{ flexGrow: n.progress.waiting + n.progress.queued }} />
                    <i data-tone="crit" style={{ flexGrow: n.progress.blocked + n.progress.failed }} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
