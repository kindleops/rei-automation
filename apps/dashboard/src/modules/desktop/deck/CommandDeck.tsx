import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../../../shared/icons'
import { LCPopover, LCTooltip, cx, useLcReducedMotion } from '../../../shared/lc'
import type { CommandResult, GlobalCommandSearchContext } from '../../../domain/command-center/command.types'
import { getApp, type AppId } from '../../../domain/app-registry/app-registry'
import { PROPERTY_LOCATOR_EVENT, readPropertyLocator } from '../../../domain/locator/property-locator'
import { appHue } from '../../mobile/app-hues'
import { sound } from '../../../shared/sound'
import { DesktopCommandBar } from '../DesktopCommandBar'
import { MachineFeed } from '../feed/MachineFeed'
import { openReplay } from '../replay/replay-store'
import { machineState, restingFor } from '../rail/rail-model'
import { useRail } from '../rail/rail-store'
import * as L from '../workspace/layout'
import { closeApp, exitMission, getWorkspace, openApp, resetWorkspace, saveWorkspace, selectionInSession, setLinked, startMission, switchWorkspace, newWorkspaceFrom, toggleMaximize, useWorkspace, WORKSPACE_TEMPLATES } from '../workspace/workspace-store'
import { planMission } from '../workspace/missions'
import { deckLine, machineCommands, missionCommands, missionSubject, placeholderFor, workspaceCommands, type DeckGlyph, type WorkspaceCommand } from './deck-model'
import { useFocusedDeckSubject } from '../workspace/deck-subject'
import { WorkspaceSelector } from './WorkspaceSelector'
import { composerCommands } from '../../../views/campaign-command/composer/composer-commands'
import { homeDeckCommands } from '../../../views/home/desktop/board/home-commands'
import { browserDeckCommands } from '../../browser/deck-commands'
import { getBoard } from '../../../views/home/desktop/board/board-store'
import './command-deck.css'

/**
 * THE COMMAND DECK — the horizontal command surface of the OS.
 *
 *   CONTEXT            GLOBAL COMMAND                 MACHINE · ALERTS · OPERATOR
 *   [workspace] Inbox  [ Search sellers, replies…  ⌘K ]        ● Live   🔔   LC
 *   Wendy B Stuhr · 3831 Sheridan Ave N
 *
 * It speaks for the FOCUSED pane (not every pane), searches that app's world
 * first, and says in words — once — what the machine is doing while the rail
 * shows where. At rest it is calm.
 */

const appMeta = (app: string | null | undefined) => { if (!app) return null; try { return getApp(app as AppId) } catch { return null } }

/** Campaign Command publishes its open campaign (nexus:campaign-subject:v1); read only its id + name. */
function readCampaignSubjectName(): { campaignId: string; name: string | null } | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem('nexus:campaign-subject:v1') || 'null') as { campaignId?: string; name?: string | null } | null
    return v?.campaignId ? { campaignId: v.campaignId, name: v.name ?? null } : null
  } catch { return null }
}

function useLocatorAddress(): string | null {
  return useSyncExternalStore(
    (l) => { window.addEventListener(PROPERTY_LOCATOR_EVENT, l); return () => window.removeEventListener(PROPERTY_LOCATOR_EVENT, l) },
    () => (selectionInSession() ? readPropertyLocator()?.address ?? null : null),
    () => null,
  )
}

function DeckGlyphView({ g }: { g: DeckGlyph }) {
  switch (g) {
    case 'typing': return <span className="cd-g cd-g--typing" aria-hidden="true"><i /><i /><i /></span>
    case 'orbit': return <svg className="cd-g cd-g--orbit" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" /></svg>
    case 'check': return <svg className="cd-g cd-g--check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" /></svg>
    case 'cross': return <svg className="cd-g cd-g--cross" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5" /><path d="M11.5 4.5 4.5 11.5" /></svg>
    case 'retry': return <svg className="cd-g cd-g--retry" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 6.2A5 5 0 1 0 13 9.6" /><path d="M12.9 3.2v3.3H9.6" /></svg>
    case 'attn': return <span className="cd-g cd-g--attn" aria-hidden="true">!</span>
    case 'stage': return <svg className="cd-g cd-g--stage" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9" /><path d="M9 4.5 12.5 8 9 11.5" /></svg>
    default: return <span className="cd-g cd-g--dot" aria-hidden="true" />
  }
}

export interface CommandDeckProps {
  searchOpen: boolean
  searchQuery: string
  commandContext: GlobalCommandSearchContext
  onSearchOpen: () => void
  onSearchClose: () => void
  onExecute: (r: CommandResult) => void
  notificationsOpen: boolean
  onToggleNotifications: () => void
  unreadCount: number
  profileOpen: boolean
  onToggleProfile: () => void
  initials: string
}

