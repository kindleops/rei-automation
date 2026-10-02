#!/usr/bin/env node
/**
 * IC8 campaign controller v0 -- HISTORICAL RULE REPLAY (offline, read-only).
 *
 * This is a RULE REPLAY ON LOGGED OUTCOMES, not a counterfactual estimate.
 * For every ops-day D it rebuilds each unit's state from events observed
 * BEFORE D (send day s < D and s + observation lag < D), runs the pure
 * controller, and records what it WOULD have proposed next to what actually
 * happened on D (sends and their eventually-logged outcomes) and the known
 * human actions. "Harm a pause would have removed" assumes the day's sends
 * are exchangeable; nothing here says what unsent volume would have done.
 *
 * Input: the extract produced by extract-daily.sql (run through the Supabase
 * MCP execute_sql, SELECT only, statement_timeout) saved as
 * <dataset>/body.txt + <dataset>/extract-meta.json; the md5 is re-checked.
 * No database access here. Output: report.md, model-card.md, manifest.json.
 *
 *   node --no-warnings scripts/intelligence/campaign-controller/replay.mjs \
 *     [--dataset=<dir>] [--out=<dir>]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONTROLLER_VERSION, proposeCampaignActions } from "../../../src/lib/domain/intelligence/campaign-controller/controller.js";
import { DEFAULT_ENVELOPE, buildEnvelope, validateEnvelope } from "../../../src/lib/domain/intelligence/campaign-controller/envelope.js";
import { DEFAULT_DETERMINISTIC_LIMITS } from "../../../src/lib/domain/intelligence/campaign-controller/guardrails.js";
import { deriveTimezoneFromGeography } from "../../../src/lib/domain/campaigns/contact-window-timezone.js";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8";
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const DATASET = args.dataset || path.join(ROOT, "datasets/campaign-controller-v0");
const OUT = args.out || path.join(ROOT, "models/campaign-controller-v0");
const DAY_MS = 86_400_000;
const BOUNDARY_H = 10;

// ---------- load + verify ----------
const meta = JSON.parse(fs.readFileSync(path.join(DATASET, "extract-meta.json"), "utf8"));
const body = fs.readFileSync(path.join(DATASET, meta.body_file), "utf8");
const md5 = crypto.createHash("md5").update(body).digest("hex");
if (md5 !== meta.body_md5) throw new Error(`extract md5 mismatch ${md5} != ${meta.body_md5}`);
const sqlPath = path.join(path.dirname(SCRIPT), "extract-daily.sql");
const sqlSha = crypto.createHash("sha256").update(fs.readFileSync(sqlPath)).digest("hex");
const day0 = Date.parse(`${meta.day0}T00:00:00Z`);
const dayIso = (d) => new Date(day0 + d * DAY_MS).toISOString().slice(0, 10);
const decisionIso = (d) => new Date(day0 + d * DAY_MS + BOUNDARY_H * 3_600_000).toISOString();

const COLS = meta.body_columns;
const cells = body.split(";").map((row) => Object.fromEntries(row.split(",").map((v, i) => [COLS[i], Number(v)])));
const totalSent = cells.reduce((a, c) => a + c.sent, 0);
if (totalSent !== meta.total_sent || cells.length !== meta.n_cells) throw new Error("extract totals mismatch");

// ---------- units ----------
const STATE_ZIP = { TX: { "Austin, TX": "78701", "Houston, TX": "77002", "Dallas, TX": "75201" }, TN: { "Memphis, TN": "38103" }, IN: { "Indianapolis, IN": "46204" }, ID: { "Boise, ID": "83702" }, MI: { "Detroit, MI": "48226" }, FL: { "Miami, FL": "33130" }, OR: {}, KY: {}, KS: {}, NE: {}, ND: {}, SD: {} };
function legacyTimezone(market) {
  const st = market.split(",").pop().trim();
  return deriveTimezoneFromGeography(st, STATE_ZIP[st]?.[market] ?? null).iana;
}
const units = meta.units.map((key, ui) => {
  if (key.startsWith("c:")) {
    const id = key.slice(2);
    const c = meta.campaigns[id];
    return { ui, key, kind: "campaign", id, label: c.label, market: c.market, cohort: c.cohort, timezone: c.timezone, daily_cap: c.daily_cap, human: c.human_actions, audience: parseAudience(meta.audience_ready_to_queue[id]) };
  }
  const market = key.slice(2);
  return { ui, key, kind: "legacy", id: `legacy:${market}`, label: `legacy feeder · ${market}`, market, cohort: "legacy_feeder", timezone: legacyTimezone(market), daily_cap: DEFAULT_ENVELOPE.volume.max_daily_per_campaign, human: [], audience: null };
});
function parseAudience(text) {
  if (!text) return [];
  return text.split(";").map((r) => r.split(",").map(Number)).map(([d, ready]) => ({ d, ready }));
}
const byUnit = new Map(units.map((u) => [u.ui, cells.filter((c) => c.u === u.ui)]));
const sendDays = new Map(units.map((u) => [u.ui, [...new Set(byUnit.get(u.ui).filter((c) => c.sent > 0).map((c) => c.d))].sort((a, b) => a - b)]));

const ZERO = () => ({ sends: 0, delivered: 0, failed: 0, filtered: 0, reply_threads: 0, opt_outs: 0, wrong_person: 0, qualified: 0, engaged: 0, hostile: 0 });
function add(acc, c) {
  acc.sends += c.sent;
  acc.filtered += c.spam;
  acc.delivered += c.dlv;
  acc.failed += c.fail;
  acc.reply_threads += c.rt;
  acc.opt_outs += c.oo;
  acc.wrong_person += c.wn;
  acc.engaged += c.eng;
  acc.qualified += c.qual;
  acc.hostile += c.host;
}
/** PIT window: send day in [from, D-1] and observed (s + lag) < D. */
function windowAt(ui, D, from) {
  const acc = ZERO();
  for (const c of byUnit.get(ui)) if (c.d >= from && c.d < D && c.d + c.lag < D) add(acc, c);
  // a count can never exceed its parent within the PIT slice
  acc.delivered = Math.min(acc.delivered, acc.sends);
  acc.failed = Math.min(acc.failed, acc.sends);
  acc.filtered = Math.min(acc.filtered, acc.sends);
  acc.reply_threads = Math.min(acc.reply_threads, acc.sends);
  for (const k of ["opt_outs", "wrong_person", "qualified", "engaged", "hostile"]) acc[k] = Math.min(acc[k], acc.reply_threads);
  return acc;
}
/** Everything ever logged for sends on day D (the "actual" column). */
function actualOn(ui, D) {
  const acc = ZERO();
  for (const c of byUnit.get(ui)) if (c.d === D) add(acc, c);
  return acc;
}

