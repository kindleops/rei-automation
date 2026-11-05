import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { PaneRouteContext } from '../../../app/router'
import type { LinkedApplyContext } from '../../../domain/locator/linked-property-bus'
import { readPropertyLocator, type PropertyLocator } from '../../../domain/locator/property-locator'
import { Icon, type IconName } from '../../../shared/icons'
import { LCLive, LCTabs, cx } from '../../../shared/lc'
import { useLinkedProperty } from '../../desktop/workspace/linked-property'
import { getKpis, getOverview, getReports, listAssignments, listMissions, wfFixturesOn } from '../api/wf-client'
import type { WfEmployee } from '../api/wf-types'
import { isTerminalMission, relTime, type LinkedSubject } from '../model/wf-model'
import { useWf, useWfLiveTick } from '../store/wf-hooks'
import { WfNavContext, type WfNav, type WfSection } from './wf-context'
import { WfUnknown } from './wf-parts'
import { AuthoritySection, ReportsSection } from './sections/Authority'
import { CommandSection } from './sections/Command'
import { EmployeesSection } from './sections/Employees'
import { FinanceSection, IntelligenceSection } from './sections/Intelligence'
import { MissionsSection } from './sections/Missions'
import { OperationsSection, QueueSection } from './sections/Operations'
import { OrganizationSection } from './sections/Organization'
import '../workforce.css'

const SECTIONS: ReadonlyArray<{ id: WfSection; label: string; short: string; icon: IconName; group: 'lead' | 'org' | 'work' | 'insight' | 'control' }> = [
  { id: 'command', label: 'Executive Command', short: 'Command', icon: 'message', group: 'lead' },
  { id: 'organization', label: 'Organization', short: 'Org', icon: 'users', group: 'org' },
  { id: 'employees', label: 'Employees', short: 'People', icon: 'user', group: 'org' },
  { id: 'missions', label: 'Missions', short: 'Missions', icon: 'target', group: 'work' },
  { id: 'operations', label: 'Operations', short: 'Ops', icon: 'activity', group: 'work' },
  { id: 'queue', label: 'Work Queue', short: 'Queue', icon: 'list', group: 'work' },
  { id: 'intelligence', label: 'Intelligence', short: 'Intel', icon: 'radar', group: 'insight' },
  { id: 'finance', label: 'Financial Performance', short: 'Finance', icon: 'dollar-sign', group: 'insight' },
  { id: 'reports', label: 'Reports', short: 'Reports', icon: 'file-text', group: 'insight' },
  { id: 'authority', label: 'Authority Center', short: 'Authority', icon: 'shield', group: 'control' },
]
const SECTION_KEY = 'lc.wf.section.v1'
const readSection = (): WfSection => {
  try { const v = localStorage.getItem(SECTION_KEY); return SECTIONS.some((s) => s.id === v) ? (v as WfSection) : 'command' } catch { return 'command' }
}

const subjectOf = (loc: Partial<PropertyLocator> | null): LinkedSubject | null =>
  loc && (loc.propertyId || loc.opportunityId || loc.threadKey) ? { propertyId: loc.propertyId ?? null, threadKey: loc.threadKey ?? null, opportunityId: loc.opportunityId ?? null, address: loc.address ?? null } : null

/**
 * WORKFORCE — the company the owner runs: an executive conversation with the
 * COO, the organization, its missions and work, what they found and what it
 * cost, and the authority that bounds it. Every figure is a read of the §7
 * Workforce API (api/wf-client.ts); an unknown is shown as Unknown with its
 * reason. Fixture data exists only in a dev server started with
 * VITE_LC_WF_FIXTURES=1 and is labelled FIXTURE.
 */
