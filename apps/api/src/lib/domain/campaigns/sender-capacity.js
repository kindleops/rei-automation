/**
 * PER-SENDER DAILY CAPACITY — one config value, not a literal in code.
 *
 * system_control.queue_per_number_cap is the operator's per-number daily limit
 * (the same value the queue processor enforces). A campaign's per_sender_cap is
 * an optional OVERRIDE; absent, the config governs. There is deliberately no
 * numeric fallback here: an unreadable config means "no campaign-level cap",
 * and the processor's own per-number rail plus each number's daily_limit still
 * bound the send. (2026-09-28: a hardcoded 150 default — "we do not do 150 per
 * number" — held Minneapolis to 150/number/day.)
 */
import { getSystemValue } from '@/lib/system-control.js'

export const PER_SENDER_CAP_CONFIG_KEY = 'queue_per_number_cap'

const positiveInt = (value) => {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function loadConfiguredPerSenderCap(deps = {}) {
  try {
    const read = deps.getSystemValue || getSystemValue
    return positiveInt(await read(PER_SENDER_CAP_CONFIG_KEY, deps.supabase ? { supabase: deps.supabase } : undefined))
  } catch {
    return null
  }
}

/** Campaign/input override first, then the configured default. */
export function effectivePerSenderCap({ input = {}, campaign = {}, configured = null } = {}) {
  return positiveInt(input.per_sender_cap ?? input.perSenderCap) ?? positiveInt(campaign.per_sender_cap) ?? positiveInt(configured)
}
