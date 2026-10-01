import { useEffect, useMemo, useState } from 'react'
import {
  LCActivityFeed, LCButton, LCChip, LCCombobox, LCConfirm, LCContextMenu, LCDataGrid, LCDialog, LCEmpty, LCError,
  LCFacts, LCFilterBar, LCFilterInspector, LCHoverCard, LCIconButton, LCInspector, LCInspectorSection, LCLive, LCMenu,
  LCMetric, LCPopover, LCProgress, LCRail, LCSearch, LCSegmented, LCSelect, LCSheet, LCSkeleton, LCSparkline, LCStatus,
  LCTabs, LCTimeline, LCToolbar, LCTooltip, LC_STATES, lcMenu, type LCActivityEvent, type LCColumn, type LCSort, type LCStateKey,
} from '../../shared/lc'
import './experience-showcase.css'

/**
 * DEV-ONLY — the Experience System reference surface (/dev/experience).
 * Registered only in development builds. Every value on this page is
 * SAMPLE data, labelled as such; nothing here reads or writes production.
 */

type Row = { id: string; name: string; market: string; stage: string; value: number; replies: number; updated: number }
const MARKETS = ['Dallas, TX', 'Minneapolis, MN', 'Miami, FL', 'Atlanta, GA', 'Phoenix, AZ', 'Tampa, FL']
const STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']
const SAMPLE_ROWS: Row[] = Array.from({ length: 640 }, (_, i) => ({
  id: `sample-${i}`,
  name: `Sample record ${String(i + 1).padStart(3, '0')}`,
  market: MARKETS[i % MARKETS.length],
  stage: STAGES[(i * 7) % STAGES.length],
  value: 90_000 + ((i * 7919) % 410_000),
  replies: (i * 13) % 9,
  updated: Date.now() - ((i * 37) % 7200) * 60_000,
}))
const COMBO = MARKETS.map((m, i) => ({ value: `m${i}`, label: m, kind: 'Market', sub: `${(3 + i) * 7} sample sellers`, group: i < 3 ? 'Primary' : 'Secondary' }))
const THEMES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'true_black', label: 'True Black' },
  { value: 'red_ops', label: 'Red Ops' },
] as const

