// JS mirror of the trigger trg_block_repeat_asking_price (public.send_queue) AS rc-8.5.20 ships
// it: the 8.5.15.1 question_kind body
//   supabase/migrations/PROPOSED_20261015120000_repeat_asking_price_question_kind.sql
// (the 8.5.16 helper modelled the OLD body from PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql:
// use_case_template ~* 'asking_price' only — rc-8.5.20 review item d). Every literal below is
// PARSED from the SQL, so a drift in the migration breaks the tests. The trigger statement itself
// (events / columns) is unchanged by 8.5.15.1 and is parsed from the mirror migration.
//
// Rules (the function body):
//   an "asking-price row" = use_case_template ~* 'asking_price' OR ~* '^s3_no_response_'
//                           OR metadata.question_kind = 'asking_price' — new row and prior rows alike
//   a pending asking-price row on a thread whose latest prior asking-price row is sent / delivered /
//   processing is CANCELLED ('blocked_repeat_asking_price'), except
//     (c) the S3 no-response follow-up: allowed after SILENCE (no inbound after that ask), else
//         cancelled 'blocked_repeat_asking_price_seller_replied'
//     (d) an audited manual override (manual_operator_send + repeat_ask_override {scope, actor,
//         reason ≥ 10 chars, at}) passes this guard only
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')
export const QUESTION_KIND_SQL_PATH = path.join(REPO, 'supabase/migrations/PROPOSED_20261015120000_repeat_asking_price_question_kind.sql')
export const MIRROR_SQL_PATH = path.join(REPO, 'supabase/migrations/PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql')

function parse() {
  const sql = fs.readFileSync(QUESTION_KIND_SQL_PATH, 'utf8')
  const trig = fs.readFileSync(MIRROR_SQL_PATH, 'utf8')
  const list = (re, src = sql) => {
    const m = re.exec(src)
    if (!m) throw new Error(`question_kind sql: pattern not found ${re}`)
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  }
  const newStatuses = list(/NEW\.queue_status not in \(([^)]*)\)/i)
  const priorStatuses = list(/p\.queue_status in \(([^)]*)\)/i)
  const useCasePatterns = [...sql.matchAll(/coalesce\(NEW\.use_case_template, ''\) ~\* '([^']+)'/g)].map((m) => m[1])
  const questionKind = /coalesce\(NEW\.metadata ->> 'question_kind', ''\) = '([^']+)'/.exec(sql)?.[1]
  const s3Pattern = /v_is_s3_followup := coalesce\(NEW\.use_case_template, ''\) ~\* '([^']+)'/.exec(sql)?.[1]
  const s3Kind = /'no_response_followup' ->> 'kind', ''\) = '([^']+)'/.exec(sql)?.[1]
  const paused = [...sql.matchAll(/NEW\.paused_reason := '([^']+)'/g)].map((m) => m[1])
  const cancelled = /NEW\.queue_status := '([^']+)'/.exec(sql)?.[1]
  const overrideScope = /v_override ->> 'scope', ''\) = '([^']+)'/.exec(sql)?.[1]
  const overrideMinReason = Number(/length\(btrim\(coalesce\(v_override ->> 'reason', ''\)\)\) >= ([0-9]+)/.exec(sql)?.[1])
  const trigger = /CREATE TRIGGER trg_block_repeat_asking_price BEFORE (INSERT OR UPDATE OF [^O]+)ON public\.send_queue/.exec(trig)?.[1]?.trim()
  const ok = useCasePatterns.length >= 2 && questionKind && s3Pattern && s3Kind && paused.length === 2 && cancelled && overrideScope && overrideMinReason && trigger
  if (!ok) throw new Error('question_kind sql: incomplete parse')
  return {
    newStatuses, priorStatuses,
    useCasePatterns: [...new Set(useCasePatterns)],
    questionKind, s3Pattern, s3Kind,
    paused: paused[1], pausedSellerReplied: paused[0],
    cancelled, overrideScope, overrideMinReason, trigger,
    // 8.5.16 compatibility: the first (primary) use-case pattern
    pattern: useCasePatterns[0],
  }
}

export const MIRROR = Object.freeze(parse())

const meta = (r) => (r?.metadata && typeof r.metadata === 'object' ? r.metadata : {})
const askingPriceRow = (r) =>
  MIRROR.useCasePatterns.some((p) => new RegExp(p, 'i').test(r?.use_case_template || '')) || meta(r).question_kind === MIRROR.questionKind
const at = (r) => Date.parse(r?.sent_at || r?.delivered_at || r?.updated_at || r?.created_at || 0) || 0

/**
 * Apply the trigger to a row about to be inserted.
 * @param {object} newRow
 * @param {object[]} existingRows the thread's send_queue rows
 * @param {{ inbound?: Array<{ thread_key: string, at: string }> }} [ctx] message_events inbound rows (rule c)
 */
export function applyBlockRepeatAskingPrice(newRow, existingRows = [], { inbound = [] } = {}) {
  const row = { ...newRow }
  if (!MIRROR.newStatuses.includes(row.queue_status) || row.thread_key == null) return row
  if (!askingPriceRow(row)) return row
  const prior = existingRows.filter((p) => p.thread_key === row.thread_key && p.id !== row.id && MIRROR.priorStatuses.includes(p.queue_status) && askingPriceRow(p))
  if (!prior.length) return row
  const lastAsk = Math.max(...prior.map(at))
  const m = meta(row)
  const s3 = new RegExp(MIRROR.s3Pattern, 'i').test(row.use_case_template || '') || m.no_response_followup?.kind === MIRROR.s3Kind
  if (s3) {
    if (inbound.some((e) => e.thread_key === row.thread_key && (Date.parse(e.at) || 0) > lastAsk)) {
      row.queue_status = MIRROR.cancelled
      row.paused_reason = MIRROR.pausedSellerReplied
    }
    return row
  }
  const o = m.repeat_ask_override
  if (o && typeof o === 'object' && m.manual_operator_send === true && o.scope === MIRROR.overrideScope && String(o.actor || '').trim() && String(o.reason || '').trim().length >= MIRROR.overrideMinReason && String(o.at || '').trim()) return row
  row.queue_status = MIRROR.cancelled
  row.paused_reason = MIRROR.paused
  return row
}
