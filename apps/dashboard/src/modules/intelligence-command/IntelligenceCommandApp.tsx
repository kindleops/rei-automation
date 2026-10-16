import { useEffect, useState } from 'react'
import { cx } from '../../shared/lc'
import { budgetMeter, modelIndicator } from '../agent/ask/ask-model'
import { deleteThread, refreshStatus, useAsk } from '../agent/ask/ask-store'
import { useAppInstance } from '../desktop/workspace/instance-context'
import * as L from '../desktop/workspace/layout'
import { toggleMaximize, useWorkspace } from '../desktop/workspace/workspace-store'
import { openConversation, SECTIONS, setSection, startNewConversation, useIc, type Section } from './store/ic-store'
import { IcInspector } from './ui/IcInspector'
import { IcGlyph, Kbd, Spec, ago, usd, type IcGlyphName } from './ui/primitives'
import { ConversationCanvas } from './ui/sections/Conversations'
import { ActivitySection, ApprovalsSection, FindingsSection, HealthSection, MissionsSection, ResearchSection, ShadowSection, WorkforceSection } from './ui/sections/Planes'
import { usePageContext } from './ui/use-page-context'
import { usePresence } from './ui/use-presence'
import { useIcDevFixtures } from './ui/use-dev-fixtures'
import './ui/ic.css'
import '../agent/ask/ui/ask.css'

const NAV_GLYPH: Record<Section, IcGlyphName> = { conversations: 'chat', shadow: 'chat', missions: 'mission', research: 'research', findings: 'finding', approvals: 'approval', activity: 'activity', workforce: 'workforce', health: 'health' }

/**
 * INTELLIGENCE COMMAND — the full-screen intelligence workspace.
 *
 *   navigation            execution canvas                     inspector
 *   Conversations ▸       chat · plan · tool steps · results   run · sources · trace
 *   Missions …            approvals as diffs · composer        cost · model · permissions
 *
 * Every state is a read of a real API (ic-client.ts); a plane that is off
 * shows its true state and what switches it on. Nothing here is simulated —
 * dev fixtures exist only in a dev server started with VITE_LC_IC_FIXTURES=1.
 */
export default function IntelligenceCommandApp() {
  const fixtures = useIcDevFixtures()
  if (!fixtures.ready) return <div className="ic ic--boot" aria-busy="true" />
  return <IntelligenceCommand devFixtures={fixtures.on} />
}

