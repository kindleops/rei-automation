// JS mirror of the LIVE trigger trg_block_repeat_asking_price (public.send_queue), derived
// from the PROPOSED repo mirror migration so a drift in the SQL breaks the tests:
//   supabase/migrations/PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')
export const MIRROR_SQL_PATH = path.join(REPO, 'supabase/migrations/PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql')

function parse() {
  const sql = fs.readFileSync(MIRROR_SQL_PATH, 'utf8')
  const list = (re) => {
    const m = re.exec(sql)
    if (!m) throw new Error(`mirror sql: pattern not found ${re}`)
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  }
  const newStatuses = list(/NEW\.queue_status IN \(([^)]*)\)/)
  const priorStatuses = list(/p\.queue_status IN \(([^)]*)\)/)
  const pattern = /~\*\s*'([^']+)'/.exec(sql)?.[1]
  const paused = /NEW\.paused_reason := '([^']+)'/.exec(sql)?.[1]
  const cancelled = /NEW\.queue_status := '([^']+)'/.exec(sql)?.[1]
  const trigger = /CREATE TRIGGER trg_block_repeat_asking_price BEFORE (INSERT OR UPDATE OF [^O]+)ON public\.send_queue/.exec(sql)?.[1]?.trim()
  if (!pattern || !paused || !cancelled || !trigger) throw new Error('mirror sql: incomplete')
  return { newStatuses, priorStatuses, pattern, paused, cancelled, trigger }
}

export const MIRROR = Object.freeze(parse())

/** Apply the trigger to a row about to be inserted, given the thread's existing rows. Returns the row as stored. */
export function applyBlockRepeatAskingPrice(newRow, existingRows = []) {
  const re = new RegExp(MIRROR.pattern, 'i')
  const row = { ...newRow }
  if (MIRROR.newStatuses.includes(row.queue_status) && row.thread_key != null && re.test(row.use_case_template || '') &&
    existingRows.some((p) => p.thread_key === row.thread_key && p.id !== row.id && MIRROR.priorStatuses.includes(p.queue_status) && re.test(p.use_case_template || ''))) {
    row.queue_status = MIRROR.cancelled
    row.paused_reason = MIRROR.paused
  }
  return row
}
