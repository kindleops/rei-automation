import { useMemo, useState } from 'react'
import { Icon, type IconName } from '../../../../shared/icons'
import { LCButton, LCConfirm, LCEmpty, LCError, LCSegmented, LCSkeleton } from '../../../../shared/lc'
import { pushRoutePath } from '../../../../app/router'
import { orchestratorAction } from '../lib/api'
import { age, count, words } from '../lib/format'
import type { ExceptionCategory, ExceptionItem, ExceptionsResponse } from '../lib/types'
import type { ReadState } from '../studio-context'
import { sound } from '../../../../shared/sound'

const CATEGORY: Record<ExceptionCategory, { label: string; icon: IconName; tone: string; hint: string }> = {
  human_review: { label: 'Human review', icon: 'user', tone: 'gold', hint: 'the runtime stopped and asked for a human read' },
  approval: { label: 'Approval', icon: 'check', tone: 'gold', hint: 'a drafted action waits for your release' },
  failed: { label: 'Failed', icon: 'alert', tone: 'crit', hint: 'a run failed' },
  stalled: { label: 'Stalled', icon: 'pause', tone: 'attn', hint: 'a runtime keeps trying and placing nothing' },
  stale_wait: { label: 'Stale wait', icon: 'clock', tone: 'attn', hint: 'past due and not picked up' },
  missing_data: { label: 'Missing data', icon: 'file-text', tone: 'attn', hint: 'held because the data it needs is not there' },
  degraded: { label: 'System degraded', icon: 'cpu', tone: 'crit', hint: 'a runtime’s own heartbeat went stale' },
}

type Grouping = 'why' | 'workflow'

/**
 * EXCEPTION QUEUE — not an alert list. Every item names the workflow, the run,
 * the node and the subject it is about, why it needs a person, how long it
 * has waited and which app owns the decision. Selecting it opens the exact
 * run on its workflow's canvas, centred on the node that holds it.
 */
