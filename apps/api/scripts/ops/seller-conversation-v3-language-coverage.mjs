// Acquisition OS v1 §35 language coverage: language × stage × intent × template.
// The language REGISTRY is authoritative (canonical-language-adapter CANONICAL_LANGUAGES
// + every language the sms_templates catalog carries), never a hardcoded list.
// For each §73 cell (stage × intent) the v3 planner names an ordered template
// preference; for each registry language the best available row is classified:
//   prod_active_safe  — live-approved row exists (sendable today, once the language is switched on)
//   draft_unreviewed  — a PROPOSED inactive row exists, needs owner / native review
//   prod_active_not_safe — an active row exists but is not approved for auto-reply
//   missing           — nothing; the turn goes to review in that language (§92)
//   no_reply_needed   — the cell is a terminal / deferral (no template)
// Also writes the PROPOSED migration for the Acquisition OS template drafts.
//
//   cd apps/api && node --import ./tests/register-aliases.mjs scripts/ops/seller-conversation-v3-language-coverage.mjs \
//     --prod-counts=<prod_template_counts.json> --out=<dir>
import "../../tests/helpers/critical-test-environment.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { runCell, INTENT_MESSAGES, MATRIX_STAGES, trustedSnapshot } from "../../tests/helpers/seller-conversation-v3-matrix.mjs";
import { draftRows, PROD_SAFE } from "../../tests/helpers/seller-conversation-v3-catalog.mjs";
import { CANONICAL_LANGUAGES } from "../../src/lib/domain/templates/canonical-language-adapter.js";
import { canonicalTemplateLanguage, parseEnabledLanguages } from "../../src/lib/domain/seller-flow/seller-autopilot-v2.js";
import { lexiconCoverage } from "../../src/lib/domain/seller-flow/seller-conversation-v3-lexicon.js";
import { ACQ_OS_LANGS, proposedAcqOsTemplateRows } from "./seller-conversation-v3-acq-os-templates.proposed.mjs";

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) || null;
const OUT = arg("out") || new URL("../../../../tmp/conversation-v3/", import.meta.url).pathname;
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const countsPath = arg("prod-counts") || new URL("../../../../tmp/conversation-v3/prod_template_counts.json", import.meta.url).pathname;
const prodCounts = existsSync(countsPath) ? JSON.parse(readFileSync(countsPath, "utf8")) : [];

// ── registry ────────────────────────────────────────────────────────────────
const registry = [];
const registryNotes = [];
for (const l of CANONICAL_LANGUAGES) {
  const t = canonicalTemplateLanguage(l) || l;
  if (t !== l) registryNotes.push(`registry name "${l}" ≠ template language "${t}" (alias resolves it)`);
  registry.push(t);
}
for (const r of prodCounts) {
  const t = canonicalTemplateLanguage(r.language) || r.language;
  if (t && !registry.includes(t)) {
    registry.push(t);
    registryNotes.push(`catalog-discovered language "${t}" (not in CANONICAL_LANGUAGES)`);
  }
}

// ── template availability per (use_case, language) ─────────────────────────
const prod = new Map(prodCounts.map((r) => [`${r.use_case}|${canonicalTemplateLanguage(r.language) || r.language}`, r]));
const safeSnapshot = new Set(PROD_SAFE.map((r) => `${r.use_case}|${r.language}`));
const drafts = new Map();
for (const r of draftRows()) {
  const k = `${r.use_case}|${r.language}`;
  if (!drafts.has(k)) drafts.set(k, r);
}
const RANK = { prod_active_safe: 4, draft_unreviewed: 3, prod_active_not_safe: 2, missing: 1 };
function statusFor(use_case, language) {
  const k = `${use_case}|${language}`;
  const p = prod.get(k);
  if ((p && p.active_safe > 0) || safeSnapshot.has(k)) return { status: "prod_active_safe", source: "sms_templates" };
  if (drafts.has(k)) return { status: "draft_unreviewed", source: drafts.get(k).source, template_id: drafts.get(k).template_id };
  if (p && p.active > 0) return { status: "prod_active_not_safe", source: "sms_templates" };
  return { status: "missing", source: null };
}
function bestOf(preference = [], language) {
  let best = { status: "missing", use_case: preference[0] || null };
  for (const uc of preference) {
    const s = statusFor(uc, language);
    if (RANK[s.status] > RANK[best.status]) best = { ...s, use_case: uc };
  }
  return best;
}

// ── the §73 cells (planner preference is language-independent) ─────────────
const cells = [];
for (const stage of Object.keys(MATRIX_STAGES)) {
  for (const [intent, message] of Object.entries(INTENT_MESSAGES)) {
    const r = await runCell({ stage, message, ade_snapshot: trustedSnapshot() });
    cells.push({ stage, intent, action: r.plan?.action || null, rule: r.plan?.reasoning_code || null, preference: r.plan?.template_preference || [] });
  }
}

