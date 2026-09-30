/**
 * Presentational parts of the desktop seller card. Everything here renders
 * facts it is handed; a missing value is stated ("Not on record"), never
 * padded with a guess.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DossierField, DossierFieldGroup } from './seller-property-dossier-contract'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import {
  TAB_LABEL,
  formatWhen,
  type DeskBadge,
  type DeskEvent,
  type DeskFact,
  type DeskRailStep,
  type DeskTab,
  type DeskTone,
  type SellerDeskModel,
} from './seller-card-desk-model'

export const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/* ── icons: one stroke family, 1.6px, 24-unit grid ─────────────────────── */

const PATHS = {
  close: 'M6 6l12 12M18 6 6 18',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  collapse: 'M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  half: 'M9 4v16M4 4h16v16H4z',
  chevronDown: 'm6 9 6 6 6-6',
  message: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  inbox: 'M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4',
  deal: 'M12 3.5 20 12l-8 8.5L4 12Z M12 8v8M8.5 12h7',
  comps: 'M5 19V11M10 19V6M15 19v-5M20 19V9M3.5 19.5h17',
  buyers: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8a5 5 0 0 1 10 0M16 5.5a3 3 0 0 1 0 5.6M18 19a5 5 0 0 0-2.4-4.3',
  graph: 'M6 7a2 2 0 1 0 0-.01M18 5a2 2 0 1 0 0-.01M18 19a2 2 0 1 0 0-.01M7.8 7.6l8.4-2M7.6 8.4l8.8 9.2',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.6 2.4 3.6 5.2 3.6 8.5s-1 6.1-3.6 8.5c-2.6-2.4-3.6-5.2-3.6-8.5s1-6.1 3.6-8.5Z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  send: 'M4 12 20 4l-4 16-4.5-6.5L4 12Zm7.5 1.5L20 4',
  campaign: 'M4 10v4h3l5 4V6L7 10H4Zm12-1.5a4 4 0 0 1 0 7',
  in: 'M19 5 5 19M5 9v10h10',
  out: 'M5 19 19 5M9 5h10v10',
  failed: 'M12 8v5M12 16.5h.01M10.3 4.3 3 17a2 2 0 0 0 1.7 3h14.6A2 2 0 0 0 21 17L13.7 4.3a2 2 0 0 0-3.4 0Z',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2',
  calendar: 'M5 6h14v14H5zM5 10h14M9 3.5V7M15 3.5V7',
  deed: 'M7 3.5h7l4 4v13H7zM14 3.5V8h4M9.5 12h6M9.5 15.5h6',
  lien: 'M9.5 14.5 7.8 16.2a3 3 0 0 1-4.2-4.2l3-3a3 3 0 0 1 4.2 0M14.5 9.5l1.7-1.7a3 3 0 0 1 4.2 4.2l-3 3a3 3 0 0 1-4.2 0',
  tag: 'M4 4h7l9 9-7 7-9-9V4Zm4.5 4.5h.01',
  gavel: 'm14 5 5 5M11.5 7.5l5 5M9 10l5-5M13 14l-8.5 8.5M4 20.5h9',
  tax: 'M6 3.5h12v17l-3-2-3 2-3-2-3 2zM9.5 8.5h5M9.5 12h5',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  home: 'M3.5 11.2 12 4l8.5 7.2M5.8 10v10h12.4V10',
} as const

export type IconName = keyof typeof PATHS

export const Icon = ({ name, size = 14 }: { name: IconName; size?: number }) => (
  <svg className="smcd-ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={PATHS[name]} />
  </svg>
)

/* ── tone chips / badges ───────────────────────────────────────────────── */

export const Badge = ({ badge }: { badge: DeskBadge }) => (
  <span className={cls('smcd-badge', `is-${badge.tone}`)}>{badge.label}</span>
)

/* ── the stage rail: S1 → S10, a hairline instrument ─────────────────────── */

