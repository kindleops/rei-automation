/**
 * SENDER ROUTING 2.0 — the PROPOSED initial routing graph (owner brief §D.2).
 *
 * STATUS: PROPOSAL. Pending owner approval. Runtime selection NEVER reads this
 * file: the router reads market_sender_routes / sender_pools /
 * sender_pool_numbers from the database (sender-routing-graph.js). This module
 * exists so the dry run, the Sender Coverage surface ("proposed, not enabled")
 * and the seed SQL generator all present the SAME proposal.
 *
 * provenance
 *   owner     a relationship the owner described in the brief (2026-10-02)
 *   proposal  this build's proposal (canonical markets x existing inventory x
 *             lead volume); the owner approves or edits it
 *   confirm   the owner named the relationship loosely ("selected Ohio",
 *             "selected OK"); the market is proposed and needs confirmation
 *
 * Pools are sending hubs. A number belongs to exactly one pool. Members are
 * listed by E.164 and resolved to textgrid_numbers ids when the seed is built.
 * pending_onboarding members (Indianapolis, Tampa) are NOT in textgrid_numbers
 * yet; they join their pool only after the onboarding lifecycle completes.
 */

import { AFFINITY_TIERS as T } from "./sender-routing-policy.js";

export const PROPOSED_GRAPH_VERSION = "proposal-2026-10-02-r2";

export const PROPOSED_POOLS = Object.freeze([
  { pool_key: "minneapolis", display_name: "Minneapolis", home_market_id: "minneapolis-mn", members: ["+16128060495", "+16125092382", "+16125092623"] },
  { pool_key: "dallas", display_name: "Dallas", home_market_id: "dallas-tx", members: ["+14693131600"] },
  { pool_key: "houston", display_name: "Houston", home_market_id: "houston-tx", members: ["+12818458577"] },
  { pool_key: "los_angeles", display_name: "Los Angeles", home_market_id: "los-angeles-ca", members: ["+13234104544", "+13235589881"] },
  { pool_key: "atlanta", display_name: "Atlanta", home_market_id: "atlanta-ga", members: ["+14704920588", "+14702936385", "+14702936402"] },
  { pool_key: "charlotte", display_name: "Charlotte", home_market_id: "charlotte-nc", members: ["+17042405818", "+19804589889"] },
  { pool_key: "jacksonville", display_name: "Jacksonville", home_market_id: "jacksonville-fl", members: ["+19048774448"] },
  // +13057604780 (local-only, absent from the provider) is NOT a member: retirement candidate.
  { pool_key: "miami", display_name: "Miami", home_market_id: "miami-fl", members: ["+17866052999", "+13058975670"] },
  { pool_key: "indianapolis", display_name: "Indianapolis", home_market_id: "indianapolis-in", members: [], pending_onboarding: ["+13173494612"] },
  { pool_key: "tampa", display_name: "Tampa", home_market_id: "tampa-fl", members: [], pending_onboarding: ["+18138947553"] },
]);

const r = (pool_key, tier, provenance, notes = null) => ({ pool_key, tier, provenance, notes });

/**
 * market_id -> ordered routes (array order = priority).
 *
 * REVISION 2 (owner approved the structure, 2026-10-02). Walk order:
 *   thread continuity -> exact/local (primary) -> preferred regional ->
 *   broader approved (regional) -> last-resort hub -> HOLD.
 * The blocklist decides number health; the graph decides geography. Routing
 * never overrides a block (nothing here unblocks anything).
 * "Dayton" is not a canonical market (canonical_markets has no dayton-oh); it
 * routes with whatever canonical market its properties resolve to.
 */
const DALLAS_LAST = r("dallas", T.LAST_RESORT, "owner", "West: Dallas as last resort only");
const IN_LAST_OH = r("indianapolis", T.LAST_RESORT, "owner", "Other Ohio: Indianapolis as a lower-priority fallback");
const CLT_FAR_NE = r("charlotte", T.LAST_RESORT, "owner", "Farther Northeast: weaker last-resort Charlotte, not equal to nearby coverage");

