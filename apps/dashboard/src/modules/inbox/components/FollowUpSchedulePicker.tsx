import type { FollowUpScheduleConfig } from '../../../lib/api/backendClient'

type Props = {
  value: FollowUpScheduleConfig
  onChange: (next: FollowUpScheduleConfig) => void
  /** Inline validation text, or null when the configuration is usable. */
  error: string | null
}

// Thumb-sized presets beat a desktop date picker on a 390px sheet. All dates
// are seller-LOCAL; the server converts per recipient.
const dayOptions = (): { value: string; label: string }[] => {
  const out: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    out.push({ value, label })
  }
  return out
}

const TIMES = ['8:00 AM', '9:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '3:00 PM', '5:00 PM', '7:00 PM']

/**
 * Validation mirrors the server's own reasons so the operator is stopped before
 * a doomed request rather than after it.
 */
export function validateSchedule(v: FollowUpScheduleConfig): string | null {
  if (v.mode === 'best_contact_time') return null
  if (!v.date) return 'Choose a date.'
  if (v.mode === 'exact' || v.mode === 'starting_at') {
    if (!v.time) return 'Choose a time.'
    return null
  }
  if (v.mode === 'window') {
    if (!v.window_start || !v.window_end) return 'Choose a start and end time.'
    if (TIMES.indexOf(v.window_end) <= TIMES.indexOf(v.window_start)) {
      return 'End time must be after start time.'
    }
  }
  return null
}

export function FollowUpSchedulePicker({ value, onChange, error }: Props) {
  const days = dayOptions()
  const manual = value.mode !== 'best_contact_time'
  const set = (patch: Partial<FollowUpScheduleConfig>) => onChange({ ...value, ...patch })

  return (
    <div className="nx-sched">
      <div className="nx-sched__label">Scheduling</div>

      <div className="nx-sched__modes">
        <button type="button" className={!manual ? 'is-on' : ''}
          onClick={() => onChange({ mode: 'best_contact_time' })}>Best Contact Time</button>
        <button type="button" className={manual ? 'is-on' : ''}
          onClick={() => set({ mode: 'exact', date: days[1].value, time: '2:00 PM' })}>Manual</button>
      </div>

      {!manual && (
        <div className="nx-sched__hint">Each seller is scheduled inside their own best contact window.</div>
      )}

      {manual && (
        <>
          <div className="nx-sched__submodes">
            {(['exact', 'starting_at', 'window'] as const).map((m) => (
              <button key={m} type="button" className={value.mode === m ? 'is-on' : ''}
                onClick={() => set({ mode: m })}>
                {m === 'exact' ? 'Exact' : m === 'starting_at' ? 'Starting At' : 'Window'}
              </button>
            ))}
          </div>

          <div className="nx-sched__row">
            <span className="nx-sched__row-label">Date</span>
            <div className="nx-sched__chips">
              {days.map((d) => (
                <button key={d.value} type="button" className={value.date === d.value ? 'is-on' : ''}
                  onClick={() => set({ date: d.value })}>{d.label}</button>
              ))}
            </div>
          </div>

          {(value.mode === 'exact' || value.mode === 'starting_at') && (
            <div className="nx-sched__row">
              <span className="nx-sched__row-label">
                {value.mode === 'exact' ? 'Time' : 'Start'}
              </span>
              <div className="nx-sched__chips">
                {TIMES.map((t) => (
                  <button key={t} type="button" className={value.time === t ? 'is-on' : ''}
                    onClick={() => set({ time: t })}>{t}</button>
                ))}
              </div>
            </div>
          )}

          {value.mode === 'window' && (
            <>
              <div className="nx-sched__row">
                <span className="nx-sched__row-label">From</span>
                <div className="nx-sched__chips">
                  {TIMES.map((t) => (
                    <button key={t} type="button" className={value.window_start === t ? 'is-on' : ''}
                      onClick={() => set({ window_start: t })}>{t}</button>
                  ))}
                </div>
              </div>
              <div className="nx-sched__row">
                <span className="nx-sched__row-label">To</span>
                <div className="nx-sched__chips">
                  {TIMES.map((t) => (
                    <button key={t} type="button" className={value.window_end === t ? 'is-on' : ''}
                      onClick={() => set({ window_end: t })}>{t}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="nx-sched__hint">Times are each seller&apos;s local time.</div>
        </>
      )}

      {error && <div className="nx-sched__error">{error}</div>}
    </div>
  )
}

export default FollowUpSchedulePicker