const money = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`)

export default function ExperienceShowcase() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.getAttribute('data-nexus-theme') || 'dark')
  const [motionOn, setMotionOn] = useState(true)
  const [density, setDensity] = useState<'dense' | 'standard' | 'comfortable'>('standard')
  const [tab, setTab] = useState('overview')
  const [seg, setSeg] = useState('table')
  const [metric, setMetric] = useState('reply_rate')
  const [group, setGroup] = useState('market')
  const [combo, setCombo] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<LCSort>({ id: 'value', dir: 'desc' })
  const [active, setActive] = useState<Row | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [count, setCount] = useState(11.9)
  const [now] = useState(() => Date.now())
  const [filters, setFilters] = useState([
    { id: 'm', field: 'Market', value: 'Miami, FL' },
    { id: 's', field: 'Stage', value: 'S2–S5' },
    { id: 'e', field: 'Equity', value: '≥ 60%' },
  ])

  // preview the theme / motion locally; the operator's saved settings are untouched
  useEffect(() => {
    const root = document.documentElement
    const prevTheme = root.getAttribute('data-nexus-theme')
    const prevMotion = root.getAttribute('data-lc-motion')
    return () => {
      if (prevTheme) root.setAttribute('data-nexus-theme', prevTheme)
      if (prevMotion) root.setAttribute('data-lc-motion', prevMotion)
    }
  }, [])
  useEffect(() => { document.documentElement.setAttribute('data-nexus-theme', theme) }, [theme])
  useEffect(() => { document.documentElement.setAttribute('data-lc-motion', motionOn ? 'on' : 'off') }, [motionOn])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle ? SAMPLE_ROWS.filter((r) => r.name.toLowerCase().includes(needle) || r.market.toLowerCase().includes(needle)) : SAMPLE_ROWS
    if (!sort) return list
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[sort.id as keyof Row]
      const bv = b[sort.id as keyof Row]
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir
    })
  }, [q, sort])

  const columns: LCColumn<Row>[] = [
    { id: 'name', header: 'Record', minWidth: 200, sortable: true, render: (r) => <span className="lcx-name">{r.name}</span> },
    { id: 'market', header: 'Market', width: 170, sortable: true, hideable: true, render: (r) => r.market },
    { id: 'stage', header: 'Stage', width: 90, sortable: true, hideable: true, render: (r) => r.stage },
    { id: 'value', header: 'Est. value', width: 120, align: 'right', sortable: true, hint: 'Sample estimate', render: (r) => money(r.value) },
    { id: 'replies', header: 'Replies', width: 90, align: 'right', sortable: true, hideable: true, render: (r) => r.replies },
    { id: 'updated', header: 'Updated', width: 130, align: 'right', sortable: true, hideable: true, render: (r) => new Date(r.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) },
  ]

  const events: LCActivityEvent[] = [
    ...Array.from({ length: 24 }, (_, i) => ({ id: `q${i}`, at: now - 4 * 60_000 - i * 3_000, title: 'Target queued', subject: `Sample record ${i + 1}`, source: 'Sample campaign · Dallas', icon: 'send' as const, tone: 'exec' as const, groupKey: 'queue:sample', groupNoun: 'targets queued' })),
    { id: 'r1', at: now - 60_000, title: 'Seller replied', subject: 'Sample seller', source: 'SMS', result: 'Interested', icon: 'message', tone: 'ok' },
    { id: 'w1', at: now - 9 * 60_000, title: 'Follow-up scheduled', subject: 'Sample seller', source: 'Workflow', result: 'Tomorrow 10:00 AM CT', icon: 'zap', tone: 'flow' },
    { id: 'f1', at: now - 22 * 60_000, title: 'Send held', subject: 'Sample record 7', source: 'Content filter', result: 'Held for review', icon: 'shield', tone: 'attn' },
  ]

  const sections = [
    { id: 'property', label: 'Property', active: 1, keywords: ['beds', 'equity', 'type'], render: () => <LCSelect label="Asset type" value="sfr" onChange={() => undefined} options={[{ value: 'sfr', label: 'Single family' }, { value: 'mf', label: '2–4 units' }]} /> },
    { id: 'geography', label: 'Geography', active: 1, keywords: ['market', 'zip', 'county'], render: () => <LCCombobox label="Market" value={combo} onChange={(v) => setCombo(v)} options={COMBO} placeholder="Search markets…" /> },
    { id: 'financial', label: 'Financial', active: 1, keywords: ['equity', 'value', 'mortgage'], render: () => <p className="lc-t-meta">Range controls render here.</p> },
    { id: 'status', label: 'Status', keywords: ['stage', 'contacted'], render: () => <p className="lc-t-meta">Stage controls render here.</p> },
    { id: 'activity', label: 'Activity', keywords: ['reply', 'sent'], render: () => <p className="lc-t-meta">Activity windows render here.</p> },
  ]

  return (
    <div className="lcx" data-lc-density={density}>
      <header className="lcx-head lc-plane is-crystal" data-under="exec">
        <div>
          <span className="lc-eyebrow">Internal · sample data</span>
          <h1 className="lc-t-app">Experience System 4.0</h1>
          <p className="lc-t-body">Every shared primitive, every state, in the live theme. Nothing on this page touches production.</p>
        </div>
        <div className="lcx-head__ctl">
          <LCSegmented label="Theme preview" value={theme} onChange={setTheme} options={THEMES.map((t) => ({ value: t.value, label: t.label }))} />
          <LCSegmented label="Density" value={density} onChange={(v) => setDensity(v as typeof density)} options={[{ value: 'dense', label: 'Dense' }, { value: 'standard', label: 'Standard' }, { value: 'comfortable', label: 'Comfortable' }]} size="sm" />
          <LCSegmented label="Motion" value={motionOn ? 'on' : 'off'} onChange={(v) => setMotionOn(v === 'on')} options={[{ value: 'on', label: 'Motion' }, { value: 'off', label: 'Still' }]} size="sm" />
        </div>
      </header>

      <section className="lcx-grid">
        <article className="lc-plane is-crystal lcx-card">
          <span className="lc-eyebrow">Buttons</span>
          <div className="lcx-row">
            <LCButton variant="primary" icon="send">Retry send</LCButton>
            <LCButton variant="secondary" trailingIcon="arrow-up-right">Open campaign</LCButton>
            <LCButton variant="quiet">Reschedule</LCButton>
            <LCButton variant="ghost">Dismiss</LCButton>
            <LCButton variant="danger" onClick={() => setConfirmOpen(true)}>Pause campaign</LCButton>
          </div>
          <div className="lcx-row">
            <LCButton variant="primary" loading>Applying</LCButton>
            <LCButton variant="secondary" disabled>Unavailable</LCButton>
            <LCButton variant="secondary" size="sm" icon="filter">Filters</LCButton>
            <LCButton variant="primary" size="lg">Apply filters</LCButton>
          </div>
          <div className="lcx-row">
            <LCIconButton icon="refresh-cw" label="Refresh" />
            <LCIconButton icon="filter" label="Filters" selected />
            <LCIconButton icon="bell" label="Alerts" count={3} />
            <LCIconButton icon="inbox" label="Inbox" dot="attn" />
            <LCIconButton icon="layers" label="Layers" variant="glass" shortcut={['L']} />
            <LCIconButton icon="settings" label="Settings" disabled />
            <LCTooltip content="Reply rate = replies ÷ delivered, same window" shortcut={['?']}><span className="lcx-pill" tabIndex={0}>Hover or focus for a tooltip</span></LCTooltip>
          </div>
        </article>

        <article className="lc-plane is-crystal lcx-card">
          <span className="lc-eyebrow">Menus · select · combobox · popover</span>
          <div className="lcx-row">
            <LCMenu
              trigger={<LCButton variant="secondary" trailingIcon="chevron-down">Actions</LCButton>}
              title="Sample record 004"
              items={lcMenu(
                [{ label: 'Open', icon: 'arrow-up-right', shortcut: '↵' }, { label: 'Open in Map', icon: 'map' }, { label: 'Open Graph', icon: 'layers' }],
                [{ label: 'Copy address', icon: 'file-text', hint: 'Copies the mailing address' }, { label: 'Pin', icon: 'star', disabled: true, reason: 'Pinning needs a saved view store' }],
                [{ label: 'Archive', icon: 'archive', tone: 'danger' }],
              )}
            />
            <LCSelect label="Metric" variant="field" value={metric} onChange={setMetric} options={[{ value: 'reply_rate', label: 'Reply rate' }, { value: 'delivery_rate', label: 'Delivery rate' }, { value: 'opportunities', label: 'Opportunities' }, { value: 'opt_out', label: 'Opt-out rate', hint: 'STOP replies ÷ delivered' }]} />
            <LCSelect label="Group by" variant="quiet" value={group} onChange={setGroup} options={[{ value: 'market', label: 'Market' }, { value: 'campaign', label: 'Campaign' }, { value: 'sender', label: 'Sender' }, { value: 'template', label: 'Template' }]} />
            <LCPopover trigger={<LCButton variant="quiet" icon="clock">Last 30 days</LCButton>} label="Time range" width={260}>
              <div className="lcx-pop">
                <span className="lc-eyebrow">Range</span>
                <LCSegmented label="Range" value="30d" onChange={() => undefined} options={[{ value: 'today', label: 'Today' }, { value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '90d', label: '90D' }]} size="sm" />
              </div>
            </LCPopover>
          </div>
          <div className="lcx-row">
            <div style={{ width: 300 }}>
              <LCCombobox label="Market" value={combo} onChange={(v) => setCombo(v)} options={COMBO} placeholder="Search markets…" />
            </div>
            <LCHoverCard trigger={<span className="lcx-pill" tabIndex={0}>Hover card preview</span>}>
              <div className="lcx-hc">
                <span className="lc-eyebrow">Seller · sample</span>
                <b className="lc-t-row">Sample seller</b>
                <span className="lc-t-meta">3831 Sample Ave N · S2 · Offer interest</span>
                <LCStatus state="system_handling" />
              </div>
            </LCHoverCard>
            <LCContextMenu items={lcMenu([{ label: 'Open', icon: 'arrow-up-right' }, { label: 'View history', icon: 'clock' }])} title="Context">
              <span className="lcx-pill" tabIndex={0}>Right-click me</span>
            </LCContextMenu>
          </div>
        </article>

        <article className="lc-plane is-crystal lcx-card">
          <span className="lc-eyebrow">Tabs · segmented · search · filters</span>
          <LCTabs label="Modes" value={tab} onChange={setTab} items={[{ id: 'overview', label: 'Overview' }, { id: 'flow', label: 'Flow', count: 42 }, { id: 'table', label: 'Table' }, { id: 'offers', label: 'Offers', count: 3, tone: 'attn' }, { id: 'later', label: 'Archive', disabled: true, reason: 'Not available yet' }]} />
          <div className="lcx-row">
            <LCSegmented label="View" value={seg} onChange={setSeg} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }, { value: 'graph', label: 'Graph' }]} />
            <LCSegmented label="Lens" value="dots" onChange={() => undefined} size="sm" options={[{ value: 'surface', label: 'Surface' }, { value: 'dots', label: 'Dots' }, { value: 'areas', label: 'Areas' }]} />
          </div>
          <LCSearch label="Search records" value={q} onChange={setQ} hint="/" />
          <LCFilterBar
            filters={filters.map((f) => ({ ...f, onRemove: () => setFilters((list) => list.filter((x) => x.id !== f.id)) }))}
            onClearAll={() => setFilters([])}
            onOpen={() => setFiltersOpen(true)}
            count={18_249}
            countNoun="sample records"
            persistent
          />
          <div className="lcx-row"><LCChip value="Miami, FL" onRemove={() => undefined} /><LCChip field="Stage" value="S2–S5" onRemove={() => undefined} /><LCChip value="Read-only" tone="neutral" /></div>
        </article>

        <article className="lc-plane is-crystal lcx-card">
          <span className="lc-eyebrow">Metrics · progress · rail</span>
          <div className="lcx-metrics">
            <LCMetric label="Reply rate" value={`${count.toFixed(1)}%`} numeric={{ value: count, decimals: 1, suffix: '%' }} delta={{ text: '+2.9 pts', tone: 'good', against: 'vs previous 30D' }} basis="101 of 848 delivered" spark={[7, 8, 8.5, null, 9.4, 10.2, 11.9]} onDefine={() => setDialogOpen(true)} size="lg" />
            <LCMetric label="Delivery rate" value="68.6%" delta={{ text: '−20.0 pts', tone: 'bad' }} basis="sample" />
            <LCMetric label="Est. pipeline" value="$315K" basis="estimated · not actual" />
            <LCMetric label="Thin sample" value="40.0%" sample={{ n: 5, min: 30 }} />
            <LCMetric label="Unavailable" value={null} basis="No source connected" />
          </div>
          <div className="lcx-row"><LCButton size="sm" variant="secondary" onClick={() => setCount((c) => Math.round((c + 1.3) * 10) / 10)}>Change value</LCButton><LCSparkline values={[3, 5, 4, 7, 6, 9, 8]} label="Sample trend" tone="ok" /></div>
          <LCProgress label="Queue capacity" value={420} max={500} threshold={450} valueText="420 / 500" />
          <LCProgress label="Delivery" segments={[{ value: 581, tone: 'ok', label: 'Delivered' }, { value: 218, tone: 'crit', label: 'Failed' }, { value: 49, tone: 'neutral', label: 'Pending' }]} valueText="848 sent" />
          <LCProgress label="Importing" />
          <LCRail label="Campaign execution" onSelect={() => undefined} selected="queue" steps={[
            { id: 'aud', label: 'Audience', value: '2,091', state: 'done' },
            { id: 'elig', label: 'Eligible', value: '1,488', state: 'done' },
            { id: 'queue', label: 'Queue', value: '312', state: 'active', sub: 'buffer, not total' },
            { id: 'sent', label: 'Sent', value: '848', state: 'waiting' },
            { id: 'del', label: 'Delivered', value: '581', state: 'blocked', note: 'Content filter' },
            { id: 'rep', label: 'Reply', value: '101', state: 'idle' },
          ]} />
        </article>

        <article className="lc-plane is-crystal lcx-card">
          <span className="lc-eyebrow">States</span>
          <div className="lcx-states">
            {(Object.keys(LC_STATES) as LCStateKey[]).map((k) => <LCStatus key={k} state={k} />)}
          </div>
          <div className="lcx-row"><LCLive live updatedAt={now} /><LCLive live stale /><LCLive live={false} /></div>
          <div className="lcx-two">
            <LCSkeleton shape="metric" />
            <LCSkeleton shape="rows" count={3} />
          </div>
          <LCEmpty title="Today is clear" body="Nothing needs you. LeadCommand is handling every open conversation." icon="check" tone="calm" />
          <LCEmpty title="No results for these filters" body="Remove a filter to widen the cohort." icon="filter" action={{ label: 'Clear filters', onClick: () => setFilters([]) }} />
          <LCError what="Campaign performance didn’t load" staleSince={now - 6 * 60_000} onRetry={() => undefined} detail="sample: 504 from upstream" />
        </article>

        <article className="lc-plane is-crystal lcx-card">
          <span className="lc-eyebrow">Activity · timeline</span>
          <div className="lcx-two">
            <LCActivityFeed events={events} label="Sample activity" />
            <LCTimeline byDay items={[
              { id: 't1', at: now - 26 * 3600_000, title: 'Contract signed', body: 'Sample · uploaded by operator', state: 'done', icon: 'file-text' },
              { id: 't2', at: now - 3 * 3600_000, title: 'Buyer assigned', state: 'done' },
              { id: 't3', at: now - 20 * 60_000, title: 'EMD verification', body: 'Waiting on title', state: 'waiting' },
              { id: 't4', at: now + 26 * 3600_000, title: 'Title commitment due', state: 'next' },
              { id: 't5', at: now + 5 * 86400_000, title: 'Settlement', state: 'next', meta: 'Sample date' },
            ]} />
          </div>
        </article>
      </section>

      <section className="lc-plane is-crystal lcx-gridcard">
        <LCToolbar
          search={<LCSearch label="Search sample records" value={q} onChange={setQ} hint="/" />}
          filters={<LCButton variant="quiet" size="sm" icon="filter" onClick={() => setFiltersOpen(true)}>Filters</LCButton>}
          controls={<><LCSelect label="Group by" variant="quiet" size="sm" value={group} onChange={setGroup} options={[{ value: 'market', label: 'Market' }, { value: 'stage', label: 'Stage' }]} /><LCSegmented label="Density" size="sm" value={density} onChange={(v) => setDensity(v as typeof density)} options={[{ value: 'dense', label: 'Dense' }, { value: 'standard', label: 'Std' }]} /></>}
          actions={<LCButton size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>Open sheet</LCButton>}
        />
        <div className="lcx-gridwrap">
          <LCDataGrid
            id="dev-showcase"
            label="Sample records"
            rows={rows}
            rowKey={(r) => r.id}
            columns={columns}
            sort={sort}
            onSortChange={setSort}
            activeKey={active?.id ?? null}
            onActivate={setActive}
            selected={selected}
            onSelectedChange={setSelected}
            density={density}
            rowMenu={(r) => lcMenu([{ label: 'Open', icon: 'arrow-up-right', onSelect: () => setActive(r) }, { label: 'Open in Map', icon: 'map' }], [{ label: 'Archive', icon: 'archive', tone: 'danger', disabled: true, reason: 'Sample data' }])}
            total={rows.length}
            height={460}
          />
          <LCInspector
            open={Boolean(active)}
            onClose={() => setActive(null)}
            id="dev-showcase"
            eyebrow={active ? `Record · ${active.stage}` : undefined}
            title={active?.name ?? ''}
            subtitle={active?.market}
            status={<LCStatus state="waiting_seller" />}
            contentKey={active?.id}
            tabs={{ items: [{ id: 'o', label: 'Overview' }, { id: 'h', label: 'History' }], value: 'o', onChange: () => undefined }}
          >
            {active ? (
              <>
                <LCInspectorSection title="Facts">
                  <LCFacts rows={[{ label: 'Est. value', value: money(active.value) }, { label: 'Replies', value: active.replies }, { label: 'Mortgage', value: null }]} />
                </LCInspectorSection>
                <LCInspectorSection title="Next">
                  <p className="lc-t-body">The arrow keys keep moving through rows while this follows.</p>
                </LCInspectorSection>
              </>
            ) : null}
          </LCInspector>
          <LCInspector open={filtersOpen} onClose={() => setFiltersOpen(false)} id="dev-filters" title="Filters" eyebrow="Sample cohort" width={380} resizable={false}>
            <LCFilterInspector sections={sections} activeCount={3} cohort={18_249} cohortNoun="sample records" onApply={() => setFiltersOpen(false)} onClear={() => undefined} />
          </LCInspector>
        </div>
      </section>

      <LCConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Pause campaign?"
        tone="danger"
        confirmLabel="Pause campaign"
        effects={[
          { text: 'New campaign sends will stop.', kind: 'stops' },
          { text: 'Existing seller conversations remain active.', kind: 'keeps' },
          { text: 'Sample only — nothing is paused from this page.', kind: 'note' },
        ]}
        onConfirm={() => new Promise((r) => window.setTimeout(r, 700))}
      />
      <LCDialog open={dialogOpen} onOpenChange={setDialogOpen} title="Reply rate" description="Replies ÷ delivered messages in the same window." footer={<LCButton variant="secondary" onClick={() => setDialogOpen(false)}>Close</LCButton>}>
        <LCFacts rows={[{ label: 'Numerator', value: 'Inbound replies' }, { label: 'Denominator', value: 'Delivered' }, { label: 'Minimum sample', value: '30' }]} />
      </LCDialog>
      <LCSheet open={sheetOpen} onOpenChange={setSheetOpen} title="Sample sheet">
        <div className="lcx-sheet">
          <span className="lc-eyebrow">Focused creation</span>
          <h2 className="lc-t-surface">Modal sheet</h2>
          <p className="lc-t-body">For focused creation that keeps the page visible. Contextual detail uses the inspector instead.</p>
          <LCButton variant="secondary" onClick={() => setSheetOpen(false)}>Close</LCButton>
        </div>
      </LCSheet>
    </div>
  )
}
