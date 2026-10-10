// Spend guard (Gate B): per-user and global DAILY caps in USD and tokens.
//
// Default $0 / 0 tokens everywhere — production included — until the owner
// sets them. Nothing is spent in S3 (Quick Scan is structurally $0, the model
// gateway refuses every call, the Postgres store refuses ledger writes); this
// guard is the next independent lock for when a paid operation exists.
//
// Env (owner-set; invalid or negative ⇒ 0, i.e. fail closed):
//   AGENT_SPEND_USER_DAILY_USD     per verified user, per UTC day
//   AGENT_SPEND_GLOBAL_DAILY_USD   whole org, per UTC day
//   AGENT_TOKENS_USER_DAILY        per verified user, per UTC day (input + output)
//   AGENT_TOKENS_GLOBAL_DAILY      whole org, per UTC day
// Hard ceilings (code; a higher env value is clamped DOWN, never honoured):
//   global ≤ $50/day (owner org cap O6), user ≤ global, tokens ≤ 100M/day.
// The proposed ≤ $10 eval allowance (D5) is NOT configured here: it needs a
// separate owner execution GO and is set, if ever, through these same vars.
//
// Rules (checkSpend):
//   * an op with no cost and no tokens always passes (structural $0)
//   * any billable op needs a VERIFIED named actor (SPEND_ACTOR_REQUIRED) —
//     no shared or service identity can spend
//   * worst case + committed today must fit EVERY cap; the tightest binds
import { round6 } from './budget-config.js'

export const SPEND_HARD_CEILINGS = Object.freeze({ global_day_usd: 50, user_day_usd: 50, global_day_tokens: 100_000_000, user_day_tokens: 100_000_000 })

export const SPEND_ENV = Object.freeze({
  user_day_usd: 'AGENT_SPEND_USER_DAILY_USD',
  global_day_usd: 'AGENT_SPEND_GLOBAL_DAILY_USD',
  user_day_tokens: 'AGENT_TOKENS_USER_DAILY',
  global_day_tokens: 'AGENT_TOKENS_GLOBAL_DAILY',
})

function amount(raw, max) {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, max)
}

/** @returns {Readonly<{ user_day_usd: number, global_day_usd: number, user_day_tokens: number, global_day_tokens: number }>} */
export function resolveSpendCaps(env = process.env) {
  const global_day_usd = round6(amount(env?.[SPEND_ENV.global_day_usd], SPEND_HARD_CEILINGS.global_day_usd))
  const global_day_tokens = Math.floor(amount(env?.[SPEND_ENV.global_day_tokens], SPEND_HARD_CEILINGS.global_day_tokens))
  return Object.freeze({
    user_day_usd: round6(Math.min(amount(env?.[SPEND_ENV.user_day_usd], SPEND_HARD_CEILINGS.user_day_usd), global_day_usd)),
    global_day_usd,
    user_day_tokens: Math.floor(Math.min(amount(env?.[SPEND_ENV.user_day_tokens], SPEND_HARD_CEILINGS.user_day_tokens), global_day_tokens)),
    global_day_tokens,
  })
}

export const ZERO_SPEND_CAPS = Object.freeze({ user_day_usd: 0, global_day_usd: 0, user_day_tokens: 0, global_day_tokens: 0 })

const SETTLED = new Set(['settle', 'sweep_settle', 'late_settle'])

function opTokens(op) {
  return Math.max(0, Number(op?.max_input_tokens || 0)) + Math.max(0, Number(op?.max_tokens || 0))
}

/**
 * Committed spend for a UTC day from ledger rows: a reserve counts at its
 * settled value once settled, else at its worst case (never under-records).
 * @returns {{ user_usd: number, global_usd: number, user_tokens: number, global_tokens: number }}
 */
export function spendUsage(ledgerRows, { user_id, day }) {
  const settled = new Map()
  for (const r of ledgerRows) if (SETTLED.has(r.kind) && r.reserve_id != null) settled.set(r.reserve_id, r)
  let user_usd = 0
  let global_usd = 0
  let user_tokens = 0
  let global_tokens = 0
  for (const r of ledgerRows) {
    if (String(r.at || '').slice(0, 10) !== day) continue
    let usd = 0
    let tokens = 0
    if (r.kind === 'reserve') {
      const s = settled.get(r.id)
      usd = s ? Number(s.cost_usd) : Number(r.cost_usd)
      tokens = s?.tokens ? Number(s.tokens.input || 0) + Number(s.tokens.output || 0) : opTokens(r.op)
    } else if (r.kind === 'reconcile' && Number(r.cost_usd) > 0) {
      usd = Number(r.cost_usd)
    } else continue
    global_usd += usd
    global_tokens += tokens
    if (user_id && r.operator_id === user_id) {
      user_usd += usd
      user_tokens += tokens
    }
  }
  return { user_usd: round6(user_usd), global_usd: round6(global_usd), user_tokens, global_tokens }
}

/**
 * @param {{ caps: ReturnType<typeof resolveSpendCaps>, actor: { user_id: string|null, verified: boolean }, worst_usd: number, worst_tokens?: number, usage: ReturnType<typeof spendUsage> }} input
 * @returns {{ ok: true, structural_zero?: boolean } | { ok: false, code: string, binding_cap: string, limit: number, committed: number, worst: number }}
 */
export function checkSpend({ caps, actor, worst_usd, worst_tokens = 0, usage }) {
  const usd = Math.max(0, Number(worst_usd) || 0)
  const tok = Math.max(0, Number(worst_tokens) || 0)
  if (usd === 0 && tok === 0) return { ok: true, structural_zero: true }
  if (!actor?.user_id || actor.verified !== true) return { ok: false, code: 'SPEND_ACTOR_REQUIRED', binding_cap: 'verified_actor', limit: 0, committed: 0, worst: usd }
  const rows = [
    { code: 'SPEND_CAP_USER_DAY', binding_cap: 'user_day_usd', limit: caps.user_day_usd, committed: usage.user_usd, worst: usd },
    { code: 'SPEND_CAP_GLOBAL_DAY', binding_cap: 'global_day_usd', limit: caps.global_day_usd, committed: usage.global_usd, worst: usd },
    { code: 'TOKEN_CAP_USER_DAY', binding_cap: 'user_day_tokens', limit: caps.user_day_tokens, committed: usage.user_tokens, worst: tok },
    { code: 'TOKEN_CAP_GLOBAL_DAY', binding_cap: 'global_day_tokens', limit: caps.global_day_tokens, committed: usage.global_tokens, worst: tok },
  ]
  for (const r of rows) {
    if (r.worst === 0) continue
    if (round6(r.committed + r.worst) > r.limit) return { ok: false, ...r }
  }
  return { ok: true }
}