export const PROPOSED_ROUTES = Object.freeze({
  // ── Midwest / Indianapolis hub ──────────────────────────
  "indianapolis-in": [r("indianapolis", T.PRIMARY, "owner", "Indiana first"), r("minneapolis", T.REGIONAL, "proposal")],
  "chicago-il": [r("indianapolis", T.PREFERRED, "owner", "Indianapolis: then Chicago"), r("minneapolis", T.REGIONAL, "owner", "Chicago -> Indianapolis / Minneapolis")],
  "detroit-mi": [r("indianapolis", T.PREFERRED, "owner", "Indianapolis: then Detroit"), r("minneapolis", T.REGIONAL, "proposal")],
  "cincinnati-oh": [r("indianapolis", T.REGIONAL, "owner", "Indianapolis: Cincinnati as regional"), r("minneapolis", T.LAST_RESORT, "proposal")],
  "columbus-oh": [r("indianapolis", T.REGIONAL, "owner", "Indianapolis: Columbus as regional"), r("minneapolis", T.LAST_RESORT, "proposal")],
  "cleveland-oh": [IN_LAST_OH],
  "louisville-ky": [r("indianapolis", T.PREFERRED, "proposal"), r("atlanta", T.REGIONAL, "proposal")],
  "minneapolis-mn": [r("minneapolis", T.PRIMARY, "owner")],
  "milwaukee-wi": [r("minneapolis", T.PREFERRED, "owner", "Minneapolis may serve WI")],
  "des-moines-ia": [r("minneapolis", T.PREFERRED, "owner", "Minneapolis may serve IA")],
  "omaha-ne": [r("minneapolis", T.PREFERRED, "owner", "Minneapolis may serve NE")],
  "st-louis-mo": [r("minneapolis", T.PREFERRED, "owner", "Minneapolis may serve St. Louis"), r("indianapolis", T.REGIONAL, "proposal")],
  "kansas-city-mo": [r("minneapolis", T.PREFERRED, "proposal"), r("dallas", T.REGIONAL, "proposal")],
  "wichita-ks": [r("dallas", T.PREFERRED, "proposal"), r("minneapolis", T.REGIONAL, "proposal")],
  // ── Texas / Oklahoma / Louisiana ────────────────────────
  "dallas-tx": [r("dallas", T.PRIMARY, "owner", "Texas hub"), r("houston", T.PREFERRED, "owner", "Texas hub")],
  "houston-tx": [r("houston", T.PRIMARY, "owner", "Texas hub"), r("dallas", T.PREFERRED, "owner", "Texas hub")],
  "austin-tx": [r("dallas", T.PREFERRED, "owner", "Texas hub"), r("houston", T.REGIONAL, "owner", "Texas hub")],
  "san-antonio-tx": [r("houston", T.PREFERRED, "owner", "Texas hub"), r("dallas", T.REGIONAL, "owner", "Texas hub")],
  "el-paso-tx": [r("dallas", T.PREFERRED, "owner", "Texas hub"), r("houston", T.REGIONAL, "owner", "Texas hub")],
  "oklahoma-city-ok": [r("dallas", T.PREFERRED, "owner", "Dallas covers Oklahoma"), r("houston", T.REGIONAL, "proposal")],
  "tulsa-ok": [r("dallas", T.PREFERRED, "owner", "Dallas covers Oklahoma"), r("houston", T.REGIONAL, "proposal")],
  "new-orleans-la": [r("houston", T.PREFERRED, "proposal"), r("dallas", T.REGIONAL, "proposal")],
  // ── West: LA / western pools first, Dallas LAST RESORT only ──
  "los-angeles-ca": [r("los_angeles", T.PRIMARY, "owner", "West: LA first"), DALLAS_LAST],
  "inland-empire-ca": [r("los_angeles", T.PREFERRED, "owner", "LA serves SoCal"), DALLAS_LAST],
  "san-diego-ca": [r("los_angeles", T.PREFERRED, "owner", "LA serves SoCal"), DALLAS_LAST],
  "bakersfield-ca": [r("los_angeles", T.PREFERRED, "owner", "West: LA first"), DALLAS_LAST],
  "las-vegas-nv": [r("los_angeles", T.PREFERRED, "owner", "LA serves Las Vegas"), DALLAS_LAST],
  "phoenix-az": [r("los_angeles", T.PREFERRED, "owner", "LA serves Phoenix-AZ"), DALLAS_LAST],
  "tucson-az": [r("los_angeles", T.PREFERRED, "owner", "LA serves Phoenix-AZ"), DALLAS_LAST],
  "fresno-ca": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "modesto-ca": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "stockton-ca": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "sacramento-ca": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "boise-id": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "salt-lake-city-ut": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "spokane-wa": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "seattle-wa": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "albuquerque-nm": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  "colorado-springs-co": [r("los_angeles", T.REGIONAL, "owner", "West: LA first"), DALLAS_LAST],
  // ── Southeast ───────────────────────────────────────────
  "atlanta-ga": [r("atlanta", T.PRIMARY, "proposal"), r("charlotte", T.REGIONAL, "proposal")],
  "birmingham-al": [r("atlanta", T.PREFERRED, "owner", "Birmingham -> Atlanta / Southeast"), r("charlotte", T.REGIONAL, "owner", "Birmingham -> Atlanta / Southeast")],
  "memphis-tn": [r("atlanta", T.PREFERRED, "proposal"), r("dallas", T.REGIONAL, "proposal")],
  // ── Charlotte, tiered: Carolinas + Virginia strong; farther Northeast weak ──
  "charlotte-nc": [r("charlotte", T.PRIMARY, "owner", "Charlotte"), r("atlanta", T.REGIONAL, "proposal")],
  "durham-nc": [r("charlotte", T.PREFERRED, "owner", "Carolinas: strong regional"), r("atlanta", T.REGIONAL, "proposal")],
  "fayetteville-nc": [r("charlotte", T.PREFERRED, "owner", "Carolinas: strong regional"), r("atlanta", T.REGIONAL, "proposal")],
  "rocky-mount-nc": [r("charlotte", T.PREFERRED, "owner", "Carolinas: strong regional"), r("atlanta", T.REGIONAL, "proposal")],
  "richmond-va": [r("charlotte", T.PREFERRED, "owner", "Virginia: strong regional")],
  "hampton-roads-va": [r("charlotte", T.PREFERRED, "owner", "Virginia: strong regional")],
  "baltimore-md": [r("charlotte", T.REGIONAL, "proposal", "Mid-Atlantic: broader than Carolinas/Virginia")],
  "philadelphia-pa": [CLT_FAR_NE],
  "pittsburgh-pa": [CLT_FAR_NE],
  "hartford-ct": [CLT_FAR_NE],
  "providence-ri": [CLT_FAR_NE],
  "rochester-ny": [CLT_FAR_NE],
  // ── Florida ─────────────────────────────────────────────
  "miami-fl": [r("miami", T.PRIMARY, "proposal"), r("tampa", T.PREFERRED, "proposal"), r("jacksonville", T.REGIONAL, "proposal")],
  "tampa-fl": [r("tampa", T.PRIMARY, "proposal"), r("miami", T.PREFERRED, "proposal"), r("jacksonville", T.REGIONAL, "proposal")],
  "orlando-fl": [r("tampa", T.PREFERRED, "proposal"), r("jacksonville", T.REGIONAL, "proposal"), r("miami", T.REGIONAL, "proposal")],
  "jacksonville-fl": [r("jacksonville", T.PRIMARY, "proposal"), r("tampa", T.PREFERRED, "proposal"), r("miami", T.REGIONAL, "proposal")],
});

