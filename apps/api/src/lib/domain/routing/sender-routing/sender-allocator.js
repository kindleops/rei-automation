/**
 * THE EXISTING SENDER ALLOCATOR — moved here unchanged so the campaign router
 * (supabase-candidate-feeder chooseTextgridNumber) and Sender Routing 2.0
 * (sender-routing-policy) rank numbers with ONE comparator.
 *
 * Least true sends today first (messages_sent_today, derived from the send
 * ledger by sender-sent-today.js), then least recently used. Sender Routing 2.0
 * applies it only WITHIN a pool: geography decides which pool, this decides
 * which number in it. It is not a new picker.
 *
 * Import-pure: no I/O, no project imports.
 */

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function byUsageThenRecency(left, right) {
  const left_sent = asNumber(left.messages_sent_today, 0);
  const right_sent = asNumber(right.messages_sent_today, 0);
  if (left_sent !== right_sent) return left_sent - right_sent;

  const left_ts = left.last_used_at ? new Date(left.last_used_at).getTime() : 0;
  const right_ts = right.last_used_at ? new Date(right.last_used_at).getTime() : 0;
  return left_ts - right_ts;
}

export default byUsageThenRecency;
