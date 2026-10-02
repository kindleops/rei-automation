/**
 * Scheduling core — routing. Pure.
 *
 * Routing is configuration on the event type, never a frontend decision:
 *
 *   strategy           who is eligible
 *   ─────────────────  ─────────────────────────────────────────────────────
 *   specific_owner     the owner a domain adapter resolves (e.g. the
 *                      opportunity's assigned operator); with
 *                      owner_unavailable = "next_available_owner" only the
 *                      owner is offered (their next free times), with
 *                      "route_to_pool" the pool is offered too and the owner is
 *                      preferred whenever both are free.
 *   round_robin        the pool; each booking goes to the free member who was
 *                      assigned least recently.
 *   qualified_pool     the pool; each booking goes to the free member with the
 *                      fewest upcoming appointments.
 *   fallback_pool      (any strategy) used only when the primary tier has no
 *                      time at all in the requested window.
 *
 * Nothing here invents an assignment: if the owner is not a configured
 * resource and no pool is configured, there is simply no availability.
 */

export const ROUTING_STRATEGIES = ['specific_owner', 'round_robin', 'qualified_pool'];

/**
 * @returns {{ tiers: Array<{ via: string, resourceIds: string[] }>, owner: string|null }}
 */
export function planRouting({ routing = {}, ownerResourceId = null, pools = {} }) {
  const strategy = ROUTING_STRATEGIES.includes(routing.strategy) ? routing.strategy : 'qualified_pool';
  const pool = (pools[routing.pool] || []).slice();
  const fallback = (pools[routing.fallback_pool] || []).slice();
  const tiers = [];

  if (strategy === 'specific_owner') {
    if (ownerResourceId) {
      if (routing.owner_unavailable === 'route_to_pool') {
        tiers.push({ via: 'specific_owner_or_pool', resourceIds: [ownerResourceId, ...pool.filter((id) => id !== ownerResourceId)] });
      } else {
        tiers.push({ via: 'specific_owner', resourceIds: [ownerResourceId] });
      }
    } else if (pool.length) {
      tiers.push({ via: 'owner_missing_pool', resourceIds: pool });
    }
  } else if (pool.length) {
    tiers.push({ via: strategy, resourceIds: pool });
  }
  if (fallback.length) tiers.push({ via: 'fallback_pool', resourceIds: fallback });
  return { tiers, owner: ownerResourceId, strategy };
}

/**
 * Picks who takes a booking at a slot, among the resources free then.
 * `stats` per resource: { lastAssignedAt (ms|null), upcoming (count) }.
 * Returns the free resources in preference order (callers try them in turn,
 * so a concurrent loss falls through to the next eligible person).
 */
export function rankForSlot({ strategy, via, ownerResourceId, freeIds, stats = {} }) {
  const ids = [...new Set(freeIds)];
  const byRecency = (a, b) => ((stats[a]?.lastAssignedAt ?? 0) - (stats[b]?.lastAssignedAt ?? 0)) || String(a).localeCompare(String(b));
  const byLoad = (a, b) => ((stats[a]?.upcoming ?? 0) - (stats[b]?.upcoming ?? 0)) || byRecency(a, b);
  const ordered = ids.sort(strategy === 'round_robin' ? byRecency : byLoad);
  if (ownerResourceId && ordered.includes(ownerResourceId) && via !== 'fallback_pool') {
    return [ownerResourceId, ...ordered.filter((id) => id !== ownerResourceId)];
  }
  return ordered;
}
