import { useEffect } from 'react'
import { AGENT_COMMAND_EVENT, AGENT_FIXTURES_ENABLED, clearPendingAgentCommand, takePendingAgentCommand, type AgentCommand } from './agent-bridge'
import { getCapability, getUi, refreshLiveCapability, setUi, startRun, useAgentUi } from './runtime/agent-store'
import { AgentDock } from './ui/dock/AgentDock'
import { AgentWorkspace } from './ui/workspace/AgentWorkspace'
import { globalKeyAction } from './ask/ask-model'
import { getAsk, requestFocus, setPalette } from './ask/ask-store'
import { AskPalette } from './ask/ui/AskPalette'
import './ui/agent.css'
import './ui/agent-s3.css'
import './ask/ui/ask.css'

/**
 * THE AGENT HOST — lazily loaded by the desktop shell when the prototype
 * flag is on (never on a phone: the desktop shell itself never mounts
 * there). It owns the dock + workspace planes, the floating ask palette, the
 * ⌘J / ⌘⇧J / ⌘L / ⌘⇧L chords, and the html classes that let the stage reflow
 * beside a docked agent.
 */
export default function AgentHost() {
  const ui = useAgentUi()

  // S3: learn once whether the live Quick Scan route is mounted on this API
  useEffect(() => { if (getCapability().status === 'unknown') void refreshLiveCapability() }, [])

  useEffect(() => {
    const run = (cmd: AgentCommand) => {
      clearPendingAgentCommand()
      if (cmd.action === 'ask') { setPalette(false); setUi({ dock: 'open', wsOpen: false, composer: cmd.query, dockRunId: null }); requestFocus('dock') }
      else if (cmd.action === 'research') { if (AGENT_FIXTURES_ENABLED) startRun('single-deep', { open: 'workspace' }); else setUi({ wsOpen: true }) }
      else if (cmd.action === 'workspace') setUi({ wsOpen: true })
      else if (cmd.action === 'toggle-dock') setUi((u) => ({ dock: u.dock === 'open' ? 'closed' : 'open', wsOpen: false }))
    }
    const pending = takePendingAgentCommand()
    if (pending) run(pending)
    const on = (e: Event) => run((e as CustomEvent<AgentCommand>).detail)
    window.addEventListener(AGENT_COMMAND_EVENT, on)
    return () => window.removeEventListener(AGENT_COMMAND_EVENT, on)
  }, [])

  // ⌘L opens + focuses the docked composer; ⌘⇧L toggles the floating
  // palette (8.5.10). ⌘K stays the Command Deck outside the agent; inside it
  // the composer claims ⌘K itself (AskComposer / the dock's key handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const insideAgent = Boolean((document.activeElement as HTMLElement | null)?.closest?.('.agx'))
      const action = globalKeyAction(e, { insideAgent })
      if (action === 'focus-dock') {
        e.preventDefault()
        if (getAsk().palette) { requestFocus('palette'); return }
        const u = getUi()
        if (u.dock !== 'open' || u.wsOpen) setUi({ dock: 'open', wsOpen: false })
        requestFocus('dock')
      } else if (action === 'toggle-palette') {
        e.preventDefault()
        const on = !getAsk().palette
        setPalette(on)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘J toggles the dock; ⌘⇧J the workspace (arch §9.3). The legacy copilot's
  // ⌘J is not mounted on the modern desktop, so nothing else claims it here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.key !== 'j' && e.key !== 'J')) return
      e.preventDefault()
      const u = getUi()
      if (e.shiftKey) setUi({ wsOpen: !u.wsOpen })
      else setUi({ dock: u.dock === 'open' && !u.wsOpen ? 'closed' : 'open', wsOpen: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the stage reflows beside a docked agent (≥ 1440) or a Beside workspace
  const docked = ui.dock === 'open' && !ui.wsOpen
  const spine = ui.dock === 'spine' && !ui.wsOpen
  const beside = ui.wsOpen && ui.wsLayout === 'beside'
  useEffect(() => {
    const html = document.documentElement
    html.classList.toggle('lc-agent-docked', docked)
    html.classList.toggle('lc-agent-spine', spine)
    html.classList.toggle('lc-agent-beside', beside)
    html.classList.toggle('lc-agent-fullscreen', ui.wsOpen && ui.wsLayout === 'fullscreen')
    html.style.setProperty('--lc-agent-dock-w', `${ui.dockWidth}px`)
    return () => {
      html.classList.remove('lc-agent-docked', 'lc-agent-spine', 'lc-agent-beside', 'lc-agent-fullscreen')
    }
  }, [docked, spine, beside, ui.wsOpen, ui.wsLayout, ui.dockWidth])

  return (
    <>
      <AgentDock />
      <AgentWorkspace />
      <AskPalette />
    </>
  )
}