function stateFor(D, unitsToday) {
  const now = decisionIso(D);
  return {
    as_of: now,
    senders_by_market: null,
    campaigns: unitsToday.map((u) => {
      const aud = u.audience?.filter((a) => a.d < D).at(-1) ?? null;
      const recent = windowAt(u.ui, D, D - 1);
      return {
        campaign_id: u.id,
        status: "active",
        market: u.market,
        cohort: u.cohort,
        strategy: "ownership_check",
        timezone: u.timezone,
        caps: { daily_cap: u.daily_cap, contact_window_start: "08:00", contact_window_end: "21:00" },
        metrics: { as_of: now, recent: recent.sends > 0 ? recent : null, rolling: windowAt(u.ui, D, D - 7), lifetime: windowAt(u.ui, D, -100000) },
        audience: aud ? { as_of: decisionIso(aud.d + 1), eligible_remaining: aud.ready } : null,
        templates: null,
        review: null,
      };
    }),
  };
}

// decision days: before every send day, and the day after the last one
const decisionDays = new Map();
for (const u of units) for (const d of sendDays.get(u.ui)) for (const D of [d, d + 1]) {
  if (!decisionDays.has(D)) decisionDays.set(D, new Set());
  decisionDays.get(D).add(u.ui);
}
const allMarkets = [...new Set(units.map((u) => u.market))].sort();
const OPEN_ENVELOPE = buildEnvelope({
  version: "replay-open-policy-2026-10-01",
  markets: { allowed: allMarkets },
  cohorts: { allowed: ["map_area", "entity_graph", "saved_filter", "legacy_feeder"] },
  volume: { max_daily_total: 100000, max_concurrent_campaigns: 100 },
  budget: { max_daily_spend_usd: 100000 },
});
const openCheck = validateEnvelope(OPEN_ENVELOPE);
if (!openCheck.ok) throw new Error(`replay envelope invalid: ${openCheck.problems.join("; ")}`);

