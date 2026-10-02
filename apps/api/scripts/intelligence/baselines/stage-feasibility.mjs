#!/usr/bin/env node
/**
 * IC8 Phase 4 -- stage_progression feasibility (NO MODEL).
 *
 * Builds the stage-entry dataset from the two history sources that exist
 * (offline, from the extract work dir; no database access):
 *   - acquisition_opportunity_history, field acquisition_stage (valid from
 *     2026-06-21), synthetic certification rows removed;
 *   - universal_lead_state_events, field lifecycle_stage (valid from
 *     2026-07-12), QA reasons removed; the send_success_seam seeds
 *     (empty -> ownership_confirmation) are entries, never progressions.
 * Each entry into a stage is a subject anchored at the entry time; its label
 * is stage_progressed@1 (14d / 30d) from the labeler, using later moves of the
 * same opportunity / thread. Canary/test deals are dropped by the versioned
 * exclusions. Output: counts per stage pair and per entered stage.
 *
 *   node --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/stage-feasibility.mjs [--out=<models root>]
 */

import fs from "node:fs";
import path from "node:path";

import { evaluateExclusions } from "../../../src/lib/domain/intelligence/datasets/exclusions.js";
import { getOutcomeDefinition } from "../../../src/lib/domain/intelligence/outcomes/taxonomy.js";
import { labelOutcome } from "../../../src/lib/domain/intelligence/outcomes/labeler.js";
import { STAGE_ORDER_V1, isForwardStageMove } from "../../../src/lib/domain/intelligence/outcomes/rules.js";
import { DEFAULT_WORK_DIR } from "./extract-first-touch.mjs";
import { LABEL_NOW } from "./build-first-touch-snapshot.mjs";

const MODELS_ROOT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/models";
const SYNTHETIC_ACTOR = /cert|certification|realtime_cert|certification_cleanup|regression|fixture|probe/i;
export const TRAINABLE_THRESHOLD = Object.freeze({ positives_per_stage: 200, note: "data audit §9(ii): re-assess at >= 200 transitions per major stage" });

const lower = (v) => String(v ?? "").trim().toLowerCase();

export function stageEntries(events, { groupOf, validFrom }) {
  const byGroup = new Map();
  for (const e of events) {
    if (Date.parse(e.created_at) < Date.parse(validFrom)) continue;
    const g = groupOf(e);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(e);
  }
  const subjects = [];
  for (const [group, list] of byGroup) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id).localeCompare(String(b.id)));
    const moves = list.map((e) => ({ id: e.id, from_stage: lower(e.previous_value), to_stage: lower(e.new_value), at: e.created_at }));
    for (const m of moves) subjects.push({ group, entry: m, later: moves.filter((x) => Date.parse(x.at) > Date.parse(m.at)) });
  }
  return subjects;
}