export const StageRail = ({ rail, color, compact = false }: { rail: DeskRailStep[]; color: string; compact?: boolean }) => {
  const current = rail.find((s) => s.current)
  return (
    <div
      className={cls('smcd-rail', compact && 'is-compact')}
      style={{ '--smcd-stage': color } as CSSProperties}
      role="img"
      aria-label={current ? `Stage ${current.n} of ${rail.length} — ${current.label}` : 'Stage unknown'}
    >
      {rail.map((step) => (
        <i key={step.code} className={cls(step.reached && 'is-reached', step.current && 'is-current')} title={`S${step.n} · ${step.label}`} />
      ))}
    </div>
  )
}

/* ── facts ─────────────────────────────────────────────────────────────── */

const toneClass = (tone?: DeskTone) => (tone && tone !== 'neutral' ? `is-${tone}` : null)

/** Figures keep the numeric scale; words (a status, a name) set a size smaller so they never truncate. */
const isFigure = (value: string) => /^[\d$+\-−.]/.test(value)

const FactValue = ({ fact, pending }: { fact: DeskFact; pending: boolean }) => {
  if (fact.value != null) return <strong className={cls('smcd-fact__value', toneClass(fact.tone), !isFigure(fact.value) && 'is-word')}>{fact.value}</strong>
  if (pending && fact.dossier) return <span className="smcd-skel" aria-label="Loading" />
  return <span className="smcd-fact__missing">{fact.missing ?? 'Not on record'}</span>
}

/** Frosted tiles (Overview / KPI row). `--i` staggers the reveal. */
export const Tiles = ({ facts, pending, variant = 'tile' }: { facts: DeskFact[]; pending: boolean; variant?: 'tile' | 'kpi' }) => (
  <div className={cls('smcd-tiles', variant === 'kpi' && 'is-kpi')}>
    {facts.map((fact, i) => (
      <div key={fact.key} className={cls('smcd-tile', toneClass(fact.tone), fact.value == null && 'is-empty')} style={{ '--i': i } as CSSProperties}>
        <span className="smcd-tile__label">{fact.label}</span>
        <FactValue fact={fact} pending={pending} />
        {fact.value != null && fact.sub ? <span className="smcd-tile__sub">{fact.sub}</span> : null}
        {fact.value == null && fact.sub ? <span className="smcd-tile__sub">{fact.sub}</span> : null}
      </div>
    ))}
  </div>
)

/** Recessed rows: label left, value (and its qualifier) right. */
export const FactRows = ({ facts, pending }: { facts: DeskFact[]; pending: boolean }) => (
  <dl className="smcd-rows">
    {facts.map((fact) => (
      <div key={fact.key} className="smcd-row">
        <dt>{fact.label}</dt>
        <dd>
          <FactValue fact={fact} pending={pending} />
          {fact.value != null && fact.sub ? <span className="smcd-row__sub">{fact.sub}</span> : null}
        </dd>
      </div>
    ))}
  </dl>
)

export const Section = ({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cls('smcd-section', className)}>
    <header className="smcd-section__head">
      <h4>{title}</h4>
      {aside}
    </header>
    {children}
  </section>
)

/* ── launch: a hand-off to the app that owns the capability ────────────── */

export type DeskLaunch = 'deal' | 'comps' | 'buyers' | 'graph' | 'inbox' | 'campaigns'

export const LAUNCH_META: Record<DeskLaunch, { label: string; icon: IconName; app: string }> = {
  deal: { label: 'Deal Intelligence', icon: 'deal', app: 'Deal Intelligence' },
  comps: { label: 'Run comps', icon: 'comps', app: 'Comp Intelligence' },
  buyers: { label: 'Find buyers', icon: 'buyers', app: 'Buyer Match' },
  graph: { label: 'Entity graph', icon: 'graph', app: 'Entity Graph' },
  inbox: { label: 'Open in Inbox', icon: 'inbox', app: 'Inbox' },
  campaigns: { label: 'Campaign Command', icon: 'campaign', app: 'Campaign Command' },
}

export const LaunchCard = ({ target, onLaunch, lede }: { target: DeskLaunch; onLaunch: (t: DeskLaunch) => void; lede: string }) => (
  <button type="button" className="smcd-launch" data-launch={target} onClick={() => onLaunch(target)}>
    <span className="smcd-launch__icon"><Icon name={LAUNCH_META[target].icon} size={16} /></span>
    <span className="smcd-launch__copy">
      <strong>{LAUNCH_META[target].label}</strong>
      <em>{lede}</em>
    </span>
    <span className="smcd-launch__go" aria-hidden="true">↗</span>
  </button>
)

