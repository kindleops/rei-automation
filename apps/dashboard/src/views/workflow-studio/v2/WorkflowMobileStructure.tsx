import { useMemo } from 'react'
import { Icon } from '../../../shared/icons'
import type { WorkflowDetail, WorkflowEdge, WorkflowStep } from '../workflow.types'

/**
 * THE STRUCTURED WORKFLOW VIEW (§16).
 *
 * Mobile opened on WorkflowCanvasV2 — the desktop node canvas — at 390px, which
 * §16 names explicitly: "Do not display a miniature desktop canvas with
 * unreadable nodes as the default editor." At that width the studio reported
 * "0 nodes · 0 paths / Fit Center Focus − 42% +", i.e. a pan-and-zoom surface
 * whose controls were bigger than its content.
 *
 * A workflow is an ORDERED THING before it is a spatial one, so on a phone it is
 * read as a list: trigger, then each step in execution order, with its delay, its
 * conditions and its branches stated in words. The canvas is not removed — it
 * becomes an explicitly entered full-screen mode, which is what §16 asks for.
 *
 * ORDER IS THE PRODUCT'S, NOT THIS FILE'S. Steps render by `step_order`, which is
 * the same key the runtime walks. Branch labels come from the edges the definition
 * actually declares. Nothing here infers a sequence the engine would not follow.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const NODE_ICON: Record<string, Parameters<typeof Icon>[0]['name']> = {
  trigger: 'zap',
  send: 'send',
  sms: 'message',
  email: 'mail',
  wait: 'clock',
  delay: 'clock',
  condition: 'filter',
  branch: 'layout-split',
  guard: 'shield',
  action: 'bolt',
  end: 'check',
}

const iconForNode = (nodeType: string): Parameters<typeof Icon>[0]['name'] => {
  const key = String(nodeType || '').toLowerCase()
  for (const [token, icon] of Object.entries(NODE_ICON)) {
    if (key.includes(token)) return icon
  }
  return 'layers'
}

const humanize = (value: string): string =>
  String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

/** "after 2 days", "immediately" — the wait the runtime will actually apply. */
const describeDelay = (step: WorkflowStep): string | null => {
  const amount = step.delay_amount
  if (amount == null || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return null
  const unit = String(step.delay_unit || 'minutes').replace(/s$/, '')
  const n = Number(amount)
  return `Waits ${n} ${unit}${n === 1 ? '' : 's'}`
}

const conditionSummary = (step: WorkflowStep): string | null => {
  const keys = Object.keys(step.conditions ?? {})
  if (keys.length === 0) return null
  if (keys.length === 1) return `Only if ${humanize(keys[0]).toLowerCase()}`
  return `${keys.length} conditions`
}

export interface WorkflowMobileStructureProps {
  detail: WorkflowDetail | null
  selectedStepId: string | null
  onSelectStep: (id: string) => void
  onOpenCanvas: () => void
  onAddStep: () => void
  loading: boolean
}

export const WorkflowMobileStructure = ({
  detail,
  selectedStepId,
  onSelectStep,
  onOpenCanvas,
  onAddStep,
  loading,
}: WorkflowMobileStructureProps) => {
  const steps = useMemo(() => {
    const rows = detail?.steps ?? []
    return [...rows].sort((left, right) => Number(left.step_order ?? 0) - Number(right.step_order ?? 0))
  }, [detail?.steps])

  /**
   * Outgoing branches per step, keyed by the step's node id. A step with more than
   * one outgoing edge is a fork, and a list has to say so or it silently claims the
   * flow is linear when it is not.
   */
  const branchesByStep = useMemo(() => {
    const edges: WorkflowEdge[] = detail?.edges ?? []
    const map = new Map<string, WorkflowEdge[]>()
    for (const edge of edges) {
      const from = String(edge.source_node_id ?? '')
      if (!from) continue
      const list = map.get(from) ?? []
      list.push(edge)
      map.set(from, list)
    }
    return map
  }, [detail?.edges])

  const labelForTarget = useMemo(() => {
    const byId = new Map(steps.map((step) => [step.id, step.label || humanize(step.node_type)]))
    return (id: string) => byId.get(id) ?? 'End'
  }, [steps])

  if (loading && steps.length === 0) {
    return (
      <div className="wfs2-struct__state" role="status">
        <span className="wfs2-struct__spinner" aria-hidden />
        <span>Reading workflow…</span>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="wfs2-struct__state">
        <strong>No workflow selected</strong>
        <span>Pick a flow to read its structure.</span>
      </div>
    )
  }

  if (steps.length === 0) {
    return (
      <div className="wfs2-struct__state">
        <strong>This workflow has no steps</strong>
        <span>
          {detail.is_legacy
            ? 'It is a legacy definition with no step rows, so there is nothing to sequence.'
            : 'Add a step to begin building the sequence.'}
        </span>
        <button type="button" onClick={onAddStep}>Add step</button>
      </div>
    )
  }

  return (
    <div className="wfs2-struct">
      {/* The workflow's NAME is already the mobile header's title, two rows above.
          Repeating it here cost 48px and said nothing new, so this states only what
          the header does not: how big the flow is, and the way into the canvas. */}
      <header className="wfs2-struct__head">
        <div>
          <strong>
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
            {detail.edges?.length ? ` · ${detail.edges.length} paths` : ''}
          </strong>
          <small>
            {detail.workflow.status ? `${humanize(String(detail.workflow.status))} · ` : ''}
            Tap a step to inspect or edit it
          </small>
        </div>
        <button type="button" className="wfs2-struct__canvas-btn" onClick={onOpenCanvas}>
          <Icon name="grid" size={13} />
          Canvas
        </button>
      </header>

      <ol className="wfs2-struct__list">
        {steps.map((step, index) => {
          const branches = branchesByStep.get(step.id) ?? []
          const delay = describeDelay(step)
          const condition = conditionSummary(step)
          return (
            <li key={step.id}>
              <button
                type="button"
                className={cls(
                  'wfs2-struct__step',
                  selectedStepId === step.id && 'is-selected',
                  !step.is_active && 'is-disabled',
                )}
                onClick={() => onSelectStep(step.id)}
              >
                <span className="wfs2-struct__rail" aria-hidden>
                  <i className="wfs2-struct__dot">
                    <Icon name={iconForNode(step.node_type)} size={12} strokeWidth={1.8} />
                  </i>
                  {index < steps.length - 1 ? <i className="wfs2-struct__line" /> : null}
                </span>
                <span className="wfs2-struct__copy">
                  <span className="wfs2-struct__title">
                    <strong>{step.label || humanize(step.node_type)}</strong>
                    {!step.is_active ? <em className="wfs2-struct__off">Disabled</em> : null}
                  </span>
                  <small>{humanize(step.node_type)}</small>
                  {delay || condition ? (
                    <span className="wfs2-struct__meta">
                      {delay ? <span>{delay}</span> : null}
                      {condition ? <span>{condition}</span> : null}
                    </span>
                  ) : null}
                  {/* A fork is stated in words. A list that renders a branching
                      workflow as a straight column is lying about the runtime. */}
                  {branches.length > 1 ? (
                    <span className="wfs2-struct__branches">
                      {branches.map((edge) => (
                        <em key={edge.id}>
                          {edge.label || humanize(edge.condition_key || edge.edge_type || 'path')}
                          {' → '}
                          {labelForTarget(String(edge.target_node_id))}
                        </em>
                      ))}
                    </span>
                  ) : null}
                </span>
                <Icon name="chevron-right" size={13} />
              </button>
            </li>
          )
        })}
      </ol>

      <button type="button" className="wfs2-struct__add" onClick={onAddStep}>
        <Icon name="bolt" size={13} />
        Add step
      </button>
    </div>
  )
}
