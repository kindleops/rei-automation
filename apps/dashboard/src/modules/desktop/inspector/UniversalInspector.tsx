import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCEmpty, LCError, LCFacts, LCIconButton, LCInspector, LCInspectorSection, LCSkeleton, LCStatus } from '../../../shared/lc'
import type { LCTone } from '../../../shared/lc/states-model'
import { pushRoutePath } from '../../../app/router'
import { sound } from '../../../shared/sound'
import { openApp, startMission } from '../workspace/workspace-store'
import { missionsFor, planMission } from '../workspace/missions'
import { propertyObject } from '../objects/object-registry'
import { showOnMap } from '../objects/object-actions'
import { replaySubjectOf } from '../feed/feed-model'
import { openReplay } from '../replay/replay-store'
import { InspectorWatch } from '../../notifications/signals/InspectorWatch'
import { inspectorFor, type InspectorModel, type InspectorTone } from './inspector-registry'
import { failureOfError, type InspectorFailure } from './inspector-read'
import { closeInspector, inspectorBack, openInspector, refKey, setInspectorPinned, useInspector, type EntityRef } from './inspector-store'
import './register-inspectors'
import './universal-inspector.css'

/**
 * THE UNIVERSAL OBJECT INSPECTOR plane — one consistent explanation of any
 * supported object, floating over the workspace without disturbing it.
 *
 *   Open          the owning app takes the focused pane (normal navigation)
 *   Open beside   the owning app opens in a new pane, aimed at this object
 *   Start mission compose the workspace this object's job needs
 *   Pin           keep the inspector while you keep working
 *
 *   Watch         Signal Center watchlist (sellers, properties; campaigns once
 *                 the Signal Center migration is applied — the server says which)
 *   Replay        Time Machine, when the event envelope can resolve the subject
 * A control appears only when the action exists.
 */

const TONE: Record<InspectorTone, LCTone> = { neutral: 'neutral', live: 'exec', attention: 'attn', ok: 'ok', crit: 'crit' }

type Load = { key: string; model: InspectorModel | null; error: InspectorFailure | null }

/** How each failed read reads to an operator (never a status code). */
const FAILURE: Record<Exclude<InspectorFailure, 'unavailable'>, { title: string; body: string; icon: 'search' | 'shield' | 'database' }> = {
  not_found: { title: 'Not on record', body: 'This object could not be found. It may have been merged or removed.', icon: 'search' },
  denied: { title: 'Not available to this session', body: 'Your sign-in does not allow reading this object. Sign in again or ask an admin.', icon: 'shield' },
  not_connected: { title: 'Not connected', body: 'LeadCommand could not reach its data service. Check your connection, then try again.', icon: 'database' },
}

function useModel(ref: EntityRef | null, attempt: number): Load | null {
  const key = ref ? `${refKey(ref)}#${attempt}` : ''
  const [load, setLoad] = useState<Load | null>(null)
  useEffect(() => {
    if (!ref) return
    const renderer = inspectorFor(ref.type)
    if (!renderer) return
    const ctl = new AbortController()
    renderer.load(ref, ctl.signal).then(
      (model) => { if (!ctl.signal.aborted) setLoad({ key, model, error: null }) },
      (e: unknown) => { if (!ctl.signal.aborted) setLoad({ key, model: null, error: failureOfError(e) }) },
    )
    return () => ctl.abort()
  }, [ref, key])
  // a stale answer for another object never paints over this one
  return load && load.key === key ? load : null
}