function IntelligenceCommand({ devFixtures }: { devFixtures: boolean }) {
  const ic = useIc()
  const a = useAsk()
  const page = usePageContext()
  const presence = usePresence()
  const inst = useAppInstance()
  const ws = useWorkspace()
  const [insp, setInsp] = useState(true)
  useEffect(() => { if (a.status.phase === 'idle') void refreshStatus() }, [a.status.phase])
  const model = modelIndicator(a.status.data)
  const budget = budgetMeter(a.status.data)
  const pane = inst.instanceId ? L.paneOf(ws.layout, inst.instanceId) : null
  const maximized = Boolean(pane && ws.layout.maximized === pane.id)
  const pending = ic.approvals.phase === 'ready' ? ic.approvals.data?.length ?? 0 : null
  const running = a.threads.reduce((n, t) => n + t.turns.filter((u) => u.phase === 'running' || u.phase === 'sending').length, 0)
  const badge: Partial<Record<Section, string>> = { approvals: pending ? String(pending) : '', conversations: running ? String(running) : '' }

  return (
    <div className={cx('ic', !insp && 'is-no-insp')} data-presence={presence.state}>
      <header className="ic-head">
        <div className="ic-head__t">
          <h1>Intelligence Command</h1>
          <span className={cx('ic-presence', `is-${presence.state}`)} title={presence.detail}><i aria-hidden="true" />{presence.label}</span>
          {devFixtures ? <span className="ic-devflag" title="VITE_LC_IC_FIXTURES=1 · synthetic data from the dev fetch double">DEV FIXTURES · synthetic</span> : null}
        </div>
        <Spec className="ic-head__spec" items={[
          a.status.phase === 'failed' && !a.status.data ? `Research agent · ${a.status.failure?.kind === 'disabled' ? 'not enabled' : a.status.failure?.code ?? 'unavailable'}` : model.primary ? <span key="m">{model.primary}{model.escalation ? ` → ${model.escalation}` : ''}</span> : 'Resolving models',
          budget ? `${budget.label} today` : null,
          a.status.data?.daily_run_cap ? `${a.status.data.runs_today}/${a.status.data.daily_run_cap} runs` : null,
        ]} />
        <div className="ic-head__acts">
          <button type="button" className="ic-btn is-quiet" onClick={() => setInsp((v) => !v)} aria-pressed={insp}>Inspector</button>
          {pane ? <button type="button" className="ic-btn is-quiet" onClick={() => toggleMaximize(pane.id)} aria-pressed={maximized} title="Full screen (⌘⇧E)"><IcGlyph name="full" size={12} />{maximized ? 'Restore' : 'Full screen'}</button> : null}
        </div>
      </header>

      <div className="ic-body">
        <nav className="ic-nav" aria-label="Intelligence Command">
          <button type="button" className="ic-nav__new" onClick={startNewConversation}><IcGlyph name="plus" size={12} />New conversation</button>
          <ul className="ic-nav__list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button type="button" className={cx('ic-nav__i', ic.section === s.id && 'is-on')} onClick={() => setSection(s.id)} aria-current={ic.section === s.id ? 'page' : undefined}>
                  <IcGlyph name={NAV_GLYPH[s.id]} size={13} /><span>{s.label}</span>{badge[s.id] ? <em>{badge[s.id]}</em> : null}
                </button>
                {s.id === 'conversations' ? (
                  <ul className="ic-nav__sub">
                    {a.threads.slice(0, 12).map((t) => (
                      <li key={t.id} className="ic-nav__thread">
                        <button type="button" className={cx('ic-nav__t', ic.section === 'conversations' && a.activeThreadId === t.id && 'is-on')} onClick={() => openConversation(t.id)} title={t.title}>
                          {t.turns.some((u) => u.phase === 'running' || u.phase === 'sending') ? <i className="ic-nav__run" aria-label="running" /> : null}
                          <span>{t.title}</span><small>{ago(t.updatedAt)}</small>
                        </button>
                        <button type="button" className="ic-nav__del" aria-label={`Remove ${t.title} from this tab`} onClick={() => deleteThread(t.id)}><IcGlyph name="close" size={9} /></button>
                      </li>
                    ))}
                    <li><button type="button" className={cx('ic-nav__t', ic.section === 'shadow' && 'is-on')} onClick={() => setSection('shadow')}><span>Seller AI · shadow</span></button></li>
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          <footer className="ic-nav__f">
            <Spec items={[a.status.data ? `Cycle ${usd(a.status.data.spend.cycle_usd)} / ${usd(a.status.data.caps.cycle_usd, 0)}` : null]} />
            <span className="ic-nav__keys"><Kbd>⌘⇧E</Kbd> here <Kbd>⌘'</Kbd> composer</span>
          </footer>
        </nav>

        <main className="ic-canvas">
          {ic.section === 'conversations' ? <ConversationCanvas page={page} />
            : <div className="ic-canvas__scroll"><div className="ic-canvas__col">
                {ic.section === 'shadow' ? <ShadowSection /> : null}
                {ic.section === 'missions' ? <MissionsSection /> : null}
                {ic.section === 'research' ? <ResearchSection /> : null}
                {ic.section === 'findings' ? <FindingsSection /> : null}
                {ic.section === 'approvals' ? <ApprovalsSection /> : null}
                {ic.section === 'activity' ? <ActivitySection /> : null}
                {ic.section === 'workforce' ? <WorkforceSection /> : null}
                {ic.section === 'health' ? <HealthSection /> : null}
              </div></div>}
        </main>

        {insp ? <IcInspector page={page} /> : null}
      </div>
    </div>
  )
}