export default function WorkforceApp() {
  const pane = useContext(PaneRouteContext)
  const [section, setSection] = useState<WfSection>(readSection)
  const [mission, setMission] = useState<string | null>(null)
  const [employee, setEmployee] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [focusAssignment, setFocusAssignment] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [liveCmd, setLiveCmd] = useState(false)
  const [liveMissions, setLiveMissions] = useState(false)
  const fast = (section === 'command' && liveCmd) || (section === 'missions' && liveMissions)
  const { tick, pollMs, visible } = useWfLiveTick(fast)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(t) }, [])

  // LINKED CONTEXT — the registry declares propertyId/threadKey 'locator' and opportunityId 'query:opp':
  // seed from the locator (and ?opp=) on mount, then follow the workspace selection while this pane follows.
  const [linked, setLinked] = useState<LinkedSubject | null>(() => {
    const loc = subjectOf(readPropertyLocator())
    let opp: string | null = null
    try { opp = new URLSearchParams((pane ? pane.location : window.location.href).split('?')[1] ?? '').get('opp') } catch { /* no query */ }
    if (opp) return { ...(loc ?? { propertyId: null, threadKey: null, address: null }), opportunityId: opp }
    return loc
  })
  const follow = useCallback((loc: PropertyLocator, ctx: LinkedApplyContext) => { ctx.apply(() => setLinked(subjectOf(loc))) }, [])
  useLinkedProperty(follow)

  const overview = useWf('wf:overview', (s) => getOverview(s), tick)
  const needsInsight = section === 'intelligence' || section === 'finance'
  const reports = useWf(needsInsight ? 'wf:reports' : null, (s) => getReports(s), tick)
  const missions = useWf(section === 'intelligence' ? 'wf:missions' : null, (s) => listMissions({ limit: 60 }, s), tick)
  const kpis = useWf(section === 'finance' ? 'wf:kpis' : null, (s) => getKpis(s), tick)
  const needs = useWf('wf:needs', (s) => listAssignments({ status: 'waiting_approval' }, s), tick)

  const employees = useMemo(() => new Map<string, WfEmployee>((overview.data?.employees ?? []).map((e) => [e.employee_id, e])), [overview.data])
  const go = useCallback((s: WfSection) => { setSection(s); try { localStorage.setItem(SECTION_KEY, s) } catch { /* private mode */ } }, [])
  const nav = useMemo<WfNav>(() => ({
    section,
    go,
    openMission: (id) => { setMission(id); setFocusAssignment(null); go('missions') },
    openEmployee: (id) => { setEmployee(id); go('employees') },
    openAssignment: (id, missionId) => {
      setFocusAssignment(id)
      if (missionId) { setMission(missionId); go('missions') } else if (section !== 'missions') go('queue')
    },
    askCoo: (text) => { setDraft(text); go('command') },
    employees,
    now,
  }), [section, go, employees, now])

  const fixtures = wfFixturesOn()
  const ov = overview.data
  const open = ov ? Object.entries(ov.missions_by_status).filter(([k]) => !isTerminalMission(k)).reduce((a, [, n]) => a + (n ?? 0), 0) : null
  const counts: Partial<Record<WfSection, number | null>> = {
    missions: open,
    employees: ov ? ov.employees.filter((e) => e.status !== 'retired').length : null,
    command: needs.data ? needs.data.length || null : null,
  }
  const stop = ov?.runtime.emergency_stop ?? null
  const live = Boolean(overview.at) && !overview.failure
  // judged against the slower cadence: a section switch to fast polling must not read as a delay
  const stale = Boolean(overview.at && now - overview.at > Math.max(pollMs, 20_000) * 2.5)
  const title = SECTIONS.find((s) => s.id === section)!

  return (
    <WfNavContext.Provider value={nav}>
      <div className={cx('wf', fixtures && 'is-fixture')} data-section={section}>
        <div className="wf-frame">
          <header className="wf-head">
            <div className="wf-head__id">
              <span className="wf-head__mark" aria-hidden="true"><Icon name="users" size={14} /></span>
              <h1>Workforce</h1>
              <LCLive live={live && visible} updatedAt={overview.at} stale={stale} label={!visible ? 'Paused' : undefined} />
              {fixtures ? <span className="wf-fixture" title="VITE_LC_WF_FIXTURES=1 · synthetic records from the fixture server; nothing here is real">FIXTURE</span> : null}
            </div>
            <div className="wf-head__spec">
              {ov ? (
                <>
                  <span><b className="lc-num">{ov.employees.filter((e) => e.status === 'active').length}</b> active</span>
                  <span><b className="lc-num">{open ?? 0}</b> open missions</span>
                  <span className={cx('wf-head__rt', stop === true && 'is-stop')}>
                    <span className="wf-dot" data-tone={stop === true ? 'crit' : ov.runtime.dispatch_enabled ? 'ok' : 'neutral'} />
                    {stop === true ? 'Emergency stop ON' : ov.runtime.dispatch_enabled === null ? <>Dispatch <WfUnknown reason="The runtime did not report dispatch state" /></> : ov.runtime.dispatch_enabled ? 'Dispatch armed' : 'Dispatch off'}
                    {ov.runtime.last_tick_at ? <small>tick {relTime(ov.runtime.last_tick_at, now)}</small> : null}
                  </span>
                </>
              ) : overview.failure?.state === 'not_enabled' ? <span className="wf-quiet">Not enabled on this server</span> : null}
            </div>
          </header>

          <nav className="wf-nav" aria-label="Workforce sections">
            <ul>
              {SECTIONS.map((s, i) => (
                <li key={s.id} className={cx(i > 0 && SECTIONS[i - 1].group !== s.group && 'is-gap')}>
                  <button type="button" className={cx('wf-nav__i', section === s.id && 'is-on')} onClick={() => go(s.id)} aria-current={section === s.id ? 'page' : undefined} title={s.label}>
                    <Icon name={s.icon} size={14} />
                    <span className="wf-nav__l">{s.label}</span>
                    {counts[s.id] ? <em className="lc-num" data-attn={s.id === 'command' ? '' : undefined}>{counts[s.id]}</em> : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="wf-tabs">
            <LCTabs<WfSection> label="Workforce sections" variant="line" value={section} onChange={go} items={SECTIONS.map((s) => ({ id: s.id, label: s.short, count: counts[s.id] ?? null }))} />
          </div>

          <main className="wf-main" aria-label={title.label}>
            {section === 'command' ? <CommandSection tick={tick} linked={linked} clearLinked={() => setLinked(null)} draft={draft} setDraft={setDraft} onLive={setLiveCmd} /> : null}
            {section === 'organization' ? <div className="wf-scroll"><OrganizationSection overview={overview} /></div> : null}
            {section === 'employees' ? <EmployeesSection overview={overview} selected={employee} onSelect={setEmployee} tick={tick} /> : null}
            {section === 'missions' ? <MissionsSection tick={tick} selected={mission} onSelect={(id) => { setMission(id); setFocusAssignment(null) }} focusAssignment={focusAssignment} onLive={setLiveMissions} /> : null}
            {section === 'operations' ? <div className="wf-scroll"><OperationsSection tick={tick} pollMs={pollMs} /></div> : null}
            {section === 'queue' ? <div className="wf-scroll"><QueueSection tick={tick} /></div> : null}
            {section === 'intelligence' ? <div className="wf-scroll"><IntelligenceSection reports={reports} missions={missions} /></div> : null}
            {section === 'finance' ? <div className="wf-scroll"><FinanceSection reports={reports} kpis={kpis} employees={ov?.employees ?? []} /></div> : null}
            {section === 'authority' ? <div className="wf-scroll"><AuthoritySection tick={tick} overview={overview} /></div> : null}
            {section === 'reports' ? <ReportsSection tick={tick} selected={report} onSelect={setReport} /> : null}
          </main>
        </div>
      </div>
    </WfNavContext.Provider>
  )
}