export function UniversalInspector() {
  const { current, previous, pinned } = useInspector()
  const [attempt, setAttempt] = useState(0)
  const renderer = current ? inspectorFor(current.type) : null
  const load = useModel(renderer ? current : null, attempt)
  const model = load?.model ?? null

  // outside the plane closes an unpinned inspector (pointer, not focus — keyboard users close with Esc)
  useEffect(() => {
    if (!current || pinned) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || t.closest('.lc-insp, [data-radix-popper-content-wrapper], .lc-dialog, [data-inspect]')) return
      closeInspector()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [current, pinned])

  if (!current) return null
  if (!renderer) {
    return (
      <LCInspector open onClose={closeInspector} id="universal" title={current.label ?? current.id} className="uinsp" label="Inspector">
        <LCEmpty compact icon="eye" title="No quick view for this yet" body="Open it in its app to see the full picture." />
      </LCInspector>
    )
  }

  const primary = model?.open?.[0] ?? null
  const mission = model?.mission ?? null
  const missions = mission ? missionsFor(mission) : []
  // Replay appears only when the event envelope can resolve this subject
  const replay = model?.replay !== undefined ? model.replay : replaySubjectOf(current)

  // [8.2] Show on Map — the property this object stands on (itself, or its property)
  const mapPid = mission?.propertyId ?? (current.type === 'property' ? current.id : null)
  const mapTarget = mapPid ? propertyObject({ propertyId: mapPid, threadKey: mission?.threadKey ?? null, label: mission?.address ?? (current.type === 'property' ? current.label ?? null : null), source: 'inspector' }) : null
  const open = () => { if (!primary) return; pushRoutePath(primary.path); if (!pinned) closeInspector() }
  const beside = () => {
    if (!primary) return
    if (openApp(primary.path, 'beside') !== 'refused') sound.workspace.drop('split')
    if (!pinned) closeInspector()
  }
  const start = (kind: (typeof missions)[number]['kind']) => {
    if (!mission) return
    const plan = planMission(kind, mission)
    if (plan && startMission(plan)) closeInspector()
  }

  const actions = (
    <LCIconButton
      icon="pin"
      size="sm"
      selected={pinned}
      label={pinned ? 'Unpin — closes when you click away' : 'Pin — stays while you work'}
      onClick={() => { setInspectorPinned(!pinned); sound.ui.toggle(!pinned) }}
    />
  )

  const footer = model ? (
    <div className="uinsp__foot">
      {primary ? <LCButton variant="primary" size="sm" onClick={open}>Open</LCButton> : null}
      {primary ? <LCButton variant="secondary" size="sm" icon="layout-split" onClick={beside}>Open beside</LCButton> : null}
      {mapTarget ? <LCButton variant="ghost" size="sm" icon="map" onClick={() => { showOnMap(mapTarget, { source: 'inspector', keepInspector: true }) }}>Show on Map</LCButton> : null}
      {missions.map((m) => (
        <LCButton key={m.kind} variant="ghost" size="sm" icon="target" onClick={() => start(m.kind)}>{m.verb}</LCButton>
      ))}
      {replay ? <LCButton variant="ghost" size="sm" icon="clock" onClick={() => openReplay(replay)}>Replay</LCButton> : null}
      <InspectorWatch subject={current} replayId={replay && replay.type === current.type ? replay.id : null} label={model.title ?? current.label ?? null} />
    </div>
  ) : null

  return (
    <LCInspector
      open
      onClose={closeInspector}
      id="universal"
      className="uinsp"
      title={model?.title ?? current.label ?? renderer.noun}
      eyebrow={<span className="uinsp__eyebrow"><Icon name={renderer.glyph} size={11} />{[renderer.noun, model?.eyebrow].filter(Boolean).join(' · ')}</span>}
      subtitle={model?.subtitle ?? null}
      status={model?.status ? <LCStatus label={model.status.label} tone={TONE[model.status.tone]} /> : null}
      actions={actions}
      contentKey={refKey(current)}
      back={previous ? { label: previous.label ?? 'Back', onBack: inspectorBack } : undefined}
      footer={footer}
      label={`${renderer.noun} inspector`}
    >
      {!load ? (
        <LCSkeleton shape="lines" count={6} label={`Loading ${renderer.noun.toLowerCase()}`} />
      ) : load.error && load.error !== 'unavailable' ? (
        <LCEmpty
          compact
          icon={FAILURE[load.error].icon}
          title={FAILURE[load.error].title}
          body={FAILURE[load.error].body}
          action={load.error === 'not_connected' ? { label: 'Try again', onClick: () => setAttempt((n) => n + 1) } : undefined}
        />
      ) : load.error || !model ? (
        <LCError what={`Couldn't load this ${renderer.noun.toLowerCase()}`} onRetry={() => setAttempt((n) => n + 1)} compact />
      ) : (
        <>
          <LCInspectorSection>
            <LCFacts rows={model.facts} />
          </LCInspectorSection>
          {model.value?.length ? (
            <LCInspectorSection title="Value">
              <LCFacts rows={model.value} />
            </LCInspectorSection>
          ) : null}
          {model.relations?.length ? (
            <LCInspectorSection title="Related">
              <ul className="uinsp__rel">
                {model.relations.map((r) => {
                  const rr = inspectorFor(r.ref.type)
                  return (
                    <li key={`${r.label}:${refKey(r.ref)}`}>
                      <button type="button" disabled={!rr} onClick={() => { openInspector(r.ref); sound.ui.select() }}>
                        <Icon name={rr?.glyph ?? 'link'} size={12} />
                        <span><small>{r.label}</small><b>{r.ref.label ?? r.ref.id}</b></span>
                        {rr ? <Icon name="chevron-right" size={12} /> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </LCInspectorSection>
          ) : null}
          {model.activity?.length ? (
            <LCInspectorSection title="Latest activity">
              <ol className="uinsp__act">
                {model.activity.slice(0, 6).map((a, i) => (
                  <li key={`${a.at}:${i}`}>
                    <time dateTime={a.at}>{new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                    <span>{a.text}</span>
                  </li>
                ))}
              </ol>
            </LCInspectorSection>
          ) : null}
          {model.open && model.open.length > 1 ? (
            <LCInspectorSection title="Open in">
              <div className="uinsp__links">
                {model.open.slice(1).map((l) => (
                  <button key={l.path} type="button" onClick={() => { if (openApp(l.path, 'beside') !== 'refused') sound.workspace.drop('split') }}>
                    {l.label}<Icon name="arrow-up-right" size={11} />
                  </button>
                ))}
              </div>
            </LCInspectorSection>
          ) : null}
          {model.freshness ? <p className="uinsp__fresh">{model.freshness}</p> : null}
        </>
      )}
    </LCInspector>
  )
}
