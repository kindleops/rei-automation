import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { replaceRoutePath } from '../../../app/router'
import { fetchAttention, fetchOverview, type Overview, type RunSummary, type StudioWorkflow, type SystemWorkflow } from './workflow-observatory-api'
import { ago, beatLabel, domainIcon, human } from './workflow-format'
import './workflow-surface.css'

const WorkflowRoom = lazy(() => import('./WorkflowRoom').then((m) => ({ default: m.WorkflowRoom })))
const RunRoom = lazy(() => import('./RunRoom').then((m) => ({ default: m.RunRoom })))

/**
 * WORKFLOW STUDIO — mobile. "I can see the company operating."
 * Needs attention first, then the automations that are running right now
 * (read from their own runtimes), then the studio's defined workflows with an
 * honest runtime status. Nothing here is simulated.
 */

const readParam = (k: string) => { try { return new URLSearchParams(window.location.search).get(k) } catch { return null } }
const setParams = (patch: Record<string, string | null>) => {
  try {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(patch)) { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k) }
    const qs = url.searchParams.toString()
    replaceRoutePath(`${url.pathname}${qs ? `?${qs}` : ''}`)
  } catch { /* best-effort */ }
}

export function WorkflowSurface() {
  const [data, setData] = useState<Overview | null>(null)
  const [attention, setAttention] = useState<RunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openWf, setOpenWf] = useState<string | null>(() => readParam('wf'))
  const [openRun, setOpenRun] = useState<{ wf: string; id: string } | null>(() => (readParam('wf') && readParam('run') ? { wf: readParam('wf')!, id: readParam('run')! } : null))

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [o, a] = await Promise.all([fetchOverview(signal), fetchAttention(signal).catch(() => ({ items: [] as RunSummary[] }))])
      setData(o); setAttention(a.items); setError(null)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setError((err as Error)?.message || 'unavailable')
    }
  }, [])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible' && !openWf) void load() }, 30_000); return () => clearInterval(t) }, [load, openWf])

  const openWorkflow = (key: string) => { setOpenWf(key); setParams({ wf: key, run: null }) }
  const closeWorkflow = () => { setOpenWf(null); setOpenRun(null); setParams({ wf: null, run: null }) }
  const openRunRoom = (wf: string, id: string) => { setOpenRun({ wf, id }); setParams({ wf, run: id }) }
  const closeRun = () => { setOpenRun(null); setParams({ run: null }) }

  const studio = data?.studio ?? []
  const realStudio = useMemo(() => studio.filter((w) => !w.test), [studio])
  const tests = useMemo(() => studio.filter((w) => w.test), [studio])

  return (
    <div className={`wf3${data?.counts.needs_you ? ' is-amb-attention' : ''}`} data-testid="workflow-surface">
      <span className="wf3-field" aria-hidden><i /><i /><i /></span>
      <header className="wf3-head">
        <span className="wf3-eyebrow"><i />Workflow Studio</span>
        {data ? (
          <>
            <h1><b>{data.counts.live}</b> live automations</h1>
            <div className="wf3-strip" role="list">
              <span role="listitem" className={`wf3-strip__i is-active${data.counts.running ? '' : ' is-zero'}`}><b>{data.counts.running}</b>running</span>
              <span role="listitem" className={`wf3-strip__i${data.counts.waiting ? '' : ' is-zero'}`}><b>{data.counts.waiting}</b>waiting</span>
              <span role="listitem" className={`wf3-strip__i is-attention${data.counts.needs_you ? '' : ' is-zero'}`}><b>{data.counts.needs_you}</b>need you</span>
            </div>
          </>
        ) : null}
      </header>

      {error && !data ? (
        <section className="wf3-state" role="alert"><Icon name="alert" /><strong>Workflow Studio is unavailable</strong><p>The runtimes could not be read. Nothing is shown rather than a guess.</p><button type="button" className="wf3-btn" onClick={() => void load()}>Try again</button></section>
      ) : !data ? (
        <div className="wf3-skel" aria-busy="true">{[0, 1, 2].map((i) => <span key={i}><i /><i /></span>)}</div>
      ) : (
        <>
          {attention && attention.length ? (
            <section className="wf3-sec" aria-label="Needs attention">
              <h2 className="wf3-h2 is-attention">Needs attention<span>{attention.length}</span></h2>
              <ul className="wf3-list">
                {attention.slice(0, 6).map((r) => (
                  <li key={`${r.workflow}:${r.id}`}>
                    <button type="button" className="wf3-attn" onClick={() => (r.workflow === 'seller_inbound' ? openRunRoom(r.workflow, r.id) : openWorkflow(r.workflow))}>
                      <span className="wf3-attn__who">{r.subject.name || r.subject.address || 'Run'}</span>
                      <span className="wf3-attn__what">{r.reason || r.label}</span>
                      <span className="wf3-attn__where">{r.subject.address && r.subject.name ? r.subject.address : human(r.workflow)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="wf3-sec" aria-label="Running now">
            <h2 className="wf3-h2 is-active">Running now</h2>
            <ul className="wf3-list">
              {data.system.map((w, i) => <li key={w.key} style={{ ['--i' as string]: i }}><SystemCard w={w} onOpen={() => openWorkflow(w.key)} /></li>)}
            </ul>
          </section>

          <section className="wf3-sec" aria-label="Studio workflows">
            <h2 className="wf3-h2">Studio workflows<span>{realStudio.length}</span></h2>
            <p className="wf3-note">{data.runtime.studio_engine.note}</p>
            <ul className="wf3-rows">
              {realStudio.map((w) => <li key={w.id}><StudioRow w={w} /></li>)}
            </ul>
            {tests.length ? <p className="wf3-note is-small">{tests.length} test fixture{tests.length === 1 ? '' : 's'} hidden ({tests.map((t) => t.name).join(', ')}).</p> : null}
          </section>

          <section className="wf3-sec" aria-label="Runtime health">
            <h2 className="wf3-h2">Runtime</h2>
            <dl className="wf3-health">
              <div><dt>Outbound queue runner</dt><dd className={`is-${data.runtime.queue_runner.state}`}>{beatLabel(data.runtime.queue_runner)}</dd></div>
              <div><dt>Seller state reconcile</dt><dd className={`is-${data.runtime.seller_reconcile.state}`}>{beatLabel(data.runtime.seller_reconcile)}</dd></div>
              {data.system.filter((w) => w.health.state !== 'event_driven').map((w) => <div key={w.key}><dt>{w.name.split(' · ')[0]}</dt><dd className={`is-${w.health.state}`}>{beatLabel(w.health)}</dd></div>)}
            </dl>
          </section>
          <p className="wf3-prov">Read from each runtime's own records · updated {ago(data.generated_at)}</p>
        </>
      )}

      {openWf ? (
        <Suspense fallback={<div className="wf3-room is-loading" />}>
          <WorkflowRoom wfKey={openWf} summary={data?.system.find((w) => w.key === openWf) ?? null} onClose={closeWorkflow} onOpenRun={(id) => openRunRoom(openWf, id)} />
        </Suspense>
      ) : null}
      {openRun ? (
        <Suspense fallback={<div className="wf3-room is-loading" />}>
          <RunRoom wfKey={openRun.wf} runId={openRun.id} onClose={closeRun} />
        </Suspense>
      ) : null}
    </div>
  )
}

function SystemCard({ w, onOpen }: { w: SystemWorkflow; onOpen: () => void }) {
  const l = w.live || {}
  const lines: Array<[string, number | undefined, string]> = w.key === 'seller_inbound'
    ? [['runs today', l.runs_24h, ''], ['held by policy (7d)', l.held_7d, ''], ['need you', l.needs_you, 'attention']]
    : w.key === 'closing_execution'
      ? [['coordinating', l.running, 'active'], ['waiting on contract', l.waiting, ''], ['need you', l.needs_you, 'attention']]
      : w.key === 'campaign_execution'
        ? [['active', l.running, 'active'], ['scheduled', l.waiting, ''], ['paused', l.paused, '']]
        : [['waiting', l.waiting, ''], ['sent', l.sent, ''], ['need you', l.needs_you, 'attention']]
  const off = w.status !== 'live'
  return (
    <button type="button" className={`wf3-card${off ? ' is-off' : ''}`} onClick={onOpen} data-wf={w.key}>
      <span className="wf3-card__top">
        <span className={`wf3-glyph is-${w.domain}`} aria-hidden><Icon name={domainIcon(w.domain)} /></span>
        <span className="wf3-card__id">
          <strong>{w.name}</strong>
          <small>{w.owner} · {w.version}</small>
        </span>
        <span className={`wf3-status is-${w.status}`}>{w.status === 'live' ? 'Live' : w.status === 'not_deployed' ? 'Not deployed' : human(w.status)}</span>
      </span>
      <span className="wf3-card__trigger"><Icon name="zap" />{w.trigger.label}</span>
      {w.live ? (
        <span className="wf3-card__stats">
          {lines.map(([label, v, tone]) => <span key={label} className={`${tone ? `is-${tone}` : ''}${v ? '' : ' is-zero'}`}><b>{v ?? 0}</b>{label}</span>)}
        </span>
      ) : <span className="wf3-card__off">Built but not deployed — nothing has run.</span>}
      <span className="wf3-card__beat">{beatLabel(w.health)}{w.health.policy?.auto_reply_mode ? ` · auto-reply ${human(w.health.policy.auto_reply_mode)}` : ''}</span>
    </button>
  )
}

function StudioRow({ w }: { w: StudioWorkflow }) {
  return (
    <div className={`wf3-srow is-${w.status}`}>
      <span className="wf3-srow__main"><b>{w.name}</b><small>{w.trigger ? human(w.trigger.replace(/^trigger\./, '')) : 'No trigger'} · v{w.version ?? 1}{w.lock === 'template' ? ' · template' : ''}</small></span>
      <span className="wf3-srow__state">{w.status === 'defined' ? 'Not armed' : human(w.status)}</span>
    </div>
  )
}

