/**
 * FLOW — a branching flow drawn as ribbons (implemented natively; Arc's
 * Sankey Flow is a Pro component this project does not license).
 *
 * Used only where branching is the question — every queue row's delivery
 * outcome splits into exactly one disposition and one class. A linear
 * funnel is never drawn this way. Node height and ribbon width are linear in
 * the count; every node is a button (hover traces its ribbons, click opens
 * its records); the counts are printed, so nothing is read from area alone.
 *
 * Labels never collide: the middle column sits left of centre so its labels
 * have a lane before the next column, the last column's labels have their
 * own lane, and labels too close together are spread apart with a short
 * leader back to their node (the flow grows taller when a column needs it).
 */
import { useMemo, useState } from 'react'
import { cx } from '../../../shared/lc'
import { fmtInt } from './intel-format'
import type { FlowLink, FlowNode } from './intel-model'
import { layoutFlow, placeFlowLabels } from './intel-model'

const LABEL_GAP = 16

export function IntelFlow({ nodes, links, columns, height = 300, width = 760, label, onPick, format = fmtInt }: {
  nodes: FlowNode[]; links: FlowLink[]; columns: number; height?: number; width?: number; label: string; onPick?: (n: FlowNode) => void; format?: (n: number) => string
}) {
  const [hover, setHover] = useState<string | null>(null)
  const padR = Math.round(Math.min(230, Math.max(150, width * 0.3)))
  const H = useMemo(() => {
    const per = new Map<number, number>()
    for (const n of nodes) if (n.value > 0) per.set(n.column, (per.get(n.column) || 0) + 1)
    return Math.max(height, Math.max(0, ...per.values()) * LABEL_GAP + 8)
  }, [nodes, height])
  const flow = useMemo(
    () => layoutFlow(nodes, links, { width: Math.max(200, width - padR), height: H, columns, colX: columns === 3 ? [0, 0.45, 1] : undefined }),
    [nodes, links, width, padR, H, columns],
  )
  const labelY = useMemo(() => placeFlowLabels(flow.nodes, H, LABEL_GAP), [flow, H])
  const lit = (l: { from: string; to: string }) => !hover || l.from === hover || l.to === hover
  const lane = (c: number, x: number) => (c >= columns - 1 ? padR - 14 : flow.xs(c + 1) - (x + flow.nodeW + 8) - 8)
  return (
    <div className="ixf" role="group" aria-label={label}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true" style={{ width, height: H }}>
        <g className="ixf__ribbons">
          {flow.ribbons.map((r) => <path key={`${r.from}-${r.to}`} d={r.d} data-tone={r.tone} className={cx('ixf__ribbon', !lit(r) && 'is-dim')} />)}
        </g>
        {flow.nodes.map((n) => <rect key={n.id} x={n.x} y={n.y} width={flow.nodeW} height={n.h} rx={2} data-tone={n.tone} className={cx('ixf__node', hover && hover !== n.id && !flow.ribbons.some((r) => (r.from === hover && r.to === n.id) || (r.to === hover && r.from === n.id)) && 'is-dim')} />)}
        {flow.nodes.map((n) => {
          const ly = labelY.get(n.id) ?? n.y + n.h / 2
          const cy = n.y + n.h / 2
          if (Math.abs(ly - cy) < 3) return null
          const x0 = n.x + flow.nodeW + 1
          return <path key={`k-${n.id}`} className="ixf__leader" d={`M${x0},${cy.toFixed(1)}L${(x0 + 6).toFixed(1)},${ly.toFixed(1)}`} />
        })}
      </svg>
      {flow.nodes.map((n) => (
        <button
          key={n.id}
          type="button"
          className={cx('ixf__label', `is-c${n.column}`, hover === n.id && 'is-on')}
          style={{ left: n.x + flow.nodeW + 8, top: labelY.get(n.id) ?? n.y + n.h / 2, maxWidth: Math.max(80, lane(n.column, n.x)) }}
          onPointerEnter={() => setHover(n.id)}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(n.id)}
          onBlur={() => setHover(null)}
          onClick={() => onPick?.(n)}
          title={n.hint || `${format(n.value)} · ${n.label}`}
        >
          <b>{format(n.value)}</b><span>{n.label}</span>
        </button>
      ))}
    </div>
  )
}