function runPass(envelope) {
  const rows = [];
  for (const D of [...decisionDays.keys()].sort((a, b) => a - b)) {
    const today = [...decisionDays.get(D)].sort((a, b) => a - b).map((ui) => units[ui]);
    const res = proposeCampaignActions(stateFor(D, today), { envelope, guardrails: DEFAULT_DETERMINISTIC_LIMITS, now: decisionIso(D), killSwitch: { paused: true, reason: "absent (no such key historically)" } });
    for (const p of res.proposals) {
      if (p.action === "narrow_contact_window") continue;
      const u = units.find((x) => x.id === p.campaign_id);
      rows.push({ D, day: dayIso(D), unit: u, proposal: p, actual: actualOn(u.ui, D) });
    }
  }
  return rows;
}
const passA = runPass(OPEN_ENVELOPE);
const passB = runPass(DEFAULT_ENVELOPE);
const determinism = JSON.stringify(runPass(OPEN_ENVELOPE).map((r) => [r.D, r.proposal.proposal_id])) === JSON.stringify(passA.map((r) => [r.D, r.proposal.proposal_id]));

// ---------- analysis ----------
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–");
const isStop = (p) => p.action === "pause";
const codesOf = (p) => p.why.filter((c) => c.startsWith("STOP_") || c.startsWith("THROTTLE_") || c.startsWith("POLICY_") || c === "DELIVERY_TELEMETRY_INCOMPLETE" || c === "NO_ELIGIBLE_AUDIENCE");
const counter = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
const sortCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

function harmSummary(rows) {
  const s = ZERO();
  for (const r of rows) add(s, { sent: r.actual.sends, spam: r.actual.filtered, dlv: r.actual.delivered, fail: r.actual.failed, rt: r.actual.reply_threads, oo: r.actual.opt_outs, wn: r.actual.wrong_person, eng: r.actual.engaged, qual: r.actual.qualified, host: r.actual.hostile });
  return s;
}
const sendRows = (rows) => rows.filter((r) => r.actual.sends > 0);
const A_send = sendRows(passA);
const A_pause = A_send.filter((r) => isStop(r.proposal));
const A_throttle = A_send.filter((r) => r.proposal.kind === "throttle");
const totals = harmSummary(A_send);
const removed = harmSummary(A_pause);

const campaignRows = passA.filter((r) => r.unit.kind === "campaign");
const legacyRows = passA.filter((r) => r.unit.kind === "legacy");

function fmtRate(c) {
  return `${c.sends} sent · ${pct(c.filtered, c.sends)} filtered · dlv ${pct(c.delivered, c.delivered + c.failed)} · ${c.opt_outs} OO · ${c.wrong_person} WN · ${c.qualified} qual`;
}
function proposalText(p) {
  if (p.action === "pause") return "**pause**";
  if (p.action === "set_daily_cap") return `daily_cap ${p.from.daily_cap ?? "∅"}→${p.to.daily_cap}`;
  return "hold";
}
function firstHumanPauseAfter(u, d) {
  const start = day0 + d * DAY_MS + BOUNDARY_H * 3_600_000;
  return u.human.find((h) => h.action === "pause" && Date.parse(h.at) >= start) || null;
}

