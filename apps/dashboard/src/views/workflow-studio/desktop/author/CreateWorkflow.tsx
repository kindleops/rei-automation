import { useEffect, useMemo, useState } from 'react'
import { Icon, type IconName } from '../../../../shared/icons'
import { LCButton, LCConfirm, LCDialog, LCEmpty, LCError, LCSkeleton } from '../../../../shared/lc'
import { sound } from '../../../../shared/sound'
import { fetchCatalog, orchestratorAction, previewBlueprint, type CatalogBlueprint, type SimulationResult, type StudioCatalog } from '../lib/api'
import { useResource } from '../lib/resource'
import { words } from '../lib/format'

const defaultsOf = (b: CatalogBlueprint) => Object.fromEntries(Object.entries(b.params).map(([k, p]) => [k, Number(p.default ?? p.min ?? 0)]))

/**
 * CREATE — a new Studio workflow from a typed blueprint. The graph is built,
 * validated, described and simulated on the server with zero writes while the
 * operator chooses; "Create draft" is the one write, through the orchestrator
 * action API, and it leaves the workflow in DRAFT — nothing runs until armed.
 */
export function CreateWorkflow({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (workflowKey: string) => void }) {
  const cat = useResource<StudioCatalog>(open ? 'catalog' : null, (sig) => fetchCatalog(sig))
  const blueprints = useMemo(() => cat.data?.blueprints ?? [], [cat.data])
  const [pick, setPick] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, number>>({})
  const [name, setName] = useState('')
  const [confirm, setConfirm] = useState(false)
  const bp = blueprints.find((b) => b.key === pick) || null
  const choose = (b: CatalogBlueprint) => { setPick(b.key); setParams(defaultsOf(b)); setName(b.name) }

  // the PURE preview: validate + describe + simulate the graph this blueprint would create
  const previewKey = pick ? JSON.stringify([pick, params]) : null
  const [preview, setPreview] = useState<{ key: string; res: SimulationResult | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!pick || !previewKey) return
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      previewBlueprint(pick, params, ctl.signal)
        .then((res) => setPreview({ key: previewKey, res, error: null }))
        .catch((e: unknown) => { if (!ctl.signal.aborted) setPreview({ key: previewKey, res: null, error: e instanceof Error ? e.message : 'unavailable' }) })
    }, 280)
    return () => { window.clearTimeout(t); ctl.abort() }
  }, [params, pick, previewKey])
  const current = preview && preview.key === previewKey ? preview : null
  const valid = Boolean(current?.res?.validation.ok)
  const canCreate = Boolean(bp && valid && name.trim())

  const create = async () => {
    if (!bp) return
    const r = await orchestratorAction('create', { blueprint: bp.key, params, name: name.trim() })
    if (!r.ok || !r.workflow_key) {
      sound.outcome.error()
      throw new Error(r.error === 'operator_identity_required' ? 'Your operator identity could not be verified — nothing was created.' : `Not created — ${words(r.error || 'the orchestrator refused')}. Nothing was changed.`)
    }
    onOpenChange(false)
    onCreated(r.workflow_key)
  }

  return (
    <>
      <LCDialog
        open={open}
        onOpenChange={onOpenChange}
        sticky
        width={820}
        title="New Studio workflow"
        description="Start from a blueprint. It is created as a draft — nothing runs, sends or alerts until you arm it."
        footer={
          <>
            <span className="ws4-create__foot">{bp ? (current?.res ? (valid ? <><Icon name="check" size={12} />Valid · simulated with 0 writes</> : <><Icon name="alert" size={12} />{current.res.validation.errors.length} problem{current.res.validation.errors.length === 1 ? '' : 's'} to fix</>) : current?.error ? `Preview unavailable — ${current.error}` : 'Validating…') : 'Choose a blueprint'}</span>
            <LCButton variant="quiet" onClick={() => onOpenChange(false)}>Cancel</LCButton>
            <LCButton variant="primary" icon="spark" disabled={!canCreate} onClick={() => setConfirm(true)}>Create draft</LCButton>
          </>
        }
      >
        {cat.error ? <LCError what="The Studio catalog could not be read" detail={cat.error} onRetry={cat.reload} />
          : !cat.data ? <LCSkeleton shape="rows" count={4} label="Reading the blueprints" />
          : !blueprints.length ? <LCEmpty title="No blueprints are published" body="The orchestrator offers no blueprints to start from." />
          : (
            <div className="ws4-create">
              <ul className="ws4-create__list" role="radiogroup" aria-label="Blueprints">
                {blueprints.map((b) => (
                  <li key={b.key}>
                    <button type="button" role="radio" aria-checked={pick === b.key} className={`ws4-create__bp${pick === b.key ? ' is-on' : ''}`} onClick={() => choose(b)}>
                      <span className="ws4-create__icon" aria-hidden><Icon name={(b.icon || 'spark') as IconName} size={14} /></span>
                      <span className="ws4-create__text">
                        <strong>{b.name}</strong>
                        <small>{b.summary}</small>
                        <em>{words(b.domain)} · reaches {words(b.reach)}</em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="ws4-create__detail">
                {bp ? (
                  <>
                    <label className="ws4-field-row"><span>Name</span><input className="ws4-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
                    {Object.entries(bp.params).map(([k, p]) => (
                      <label key={k} className="ws4-field-row">
                        <span>{p.label}{p.unit ? ` (${p.unit})` : ''}</span>
                        <input className="ws4-input" type="number" min={p.min} max={p.max} step={p.step} value={params[k] ?? ''} onChange={(e) => setParams((o) => ({ ...o, [k]: Number(e.target.value) }))} />
                      </label>
                    ))}
                    <div className="ws4-create__preview" aria-live="polite">
                      <h5>What it will do</h5>
                      {current?.res ? (
                        <>
                          <p>{current.res.description}</p>
                          <ol className="ws4-outline">
                            {current.res.outline.map((o) => <li key={o.id}><span className="lc-num">{o.n}</span>{o.text}{o.exits?.length ? <em>{o.exits.map((x) => `${x.exit} → ${x.to}`).join(' · ')}</em> : null}</li>)}
                          </ol>
                          {current.res.validation.errors.map((e, i) => <p key={i} className="ws4-issue is-error"><Icon name="alert" size={11} />{e.message}</p>)}
                          {current.res.validation.warnings.map((e, i) => <p key={i} className="ws4-issue"><Icon name="alert-circle" size={11} />{e.message}</p>)}
                        </>
                      ) : current?.error ? <p className="ws4-quiet is-error">The preview could not be built — {current.error}</p> : <LCSkeleton shape="rows" count={3} label="Validating and simulating" />}
                    </div>
                  </>
                ) : <p className="ws4-quiet">Choose a blueprint to see exactly what it will do — validated and simulated here with zero writes.</p>}
              </div>
            </div>
          )}
      </LCDialog>
      <LCConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={`Create “${name.trim() || bp?.name || 'workflow'}”?`}
        effects={[
          { kind: 'note', text: 'Creates a new Studio workflow — version 1, in draft.' },
          { kind: 'keeps', text: 'Nothing runs until you arm it: no runs, no messages, no alerts.' },
          { kind: 'note', text: 'The version is recorded with your name in its history.' },
        ]}
        confirmLabel="Create draft"
        onConfirm={create}
      />
    </>
  )
}
