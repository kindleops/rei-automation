// Usage: node apps/api/scripts/ops/campaign-property-touch-shadow-report.mjs <out.json>   (reads /tmp/.dburl)
// READ-ONLY shadow report for CAMPAIGN_PROPERTY_TOUCH_HOLD over current/scheduled
// campaign targets (planned + ready openers). No writes. Batched, 30s timeout.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/Users/ryankindle/rei-automation/package.json");
const pg = require("pg");
const c = new pg.Client({ connectionString: readFileSync("/tmp/.dburl", "utf8").trim() });
await c.connect();
await c.query("set statement_timeout='30s'; set default_transaction_read_only=on;");
const d10 = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
const PERSON_KEY = /^pros\d+_[0-9a-f]+$/i;
const ENTITY = /\b(llc|l\.l\.c|inc|corp|corporation|company|holdings|properties|trust|estate|lp|llp|partners|partnership|ventures|investments|group|realty|management|ltd)\b/i;

const { rows: targets } = await c.query(`select id, campaign_name, market, property_id::text as property_id, to_phone_number, prospect_id, master_owner_id::text as master_owner_id, owner_name, target_status
  from campaign_targets where target_status in ('planned','ready') and coalesce(touch_number,1) <= 1 and property_id is not null`);
const pids = [...new Set(targets.map((t) => t.property_id))];
const prior = new Map();
for (let i = 0; i < pids.length; i += 500) {
  const { rows } = await c.query(`select property_id::text as property_id, to_phone_number, prospect_id, master_owner_id::text as master_owner_id, queue_status
    from send_queue where property_id::text = any($1) and (sent_at is not null or queue_status in ('sent','delivered','queued','scheduled','sending','processing'))`, [pids.slice(i, i + 500)]);
  for (const r of rows) (prior.get(r.property_id) || prior.set(r.property_id, []).get(r.property_id)).push(r);
}
const keys = new Set();
for (const t of targets) if (t.prospect_id) keys.add(t.prospect_id);
for (const list of prior.values()) for (const r of list) if (PERSON_KEY.test(r.prospect_id || "")) keys.add(r.prospect_id);
const pros = new Map();
const kl = [...keys];
for (let i = 0; i < kl.length; i += 1000) {
  const { rows } = await c.query(`select prospect_id, master_owner_id::text as master_owner_id, matching_flags, best_phone, owner_type_guess, likely_owner, likely_renting from prospects where prospect_id = any($1)`, [kl.slice(i, i + 1000)]);
  for (const r of rows) pros.set(r.prospect_id, r);
}
await c.end();

const cats = { not_touched: 0, phone_already_texted: 0, same_person_new_number: 0, ambiguous_identity: 0, entity_principal: 0, spouse_co_owner: 0, confidently_different_person: 0, different_key_phone_unproven: 0 };
const ex = Object.fromEntries(Object.keys(cats).map((k) => [k, []]));
for (const t of targets) {
  const E = d10(t.to_phone_number);
  const rows = prior.get(t.property_id) || [];
  let cat;
  if (!rows.length) cat = "not_touched";
  else if (rows.some((r) => d10(r.to_phone_number) === E)) cat = "phone_already_texted";
  else {
    const priorKeys = rows.map((r) => r.prospect_id).filter((k) => PERSON_KEY.test(k || ""));
    const unknown = rows.some((r) => !PERSON_KEY.test(r.prospect_id || ""));
    const tp = pros.get(t.prospect_id) || null;
    const flags = String(tp?.matching_flags || "");
    const sameHousehold = priorKeys.some((k) => pros.get(k)?.master_owner_id && pros.get(k)?.master_owner_id === (tp?.master_owner_id || t.master_owner_id));
    if (t.prospect_id && priorKeys.includes(t.prospect_id)) cat = "same_person_new_number";
    else if (!t.prospect_id || unknown || !priorKeys.length) cat = "ambiguous_identity";
    else if (ENTITY.test(t.owner_name || "") || /entity|company|corporate/i.test(tp?.owner_type_guess || "")) cat = "entity_principal";
    else if (/family|spouse|relative|household/i.test(flags) || sameHousehold) cat = "spouse_co_owner";
    else if (d10(tp?.best_phone) === E) cat = "confidently_different_person";
    else cat = "different_key_phone_unproven";
  }
  cats[cat]++;
  if (ex[cat].length < 4) ex[cat].push({ campaign: t.campaign_name, market: t.market, status: t.target_status, prior_sends_about_property: rows.length, tags: pros.get(t.prospect_id)?.matching_flags || null, owner_is_entity: ENTITY.test(t.owner_name || "") });
}
const touched_other_phone = cats.same_person_new_number + cats.ambiguous_identity + cats.entity_principal + cats.spouse_co_owner + cats.confidently_different_person + cats.different_key_phone_unproven;
const out = { generated_at: new Date().toISOString(), population: "campaign_targets planned+ready, touch_number<=1", targets: targets.length, categories: cats,
  would_hold: touched_other_phone - cats.confidently_different_person, would_release_if_phone_proof: cats.confidently_different_person, examples: ex };
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(JSON.stringify({ targets: out.targets, would_hold: out.would_hold, ...cats }));