const lines = [];
const L = (s = "") => lines.push(s);
L("# Campaign controller v0 — historical rule replay");
L();
L(`Generated by \`apps/api/scripts/intelligence/campaign-controller/replay.mjs\` · controller \`${CONTROLLER_VERSION}\` · extract md5 \`${meta.body_md5}\` · ${meta.total_sent.toLocaleString("en-US")} proactive sends · ${units.length} units (6 campaigns + ${units.length - 6} legacy feeder markets) · ${decisionDays.size} decision days.`);
L();
L("**What this is:** a RULE REPLAY on LOGGED outcomes. Each day the controller saw only events observed before that day's 10:00 UTC boundary; its proposal is set beside what actually happened that day. It is **not** a counterfactual estimate: nothing was randomised, no propensity was logged, and the outcome of volume that was never sent is unknown. \"Harm removed\" = outcomes logged on the sends of a day the controller would have paused (sends assumed exchangeable within the day).");
L();
L("**Envelope:** pass A uses the default thresholds with an OPEN market/cohort/volume policy (so only the §45 conditions decide; the operator never had an envelope). Pass B uses `DEFAULT_ENVELOPE` as shipped. Kill switch absent historically ⇒ every proposal `would_execute:false`.");
L();
L("## Headline");
L();
L(`- Pass A, days that actually sent (${A_send.length} unit-days, ${totals.sends.toLocaleString("en-US")} sends): pause proposed on **${A_pause.length}** unit-days, throttle on **${A_throttle.length}**.`);
L(`- The paused unit-days carried ${removed.sends.toLocaleString("en-US")} sends (${pct(removed.sends, totals.sends)}) with ${removed.filtered} carrier-filtered (${pct(removed.filtered, totals.filtered)} of all filtering), ${removed.opt_outs} opt-out threads (${pct(removed.opt_outs, totals.opt_outs)}), ${removed.wrong_person} wrong-number threads, and ${removed.qualified} strict-qualified threads (${pct(removed.qualified, totals.qualified)} of all qualified) — the cost side.`);
const scaleA = passA.filter((r) => r.proposal.kind === "scale").length;
L(`- Scale-ups proposed: **${scaleA}**. Every day lacked the evidence (≥${DEFAULT_ENVELOPE.evidence.min_sends_for_scale} sends and ≥${DEFAULT_ENVELOPE.evidence.min_qualified_for_scale} qualified with a lower bound ≥ ${DEFAULT_ENVELOPE.scale.min_qualified_rate}), sender capacity (fleet history not reconstructable) or audience.`);
L(`- Determinism: re-running pass A gives identical proposal ids: **${determinism}**.`);
L();
L("## The 6 real campaigns, day by day (pass A)");
L();
L("| campaign | decision day (ops) | state the controller saw (PIT) | would have | why | actually sent that day | human actions |");
L("|---|---|---|---|---|---|---|");
for (const r of campaignRows) {
  const seen = r.proposal.evidence?.conditions?.length ? `rolling: ${fmtRate(windowAt(r.unit.ui, r.D, r.D - 7))}` : "no history yet";
  const human = r.unit.human.filter((h) => Math.floor((Date.parse(h.at) - day0 - BOUNDARY_H * 3_600_000) / DAY_MS) === r.D).map((h) => `${h.action} ${h.at.slice(11, 16)}Z`).join(", ");
  L(`| ${r.unit.label} | ${r.day} | ${seen} | ${proposalText(r.proposal)} | ${codesOf(r.proposal).join(", ") || r.proposal.why.join(", ")} | ${r.actual.sends ? fmtRate(r.actual) : "0"} | ${human || "–"} |`);
}
L();
L("### Earlier than the humans?");
L();
for (const u of units.filter((x) => x.kind === "campaign")) {
  const rows = campaignRows.filter((r) => r.unit === u);
  const firstStop = rows.find((r) => isStop(r.proposal));
  const firstSend = sendDays.get(u.ui)[0];
  const human = firstHumanPauseAfter(u, firstSend);
  let text;
  if (!firstStop) text = "no stop condition ever fired (thresholds not breached with credible evidence, or too few sends).";
  else {
    const fireAt = decisionIso(firstStop.D);
    const cmp = human ? (Date.parse(fireAt) < Date.parse(human.at) ? `**earlier** than the human pause at ${human.at}` : `later than the human pause at ${human.at} (the daily cadence cannot act inside the first burst day)`) : "no human pause recorded after the first send";
    const later = rows.filter((r) => r.D >= firstStop.D && r.actual.sends > 0);
    const laterHarm = harmSummary(later);
    const trigger = windowAt(u.ui, firstStop.D, firstStop.D - 7);
    text = `first pause proposal at ${fireAt} (${codesOf(firstStop.proposal).join(", ")}) — ${cmp}. Sends on/after that day that a held pause would have removed: ${laterHarm.sends} (${laterHarm.filtered} filtered, ${laterHarm.opt_outs} OO, ${laterHarm.qualified} qualified). Trigger window: ${pct(trigger.filtered, trigger.sends)} filtered, ${pct(trigger.opt_outs, trigger.sends)} opt-out; removed days: ${pct(laterHarm.filtered, laterHarm.sends)} filtered, ${pct(laterHarm.opt_outs, laterHarm.sends)} opt-out${laterHarm.sends && laterHarm.filtered / laterHarm.sends < DEFAULT_ENVELOPE.safety.max_carrier_filtering_rate / 2 ? " — carrier filtering on the removed days was far below the trigger (a template/wording change the controller could not see: the replay has no per-template input), so this pause would have removed mostly unfiltered volume" : ""}.`;
  }
  L(`- **${u.label}** (${u.market}): ${text}`);
}
L();
L("## Legacy feeder pseudo-campaigns (one per property market; pass A)");
L();
const legacyFire = counter(legacyRows.filter((r) => r.actual.sends > 0).flatMap((r) => codesOf(r.proposal)));
L("Reason codes on legacy days that sent:");
L();
L("| code | unit-days |");
L("|---|---|");
for (const [code, n] of sortCount(legacyFire)) L(`| ${code} | ${n} |`);
L();
L("Largest legacy days the controller would have paused (by sends):");
L();
L("| day | market | would have | why | actual |");
L("|---|---|---|---|---|");
for (const r of legacyRows.filter((x) => x.actual.sends > 0 && isStop(x.proposal)).sort((a, b) => b.actual.sends - a.actual.sends).slice(0, 15)) {
  L(`| ${r.day} | ${r.unit.market} | pause | ${codesOf(r.proposal).join(", ")} | ${fmtRate(r.actual)} |`);
}
L();
const weekly = new Map();
for (const r of A_send) {
  const wk = dayIso(r.D - ((r.D % 7) + 7) % 7);
  const w = weekly.get(wk) || { sends: 0, paused: 0, throttled: 0, filtered: 0, filteredPaused: 0 };
  w.sends += r.actual.sends;
  w.filtered += r.actual.filtered;
  if (isStop(r.proposal)) { w.paused += r.actual.sends; w.filteredPaused += r.actual.filtered; }
  if (r.proposal.kind === "throttle") w.throttled += r.actual.sends;
  weekly.set(wk, w);
}
L("Weekly (week starting Monday): share of actual volume on unit-days the controller would have paused / throttled.");
L();
L("| week | sends | filtered | on paused days | on throttled days | filtered on paused days |");
L("|---|---|---|---|---|---|");
for (const [wk, w] of [...weekly.entries()].sort()) L(`| ${wk} | ${w.sends} | ${pct(w.filtered, w.sends)} | ${pct(w.paused, w.sends)} | ${pct(w.throttled, w.sends)} | ${w.filteredPaused} |`);
L();
L("## Which stop conditions fired (pass A, all decision days)");
L();
L("| condition code | unit-days | of which on days with sends |");
L("|---|---|---|");
const allCodes = counter(passA.flatMap((r) => codesOf(r.proposal)));
const sendCodes = counter(A_send.flatMap((r) => codesOf(r.proposal)));
for (const [code, n] of sortCount(allCodes)) L(`| ${code} | ${n} | ${sendCodes.get(code) || 0} |`);
L();
const neverEval = ["template_failure", "sender_degradation", "human_review_burden"];
L(`Not evaluable historically (inputs not reconstructable): ${neverEval.join(", ")}; capacity-based clamps; scale (capacity unknown).`);
L();
L("## Pass B — the shipped DEFAULT envelope");
L();
const B_send = sendRows(passB);
L(`Market allowlist = Dallas + Minneapolis, max ${DEFAULT_ENVELOPE.volume.max_concurrent_campaigns} concurrent, ${DEFAULT_ENVELOPE.volume.max_daily_total}/day total and $${DEFAULT_ENVELOPE.budget.max_daily_spend_usd}/day.`);
L();
L("| code | unit-days with sends |");
L("|---|---|");
for (const [code, n] of sortCount(counter(B_send.flatMap((r) => codesOf(r.proposal))))) L(`| ${code} | ${n} |`);
L();
const outside = units.filter((u) => u.kind === "legacy" && !DEFAULT_ENVELOPE.markets.allowed.includes(u.market)).length;
L(`Pause proposed on ${B_send.filter((r) => isStop(r.proposal)).length} of ${B_send.length} unit-days with sends: the legacy feeder sent in ${outside} markets the default envelope does not allow (and its cohort, legacy_feeder, is not an allowed cohort), and Miami / LA / multi-market campaigns are outside it too. This is a statement about today's envelope, not about history's quality.`);
L();
L("## Caveats (read before using any number above)");
L();
L("- **Rule replay, not counterfactual.** No randomisation, no logged propensities (audit §1.3). Volume differences in history came from broken infrastructure (no scheduler before 09-28, blocked/cooling senders), not decisions.");
L("- **Daily cadence.** The replay decides once per ops-day (10:00 UTC). It cannot stop a first-day burst: Minneapolis 09-28 sent 478 before any day boundary. Intraday protection needs the */5 feeder hook (H3) — the same pure controller can run per tick.");
L("- **Status history is partial.** The transition RPC keeps only `last_transition_*`; pass A treats a unit as live on each decision day. Human actions are from `paused_at` / `last_transition_*` / `campaign.activated` events only.");
L("- **Reply classes are today's classifier reading** (`detected_intent`, later repairs included), used as operational signals per the Analytics Lab definitions, not as labels. Opt-out = is_opt_out ∨ opt_out_keyword ∨ OPTOUT_INTENTS.");
L("- **Telemetry lag is real and replayed:** 864 delivery receipts arrived two ops-days late in April–May; the controller saw those days with low receipt coverage and held delivery as not evaluable (DELIVERY_TELEMETRY_INCOMPLETE) instead of declaring a collapse. ~360 failure events were back-filled weeks later; those failures are invisible to the replay until they appear (as they were to the system).");
L("- **Thin data.** 6 campaigns, 12 campaign send-days, 1 strict-qualified campaign thread. Legacy markets give 724 market-days but most are tiny (<20 sends ⇒ INSUFFICIENT_EVIDENCE).");
L("- **Not reconstructable:** sender fleet health, template governance/blocklist history, human-review burden, legacy audience size. Those conditions are implemented and tested hermetically but never fire here.");
L("- **Pseudo-campaign caps:** the legacy feeder had no per-market daily cap; the replay assumes 750 so the uncapped clamp does not mask the stop conditions.");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "report.md"), `${lines.join("\n")}\n`);

