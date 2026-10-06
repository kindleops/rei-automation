// READ-ONLY: writes MATRIX.csv + MATRIX_GAPS.txt (intent × stage × 16 languages coverage) to the job tmp dir.
// Usage (from apps/api): nice -n 15 node --import ./scripts/register-aliases-ops.mjs scripts/ops/seller-autopilot-v2-gen-matrix.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { V2_MATRIX, V2_INTENTS } from "../../src/lib/domain/seller-flow/seller-autopilot-v2.js";
import { V2_LANGS, proposedTemplateRows } from "./seller-autopilot-v2-templates.proposed.mjs";
const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: readFileSync("/tmp/.dburl", "utf8").trim(), ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL statement_timeout='30s'");
const { rows } = await client.query(`select use_case, language,
  count(*) filter (where is_active and safe_for_auto_reply and coalesce(reply_mode,'auto') in ('auto','auto_reply','')) safe,
  count(*) filter (where is_active) active from sms_templates group by 1,2`);
await client.query("ROLLBACK"); await client.end();
const cov = new Map(rows.map((r) => [`${r.use_case}|${r.language}`, r]));
const proposed = new Set(proposedTemplateRows().map((r) => `${r.use_case}|${r.language}`));
const status = (uc, lang) => {
  const r = cov.get(`${uc}|${lang}`);
  if (r && Number(r.safe) > 0) return "SAFE";
  if (proposed.has(`${uc}|${lang}`)) return r && Number(r.active) > 0 ? "UNSAFE+PROPOSED" : "PROPOSED";
  if (r && Number(r.active) > 0) return "ACTIVE_NOT_SAFE";
  return "MISSING";
};
const SAFE_FLAG = new Set(["consider_selling", "seller_asking_price", "price_works_confirm_basics", "price_high_condition_probe"]);
const RESP = {
  consider_selling: "ask S2: open to a proposal?", seller_asking_price: "ask S3: price in mind?",
  price_works_confirm_basics: "accept path: that should work — vacant or occupied?", price_high_condition_probe: "price above range: condition?",
  no_price_condition_probe: "no worries, I'll run numbers — condition?", ask_condition_clarifier: "(fallback) condition clarifier",
  as_is_comp_anchor: "anchor: as-is sales nearby ~$X (X=lowest nearby as-is comp ≤ MAO)", as_is_offer_anchor: "anchor (capped): I'd be around $X=MAO",
  who_is_this_resume_ownership: "identity + re-ask ownership", who_is_this: "identity + ask S2", who_is_this_resume_price: "identity + re-ask price",
  who_is_this_resume_condition: "identity + re-ask condition", capital_gains_creative_probe: "creative: seller financing / lease option",
};
const LANG = V2_LANGS.map(([l]) => l);
const lines = [["intent", "stage", "action", "response", "template_use_cases", ...LANG, "notes"].join(",")];
const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
for (const [intent, cells] of Object.entries(V2_MATRIX)) {
  for (const stage of ["S1", "S2", "S3", "S4"]) {
    const cell = cells[stage];
    let ucs = [], action = "reply", resp = "", notes = "";
    if (cell === "defer") { action = "defer (existing pipeline)"; resp = "existing route"; }
    else if (cell === "price") { ucs = ["price_works_confirm_basics", "price_high_condition_probe"]; resp = "asking ≤ MAO → confirm basics; > MAO → condition probe"; notes = "SFR + authoritative offer: compare. Offer missing/not authoritative/stale → number-free condition probe (hold binds at the anchor). Multifamily / implausible ask → human review"; }
    else if (cell === "anchor") { ucs = ["as_is_comp_anchor", "as_is_offer_anchor"]; resp = "anchor X (or confirm basics if known ask ≤ MAO)"; notes = "SFR + authoritative offer + ≥3 nearby as-is comps; else human review"; }
    else { ucs = cell; resp = cell.map((u) => RESP[u] || u).join(" | fallback: "); }
    const per = LANG.map((l) => (ucs.length ? ucs.map((u) => status(u, l)).join("/") : "n/a"));
    lines.push([intent, stage, action, q(resp), q(ucs.join(" > ")), ...per, q(notes)].join(","));
  }
}
const DEFER = [
  ["opt_out", "suppress + cancel queued (unchanged)", ""], ["wrong_number", "suppress (unchanged)", ""], ["hostile_legal", "human review (unchanged)", ""],
  ["not_interested", "no reply; 30-day nurture follow-up (owner rule)", "nurture_not_interested"], ["not_now", "future_nurture ack + later follow-up (existing)", "future_nurture"],
  ["referral", "referral automation / review (existing)", ""], ["sold_former_owner", "property_sold disposition, review (existing)", ""],
  ["trust_executor", "legal-authority human lane (existing)", ""], ["non_owner", "property-relationship review (existing)", ""],
  ["entity_or_legal", "llc/title/lien/bankruptcy human lane (existing)", ""], ["callback", "text-only redirect (existing)", "text_only_redirect"],
  ["listed", "already_listed / off-market (existing review)", "already_listed"], ["language_switch", "same stage, requested language (existing)", ""],
  ["acknowledgement", "no reply at S1/S3; 'ok' at S2 = yes → price question; at S4 = condition answer → anchor", ""],
  ["unclear", "existing safe clarifier (English only) or human review", ""], ["reaction", "no reply (tapback)", ""],
];
for (const [intent, resp, uc] of DEFER) {
  const per = LANG.map((l) => (uc ? status(uc, l) : "n/a"));
  lines.push([intent, "S1-S4", "defer (existing pipeline)", q(resp), q(uc), ...per, q("compliance/relationship lane — v2 never answers it")].join(","));
}
writeFileSync("/Users/ryankindle/.claude/jobs/c39b0175/tmp/autopilot-v2/MATRIX.csv", lines.join("\n") + "\n");
// gaps
const gaps = [];
const usecases = [...new Set(Object.values(V2_MATRIX).flatMap((c) => Object.values(c)).flatMap((c) => (Array.isArray(c) ? c : c === "price" ? ["price_works_confirm_basics", "price_high_condition_probe"] : c === "anchor" ? ["as_is_comp_anchor", "as_is_offer_anchor"] : [])))];
for (const uc of usecases) {
  const st = Object.fromEntries(LANG.map((l) => [l, status(uc, l)]));
  const bad = LANG.filter((l) => st[l] !== "SAFE");
  gaps.push(`${uc.padEnd(32)} SAFE today in: ${LANG.filter((l) => st[l] === "SAFE").join(", ") || "none"}\n${" ".repeat(33)}gap: ${bad.map((l) => `${l}=${st[l]}`).join(", ") || "none"}`);
}
writeFileSync("/Users/ryankindle/.claude/jobs/c39b0175/tmp/autopilot-v2/MATRIX_GAPS.txt", `MATRIX GAPS (use case × 16 languages; SAFE = active + safe_for_auto_reply + auto reply_mode today)\nPROPOSED = row in PROPOSED_20261006090000 (inactive); ACTIVE_NOT_SAFE = exists but not safe/manual (see PROPOSED_20261006090100 safe-flag list for ${[...SAFE_FLAG].join(", ")})\n\n${gaps.join("\n")}\n`);
console.log("ok", lines.length);
