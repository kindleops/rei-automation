import { memo, useMemo, useState } from 'react'
import { LCActivityFeed, LCSkeleton, LCTabs } from '../../../shared/lc'
import { sound } from '../../../shared/sound'
import type { Batch, CampaignIntel } from './war-room-api'
import { ACTIVITY_FILTERS, type ActivityCategory, type WarEvent } from './war-room-activity'
import { nf, plural } from './war-room-model'
import { BatchCard } from './WarExecution'
import { Plane } from './WarPlanes'

/**
 * ACTIVITY — the campaign's execution as a grouped timeline (a feeder pass
 * is one batch, an hour of sends one line, a burst of replies one group),
 * filterable by what the event is about, beside the batch ledger.
 */
export const ActivityMode = memo(function ActivityMode({ events, intel, tz, now, loading, onBatch }: { events: WarEvent[]; intel: CampaignIntel | null; tz: string | null; now: number; loading: boolean; onBatch: (b: Batch) => void }) {
  const [filter, setFilter] = useState<'all' | ActivityCategory>('all')
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: events.length }
    for (const e of events) out[e.category] = (out[e.category] ?? 0) + 1
    return out
  }, [events])
  const shown = filter === 'all' ? events : events.filter((e) => e.category === filter)
  const batches = intel?.batches?.list ?? []
  return (
    <div className="cc3-activity">
      <Plane title="Execution timeline" meta={`${plural(shown.length, 'event')}${filter === 'all' ? '' : ` · ${ACTIVITY_FILTERS.find((x) => x.key === filter)?.label.toLowerCase()}`}`} className="cc3-activity__feed" id="cc3-af">
        <LCTabs
          label="Activity filter"
          variant="line"
          value={filter}
          onChange={(v) => { sound.ui.select(); setFilter(v) }}
          items={ACTIVITY_FILTERS.map((x) => ({ id: x.key, label: x.label, count: counts[x.key] ?? 0, disabled: x.key !== 'all' && !counts[x.key], reason: 'Nothing of this kind yet' }))}
        />
        <LCActivityFeed
          events={shown}
          loading={loading}
          tz={tz ?? undefined}
          max={240}
          windowMs={60 * 60_000}
          empty={{ title: filter === 'all' ? 'No execution yet' : 'Nothing of this kind', body: 'Every entry comes from the campaign’s own records — events, feeder passes, the send queue and the message log.' }}
          label="Campaign execution timeline"
        />
      </Plane>
      <Plane title="Batches" meta={intel?.batches ? `${plural(intel.batches.placed_passes, 'pass', 'passes')} placed rows · ${nf(intel.batches.empty_passes)} found nothing` : null} className="cc3-activity__batches" id="cc3-ab">
        {!intel ? <LCSkeleton shape="rows" count={5} /> : batches.length ? batches.slice(0, 24).map((b) => <BatchCard key={b.run_id} b={b} tz={tz} now={now} onOpen={() => onBatch(b)} />) : <p className="cc3-muted">No feeder pass has placed rows yet.</p>}
      </Plane>
    </div>
  )
})
