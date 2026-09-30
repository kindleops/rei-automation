import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { FAMILY } from '../families'
import type { RegistryEntry, Topology, WorkflowTelemetry } from '../observatory-types'
import { fmtCount } from '../canvas/CanvasNode'
import { StudioCanvas } from '../canvas/StudioCanvas'

interface Impulse { id: string; to: number }

/**
 * THE FIRST FRAME: this is automation. The workflow's macro stages as a live
 * pipeline — volume through each stage for the period, the exceptions that
 * stage produced, and ONE restrained impulse per new run travelling as far as
 * the run actually got. Reduced motion: the stage it reached simply lights.
 */
export function MiniLiveGraph({ workflow, topology, telemetry, arrivals, still, onOpenCanvas, onOpenNode, wide = false }: {
  workflow: RegistryEntry | null
  topology: Topology | null
  telemetry: WorkflowTelemetry | null
  /** new runs since the last poll, each with the node it reached */
  arrivals: Array<{ run_id: string; node_key: string | null }>
  still: boolean
  onOpenCanvas: () => void
  onOpenNode: (nodeKey: string) => void
  /** an ultrawide pane: show the whole real topology, not the stage summary */
  wide?: boolean
}) {
  const stages = topology?.stages?.length ? topology.stages : topology ? topology.nodes.filter((n) => (n.lane ?? 0) === 0 && !n.group).slice(0, 8).map((n) => ({ key: n.key, label: n.short || n.label, nodes: [n.key] })) : []
  const [impulses, setImpulses] = useState<Impulse[]>([])
  const [lit, setLit] = useState<string | null>(null)
  const seen = useRef<Set<string>>(new Set())
  const primed = useRef(false)

  // another workflow: its recent runs are history too
  useEffect(() => { primed.current = false; seen.current = new Set(); setImpulses([]) }, [workflow?.workflow_key])

  useEffect(() => {
    const fresh = arrivals.filter((a) => !seen.current.has(a.run_id))
    for (const a of arrivals) seen.current.add(a.run_id)
    // runs already there when the page opened are history, not arrivals
    if (!primed.current) { primed.current = arrivals.length > 0; return }
    if (!fresh.length || !stages.length) return
    const idxOf = (nk: string | null) => Math.max(0, stages.findIndex((s) => nk && s.nodes.includes(nk)))
    if (still) { const i = idxOf(fresh[fresh.length - 1].node_key); setLit(stages[i]?.key || null); const t = window.setTimeout(() => setLit(null), 2400); return () => window.clearTimeout(t) }
    setImpulses((cur) => [...cur, ...fresh.slice(-3).map((a) => ({ id: `${a.run_id}:${Date.now()}`, to: stages.length > 1 ? idxOf(a.node_key) / (stages.length - 1) : 0 }))].slice(-3))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals, still])

  if (!workflow || !topology) return <section className="ws3-mini is-loading" aria-busy="true"><div className="ws3-skel-line" /><div className="ws3-skel-pipe" /></section>

  // one run can be held at two nodes of a stage — take the largest, never the sum
  const stat = (keys: string[]) => {
    let entered = 0; let held = 0; let human = 0; let failed = 0; let waiting = 0
    for (const k of keys) {
      const t = telemetry?.nodes[k]
      if (!t) continue
      entered = Math.max(entered, t.entered); held = Math.max(held, t.held); human = Math.max(human, t.human); failed = Math.max(failed, t.failed); waiting += t.waiting_now
    }
    return { entered, held, human, failed, waiting }
  }

  return (
    <section className="ws3-mini" aria-label={`${workflow.name} — live pipeline`}>
      <header className="ws3-mini__head">
        <span className="ws3-mini__title">
          <small>{workflow.kind === 'system' ? 'System workflow' : 'Studio workflow'} · {workflow.owner_app}</small>
          <strong>{workflow.name}</strong>
        </span>
        <span className="ws3-mini__meta">{telemetry ? `${fmtCount(telemetry.runs.total)} runs · ${telemetry.period}` : '—'}</span>
        <button type="button" className="ws3-btn is-primary" onClick={onOpenCanvas}><Icon name="grid" />Open canvas</button>
      </header>
      {wide ? (
        <div className="ws3-mini__board">
          <StudioCanvas topology={topology} telemetry={telemetry} expanded={NONE} selected={null} onSelect={(k) => { if (k) onOpenNode(k) }} mini interactive={false} reducedMotion={still} />
        </div>
      ) : null}
      <div className={`ws3-mini__pipe${wide ? ' is-hidden' : ''}`} style={{ ['--n' as string]: stages.length }}>
        <span className="ws3-mini__track" aria-hidden>
          {impulses.map((m) => <i key={m.id} className="ws3-mini__impulse" style={{ ['--to' as string]: m.to }} onAnimationEnd={() => setImpulses((cur) => cur.filter((x) => x.id !== m.id))} />)}
        </span>
        {stages.map((s) => {
          const first = topology.nodes.find((n) => n.key === s.nodes[0])
          const meta = first ? FAMILY[first.family] : FAMILY.ACTION
          const x = stat(s.nodes)
          return (
            <button key={s.key} type="button" className={`ws3-mini__stage is-${meta.tone}${lit === s.key ? ' is-lit' : ''}${x.waiting ? ' is-human' : ''}`} onClick={() => onOpenNode(s.nodes[0])}>
              <span className="ws3-mini__glyph"><Icon name={meta.icon} /></span>
              <b>{fmtCount(x.entered)}</b>
              <strong>{s.label}</strong>
              <small>
                {x.waiting ? <em className="is-human">{fmtCount(x.waiting)} waiting</em> : null}
                {x.failed ? <em className="is-bad">{fmtCount(x.failed)} failed</em> : null}
                {x.held ? <em className="is-held">{fmtCount(x.held)} held</em> : null}
                {x.human && !x.waiting ? <em className="is-human">{fmtCount(x.human)} to a person</em> : null}
                {!x.failed && !x.held && !x.human && !x.waiting ? <em>clear</em> : null}
              </small>
            </button>
          )
        })}
      </div>
      <p className="ws3-mini__foot"><i className="ws3-livedot" aria-hidden />{topology.badge}</p>
    </section>
  )
}

const NONE: ReadonlySet<string> = new Set()