export function CommandDeck(p: CommandDeckProps) {
  const ws = useWorkspace()
  const rail = useRail()
  const reduced = useLcReducedMotion()
  const address = useLocatorAddress()
  const [machineOpen, setMachineOpen] = useState(false)

  const focused = L.focusedInstance(ws.layout)
  const app = appMeta(focused?.app)
  const multi = Object.keys(ws.layout.instances).length > 1
  const resting = app ? restingFor(app.route, rail.telemetry?.metrics ?? null) : null
  const consumesSubject = Boolean(app && (app.context.propertyId || app.context.threadKey || app.id === 'deal-intelligence'))
  // the app's own words for its subject win; then a pinned label; then the linked selection
  const described = useFocusedDeckSubject(focused?.id ?? null)
  const subject = focused?.pinned && focused.pinLabel ? focused.pinLabel : consumesSubject ? address : null
  const second = described ? [described.title, described.subtitle].filter(Boolean).join(' · ') : subject ?? resting?.peek[0] ?? app?.description ?? null

  const machine = machineState(rail.telemetry, rail.updatedAt ?? 0)
  const line = deckLine(rail.transients)

  // one localized halo when a durable notification arrives — never a loop
  const [seenUnread, setSeenUnread] = useState(p.unreadCount)
  const [halo, setHalo] = useState(0)
  if (seenUnread !== p.unreadCount) { setSeenUnread(p.unreadCount); if (p.unreadCount > seenUnread) setHalo((h) => h + 1) }

  // the search speaks the focused app's language and ranks its world first
  const hasFocus = Boolean(focused)
  const { commandContext } = p
  const layout = ws.layout
  const context = useMemo<GlobalCommandSearchContext>(() => {
    const f = L.focusedInstance(layout)
    return { ...commandContext, routePath: f ? f.path.split('?')[0] : commandContext.routePath }
  }, [commandContext, layout])
  const saved = ws.saved
  // a mission starts from what the operator is looking at: the linked selection
  // (only one made in this session) and the focused app's own open subject
  const focusedPath = focused?.path ?? null
  const focusedTitle = described?.title ?? null
  const missionTitle = ws.mission?.title ?? null
  const hasSelection = address !== null
  // recomputed per keystroke inside the bar's own memo — cheap, so no manual memo here
  const extra = (q: string) => {
    const subject = missionSubject({ locator: hasSelection ? readPropertyLocator() : null, focusedPath, focusedTitle, campaignSubject: readCampaignSubjectName() })
    const selection = hasSelection ? readPropertyLocator() : null
    const home = homeDeckCommands(q, { layouts: getBoard().layouts.map((l) => ({ id: l.id, name: l.name })), campaign: subject?.campaignId ? { id: subject.campaignId, label: subject.label } : null })
    const browser = browserDeckCommands(q, { selection: selection ? { propertyId: selection.propertyId, address: selection.address } : null, browserOpen: Boolean(L.instanceForApp(getWorkspace().layout, 'browser')) })
    return [...home, ...browser, ...composerCommands(q, { selection: selection ? { propertyId: selection.propertyId, address: selection.address } : null }), ...machineCommands(q, { subject }), ...missionCommands(q, { subject, active: missionTitle ? { title: missionTitle } : null }), ...workspaceCommands(q, { saved, multi, hasFocus })]
  }

  const runWorkspace = (cmd: WorkspaceCommand) => {
    const s = getWorkspace().layout
    switch (cmd.kind) {
      case 'beside': if (openApp(cmd.path, { pane: s.focus, zone: 'right' }) !== 'refused') sound.workspace.drop('split'); break
      case 'stack': if (openApp(cmd.path, { pane: s.focus, zone: 'stack' }) !== 'refused') sound.workspace.drop('stack'); break
      case 'switch': switchWorkspace(cmd.id); break
      case 'template': { const t = WORKSPACE_TEMPLATES.find((x) => x.id === cmd.id); if (t) newWorkspaceFrom(t); break }
      case 'save': saveWorkspace(getWorkspace().name ?? 'Workspace'); sound.outcome.success('subtle'); break
      case 'close': { const pane = L.findPane(s.root, s.focus); if (pane) closeApp(pane.active); break }
      case 'maximize': toggleMaximize(s.focus); break
      case 'reset': resetWorkspace(); break
      case 'link': setLinked(cmd.linked); break
      case 'mission': { const plan = planMission(cmd.mission, cmd.subject); if (plan) startMission(plan); break }
      case 'exit-mission': exitMission(); break
      case 'machine-feed': setMachineOpen(true); sound.panel.open(); break
      case 'replay': openReplay(cmd.subject); break
    }
  }

  useEffect(() => {
    if (p.searchOpen) sound.command.open()
    // the workspace recedes a little while the operator commands
    document.documentElement.classList.toggle('lc-commanding', p.searchOpen)
    return () => document.documentElement.classList.remove('lc-commanding')
  }, [p.searchOpen])

  const loc = machineOpen && hasSelection ? readPropertyLocator() : null
  const linked = loc ? { threadKey: loc.threadKey, propertyId: loc.propertyId, address: loc.address } : null
  const machineLabel = machine.state === 'live' ? 'Live' : machine.state === 'degraded' ? 'Degraded' : machine.state === 'idle' ? 'Idle' : 'Machine'
  const fade = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : { initial: { opacity: 0, y: 5, filter: 'blur(2px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' }, exit: { opacity: 0, y: -5, filter: 'blur(2px)' } }

  return (
    <header className={cx('cd', p.searchOpen && 'is-commanding')} aria-label="Command deck">
      <div className="cd__glass">
        <div className="cd__ctx">
          <WorkspaceSelector />
          {ws.mission ? (
            <LCTooltip content="End mission · restores the workspace you had before" side="bottom">
              <button type="button" className="cd-mission" onClick={() => exitMission()} aria-label={`End ${ws.mission.title} mission and restore the previous workspace`}>
                <span className="cd-mission__k">Mission</span>
                <Icon name="x" size={10} />
              </button>
            </LCTooltip>
          ) : null}
          {app ? (
            <div className="cd-app" style={{ ['--app' as string]: appHue(app.id) }}>
              <span className="cd-app__glyph" aria-hidden="true"><Icon name={app.icon} size={14} strokeWidth={1.7} /></span>
              <span className="cd-app__text">
                <b>{app.label}</b>
                {second ? <small title={second}>{focused?.pinned ? <Icon name="pin" size={9} /> : null}{second}</small> : null}
              </span>
            </div>
          ) : null}
        </div>

        <div className="cd__cmd">
          <DesktopCommandBar
            open={p.searchOpen}
            initialQuery={p.searchQuery}
            context={context}
            onOpen={p.onSearchOpen}
            onClose={p.onSearchClose}
            onExecute={p.onExecute}
            placeholder={placeholderFor(focused?.app)}
            scope={app ? app.shortLabel : null}
            extraResults={extra}
            onWorkspaceCommand={runWorkspace}
          />
        </div>

        <div className="cd__right">
          <LCPopover
            open={machineOpen}
            onOpenChange={(o) => { setMachineOpen(o); if (o) sound.panel.open() }}
            side="bottom"
            align="end"
            width={640}
            label="Machine activity"
            trigger={
              <button type="button" className={cx('cd-machine', `is-${machine.state}`, line && `has-line tone-${line.tone}`)} aria-label={line ? `${line.text}` : `Machine ${machineLabel}${machine.reason ? ` — ${machine.reason}` : ''}`}>
                <AnimatePresence mode="wait" initial={false}>
                  {line ? (
                    <motion.span key={line.key} className="cd-machine__face" {...fade} transition={{ duration: 0.2 }}>
                      <DeckGlyphView g={line.glyph} />
                      <span className="cd-machine__text">{line.text}</span>
                    </motion.span>
                  ) : (
                    <motion.span key={`rest-${machine.state}`} className="cd-machine__face" {...fade} transition={{ duration: 0.2 }}>
                      <i className="cd-machine__dot" aria-hidden="true" />
                      <span className="cd-machine__text">{machineLabel}</span>
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
            }
          >
            <MachineFeed rail={rail} linked={linked} onLeave={() => setMachineOpen(false)} />
          </LCPopover>

          <LCTooltip content="Notifications" side="bottom">
            <button type="button" className={cx('cd-btn', p.notificationsOpen && 'is-active')} onClick={p.onToggleNotifications} aria-label={p.unreadCount ? `Notifications — ${p.unreadCount} unread` : 'Notifications'} aria-expanded={p.notificationsOpen}>
              <Icon name="bell" size={16} strokeWidth={1.7} />
              {p.unreadCount > 0 ? <span className="cd-btn__count">{p.unreadCount > 99 ? '99+' : p.unreadCount}</span> : null}
              {halo ? <span key={halo} className="cd-btn__halo" aria-hidden="true" /> : null}
            </button>
          </LCTooltip>

          <button type="button" className={cx('cd-op', p.profileOpen && 'is-active')} onClick={p.onToggleProfile} aria-label="Operator, appearance and system" aria-expanded={p.profileOpen}>
            <span className="cd-op__avatar">{p.initials}</span>
          </button>
        </div>
      </div>
    </header>
  )
}