export function ExceptionQueue({ read, selectedId, onOpen, onOpenRuns, compact = false }: {
  read: ReadState<ExceptionsResponse>
  selectedId?: string | null
  onOpen: (it: ExceptionItem) => void
  onOpenRuns: (workflowKey: string, drill: ExceptionItem['drill']) => void
  compact?: boolean
}) {
  const [grouping, setGrouping] = useState<Grouping>('why')
  const [confirm, setConfirm] = useState<{ it: ExceptionItem; kind: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const items = useMemo(() => read.data?.items ?? [], [read.data])
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; tone: string; icon: IconName; items: ExceptionItem[] }>()
    for (const it of items) {
      const k = grouping === 'why' ? (it.finding ? 'finding' : it.category) : it.workflow_key
      const g = m.get(k) || (grouping === 'why'
        ? (k === 'finding' ? { key: k, label: 'System findings', tone: 'neutral', icon: 'spark' as IconName, items: [] } : { key: k, label: CATEGORY[it.category].label, tone: CATEGORY[it.category].tone, icon: CATEGORY[it.category].icon, items: [] })
        : { key: k, label: it.workflow_name, tone: 'neutral', icon: 'layers' as IconName, items: [] })
      g.items.push(it)
      m.set(k, g)
    }
    return [...m.values()]
  }, [items, grouping])

  const act = async (it: ExceptionItem, kind: string) => {
    const a = it.actions.find((x) => x.kind === kind)
    if (!a) return
    if (a.href) { pushRoutePath(a.href); return }
    if (a.kind === 'show_runs') { onOpenRuns(it.workflow_key, a.drill || it.drill); return }
    setConfirm({ it, kind })
  }
  const run = async () => {
    if (!confirm) return
    const a = confirm.it.actions.find((x) => x.kind === confirm.kind)!
    const r = await orchestratorAction(confirm.kind as 'approve' | 'reject' | 'resume' | 'cancel', { run_id: a.run_id, node_id: a.node_id })
    if (!r.ok) sound.outcome.error()
    setNote(r.ok ? `${a.label} — done. The orchestrator picks it up on its next tick.` : `${a.label} refused — ${r.error || r.code || 'unavailable'}`)
    setConfirm(null)
    read.reload()
  }

  return (
    <section className={`ws4-exq${compact ? ' is-compact' : ''}`} aria-label="Exception queue">
      <header className="ws4-panelhead">
        <span className="ws4-panelhead__title">Exceptions<b className={`lc-num${read.data?.total ? ' is-on' : ''}`}>{read.data ? read.data.total : '—'}</b></span>
        <LCSegmented size="sm" label="Group exceptions" value={grouping} onChange={setGrouping} options={[{ value: 'why', label: 'Why' }, { value: 'workflow', label: 'Workflow' }]} />
      </header>
      {read.loading ? <LCSkeleton shape="rows" count={5} label="Reading what needs a person" /> : null}
      {read.error && !read.data ? <LCError what="The exception queue could not be read" detail={read.error} onRetry={read.reload} compact /> : null}
      {read.stale ? <p className="ws4-stale"><Icon name="clock" size={12} />Last read {age(read.at)} ago — the latest read failed</p> : null}
      {read.data && !items.length ? <LCEmpty title="No exceptions" body="Automation is handling everything — nothing is waiting on a person." icon="check" tone="calm" compact /> : null}
      <div className="ws4-exq__scroll lc-scroll">
        {groups.map((g) => (
          <section key={g.key} className="ws4-exq__group" data-tone={g.tone}>
            <h4><Icon name={g.icon} size={12} />{g.label}<em className="lc-num">{g.items.length}</em></h4>
            <ol>
              {g.items.map((it) => (
                <li key={it.id}>
                  <div className={`ws4-exc${selectedId === it.id ? ' is-on' : ''}${it.finding ? ' is-finding' : ''}`} data-tone={CATEGORY[it.category].tone}>
                    <button type="button" className="ws4-exc__main" onClick={() => onOpen(it)} data-exception={it.id}>
                      <span className="ws4-exc__top">
                        <strong>{it.count && !it.subject ? `${count(it.count)} · ${it.workflow_name}` : it.subject?.name || it.subject?.address || it.subject?.id || it.workflow_name}</strong>
                        <time className="lc-t-stamp" title={it.since || ''}>{age(it.since)}</time>
                      </span>
                      <span className="ws4-exc__why">{it.reason}</span>
                      <span className="ws4-exc__spec">
                        {grouping === 'why' ? <span>{it.workflow_name}</span> : <span>{CATEGORY[it.category].label}</span>}
                        {it.node_key ? <span>{words(it.node_key)}</span> : null}
                        {it.subject?.name && it.subject?.address ? <span>{it.subject.address}</span> : null}
                        <span className="is-owner">{it.owner_app}</span>
                      </span>
                      {it.detail ? <span className="ws4-exc__detail">{it.detail}</span> : null}
                    </button>
                    {selectedId === it.id && it.actions.length ? (
                      <div className="ws4-exc__acts">
                        {it.actions.map((a) => <LCButton key={a.kind} size="sm" variant={['approve'].includes(a.kind) ? 'primary' : ['cancel', 'reject'].includes(a.kind) ? 'quiet' : 'secondary'} icon={a.href ? 'arrow-up-right' : a.kind === 'show_runs' ? 'list' : undefined} onClick={() => void act(it, a.kind)}>{a.label}</LCButton>)}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      {note ? <p className="ws4-note" role="status">{note}</p> : null}
      <LCConfirm
        open={Boolean(confirm)}
        onOpenChange={(o) => { if (!o) setConfirm(null) }}
        title={confirm ? `${confirm.it.actions.find((a) => a.kind === confirm.kind)?.label} — ${confirm.it.workflow_name}` : ''}
        tone={confirm?.kind === 'cancel' || confirm?.kind === 'reject' ? 'danger' : 'primary'}
        confirmLabel={confirm ? confirm.it.actions.find((a) => a.kind === confirm.kind)?.label || 'Confirm' : 'Confirm'}
        effects={confirm ? effectsOf(confirm.kind) : []}
        onConfirm={run}
      />
    </section>
  )
}

function effectsOf(kind: string) {
  switch (kind) {
    case 'approve': return [{ text: 'The run continues on its Approved path at the orchestrator’s next tick (every 5 minutes).', kind: 'stops' as const }, { text: 'The action runs through its canonical capability — every domain guard still applies.', kind: 'keeps' as const }]
    case 'reject': return [{ text: 'The run takes its Rejected path; the gated action never runs.', kind: 'stops' as const }]
    case 'resume': return [{ text: 'The held run continues from the node it stopped at, on its pinned version.', kind: 'stops' as const }]
    case 'cancel': return [{ text: 'The run ends now (cancelled). Nothing it already did is undone.', kind: 'danger' as const }]
    default: return []
  }
}