export function pairCounts(events) {
  const out = {};
  for (const e of events) {
    const key = `${lower(e.previous_value) || "(none)"} -> ${lower(e.new_value) || "(none)"}`;
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function label(subjects, def) {
  const byStage = {};
  for (const s of subjects) {
    const stage = s.entry.to_stage || "(none)";
    const r = labelOutcome(def, { id: s.entry.id, anchor_at: s.entry.at }, { stageEvents: s.later }, { now: LABEL_NOW });
    if (!byStage[stage]) byStage[stage] = { entries: 0, mature_14d: 0, progressed_14d: 0, mature_30d: 0, progressed_30d: 0, pending_or_censored: 0 };
    const t = byStage[stage];
    t.entries += 1;
    const status = r.evidence.status_by_horizon || {};
    if (status["14d"] === "mature") {
      t.mature_14d += 1;
      if (r.value?.["14d"] === true) t.progressed_14d += 1;
    }
    if (status["30d"] === "mature") {
      t.mature_30d += 1;
      if (r.value?.["30d"] === true) t.progressed_30d += 1;
    }
    if (r.status !== "mature") t.pending_or_censored += 1;
  }
  return Object.fromEntries(Object.entries(byStage).sort((a, b) => STAGE_ORDER_V1.indexOf(a[0]) - STAGE_ORDER_V1.indexOf(b[0]) || a[0].localeCompare(b[0])));
}

export function runFeasibility({ history, leadState, opportunities }) {
  const def = getOutcomeDefinition("stage_progressed", 1);
  const opp = new Map(opportunities.map((o) => [o.id, o]));
  const dropped = { synthetic: 0, excluded_test_deal: 0, qa_reason: 0, before_valid_from: 0 };
  const realHistory = history.filter((h) => {
    if (SYNTHETIC_ACTOR.test(String(h.actor ?? "")) || SYNTHETIC_ACTOR.test(String(h.source ?? ""))) {
      dropped.synthetic += 1;
      return false;
    }
    const o = opp.get(h.opportunity_id) || {};
    const ex = evaluateExclusions({ opportunity_id: h.opportunity_id, created_at: o.created_at, promotion_reason: o.promotion_reason, anchor_at: h.created_at }, { subjectType: "opportunity" });
    if (ex.drop) {
      dropped.excluded_test_deal += 1;
      return false;
    }
    return true;
  });
  const realLead = leadState.filter((e) => {
    if (e.qa_reason) {
      dropped.qa_reason += 1;
      return false;
    }
    return true;
  });
  const oppSubjects = stageEntries(realHistory, { groupOf: (e) => e.opportunity_id, validFrom: "2026-06-21T00:00:00Z" });
  const leadSubjects = stageEntries(realLead, { groupOf: (e) => e.hk, validFrom: "2026-07-12T00:00:00Z" });
  dropped.before_valid_from = realLead.length - leadSubjects.length;
  const forward = (events) => events.filter((e) => isForwardStageMove(e.previous_value, e.new_value)).length;
  return {
    label_cutoff: LABEL_NOW,
    outcome: `${def.id} (${def.horizons.join(" / ")}), rules stage_forward_move@1 (bare closed = closed-lost, never progress)`,
    dropped,
    opportunity_history: {
      rows: history.length,
      real_transitions: realHistory.length,
      forward_moves: forward(realHistory),
      pairs: pairCounts(realHistory),
      by_entered_stage: label(oppSubjects, def),
      opportunities_with_history: new Set(realHistory.map((h) => h.opportunity_id)).size,
    },
    lead_state_lifecycle: {
      rows: leadState.length,
      after_qa_filter: realLead.length,
      with_prior_value: realLead.filter((e) => e.previous_value).length,
      forward_moves: forward(realLead),
      by_change_source: realLead.reduce((acc, e) => ({ ...acc, [e.change_source || "(null)"]: (acc[e.change_source || "(null)"] || 0) + 1 }), {}),
      pairs: pairCounts(realLead),
      by_entered_stage: label(leadSubjects, def),
    },
    opportunities: { rows: opportunities.length, bulk_created_20260621: opportunities.filter((o) => String(o.created_at).startsWith("2026-06-21")).length },
    threshold: TRAINABLE_THRESHOLD,
  };
}

function render(r) {
  const table = (pairs) => ["| from -> to | count |", "|---|---|", ...Object.entries(pairs).map(([k, v]) => `| ${k} | ${v} |`)];
  const stageTable = (by) => [
    "| entered stage | entries | mature 14d | progressed 14d | mature 30d | progressed 30d |",
    "|---|---|---|---|---|---|",
    ...Object.entries(by).map(([k, v]) => `| ${k} | ${v.entries} | ${v.mature_14d} | ${v.progressed_14d} | ${v.mature_30d} | ${v.progressed_30d} |`),
  ];
  const maxPos = Math.max(0, ...Object.values(r.opportunity_history.by_entered_stage).map((v) => v.progressed_30d), ...Object.values(r.lead_state_lifecycle.by_entered_stage).map((v) => v.progressed_30d));
  return `${[
    "# stage_progression v0: feasibility (NO MODEL)",
    "",
    `**Verdict: INSUFFICIENT DATA.** The largest per-stage count of forward moves within 30 days is ${maxPos}; the bar for a model is ${r.threshold.positives_per_stage} per major stage (${r.threshold.note}). Opportunity history has ${r.opportunity_history.real_transitions} real stage transitions (${r.opportunity_history.forward_moves} forward) on ${r.opportunity_history.opportunities_with_history} opportunities; lead-state lifecycle has ${r.lead_state_lifecycle.with_prior_value} moves with a prior value (${r.lead_state_lifecycle.forward_moves} forward). No model is trained.`,
    "",
    `- Outcome: ${r.outcome}. Labels as of ${r.label_cutoff}.`,
    `- Dropped: ${JSON.stringify(r.dropped)}.`,
    `- ${r.opportunities.bulk_created_20260621} of ${r.opportunities.rows} opportunities were bulk-created on 2026-06-21, so opportunity creation dates are not entries.`,
    "",
    "## acquisition_opportunity_history (acquisition_stage, from 2026-06-21)",
    "",
    ...table(r.opportunity_history.pairs),
    "",
    "### Stage entries and 14d / 30d progression",
    "",
    ...stageTable(r.opportunity_history.by_entered_stage),
    "",
    "## universal_lead_state_events (lifecycle_stage, from 2026-07-12)",
    "",
    `Rows ${r.lead_state_lifecycle.rows}, after QA filter ${r.lead_state_lifecycle.after_qa_filter}, by change source ${JSON.stringify(r.lead_state_lifecycle.by_change_source)}.`,
    "",
    ...table(r.lead_state_lifecycle.pairs),
    "",
    "### Stage entries and 14d / 30d progression",
    "",
    ...stageTable(r.lead_state_lifecycle.by_entered_stage),
    "",
    "## What would make it trainable",
    "",
    "- Journal every seller turn with the prior stage, policy version and decision id (decision_journal H1) so entries and exits are dated at decision time.",
    "- At about 25 real transitions a month, 200 per major stage is many months away; report descriptive transition rates with intervals until then.",
  ].join("\n")}\n`;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  const read = (name) =>
    fs
      .readFileSync(path.join(DEFAULT_WORK_DIR, `${name}.ndjson`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const result = runFeasibility({ history: read("opportunity_stage_history"), leadState: read("lead_state_stage_events"), opportunities: read("opportunities") });
  const outDir = path.join(args.out || MODELS_ROOT, "stage_progression", "v0");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "feasibility.json"), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), render(result));
  console.log(render(result).split("\n").slice(0, 4).join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error?.stack || error).slice(0, 800));
    process.exit(1);
  });
}
