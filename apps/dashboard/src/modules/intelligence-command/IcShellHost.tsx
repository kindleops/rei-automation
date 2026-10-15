import { useEffect } from 'react'
import { activeThread, useAsk } from '../agent/ask/ask-store'
import { isIcFocused, openIntelligenceCommand } from './ic-nav'
import { globalIcKey } from './model/composer-model'
import { focusComposer, getIc, setOverlay, toggleOverlay, useIc } from './store/ic-store'
import { ActEntryView } from './ui/ActCard'
import { Composer } from './ui/Composer'
import { IcGlyph, Kbd } from './ui/primitives'
import { RunTurn } from './ui/RunTurn'
import { ensureIcDevFixtures } from './ui/use-dev-fixtures'
import { usePageContext } from './ui/use-page-context'
import './ui/ic.css'
import '../agent/ask/ui/ask.css'

/**
 * THE SHELL HOST — lazily mounted by the desktop shell beside AgentHost (same
 * flag). Owns the two global chords and the composer overlay:
 *   ⌘⇧E  open Intelligence Command full screen
 *   ⌘'   the composer overlay over the current page (inside Intelligence
 *        Command it focuses the docked composer instead)
 */
export default function IcShellHost() {
  const ic = useIc()
  useEffect(() => { void ensureIcDevFixtures() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = globalIcKey(e)
      if (!k) return
      e.preventDefault()
      if (k === 'open-ic') { setOverlay(false); openIntelligenceCommand(); return }
      if (isIcFocused() && !getIc().overlay) { focusComposer(); return }
      toggleOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return ic.overlay ? <ComposerOverlay /> : null
}

function ComposerOverlay() {
  const page = usePageContext()
  const a = useAsk()
  const ic = useIc()
  const thread = activeThread(a)
  const turn = thread?.turns.at(-1) ?? null
  const act = ic.acts.find((x) => x.threadId === (thread?.id ?? null)) ?? null
  const showAct = act && (!turn || act.createdAt > turn.sentAt)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('.ic-composer')) setOverlay(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="ic-ov" role="dialog" aria-modal="true" aria-label="LeadCommand composer">
      <button type="button" className="ic-ov__scrim" aria-label="Close composer" onClick={() => setOverlay(false)} />
      <div className="ic-ov__panel">
        <header className="ic-ov__h">
          <b>LeadCommand</b>
          <span className="ic-ov__ctx">{page.appLabel ? `on ${page.appLabel}` : 'no page in focus'}</span>
          <button type="button" className="ic-btn is-quiet" onClick={() => { setOverlay(false); openIntelligenceCommand() }}><IcGlyph name="full" size={11} />Open Intelligence Command <Kbd>⌘⇧E</Kbd></button>
          <button type="button" className="ic-icon" aria-label="Close" onClick={() => setOverlay(false)}><IcGlyph name="close" size={11} /></button>
        </header>
        <Composer page={page} surface="overlay" />
        {showAct ? <div className="ic-ov__result"><ActEntryView entry={act!} /></div>
          : turn && thread ? <div className="ic-ov__result"><RunTurn thread={thread} turn={turn} tools={a.status.data?.tools ?? []} mode={ic.turnModes[turn.id] ?? 'ask'} labelOf={(id) => a.labels[id] ?? null} compact /></div> : null}
      </div>
    </div>
  )
}