// ---------- model card ----------
const card = `# Model card — Campaign controller v0 (shadow)

**Family:** campaign_controller (familyType campaign_allocation) · **Version:** \`${CONTROLLER_VERSION}\` · **Status:** development / shadow prototype (phase 10). Nothing executes.

## Purpose
Propose, never execute, per-campaign lifecycle/caps changes inside an operator envelope: stop or throttle on delivery collapse, carrier-filtering spike, opt-out rise, template failure, sender degradation, reply-quality collapse, human-review burden, no audience or policy limits (§45); scale only when delivery is healthy, the shrunk qualified-reply rate is credibly strong, opt-out is low and capacity and audience exist (§46).

## What it is (no learned parameters)
- Deterministic rules over **beta-binomial shrunk rates** (foundation \`models/beta-binomial.js\`, market → campaign; templates market → campaign → template), each with an equal-tailed ${DEFAULT_ENVELOPE.evidence.credible_level * 100}% credible interval. Priors are fitted per decision by marginal ML across the portfolio of that day.
- Severity: **stop** when the whole interval breaches the limit, **throttle** when the posterior mean does. Scale requires every unfavourable bound to be inside the limits. Never on raw reply rate.
- Allocation ranks campaigns by expected qualified replies minus documented penalties (opt-out ${DEFAULT_ENVELOPE.penalties.opt_out}, carrier-filtered ${DEFAULT_ENVELOPE.penalties.carrier_filtered}, wrong person ${DEFAULT_ENVELOPE.penalties.wrong_person} qualified-reply equivalents — placeholders pending owner sign-off) and trims lowest-ranked first when concurrency / total volume / budget / market sender capacity bind. Exploration share 0.

## Action space (closed)
hold · pause (POST /api/cockpit/campaigns/{id}/lifecycle {action:'pause'}) · daily_cap (PATCH /api/cockpit/campaigns/{id}) · contact-window narrowing (same PATCH). Never activate/resume/schedule/complete/archive; never status via PATCH; never batch_max / market_cap / per_sender_cap (shared queue rails), total_cap, auto_* flags, targeting, templates, senders, recipients or offers. daily_cap ≥ 1 always (0/null is UNLIMITED in the feeder's resolveFeedLimit).

## Inputs
Per-campaign point-in-time counts (sends, delivered, failed, carrier-filtered, reply threads, opt-out, wrong person, qualified, engaged, hostile) for the last day / 7 days / lifetime; remaining eligible audience; sender fleet per property market; template stats + governance; open real review holds; envelope; deterministic-limit snapshot. No names, phones, emails or person attributes are inputs (identity-like fields are rejected).

## Evaluation
Historical rule replay (see report.md): ${meta.total_sent.toLocaleString("en-US")} proactive sends, 6 campaigns + ${units.length - 6} legacy feeder markets, ${decisionDays.size} decision days, PIT by ops-day with observation lags. Pass A: pause on ${A_pause.length} of ${A_send.length} sending unit-days, removing ${pct(removed.filtered, totals.filtered)} of logged carrier filtering at the cost of ${pct(removed.qualified, totals.qualified)} of logged strict-qualified threads. **No counterfactual claim is made.** §211 guardrail matrix: tests/intelligence/campaign-controller-*.test.mjs.

## Limitations
Daily cadence (cannot beat an intraday human pause on a first-day burst); thresholds are operator numbers (rotation-control 2.5% opt-out / 75–80% delivery / 5% wrong number) plus the audit's 20% filtering example, not optimised; qualified-reply evidence is far too thin to justify any scale-up today (1 strict-qualified campaign thread); sender, template-governance and review-burden history is not reconstructable; classifier intents are operational signals, not labels.

## Prohibited uses
Executing anything; acting outside the canonical lifecycle/caps APIs; overriding any deterministic guardrail (DNC, STOP, wrong number, windows, sender eligibility, caps, the 50 clamp, template governance, lifecycle edges, offer authority); being read as an estimate of what unsent volume would have produced.
`;
fs.writeFileSync(path.join(OUT, "model-card.md"), card);

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.dirname(SCRIPT), encoding: "utf8" }).trim();
} catch {
  commit = null;
}
const manifest = {
  model: "campaign-controller-v0",
  controller_version: CONTROLLER_VERSION,
  kind: "historical_rule_replay_on_logged_outcomes",
  counterfactual: false,
  generated_at: new Date().toISOString(),
  code_commit_at_run: commit,
  dataset: { dir: DATASET, body_md5: meta.body_md5, n_cells: meta.n_cells, total_sent: meta.total_sent, extracted_at: meta.extracted_at, sql_file: meta.sql_file, sql_sha256: sqlSha },
  envelopes: { pass_a: { version: OPEN_ENVELOPE.version, hash: openCheck.hash }, pass_b: { version: DEFAULT_ENVELOPE.version, hash: validateEnvelope(DEFAULT_ENVELOPE).hash } },
  guardrails_version: DEFAULT_DETERMINISTIC_LIMITS.version,
  decision_days: decisionDays.size,
  unit_days_evaluated: passA.length,
  pass_a: { sending_unit_days: A_send.length, pause: A_pause.length, throttle: A_throttle.length, scale: scaleA, removed, totals },
  pass_b: { sending_unit_days: B_send.length, pause: B_send.filter((r) => isStop(r.proposal)).length },
  deterministic_rerun_identical: determinism,
};
fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, ...manifest.pass_a, pass_b: manifest.pass_b, determinism }, null, 0));
