// Template catalogs for the SELLER CONVERSATION v3 replay. Pure file reads.
//   prodSafe       — the prod active + safe EN/ES snapshot (round-8 fixture)
//   draftRows()    — every PROPOSED draft row, tagged by source:
//                    v2 autopilot (PROPOSED_20261006090000), price reality check
//                    (…150200), frustration apology (…230000), native-script core
//                    (…235900), v3 new (PROPOSED_20261007030000 source)
//   catalogFor(scenario) — "en_es": prod safe + EN/ES drafts; "all": + every language
import { readFileSync } from "node:fs";
import { proposedTemplateRows } from "../../scripts/ops/seller-autopilot-v2-templates.proposed.mjs";
import { proposedV3TemplateRows } from "../../scripts/ops/seller-conversation-v3-templates.proposed.mjs";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const read = (name) => readFileSync(new URL(name, MIGRATIONS), "utf8");
const unq = (s) => s.replace(/''/g, "'");

const PROD_SAFE_SNAPSHOT = JSON.parse(
  readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8"),
).rows;

// Prod active + safe rows the round-8 snapshot did not carry (read-only fetch 2026-10-07).
const PROD_SAFE_EXTRA = [
  { template_id: "lc-text-only-redirect-en-1", use_case: "text_only_redirect", language: "English", stage_code: "SP", reply_mode: "auto", property_type_scope: "Any Residential", is_active: true, safe_for_auto_reply: true, template_body: "Sorry I missed you, texting is the fastest way to reach me. Did you have an asking price in mind for the property?" },
  { template_id: "lc-text-only-redirect-es-1", use_case: "text_only_redirect", language: "Spanish", stage_code: "SP", reply_mode: "auto", property_type_scope: "Any Residential", is_active: true, safe_for_auto_reply: true, template_body: "Disculpe que no le contesté, es más fácil para mí por mensaje. ¿Tenía un precio en mente para la propiedad?" },
].map((r) => ({ ...r, id: r.template_id }));

const row = (use_case, template_id, language, template_body, source) => ({
  id: template_id, template_id, use_case, language, template_body, source,
  stage_code: null, is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply",
});

function parseRealityCheck() {
  const sql = read("PROPOSED_20261006150200_price_reality_check_templates.sql");
  const re = /\('(lc-price-reality-check-[a-z]+-\d)',\s*'(?:[^']|'')*',\s*'([^']+)',\s*\d+,\s*'((?:[^']|'')*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) out.push(row("price_reality_check", m[1], m[2], unq(m[3]), "PROPOSED_20261006150200"));
  return out;
}
function parseApology() {
  const sql = read("PROPOSED_20261006230000_seller_frustration_apology_templates.sql");
  const re = /\('(lc-seller-frustration-apology-[a-z]+-\d)',\s*'(?:[^']|'')*',\s*'([^']+)',\s*'((?:[^']|'')*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) out.push(row("seller_frustration_apology", m[1], m[2], unq(m[3]), "PROPOSED_20261006230000"));
  return out;
}
function parseNative() {
  const sql = read("PROPOSED_20261006235900_native_script_core_templates.sql");
  const re = /\('([a-z_]+)',\s*'(lc-native-[^']+)',\s*'(?:[^']|'')*',\s*'([^']+)',\s*'((?:[^']|'')*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) out.push(row(m[1], m[2], m[3], unq(m[4]), "PROPOSED_20261006235900"));
  return out;
}

export const PROD_SAFE = [...PROD_SAFE_SNAPSHOT, ...PROD_SAFE_EXTRA];

let cache = null;
export function draftRows() {
  if (cache) return cache;
  cache = [
    ...proposedTemplateRows().map((r) => row(r.use_case, r.template_id, r.language, r.template_body, "PROPOSED_20261006090000")),
    ...parseRealityCheck(),
    ...parseApology(),
    ...parseNative(),
    ...proposedV3TemplateRows().map((r) => row(r.use_case, r.template_id, r.language, r.template_body, "PROPOSED_20261007030000")),
  ];
  return cache;
}

const EN_ES = new Set(["English", "Spanish"]);
export function catalogFor(scenario = "en_es") {
  const drafts = draftRows().filter((r) => scenario === "all" || EN_ES.has(r.language));
  return [...PROD_SAFE.map((r) => ({ ...r, source: "prod_active_safe" })), ...drafts];
}

export const ALL_LANGUAGES_SWITCH =
  "English,Spanish,Portuguese,French,German,Italian,Polish,Vietnamese,Mandarin,Korean,Japanese,Hebrew,Arabic,Russian,Greek,Indian (Hindi or Other)";
