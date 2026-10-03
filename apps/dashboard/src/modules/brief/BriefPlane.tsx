import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import { LCIconButton, LCInspector, LCSegmented, LCSkeleton, LCStatus, cx } from '../../shared/lc'
import { useNow } from '../../views/home/desktop/board/widget-runtime'
import { buildBrief, headline, SECTION_LABEL, type BriefSection } from './brief-model'
import { useBriefFacts } from './brief-sources'
import { BriefLines } from './BriefLines'
import { closeBrief, useBriefOpen, useBriefSeen } from './brief-store'
import './brief.css'

/**
 * THE BRIEF PLANE — the operator brief, expanded, from the Command Deck
 * ("Brief me"). A floating glass plane (LCInspector) over the workspace:
 * the ranked statements, filterable by source, each opening the object or
 * app it cites; the sources that could not be read are named at the foot.
 * Deterministic templates over real reads — no generated prose.
 */
export function BriefPlane() {
  const open = useBriefOpen()
  if (!open) return null
  return <BriefPlaneBody />
}

type Filter = 'all' | 'attention'

function BriefPlaneBody() {
  const now = useNow(30_000)
  const facts = useBriefFacts(true, now)
  const brief = useMemo(() => buildBrief(facts), [facts])
  const lastSeen = useBriefSeen()
  const [filter, setFilter] = useState<Filter>('all')
  const [section, setSection] = useState<BriefSection | null>(null)
  const [wide, setWide] = useState(false)
  const lines = brief.lines.filter((l) => (filter === 'all' || l.tone === 'attn' || l.tone === 'crit') && (!section || l.section === section))
  const present = [...new Set(brief.lines.map((l) => l.section))]
  const stamp = new Date(now).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <LCInspector
      open onClose={closeBrief} id="brief-plane" mode="float" width={wide ? 980 : 560} minWidth={460} maxWidth={1400} resizable
      className={cx('bf-plane', wide && 'is-wide')}
      eyebrow={<span className="bf-eyebrow"><Icon name="briefing" size={11} /> Intelligence Brief</span>}
      title={headline(brief)}
      subtitle={`${stamp} · every line cites its source`}
      status={<LCStatus tone="neutral" quiet hollow label="Read-only" />}
      actions={<LCIconButton icon="maximize" label={wide ? 'Narrow the brief' : 'Expand the brief'} size="sm" selected={wide} onClick={() => setWide((w) => !w)} />}
      label="Intelligence Brief"
    >
      <div className="bf-body">
        <div className="bf-tools">
          <LCSegmented<Filter> size="sm" label="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Everything' }, { value: 'attention', label: 'Needs attention' }]} />
          <div className="bf-chips" role="group" aria-label="Source">
            <button type="button" className={cx('bf-chip', !section && 'is-on')} onClick={() => setSection(null)}>All sources</button>
            {present.map((s) => <button key={s} type="button" className={cx('bf-chip', section === s && 'is-on')} onClick={() => setSection(section === s ? null : s)}>{SECTION_LABEL[s]}</button>)}
          </div>
        </div>
        {brief.loading.length && !brief.lines.length ? <LCSkeleton shape="lines" count={6} label="Reading the brief" /> : (
          lines.length ? <BriefLines lines={lines} lastSeen={lastSeen} sections={!section} onOpen={() => { if (!wide) closeBrief() }} /> : (
            <p className="bf-empty"><Icon name="check" size={13} />{filter === 'attention' ? 'Nothing here needs your attention.' : 'Nothing to report from this source.'}</p>
          )
        )}
        <footer className="bf-foot">
          {brief.quiet.length ? <p><b>Nothing to report:</b> {brief.quiet.map((s) => SECTION_LABEL[s]).join(' · ')}</p> : null}
          {brief.loading.length ? <p><b>Still reading:</b> {brief.loading.map((s) => SECTION_LABEL[s]).join(' · ')}</p> : null}
          {brief.unavailable.length ? <p className="is-gap"><b>Not included</b> (could not be read): {brief.unavailable.map((u) => `${SECTION_LABEL[u.section]} — ${u.reason}`).join(' · ')}</p> : null}
          <p className="bf-foot__how">Composed from fixed templates over Signal Center, Notification Center, the platform event ledger, Campaign Command, Inbox, Closing Desk and the Analytics engine. No language model writes any line.</p>
        </footer>
      </div>
    </LCInspector>
  )
}
