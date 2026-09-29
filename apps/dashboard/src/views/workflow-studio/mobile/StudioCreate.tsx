import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../../shared/icons'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import { createWorkflow, fetchBlueprints, previewBlueprint, type Blueprint, type Preview } from './studio-api'
import { FlowDiagram } from './StudioRooms'
import { LiquidBackdrop, REACH_LABEL, ReachBadge } from './StudioParts'
import { human } from './workflow-format'

/**
 * CREATE — pick a blueprint, tune it, see exactly what it will do (the
 * server validates and simulates every change with the publish validator),
 * then save it as a draft or arm it. Nothing runs until it is armed.
 */
export function CreateRoom({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const [blueprints, setBlueprints] = useState<Blueprint[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pick, setPick] = useState<Blueprint | null>(null)
  const [params, setParams] = useState<Record<string, number>>({})
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState<null | 'draft' | 'arm'>(null)
  const [confirmArm, setConfirmArm] = useState(false)
  const [result, setResult] = useState<{ key: string; status: string } | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const seq = useRef(0)
  useBackHandler(true, 'studio-create', 'Close create', () => { if (pick && !result) { setPick(null); setPreview(null); return true } onClose(); return true })

  useEffect(() => {
    const ac = new AbortController()
    fetchBlueprints(ac.signal).then((r) => setBlueprints(r.blueprints)).catch((e) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) })
    return () => ac.abort()
  }, [])

  const choose = (b: Blueprint) => {
    setPick(b); setName(b.name); setResult(null); setSaveErr(null); setConfirmArm(false)
    setParams(Object.fromEntries(Object.entries(b.params).map(([k, p]) => [k, p.default])))
  }

  // Live, debounced server preview on every change.
  useEffect(() => {
    if (!pick) return
    const my = ++seq.current
    setPreviewing(true)
    const t = setTimeout(() => {
      previewBlueprint(pick.key, params).then((r) => { if (my === seq.current) { setPreview(r.ok ? r : null); setPreviewing(false) } }).catch(() => { if (my === seq.current) setPreviewing(false) })
    }, 220)
    return () => clearTimeout(t)
  }, [pick, params])

  const save = async (arm: boolean) => {
    if (!pick) return
    setSaving(arm ? 'arm' : 'draft'); setSaveErr(null)
    const r = await createWorkflow({ blueprint: pick.key, params, name: name.trim() || pick.name, arm })
    setSaving(null); setConfirmArm(false)
    if (!r.ok) { setSaveErr(r.errors?.map((e) => e.message).join(' · ') || human(r.code || r.error || 'not accepted')); return }
    setResult({ key: r.workflow_key, status: r.status })
  }

  const graph = useMemo(() => (preview ? { nodes: preview.nodes, edges: preview.edges } : null), [preview])
  const outcomeLine = useMemo(() => {
    if (!preview) return null
    const acts = preview.simulation.actions.map((a) => a.preview).filter(Boolean)
    return acts.length ? acts.join(' · ') : `Ends: ${human(preview.simulation.outcome)}`
  }, [preview])

  return createPortal(
    <div className="wf3-room wfx wfx-room wfx-create" role="dialog" aria-modal="true" aria-label="Create a workflow" data-testid="studio-create">
      <LiquidBackdrop />
      <div className="wf3-room__scroll wfx-room__scroll">
        <header className="wfx-bar">
          <button type="button" className="wfx-iconbtn" aria-label="Back" onClick={() => (pick && !result ? (setPick(null), setPreview(null)) : onClose())}><Icon name="chevron-left" /></button>
          <span className="wfx-eyebrow"><i className="wfx-live" />Create · {pick ? (result ? 'done' : 'step 2 of 2') : 'step 1 of 2'}</span>
        </header>

        {result ? (
          <section className="wfx-done">
            <span className="wfx-done__burst" aria-hidden><i /><i /><i /></span>
            <span className="wfx-done__check"><Icon name="check" /></span>
            <h1>{name.trim() || pick?.name}</h1>
            <p>{result.status === 'armed' ? 'Armed. It starts on the next real event and you will see every run in Leads and Activity.' : 'Saved as a draft (v1). Nothing runs until you arm it.'}</p>
            <button type="button" className="wfx-btn" onClick={() => onCreated(result.key)}>Open workflow<Icon name="chevron-right" /></button>
          </section>
        ) : !pick ? (
          <>
            <section className="wfx-createhead">
              <h1>What should happen?</h1>
              <p>Every blueprint runs on real events through the canonical systems — suppression, contact windows and send brakes always apply.</p>
            </section>
            {err ? <div className="wfx-empty"><Icon name="alert" /><strong>Blueprints could not be loaded</strong></div> : null}
            {!blueprints && !err ? <div className="wfx-skel">{[0, 1, 2].map((i) => <span key={i}><i /><i /><i /></span>)}</div> : null}
            <ul className="wfx-bps">
              {(blueprints || []).map((b, i) => (
                <li key={b.key} style={{ ['--i' as string]: i }}>
                  <button type="button" className={`wfx-bp is-${b.domain}`} onClick={() => choose(b)}>
                    <span className={`wfx-glyph is-${b.domain}`}><Icon name={b.icon as IconName} /></span>
                    <span className="wfx-bp__main"><strong>{b.name}</strong><small>{b.summary}</small><ReachBadge reach={b.reach} /></span>
                    <Icon name="chevron-right" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <section className="wfx-createhead is-config">
              <span className={`wfx-glyph is-${pick.domain} is-lg`}><Icon name={pick.icon as IconName} /></span>
              <input className="wfx-namefield" value={name} onChange={(e) => setName(e.target.value)} aria-label="Workflow name" maxLength={60} />
              <p>{pick.summary}</p>
            </section>

            {Object.keys(pick.params).length ? (
              <section className="wfx-sec" aria-label="Tune it">
                <h2 className="wfx-h2">Tune it</h2>
                <div className="wfx-panel wfx-params">
                  {Object.entries(pick.params).map(([k, p]) => (
                    <label key={k} className="wfx-param">
                      <span><b>{p.label}</b><em>{params[k]} {p.unit}</em></span>
                      <input type="range" min={p.min} max={p.max} step={p.step} value={params[k] ?? p.default} onChange={(e) => setParams((cur) => ({ ...cur, [k]: Number(e.target.value) }))} style={{ ['--p' as string]: `${(((params[k] ?? p.default) - p.min) / (p.max - p.min)) * 100}%` }} />
                      <small><span>{p.min}</span><span>{p.max} {p.unit}</span></small>
                    </label>
                  ))}
                </div>
              </section>
            ) : null}

            <section className={`wfx-sec wfx-preview${previewing ? ' is-updating' : ''}`} aria-label="Preview">
              <h2 className="wfx-h2"><i className="wfx-live" />Live preview{preview ? <span className={preview.validation.ok ? 'is-ok' : 'is-bad'}>{preview.validation.ok ? 'Ready' : 'Needs fixing'}</span> : null}</h2>
              {preview ? (
                <>
                  <p className="wfx-sentence">{preview.description}</p>
                  <FlowDiagram key={JSON.stringify(params)} trigger={preview.graph?.trigger?.type || null} graph={graph} />
                  <div className="wfx-panel wfx-sim">
                    <span className="wfx-sim__label">Simulated on a sample event</span>
                    <b>{outcomeLine}</b>
                    <small>{preview.simulation.path.length} steps · {preview.simulation.duration_hours ? `${preview.simulation.duration_hours}h end to end` : 'instant'} · {preview.simulation.writes} writes (simulation never writes)</small>
                  </div>
                  {preview.validation.errors.length ? <ul className="wfx-errors">{preview.validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul> : null}
                </>
              ) : <div className="wfx-skel"><span><i /><i /><i /></span></div>}
            </section>

            {saveErr ? <p className="wfx-note is-bad" role="alert">{saveErr}</p> : null}
            {confirmArm ? (
              <div className="wfx-confirm">
                <strong>Create and arm?</strong>
                <p>It starts on the next real event. {pick.reach === 'seller' ? 'It can cause seller-facing messages through the canonical senders, under every brake.' : pick.reach === 'operator' ? 'It can only notify you — it never contacts a seller.' : 'It only updates internal records — it never contacts anyone.'}</p>
                <span><button type="button" className="wfx-btn is-quiet" onClick={() => setConfirmArm(false)}>Back</button><button type="button" className="wfx-btn" disabled={saving !== null} onClick={() => void save(true)}>{saving === 'arm' ? 'Arming…' : 'Create & arm'}</button></span>
              </div>
            ) : null}
            <div className="wfx-createbar">
              <span className="wfx-createbar__reach">{REACH_LABEL[pick.reach]}</span>
              <button type="button" className="wfx-btn is-quiet" disabled={!preview?.validation.ok || saving !== null} onClick={() => void save(false)}>{saving === 'draft' ? 'Saving…' : 'Save draft'}</button>
              <button type="button" className="wfx-btn" disabled={!preview?.validation.ok || saving !== null} onClick={() => setConfirmArm(true)}>Create & arm</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