/* ── the tab rail: a recessed track with one raised pill ────────────────── */

export const TabRail = ({ tabs, active, onChange }: { tabs: DeskTab[]; active: DeskTab; onChange: (tab: DeskTab) => void }) => {
  const railRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`)
    if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth })
  }, [active, tabs])
  return (
    <div className="smcd-tabs" role="tablist" aria-label="Property sections" ref={railRef}>
      {pill ? <span className="smcd-tabs__pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden="true" /> : null}
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          data-tab={tab}
          aria-selected={tab === active}
          className={cls('smcd-tab', tab === active && 'is-active')}
          onClick={() => onChange(tab)}
        >
          {TAB_LABEL[tab]}
        </button>
      ))}
    </div>
  )
}

/* ── activity ──────────────────────────────────────────────────────────── */

const EVENT_ICON: Record<DeskEvent['kind'], IconName> = {
  sms_in: 'in',
  sms_out: 'out',
  sms_failed: 'failed',
  scheduled: 'calendar',
  follow_up: 'clock',
  sale: 'home',
  deed: 'deed',
  lien: 'lien',
  mls: 'tag',
  auction: 'gavel',
  tax: 'tax',
}

const relative = (ms: number): string => {
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const m = Math.round(abs / 60000)
  const label = m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : m < 60 * 24 * 45 ? `${Math.round(m / 1440)}d` : null
  if (!label) return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(ms))
  if (label === 'now') return 'just now'
  return diff > 0 ? `in ${label}` : `${label} ago`
}

export const Timeline = ({ events, loading, error, limit }: { events: DeskEvent[]; loading: boolean; error: string | null; limit?: number }) => {
  const shown = typeof limit === 'number' ? events.slice(0, limit) : events
  return (
    <div className="smcd-timeline">
      {loading ? (
        <div className="smcd-timeline__loading" aria-label="Loading the conversation">
          <span className="smcd-skel is-row" /><span className="smcd-skel is-row" /><span className="smcd-skel is-row is-short" />
        </div>
      ) : null}
      {error && !loading ? <p className="smcd-note is-attention">The conversation didn't load ({error}). Record events are shown.</p> : null}
      {shown.length === 0 && !loading ? (
        <p className="smcd-empty"><Icon name="clock" size={16} />No activity on record yet — the first message or record event will appear here.</p>
      ) : (
        <ol className="smcd-events">
          {shown.map((event, i) => (
            <li key={event.key} className={cls('smcd-event', `is-${event.kind}`, event.upcoming && 'is-upcoming')} style={{ '--i': Math.min(i, 8) } as CSSProperties}>
              <span className="smcd-event__icon"><Icon name={EVENT_ICON[event.kind]} size={13} /></span>
              <div className="smcd-event__body">
                <div className="smcd-event__top">
                  <strong>{event.title}</strong>
                  <time dateTime={event.at} title={formatWhen(event.at)}>{relative(event.atMs)}</time>
                </div>
                {event.detail ? <p>{event.detail}</p> : null}
                <span className="smcd-event__meta">
                  {event.upcoming ? <b>Upcoming · </b> : null}{event.source}{event.status ? ` · ${event.status}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/* ── the property record (FULL › Property) ──────────────────────────────── */

const Spec = ({ fields }: { fields: DossierField[] }) => (
  <dl className="smcd-spec-grid">
    {fields.map((f) => (
      <div key={f.key}>
        <dt>{f.label}</dt>
        <dd>{f.value}</dd>
      </div>
    ))}
  </dl>
)

export const PropertyRecord = ({ viewModel, loading }: { viewModel: SellerMapCardViewModel; loading: boolean }) => {
  const dossier = viewModel.dossier
  if (!dossier) {
    return loading ? (
      <div className="smcd-record-loading" aria-label="Loading the property record">
        {Array.from({ length: 6 }).map((_, i) => <span key={i} className="smcd-skel is-row" />)}
      </div>
    ) : (
      <p className="smcd-empty"><Icon name="deed" size={16} />The county record didn't load for this property. Reopen the card to try again.</p>
    )
  }
  const group = (key: string): DossierFieldGroup | undefined => dossier.propertyDetails.find((g) => g.key === key)
  const structure = ['structure', 'construction', 'systems', 'amenities', 'roof']
    .map(group)
    .filter((g): g is DossierFieldGroup => Boolean(g))
  const site = group('site')
  return (
    <div className="smcd-record">
      {site ? <Section title="Parcel & site"><Spec fields={site.fields} /></Section> : null}
      {structure.length > 0 ? (
        <Section title="Structure">
          {structure.map((g) => (
            <div key={g.key} className="smcd-record__group">
              <h5>{g.label}</h5>
              <Spec fields={g.fields} />
            </div>
          ))}
        </Section>
      ) : null}
      <Section title="Tax & assessment">
        {dossier.valuationAssessment.length ? <Spec fields={dossier.valuationAssessment} /> : <p className="smcd-note">No assessment on record.</p>}
      </Section>
      <Section title="Transactions & loans">
        {dossier.loanTransaction.length ? <Spec fields={dossier.loanTransaction} /> : <p className="smcd-note">No transaction or loan history on record.</p>}
      </Section>
      <Section title="Liens & distress">
        {dossier.distressLegal?.length ? <Spec fields={dossier.distressLegal} /> : <p className="smcd-note">No lien, tax-delinquency or foreclosure records.</p>}
      </Section>
      {dossier.assetSpecific.length ? <Section title="Asset specifics"><Spec fields={dossier.assetSpecific} /></Section> : null}
    </div>
  )
}

/* ── entity snapshot (FULL › Graph) ─────────────────────────────────────── */

export const GraphSnapshot = ({ graph }: { graph: SellerDeskModel['graph'] }) => {
  const nodes: Array<{ key: string; x: number; y: number; label: string; sub: string | null; kind: string; dashed?: boolean }> = [
    { key: 'owner', x: 112, y: 104, label: graph.owner.label, sub: graph.owner.sub, kind: 'owner', dashed: !graph.owner.id },
    { key: 'property', x: 330, y: 50, label: graph.property.label, sub: graph.property.sub, kind: 'property' },
    { key: 'contact', x: 330, y: 158, label: graph.contact.label ?? 'Contact unresolved', sub: graph.contact.sub, kind: 'contact', dashed: !graph.contact.label },
  ]
  if (graph.phones.length) nodes.push({ key: 'phone', x: 528, y: 158, label: graph.phones[0], sub: graph.phones.length > 1 ? `+${graph.phones.length - 1} more` : 'Phone', kind: 'phone' })
  if (graph.thread) nodes.push({ key: 'thread', x: 528, y: 50, label: 'Conversation', sub: 'Inbox thread', kind: 'thread' })
  const at = (key: string) => nodes.find((n) => n.key === key)
  const edges: Array<[string, string]> = [['owner', 'property'], ['owner', 'contact'], ['contact', 'phone'], ['property', 'thread'], ['contact', 'thread']]
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  return (
    <div className="smcd-graph">
      <svg viewBox="0 0 640 210" role="img" aria-label="Entity snapshot: owner, property, contact and phones">
        {edges.map(([a, b]) => {
          const from = at(a)
          const to = at(b)
          if (!from || !to) return null
          return <line key={`${a}-${b}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={cls('smcd-graph__edge', (from.dashed || to.dashed) && 'is-dashed')} />
        })}
        {nodes.map((n) => (
          <g key={n.key} className={cls('smcd-graph__node', `is-${n.kind}`, n.dashed && 'is-dashed')} transform={`translate(${n.x}, ${n.y})`}>
            <circle r={n.kind === 'owner' ? 11 : 8} />
            <text y={n.kind === 'owner' ? 30 : 26} textAnchor="middle" className="smcd-graph__label">{trim(n.label, 26)}</text>
            {n.sub ? <text y={n.kind === 'owner' ? 45 : 41} textAnchor="middle" className="smcd-graph__sub">{trim(n.sub, 30)}</text> : null}
          </g>
        ))}
      </svg>
      {graph.portfolio ? <p className="smcd-note">This owner holds {graph.portfolio} — the full portfolio opens in Entity Graph.</p> : null}
    </div>
  )
}
