// SELLER CONVERSATION v3 replay: every redacted inbound since 10-05 (the 394
// round-8 fixtures + the 10-07 read-only fetch) through the v3 chain, under
//   (a) EN/ES only: prod active+safe EN/ES + EN/ES drafts, switch English,Spanish
//   (b) all drafts: + every language's drafts, switch = all 16 languages
// Writes tmp/conversation-v3/REPLAY.json + REPLAY_SUMMARY.txt. Offline: no network.
//
//   cd apps/api && node --import ./tests/register-aliases.mjs scripts/ops/seller-conversation-v3-replay.mjs
import "../../tests/helpers/critical-test-environment.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { replayV3 } from "../../tests/helpers/seller-conversation-v3-harness.mjs";
import { catalogFor, ALL_LANGUAGES_SWITCH, PROD_SAFE } from "../../tests/helpers/seller-conversation-v3-catalog.mjs";

const OUT = new URL("../../../../tmp/conversation-v3/", import.meta.url);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const fixtures = JSON.parse(readFileSync(new URL("../../tests/fixtures/reply-quality/2026-10-05to06-all-inbound.json", import.meta.url), "utf8")).cases;
const todayFile = new URL("inbound-2026-10-07.json", OUT);
const today = existsSync(todayFile) ? JSON.parse(readFileSync(todayFile, "utf8")).cases : [];
const cases = [...fixtures, ...today];

const EARLY = new Set(["S1_ownership", "S2_interest", "unknown"]);
const scenarios = {
  // reference: what v3 does with TODAY's active+safe rows only (no draft approved)
  z_prod_active_only: { catalog: PROD_SAFE.map((r) => ({ ...r, source: "prod_active_safe" })), languages: "English,Spanish" },
  a_en_es: { catalog: catalogFor("en_es"), languages: "English,Spanish" },
  b_all_drafts: { catalog: catalogFor("all"), languages: ALL_LANGUAGES_SWITCH },
};

const rows = [];
const summary = {};
for (const [name, opts] of Object.entries(scenarios)) {
  const tally = { total: 0, auto_reply: 0, auto_terminal: 0, suppressed: 0, review: 0, s1s2_review: 0, reply_needs_draft: 0 };
  const reviews = [];
  for (const c of cases) {
    const r = await replayV3(c, opts);
    tally.total += 1;
    tally[r.outcome] += 1;
    const early = EARLY.has(r.plan?.stage);
    if (r.outcome === "review" && early) tally.s1s2_review += 1;
    if (r.outcome === "auto_reply" && r.template?.source && r.template.source !== "prod_active_safe") tally.reply_needs_draft += 1;
    if (r.outcome === "review") {
      reviews.push({ id: c.fixture_id, stage: r.plan?.stage, msg: c.seller_message.slice(0, 90), language: r.classification.language, intent: r.raw.primary_intent, plan: r.planned, plan_reason: r.plan?.reasoning_code, reason: r.review_reason });
    }
    rows.push({
      scenario: name, id: c.fixture_id, stage: r.plan?.stage, language: r.classification.language,
      message: c.seller_message, intent: r.raw.primary_intent, v2_intent: r.plan?.v2_intent, planned: r.planned,
      plan_reason: r.plan?.reasoning_code, missing: r.plan?.missing, price_branch: r.plan?.price_branch,
      outcome: r.outcome, use_case: r.template?.use_case || null, template_id: r.template?.template_id || null, template_source: r.template?.source || null,
      text: r.text, review_reason: r.review_reason, live_intent: c.live?.intent, live_auto_reply: c.live?.auto_reply ?? null,
    });
  }
  const pct = (n) => `${((n / tally.total) * 100).toFixed(1)}%`;
  summary[name] = {
    ...tally,
    pct_auto_reply: pct(tally.auto_reply),
    pct_auto_terminal: pct(tally.auto_terminal + tally.suppressed),
    pct_review: pct(tally.review),
    reviews,
  };
}

writeFileSync(new URL("REPLAY.json", OUT), JSON.stringify({ generated_at: new Date().toISOString(), cases: cases.length, summary, rows }, null, 2));
const lines = [];
for (const [name, s] of Object.entries(summary)) {
  lines.push(`== ${name}: ${s.total} inbound`);
  lines.push(`   auto-reply ${s.auto_reply} (${s.pct_auto_reply}) | auto-terminal ${s.auto_terminal} + suppressed ${s.suppressed} (${s.pct_auto_terminal}) | review ${s.review} (${s.pct_review}) | S1/S2 review ${s.s1s2_review} | auto-replies needing a draft approved ${s.reply_needs_draft}`);
  for (const r of s.reviews) lines.push(`   - ${r.id} [${r.stage}] ${r.language} ${r.intent} -> ${r.plan}/${r.plan_reason} :: ${r.reason} :: ${JSON.stringify(r.msg)}`);
}
writeFileSync(new URL("REPLAY_SUMMARY.txt", OUT), lines.join("\n") + "\n");
console.log(lines.join("\n"));