const lex = lexiconCoverage();
const enabledToday = parseEnabledLanguages(null);
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const lines = ["language,stage,intent,action,rule,reply_use_case,template_status,template_source,template_id,preference,language_switch_default,lexicon_intents"];
const summary = {};
for (const language of registry) {
  const s = (summary[language] = { reply_cells: 0, prod_active_safe: 0, draft_unreviewed: 0, prod_active_not_safe: 0, missing: 0, missing_use_cases: new Set(), unreviewed_use_cases: new Set() });
  for (const c of cells) {
    const replies = c.action === "reply";
    const best = replies ? bestOf(c.preference, language) : { status: "no_reply_needed", use_case: null };
    if (replies) {
      s.reply_cells += 1;
      s[best.status] += 1;
      if (best.status === "missing" || best.status === "prod_active_not_safe") s.missing_use_cases.add(c.preference[0]);
      if (best.status === "draft_unreviewed") s.unreviewed_use_cases.add(best.use_case);
    }
    lines.push([language, c.stage, c.intent, c.action, c.rule, best.use_case, best.status, best.source, best.template_id, c.preference.join(" > "), enabledToday.includes(language) ? "on" : "off", (lex[language] || []).join(" ")].map(q).join(","));
  }
}
writeFileSync(`${OUT}/LANGUAGE_COVERAGE.csv`, lines.join("\n") + "\n");

const md = ["# Language coverage (registry × §73 cells)", "", ...registryNotes.map((n) => `- note: ${n}`), "",
  "| language | switch (default) | reply cells | prod active+safe | draft (unreviewed) | active not safe | missing | autonomous? | missing use cases | lexicon intents |",
  "|---|---|---|---|---|---|---|---|---|---|"];
for (const [language, s] of Object.entries(summary)) {
  const autonomous = s.prod_active_safe === s.reply_cells && enabledToday.includes(language);
  md.push(`| ${language} | ${enabledToday.includes(language) ? "on" : "off"} | ${s.reply_cells} | ${s.prod_active_safe} | ${s.draft_unreviewed} | ${s.prod_active_not_safe} | ${s.missing} | ${autonomous ? "yes" : "no"} | ${[...s.missing_use_cases].join(", ") || "—"} | ${(lex[language] || ["classifier"]).join(" ")} |`);
}
writeFileSync(`${OUT}/LANGUAGE_COVERAGE_SUMMARY.md`, md.join("\n") + "\n");

// ── PROPOSED migration for the Acquisition OS drafts ───────────────────────
const sq = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const rows = proposedAcqOsTemplateRows();
const values = rows
  .map((r) => `  (${[r.use_case, r.template_id, `${r.use_case} — ${r.language} (seller conversation v3, acquisition os)`, r.language, r.template_body, r.english_translation, r.stage_code, r.stage_label].map(sq).join(", ")}, ${r.native_review}, ${sq(r.kind)})`)
  .join(",\n");
const sql = `-- PROPOSED — NOT APPLIED. Owner approval of the EN/ES wording (tmp/conversation-v3/EN_ES_COPY_REVIEW.md,
-- section "Acquisition OS v1") and NATIVE review of every other row are required before activation.
--
-- SELLER CONVERSATION MACHINE v3 · Acquisition OS v1 (§21 §23 §26–27 §36 §38): ${rows.length} sms_templates rows,
-- ${new Set(rows.map((r) => r.use_case)).size} use cases × ${ACQ_OS_LANGS.length} languages (native script). Every row: is_active = false,
-- safe_for_auto_reply = false, metadata.review_status = 'unreviewed'. Only the SELLER_CONVERSATION_V3
-- layer (env flag, default OFF) names these use cases, and a language replies only when it is ALSO in
-- system_control[seller_autopilot_v2_languages] (per-language activation). Nothing can send from this file.
-- Idempotent: inserts only template_ids that do not exist.
--
-- Activate per row after review:
--   update public.sms_templates set is_active = true, safe_for_auto_reply = true,
--          metadata = metadata || jsonb_build_object('review_status','approved','reviewed_by','<name>','reviewed_at',now())
--    where template_id in (...);

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, stage_code, stage_label,
  is_first_touch, is_follow_up, fallback_rank, quarantine_state, metadata
)
select v.use_case, v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation, '{}'::jsonb,
       false, false, 'auto',
       'neutral', 'Residential', v.stage_code, v.stage_label,
       false, false, 1, 'active',
       jsonb_build_object(
         'source', 'PROPOSED_20261007050000_seller_conversation_v3_acq_os_templates',
         'review_status', 'unreviewed',
         'needs_native_review', v.native_review,
         'kind', v.kind,
         'machine', 'seller_conversation_v3'
       )
from (values
${values}
) as v(use_case, template_id, template_name, language, template_body, english_translation, stage_code, stage_label, native_review, kind)
where not exists (select 1 from public.sms_templates t where t.template_id = v.template_id);

commit;
`;
const MIG = new URL("../../../../supabase/migrations/", import.meta.url).pathname;
writeFileSync(`${MIG}PROPOSED_20261007050000_seller_conversation_v3_acq_os_templates.sql`, sql);
writeFileSync(
  `${MIG}PROPOSED_20261007050000_seller_conversation_v3_acq_os_templates_rollback.sql`,
  `-- Rollback for PROPOSED_20261007050000 (only rows this migration inserted, still inactive).\nbegin;\ndelete from public.sms_templates\n where metadata->>'source' = 'PROPOSED_20261007050000_seller_conversation_v3_acq_os_templates'\n   and is_active = false;\ncommit;\n`,
);
console.log(md.join("\n"));
