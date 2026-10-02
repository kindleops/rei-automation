/**
 * SENDER SELECTION FOR A CLEANUP REPLY — the campaign router's selection, with
 * the runner's own sender guard as the final word.
 *
 * INCIDENT 2026-10-02 20:16Z. The re-queued replies called
 * chooseTextgridNumber WITHOUT the operator blocklist. The router then treats
 * every active number as eligible, a blocked number never sends so it has the
 * lowest usage, and byUsageThenRecency picks it (the Miami 09-30 failure mode
 * the campaign path already fixed). 15 of 16 rows were refused at send time:
 * blocked_by_health_guard / blocked_sender_number.
 *
 * Now, exactly like campaign-automation-service:
 *   1. read the guard's OWN system_control (sms_blocked_sender_numbers,
 *      require_local_routing, allow_regional_fallback_for_first_touch);
 *      unreadable -> NO sender (fail closed; the campaign path may proceed on
 *      an empty set because dispatch re-checks, a repair holds instead);
 *   2. chooseTextgridNumber with blocked_sender_numbers: status, health,
 *      cooling, daily cap, market / regional routing, operator block;
 *   3. evaluateSmsHealthGuard on the chosen number, tier and template, with
 *      the same inputs the runner passes at send time. Refused -> no sender.
 * Nothing on a plan can pin a number.
 */
import {
  evaluateSmsHealthGuard,
  getDispatchBlockedSets,
  loadSmsHealthGuardSystemControl,
} from "@/lib/domain/delivery/sms-health-guard.js";

const clean = (v) => String(v ?? "").trim();

const noSender = (routing_block_reason, extra = {}) => ({
  routing_allowed: false,
  phone_number: null,
  item_id: null,
  selection_reason: null,
  routing_tier: null,
  routing_block_reason,
  ...extra,
});

/**
 * @param {object} args  { market, state, template_id }
 * @param {object} deps  { chooseTextgridNumber(candidate, options, deps), getSystemValue(key), supabase, env }
 */
export async function selectCleanupReplySender({ market = null, state = null, template_id = null } = {}, deps = {}) {
  const env = deps.env || process.env;
  let system_control;
  try {
    system_control = await loadSmsHealthGuardSystemControl(deps.getSystemValue);
  } catch {
    return noSender("sender_blocklist_unreadable");
  }
  if (!system_control || system_control.sms_blocked_sender_numbers === undefined) {
    return noSender("sender_blocklist_unreadable");
  }
  const blocked = getDispatchBlockedSets(env, system_control).sender_numbers;

  let r;
  try {
    r = await deps.chooseTextgridNumber(
      { market, state, touch_number: 2, is_first_touch: false },
      { first_touch: false, blocked_sender_numbers: blocked },
      { supabase: deps.supabase, ...(Array.isArray(deps.textgridNumberRows) ? { textgridNumberRows: deps.textgridNumberRows } : {}) }
    );
  } catch {
    return noSender("sender_engine_unavailable");
  }
  const phone_number = clean(r?.selected_textgrid_number || r?.selected?.phone_number);
  if (!(r?.ok === true && r?.routing_allowed !== false && phone_number)) {
    return noSender(r?.routing_block_reason || r?.reason_code || "no_eligible_sender", {
      local_sender_inventory: r?.local_sender_inventory || null,
    });
  }

  const guard = evaluateSmsHealthGuard({
    from_phone_number: phone_number,
    template_id,
    routing_tier: r.routing_tier || null,
    first_touch: false,
    env,
    system_control,
  });
  if (!guard.allowed) return noSender(guard.reason, { rejected_sender: phone_number });

  return {
    routing_allowed: true,
    phone_number,
    item_id: r?.selected?.id || null,
    selection_reason: r?.selection_reason || null,
    routing_tier: r?.routing_tier || null,
    selected_market: r?.selected_textgrid_market || null,
    routing_block_reason: null,
    health_guard: guard.reason,
  };
}
