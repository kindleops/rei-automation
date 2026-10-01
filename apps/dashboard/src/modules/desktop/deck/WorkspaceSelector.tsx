import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCPopover, cx } from '../../../shared/lc'
import { sound } from '../../../shared/sound'
import * as L from '../workspace/layout'
import {
  WORKSPACE_TEMPLATES, deleteWorkspace, duplicateWorkspace, newWorkspaceFrom, renameWorkspace, resetWorkspace,
  saveWorkspace, setLinked, switchWorkspace, useWorkspace, type SavedWorkspace,
} from '../workspace/workspace-store'
import { workspaceShape } from './deck-model'

/**
 * The workspace selector: which environment you are in, the ones you saved,
 * and a few considered starting points. Miniatures are abstract geometry
 * drawn from the layout itself — never screenshots.
 */

function Mini({ rects, active }: { rects: L.Rect[]; active?: boolean }) {
  return (
    <svg className={cx('cdw-mini', active && 'is-active')} viewBox="0 0 30 20" aria-hidden="true">
      {rects.map((r, i) => (
        <rect key={i} x={0.8 + r.x * 28.4} y={0.8 + r.y * 18.4} width={Math.max(1.2, r.w * 28.4 - 1.2)} height={Math.max(1.2, r.h * 18.4 - 1.2)} rx="1.4" />
      ))}
    </svg>
  )
}

function SavedRow({ w, current }: { w: SavedWorkspace; current: boolean }) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'confirm'>('idle')
  const [name, setName] = useState(w.name)
  const shape = workspaceShape(w)
  if (mode === 'rename') {
    return (
      <form className="cdw-row is-editing" onSubmit={(e) => { e.preventDefault(); renameWorkspace(w.id, name); setMode('idle') }}>
        <Mini rects={shape.rects} />
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setMode('idle') } }} aria-label="Workspace name" maxLength={40} />
        <button type="submit" className="cdw-act">Rename</button>
      </form>
    )
  }
  if (mode === 'confirm') {
    return (
      <div className="cdw-row is-confirm">
        <span className="cdw-row__name">Delete “{w.name}”?</span>
        <button type="button" className="cdw-act is-danger" onClick={() => { deleteWorkspace(w.id); setMode('idle') }}>Delete</button>
        <button type="button" className="cdw-act" onClick={() => setMode('idle')}>Keep</button>
      </div>
    )
  }
  return (
    <div className={cx('cdw-row', current && 'is-current')}>
      <button type="button" className="cdw-row__main" onClick={() => { if (!current) switchWorkspace(w.id) }} aria-current={current ? 'true' : undefined}>
        <Mini rects={shape.rects} active={current} />
        <span className="cdw-row__name">{w.name}</span>
        <span className="cdw-row__meta">{shape.apps} {shape.apps === 1 ? 'app' : 'apps'}</span>
      </button>
      <span className="cdw-row__tools">
        <button type="button" className="cdw-icon" aria-label={`Rename ${w.name}`} title="Rename" onClick={() => setMode('rename')}><Icon name="file-text" size={12} /></button>
        <button type="button" className="cdw-icon" aria-label={`Duplicate ${w.name}`} title="Duplicate" onClick={() => duplicateWorkspace(w.id)}><Icon name="layers" size={12} /></button>
        <button type="button" className="cdw-icon" aria-label={`Delete ${w.name}`} title="Delete" onClick={() => setMode('confirm')}><Icon name="x" size={12} /></button>
      </span>
    </div>
  )
}

export function WorkspaceSelector() {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const apps = Object.keys(ws.layout.instances).length
  const rects = L.miniature(ws.layout.root)
  const label = ws.name ?? (apps > 1 ? 'Workspace' : null)
  const multi = apps > 1

  const save = () => {
    const name = draft.trim()
    if (!name) return
    saveWorkspace(name)
    sound.outcome.success('subtle')
    setNaming(false)
    setDraft('')
  }

  return (
    <LCPopover
      open={open}
      onOpenChange={(o) => { setOpen(o); if (o) sound.panel.open(); else { setNaming(false); sound.panel.close() } }}
      side="bottom"
      align="start"
      width={340}
      label="Workspaces"
      className="cdw"
      trigger={
        <button type="button" className={cx('cd-ws', label && 'has-name', ws.dirty && 'is-dirty')} aria-label={label ? `Workspace: ${label}` : 'Workspaces'}>
          <Mini rects={rects} active />
          {label ? <b>{label}</b> : null}
          {multi ? <span className="cd-ws__count">{apps}</span> : null}
          <Icon name="chevron-down" size={11} />
        </button>
      }
    >
      <div className="cdw-body">
        <header className="cdw-head">
          <span className="lc-eyebrow">Workspaces</span>
          {ws.dirty ? <span className="cdw-dirty">Unsaved changes</span> : null}
        </header>

        {ws.saved.length ? (
          <div className="cdw-list" role="list">
            {ws.saved.map((w) => <SavedRow key={w.id} w={w} current={w.id === ws.savedId} />)}
          </div>
        ) : (
          <p className="cdw-quiet">Arrange apps side by side, then save the arrangement to come back to it.</p>
        )}

        <div className="cdw-actions">
          {naming ? (
            <form className="cdw-name" onSubmit={(e) => { e.preventDefault(); save() }}>
              <input autoFocus placeholder="Name this workspace" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(false) } }} maxLength={40} aria-label="Workspace name" />
              <button type="submit" className="cdw-act is-primary" disabled={!draft.trim()}>Save</button>
            </form>
          ) : (
            <>
              {ws.savedId && ws.dirty ? <button type="button" className="cdw-act is-primary" onClick={() => { saveWorkspace(); sound.outcome.success('subtle') }}>Save changes to “{ws.name}”</button> : null}
              <button type="button" className="cdw-act" onClick={() => { setDraft(ws.savedId ? `${ws.name} 2` : ''); setNaming(true) }}>{ws.savedId ? 'Save as new…' : 'Save workspace…'}</button>
              {multi ? <button type="button" className="cdw-act" onClick={() => { resetWorkspace(); setOpen(false) }}>Back to one app</button> : null}
            </>
          )}
        </div>

        {multi ? (
          <div className="cdw-link" role="radiogroup" aria-label="Linked context">
            <span className="lc-eyebrow">Selection</span>
            <div className="cdw-seg">
              <button type="button" role="radio" aria-checked={ws.linked} className={cx(ws.linked && 'is-on')} onClick={() => { setLinked(true); sound.ui.select() }}><Icon name="link" size={11} />Panes follow</button>
              <button type="button" role="radio" aria-checked={!ws.linked} className={cx(!ws.linked && 'is-on')} onClick={() => { setLinked(false); sound.ui.select() }}>Independent</button>
            </div>
          </div>
        ) : null}

        <div className="cdw-templates">
          <span className="lc-eyebrow">Start from</span>
          {WORKSPACE_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="cdw-tpl" onClick={() => { newWorkspaceFrom(t); setOpen(false) }}>
              <Mini rects={t.arrangement === 'main-right-stack' ? [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] : [{ x: 0, y: 0, w: 0.33, h: 1 }, { x: 0.33, y: 0, w: 0.34, h: 1 }, { x: 0.67, y: 0, w: 0.33, h: 1 }]} />
              <span className="cdw-row__name">{t.name}</span>
              <span className="cdw-row__meta">{t.paths.map((p) => p.slice(1).replace(/-/g, ' ')).join(' · ')}</span>
            </button>
          ))}
        </div>
      </div>
    </LCPopover>
  )
}
