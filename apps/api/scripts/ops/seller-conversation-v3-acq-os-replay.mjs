// Acquisition OS v1 §40 replay: every redacted inbound since 10-05 (the 394
// round-8 fixtures + the 10-07 read-only fetches) through
//   prod     — efb21e99 live chain (run separately in a detached worktree; rows passed in)
//   branch   — this branch, both conversation flags OFF (what deploying today would do)
//   v3       — this branch, SELLER_AUTOPILOT_V2 + SELLER_CONVERSATION_V3 on, three catalogs:
//                v3_prod_safe  (today's active+safe rows only, nothing approved)
//                v3_en_es      (+ every EN/ES PROPOSED draft approved; switch English,Spanish)
//                v3_all        (+ every language's drafts; switch = all 16)
// Per message: classified? stage, outcome (auto_reply / auto_terminal /
// suppressed / review), terminal action, template, why; plus agreement with
// the round-8 labels. Offline: no network, no DB.
//
//   cd apps/api && node --import ./tests/register-aliases.mjs scripts/ops/seller-conversation-v3-acq-os-replay.mjs \
//     --prod=<prod_rows.json> --out=<dir> [--fixtures=a.json,b.json]
import "../../tests/helpers/critical-test-environment.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { replayV3 } from "../../tests/helpers/seller-conversation-v3-harness.mjs";
import { replayReply } from "../../tests/helpers/reply-replay-harness.mjs";
import { catalogFor, ALL_LANGUAGES_SWITCH, PROD_SAFE } from "../../tests/helpers/seller-conversation-v3-catalog.mjs";
import { isUncertainTurn } from "../../src/lib/domain/seller-flow/seller-conversation-v3-audit.js";

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) || null;
const OUT = arg("out") ? new URL(`file://${arg("out").replace(/\/?$/, "/")}`) : new URL("../../../../tmp/conversation-v3/", import.meta.url);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const ROOT = new URL("../../../../", import.meta.url);
const defaultFixtures = [
  new URL("apps/api/tests/fixtures/reply-quality/2026-10-05to06-all-inbound.json", ROOT).pathname,
  new URL("tmp/conversation-v3/inbound-2026-10-07.json", ROOT).pathname,
  new URL("tmp/conversation-v3/inbound-newer.json", ROOT).pathname,
];
const fixtureFiles = (arg("fixtures") ? arg("fixtures").split(",") : defaultFixtures).filter((f) => existsSync(f));
const cases = fixtureFiles.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).cases);
const labels = JSON.parse(readFileSync(new URL("../../tests/fixtures/reply-quality/2026-10-05to06-all-inbound.labels.json", import.meta.url), "utf8")).labels;
const prodRows = arg("prod") && existsSync(arg("prod")) ? new Map(JSON.parse(readFileSync(arg("prod"), "utf8")).map((r) => [r.id, r])) : new Map();

const EARLY = new Set(["S1_ownership", "S2_interest", "unknown"]);
const prodSafe = PROD_SAFE.map((r) => ({ ...r, source: "prod_active_safe" }));
const V3 = {
  v3_prod_safe: { catalog: prodSafe, languages: "English,Spanish" },
  v3_en_es: { catalog: catalogFor("en_es"), languages: "English,Spanish" },
  v3_all: { catalog: catalogFor("all"), languages: ALL_LANGUAGES_SWITCH },
};
const labelFor = (id) => {
  const m = /-(\d{3})$/.exec(id || "");
  return id?.startsWith("rq-2026-10-05to06-") && m ? labels[m[1]] || null : null;
};
/** Does an outcome agree with the round-8 label (by class)? Hostile/troll moved review → quiet archive by owner decision. */
function agrees(label, outcome, intent) {
  if (!label) return null;
  const want = label.outcome_with_en_es_drafts || label.outcome;
  if (want === "suppressed") return outcome === "suppressed";
  if (want === "no_reply_by_design") return outcome === "auto_terminal" || outcome === "suppressed";
  if (want === "auto_reply") return outcome === "auto_reply";
  if (want === "review") return outcome === "review" ? true : ["hostile_or_troll", "hostile_or_legal"].includes(intent) ? outcome === "auto_terminal" : "changed_by_design";
  return null;
}

const rows = [];
const tally = {};
const bump = (k, f) => {
  tally[k] = tally[k] || { total: 0, classified: 0, auto_reply: 0, auto_terminal: 0, suppressed: 0, review: 0, s1s2_review: 0, label_agree: 0, label_disagree: 0, label_changed_by_design: 0, research_log: 0 };
  const t = tally[k];
  t.total += 1;
  t[f.outcome] = (t[f.outcome] || 0) + 1;
  if (f.classified) t.classified += 1;
  if (f.outcome === "review" && f.early) t.s1s2_review += 1;
  if (f.agree === true) t.label_agree += 1;
  else if (f.agree === false) t.label_disagree += 1;
  else if (f.agree === "changed_by_design") t.label_changed_by_design += 1;
  if (f.research) t.research_log += 1;
};