/**
 * Raw graph rows (buildRoutingGraph input) for the proposal, resolved against
 * the live fleet. includePending=true models the post-onboarding world: the
 * Indianapolis/Tampa numbers join their pools (they still have to pass every
 * eligibility gate, so the caller supplies an onboarded fleet row for them).
 */
export function proposedGraphRows({ markets = [], fleet = [], includePending = false } = {}) {
  const idByPhone = new Map((fleet || []).map((row) => [String(row.phone_number), row.id]));
  const pools = PROPOSED_POOLS.map((p) => ({ pool_key: p.pool_key, display_name: p.display_name, home_market_id: p.home_market_id, is_active: true }));
  const pool_numbers = [];
  for (const p of PROPOSED_POOLS) {
    const phones = [...p.members, ...(includePending ? p.pending_onboarding || [] : [])];
    for (const phone of phones) pool_numbers.push({ pool_key: p.pool_key, phone_number: phone, textgrid_number_id: idByPhone.get(phone) || null, status: "active" });
  }
  const routes = [];
  for (const [market_id, list] of Object.entries(PROPOSED_ROUTES)) {
    list.forEach((route, i) => routes.push({ market_id, pool_key: route.pool_key, priority: (i + 1) * 10, affinity_tier: route.tier, enabled: true, provenance: route.provenance, notes: route.notes }));
  }
  return { markets, pools, pool_numbers, routes, version: PROPOSED_GRAPH_VERSION, source: includePending ? "proposal+onboarded" : "proposal" };
}

/**
 * The evidence backfill the PROPOSED seed (20261002130100) writes, frozen from
 * the 2026-10-02 reconciliation (TextGrid API GET + inbound message history).
 * The Sender Coverage surface applies it IN MEMORY in proposal mode so the
 * owner reviews the graph as it would behave once seeded; nothing is written.
 */
export const PROPOSED_SEED_BACKFILL = Object.freeze([
  { phone: "+12818458577", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+13058975670", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+13234104544", registration_status: "registered", sms_webhook_status: "configured" },
  { phone: "+13235589881", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+14693131600", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+14702936385", registration_status: null, sms_webhook_status: "configured" },
  { phone: "+14702936402", registration_status: null, sms_webhook_status: "configured" },
  { phone: "+14704920588", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+16125092382", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+16125092623", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+16128060495", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+17042405818", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+17866052999", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+19048774448", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+19804589889", registration_status: "registered", sms_webhook_status: "verified" },
]);