for (const c of cases) {
  const label = labelFor(c.fixture_id);
  const row = { id: c.fixture_id, message: c.seller_message, prior_use_case: c.prior_question?.template_use_case || null, live: c.live || null, label };
  const p = prodRows.get(c.fixture_id);
  if (p) {
    row.prod = { intent: p.intent, outcome: p.outcome, use_case: p.use_case, why: p.review_reason, classified: Boolean(p.intent && p.intent !== "unclear") };
    bump("prod_efb21e99", { ...row.prod, early: null, agree: agrees(label, p.outcome, p.intent) });
  }
  const br = await replayReply(c, { catalog: prodSafe });
  const brIntent = br.classification?.primary_intent || null;
  row.branch = { intent: brIntent, outcome: br.outcome === "no_reply_by_design" ? "auto_terminal" : br.outcome, use_case: br.template?.use_case || null, why: br.decision?.should_mark_human_review ? br.decision.human_review_reason || br.decision.audit_reason : null, classified: Boolean(brIntent && brIntent !== "unclear") };
  bump("branch_flags_off", { ...row.branch, agree: agrees(label, row.branch.outcome, brIntent) });
  for (const [name, opts] of Object.entries(V3)) {
    const r = await replayV3(c, opts);
    const intent = r.raw.primary_intent;
    const understood = Boolean((intent && intent !== "unclear") || (r.plan?.v2_intent && r.plan.v2_intent !== "unclear"));
    const f = {
      intent, v2_intent: r.plan?.v2_intent || null, stage: r.plan?.stage || null, language: r.classification.language,
      outcome: r.outcome, planned: r.planned, rule: r.plan?.reasoning_code || null,
      terminal_action: r.plan?.terminal_action || r.plan?.then || null, missing: r.plan?.missing || [],
      checklist: r.plan?.checklist_state || null, use_case: r.template?.use_case || null, template_source: r.template?.source || null,
      text: r.text, why: r.review_reason || r.plan?.reasoning_code || null, classified: understood,
      early: EARLY.has(r.plan?.stage), research: isUncertainTurn(r.plan, r.raw),
    };
    f.agree = agrees(label, f.outcome, intent);
    row[name] = f;
    bump(name, f);
  }
  rows.push(row);
}

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
const lines = [`# Acquisition OS v1 conversation replay — ${cases.length} inbound (${fixtureFiles.map((f) => f.split("/").pop()).join(", ")})`, ""];
for (const [k, t] of Object.entries(tally)) {
  lines.push(`${k.padEnd(18)} classified ${t.classified}/${t.total} | auto-reply ${t.auto_reply} (${pct(t.auto_reply, t.total)}) | auto-terminal ${t.auto_terminal} | suppressed ${t.suppressed} | review ${t.review} (${pct(t.review, t.total)}) | S1/S2 review ${k.startsWith("v3") ? t.s1s2_review : "n/a"} | label agree ${t.label_agree} / disagree ${t.label_disagree} / changed-by-design ${t.label_changed_by_design}${k.startsWith("v3") ? ` | research-log ${t.research_log}` : ""}`);
}
for (const name of Object.keys(V3)) {
  const rev = rows.filter((r) => r[name]?.outcome === "review");
  lines.push("", `## ${name}: review cases (${rev.length})`);
  for (const r of rev) lines.push(`- ${r.id} [${r[name].stage}] ${r[name].language} ${r[name].intent} → ${r[name].rule} :: ${r[name].why} :: ${JSON.stringify(String(r.message).slice(0, 80))}`);
}
const dis = rows.filter((r) => r.v3_en_es?.agree === false);
lines.push("", `## v3_en_es label disagreements (${dis.length})`);
for (const r of dis) lines.push(`- ${r.id} label=${r.label?.outcome_with_en_es_drafts || r.label?.outcome}/${r.label?.intent} v3=${r.v3_en_es.outcome}/${r.v3_en_es.rule} :: ${JSON.stringify(String(r.message).slice(0, 80))}`);

writeFileSync(new URL("REPLAY.json", OUT), JSON.stringify({ generated_at: new Date().toISOString(), cases: cases.length, fixtures: fixtureFiles, summary: tally, rows }, null, 1));
writeFileSync(new URL("REPLAY_SUMMARY.md", OUT), lines.join("\n") + "\n");
console.log(lines.slice(0, 8).join("\n"));
