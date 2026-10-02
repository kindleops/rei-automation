#!/usr/bin/env node
/**
 * IC 8.1 first-text model -- variants A-F on the SAME temporal split, with
 * incremental lift, leave-one-block-out ablation, block permutation
 * importance, thresholds, market-balanced metrics and market-level
 * calibration tests. Offline, deterministic, seeded; BACKTEST only.
 *
 *   A  baseline rates (base rate; market / template beta-binomial shrunk)
 *   B  property only: operational context + property facts + school district + market
 *   C  B + prospect fields          D  B + investor activity
 *   E  B + prospect + investor      F  E + wealth + owner/company/portfolio facts
 * The no-prospect variants are a scientific comparison, not the preferred
 * production design.
 *
 * Inputs: a sealed first-touch snapshot built on seller_first_touch_all@3 and
 * its sealed ft_graph_extras@1 augmentation. Outputs in
 * <out>/seller_first_touch_reply/v0/variants/.
 *
 *   node --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/train-first-text-variants.mjs --dataset=<dir> [--out=<models root>]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readNdjsonGz } from "../../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { buildFairnessReport } from "../../../src/lib/domain/intelligence/fairness/group-audit.js";
import { createV1Registry } from "../../../src/lib/domain/intelligence/features/v1-features.js";
import { temporalSplit } from "../../../src/lib/domain/intelligence/models/splits.js";
import { IC8_NAMESPACE, uuidV5 } from "../../../src/lib/domain/intelligence/util/hash.js";
import { readAugmentation } from "./build-graph-extras-augmentation.mjs";
import { armFromSet, compareScores, fitArm, fitBaselines, fullMetrics, predictArm, rollingOrigin, segmentReport, selectL2 } from "./lib/modeling.mjs";
import { familyPopulations, matureRows } from "./lib/populations.mjs";
import { ciText, f, fairnessSection, pct, verdictOf } from "./lib/report-writers.mjs";
import { BLOCKS, registerVariantSets, VARIANTS } from "./lib/variant-sets.mjs";
import { blockPermutationImportance, marketBalanced, marketCalibration, precisionRecall } from "./lib/variant-eval.mjs";

const MODELS_ROOT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/models";
const SEED = "ic8.1-first-text-variants-v0";
const HORIZON_MS = 72 * 3600e3;
const marketOf = (r) => r.features["property.market"];

export function mergeAugmentation(records, augmentation) {
  return records.map((r) => {
    const a = augmentation.bySubject.get(r.subject_id);
    if (!a) throw new Error(`augmentation missing subject ${r.subject_id}`);
    return { ...r, features: { ...r.features, ...a.features }, missingness: { ...(r.missingness || {}), ...(a.missingness || {}) } };
  });
}

const stripVersion = (ref) => String(ref).replace(/@\d+$/, "");

export function runVariants({ records, registry, sets }) {
  const rows = matureRows(familyPopulations(records).seller_first_touch_reply.rows, "reply_any@1");
  const split = temporalSplit(rows, { timeOf: (r) => r.as_of, cutoff: "2026-07-01T00:00:00.000Z", testEnd: "2026-09-29T00:00:00.000Z", horizonMs: HORIZON_MS, idOf: (r) => r.subject_id });
  const { train, test } = split;
  const y = test.map((r) => r.y);
  const baselines = fitBaselines(train);
  const scores = {};
  for (const [name, b] of Object.entries(baselines)) scores[`A_${name}`] = test.map((r) => b.predict(r));
  const armNames = Object.keys(sets).filter((k) => k !== "graph_extras");
  const models = {};
  for (const name of armNames) {
    const arm = armFromSet(sets[name], name);
    const sel = selectL2(train, arm, { horizonMs: HORIZON_MS, grid: [3, 30, 300] });
    const model = fitArm(train, arm, { l2: sel.l2 });
    models[name] = { arm, model, l2: sel.l2, l2_grid: sel.grid };
    scores[name] = predictArm(model, test, arm);
  }
  const metrics = {};
  for (const [name, p] of Object.entries(scores)) metrics[name] = fullMetrics(y, p, { seed: `${SEED}:${name}` });
  const baselineNames = Object.keys(scores).filter((k) => k.startsWith("A_"));
  const reference = [...baselineNames].sort((a, b) => metrics[a].log_loss - metrics[b].log_loss || a.localeCompare(b))[0];

  const incremental = [
    ["B_property", reference, "B property vs best baseline (A)"],
    ["C_property_prospect", "B_property", "prospect fields (C vs B)"],
    ["D_property_investor", "B_property", "investor activity (D vs B)"],
    ["E_property_prospect_investor", "D_property_investor", "prospect fields given investor (E vs D)"],
    ["E_property_prospect_investor", "C_property_prospect", "investor activity given prospect (E vs C)"],
    ["F_broad_graph", "E_property_prospect_investor", "wealth + owner/company/portfolio (F vs E)"],
    ["F_broad_graph", reference, "F vs best baseline (A)"],
  ];
  const ablations = Object.keys(sets)
    .filter((k) => k.startsWith("F_minus_"))
    .map((k) => ["F_broad_graph", k, `${k.replace("F_minus_", "")} block (F vs F without it)`]);
  const comparisons = [...incremental, ...ablations].map(([a, b, label]) => ({ a, b, label, ...compareScores(y, scores[a], scores[b], { seed: `${SEED}:cmp:${a}:${b}` }) }));

  const focus = [reference, ...Object.keys(VARIANTS)];
  const thresholds = Object.fromEntries(focus.map((n) => [n, precisionRecall(y, scores[n])]));
  const balanced = Object.fromEntries(focus.map((n) => [n, marketBalanced(test, scores[n], { segmentOf: marketOf, seed: `${SEED}:mb:${n}` })]));
  const calibration = Object.fromEntries(focus.map((n) => [n, marketCalibration(test, scores[n], { segmentOf: marketOf })]));
  const segments = {
    market: segmentReport(test, scores, { segmentOf: marketOf, names: focus, seed: `${SEED}:seg:market` }),
    template_language: segmentReport(test, scores, { segmentOf: (r) => r.strata?.template_language, names: focus, seed: `${SEED}:seg:lang` }),
    asset_family: segmentReport(test, scores, { segmentOf: (r) => r.features["property.asset_family"], names: focus, seed: `${SEED}:seg:asset` }),
  };
  const permutation = {};
  for (const name of ["E_property_prospect_investor", "F_broad_graph"]) {
    const { arm, model } = models[name];
    const blocks = Object.fromEntries(VARIANTS[name].blocks.map((b) => [b, BLOCKS[b].map(stripVersion)]));
    permutation[name] = blockPermutationImportance(test, (rs) => predictArm(model, rs, arm), blocks, { repeats: 20, seed: `${SEED}:perm:${name}` });
  }
  const rolling = rollingOrigin({ rows, arms: Object.keys(VARIANTS).map((n) => ({ arm: models[n].arm, l2: models[n].l2 })), horizonMs: HORIZON_MS, seed: `${SEED}:rolling` });
  return { split, train, test, baselines, models, scores, metrics, reference, comparisons, thresholds, balanced, calibration, segments, permutation, rolling, registry };
}

function render(res, { datasetManifest, augManifest, fairness }) {
  const L = [];
  const s = res.split;
  L.push(
    "# seller_first_touch_reply v0: first-text variants A-F (IC 8.1, BACKTEST)",
    "",
    "> The no-prospect variants (B, D) are a scientific comparison, not the preferred production design. Nothing here is deployed; every model is status BACKTEST.",
    "",
    `Dataset \`${datasetManifest.dataset_id}\` (sha256 \`${datasetManifest.sha256}\`) + augmentation \`${augManifest.feature_set_id}\` (sha256 \`${augManifest.sha256}\`). Target \`reply_any@1\` (72h). Population: delivered first-touch episode leads, mature labels.`,
    `Temporal split: train < ${s.cutoff.slice(0, 10)} (${res.train.length} rows, ${res.train.reduce((a, r) => a + r.y, 0)} positives), test ${s.cutoff.slice(0, 10)} to ${s.testEnd.slice(0, 10)} (${res.test.length} rows, ${res.test.reduce((a, r) => a + r.y, 0)} positives), purged by the 72h horizon (${s.purged.length}). L2 per variant from a time-ordered inner validation (grid 3/30/300).`,
    "",
    "## Variants",
    "",
    "| variant | inputs | blocks | l2 |",
    "|---|---|---|---|",
    ...Object.entries(VARIANTS).map(([n, v]) => `| ${n} | ${res.models[n].arm.members.length} | ${v.blocks.join(", ")} | ${res.models[n].l2} |`),
    "",
    `Blocks: ${Object.entries(BLOCKS).map(([b, m]) => `${b} (${m.length})`).join(", ")}. Missingness is tri-state and never zero-filled; seller.* mortgage/lien/sale records are unreadable through the sanctioned path and absent; property.equity_estimate_ratio is decision-snapshot-only and excluded.`,
    "",
    "## Test metrics (pooled)",
    "",
    "| predictor | AUC [95% CI] | PR-AUC [95% CI] | log loss | Brier | ECE | top-decile lift |",
    "|---|---|---|---|---|---|---|",
  );
  for (const n of Object.keys(res.metrics)) {
    const m = res.metrics[n];
    L.push(`| ${n}${n === res.reference ? " (best baseline)" : ""} | ${ciText(m.auc)} | ${ciText(m.pr_auc)} | ${f(m.log_loss, 4)} | ${f(m.brier, 4)} | ${f(m.calibration.ece, 4)} | ${f(m.lift.rows[0].lift, 2)} |`);
  }
  L.push("", "## Incremental lift and block ablation (paired bootstrap, 1,000 resamples; A - B)", "", "| row | dAUC [95% CI] | dPR-AUC [95% CI] | dlog loss [95% CI] (negative = better) | dBrier [95% CI] | verdict |", "|---|---|---|---|---|---|");
  for (const c of res.comparisons) L.push(`| ${c.label} | ${ciText(c.auc, 4)} | ${ciText(c.pr_auc, 4)} | ${ciText(c.log_loss, 5)} | ${ciText(c.brier, 5)} | ${verdictOf(c)} |`);
  L.push("", "## Block permutation importance (test set, 20 seeded permutations per block)", "");
  for (const [name, perm] of Object.entries(res.permutation)) {
    L.push(`### ${name} (test AUC ${f(perm.base_auc)}, log loss ${f(perm.base_log_loss, 4)})`, "", "| block | features | AUC drop mean [2.5%, 97.5%] | log-loss increase mean [2.5%, 97.5%] |", "|---|---|---|---|");
    for (const [b, v] of Object.entries(perm.blocks)) L.push(`| ${b} | ${v.features} | ${f(v.auc_drop.mean, 4)} [${f(v.auc_drop.lower, 4)}, ${f(v.auc_drop.upper, 4)}] | ${f(v.log_loss_increase.mean, 5)} [${f(v.log_loss_increase.lower, 5)}, ${f(v.log_loss_increase.upper, 5)}] |`);
    L.push("");
  }
  L.push("Permutation intervals are over permutations only (model and test set fixed); the paired-bootstrap ablation rows above carry the sampling uncertainty.", "");
  L.push("## Precision / recall at thresholds (test)", "");
  for (const [n, rows] of Object.entries(res.thresholds)) {
    L.push(`### ${n}`, "", "| rule | selected | precision | recall |", "|---|---|---|---|", ...rows.map((r) => `| ${r.rule} | ${r.selected} | ${pct(r.precision)} | ${pct(r.recall)} |`), "");
  }
  L.push("## Pooled vs market-balanced (macro over markets with n >= 30, >= 3 positives and negatives; market-stratified bootstrap)", "", "| predictor | pooled AUC | balanced AUC [95% CI] | pooled log loss | balanced log loss [95% CI] | markets |", "|---|---|---|---|---|---|");
  for (const [n, b] of Object.entries(res.balanced)) {
    L.push(`| ${n} | ${f(res.metrics[n].auc.estimate)} | ${ciText(b.macro_auc)} | ${f(res.metrics[n].log_loss, 4)} | ${ciText(b.macro_log_loss, 4)} | ${b.markets.map((m) => `${m.market} (${m.n})`).join(", ") || "none"} |`);
  }
  L.push("", "## Market-level calibration test (observed vs expected per market with n >= 30)", "");
  for (const [n, c] of Object.entries(res.calibration)) {
    L.push(`### ${n}: chi-square ${f(c.chi_square, 2)} on ${c.df} markets, p = ${f(c.p_value, 4)}${c.p_value !== null && c.p_value < 0.05 ? " (miscalibrated across markets)" : ""}`, "", "| market | n | observed | expected | O/E | z | p |", "|---|---|---|---|---|---|---|");
    for (const m of c.markets) L.push(`| ${m.market} | ${m.n} | ${m.observed} | ${f(m.expected, 1)} | ${f(m.observed_over_expected, 2)} | ${f(m.z, 2)} | ${f(m.p_value, 4)} |`);
    L.push("");
  }
  L.push("## Segments (test; LOW SUPPORT = n < 200 or < 20 positives/negatives)");
  for (const [seg, table] of Object.entries(res.segments)) {
    const names = [res.reference, ...Object.keys(VARIANTS)];
    L.push("", `### By ${seg}`, "", `| ${seg} | n | positives | support | ${names.map((n) => `${n} AUC [CI]`).join(" | ")} |`, `|---|---|---|---|${names.map(() => "---").join("|")}|`);
    for (const [k, e] of Object.entries(table)) L.push(`| ${k} | ${e.n} | ${e.positives} | ${e.low_support ? "LOW SUPPORT" : "ok"} | ${names.map((n) => ciText(e[n]?.auc)).join(" | ")} |`);
  }
  const rollNames = [...Object.keys(res.baselines).map((b) => b), ...Object.keys(VARIANTS)];
  L.push("", "## Rolling origin (refit each month; AUC [CI] / log loss)", "", `| month | train n | test n | positives | support | ${rollNames.join(" | ")} |`, `|---|---|---|---|---|${rollNames.map(() => "---").join("|")}|`);
  for (const r of res.rolling) {
    if (r.skipped) L.push(`| ${r.origin.slice(0, 7)} | ${r.train_n} | ${r.test_n} | ${r.test_positives} | skipped | ${rollNames.map(() => "-").join(" | ")} |`);
    else L.push(`| ${r.origin.slice(0, 7)} | ${r.train_n} | ${r.test_n} | ${r.test_positives} | ${r.low_support ? "LOW SUPPORT" : "ok"} | ${rollNames.map((n) => `${ciText(r.results[n]?.auc)} / ${f(r.results[n]?.log_loss, 4)}`).join(" | ")} |`);
  }
  L.push("", ...fairnessSection(fairness, { title: "Fairness group report: variant F (test window)" }));
  L.push(
    "## Limitations",
    "",
    "- Train (Apr-Jun) is the legacy feeder; test (Jul-Sep) is Map-operator and campaign sends in few markets: the split measures transfer across a sending-system change, and most markets are LOW SUPPORT in test.",
    "- One test window with ~123 positives: incremental-lift CIs are wide; an interval that includes 0 is 'not shown', not 'no effect'.",
    "- Owner/company/portfolio facts are vendor rollups from the 2026-04 import (equity share is a VENDOR_ESTIMATE, LOW confidence); mortgage/lien/sale records from seller.* could not be read.",
    "- Investor activity: ZIP-level counts are lower bounds where a ZIP extends beyond 2.5 miles of the property; the buyer-index archetype uses each buyer's full history.",
    "",
  );
  return `${L.join("\n")}\n`;
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  if (!args.dataset) throw new Error("usage: --dataset=<dir> [--out=<models root>]");
  const datasetManifest = JSON.parse(fs.readFileSync(path.join(args.dataset, "manifest.json"), "utf8"));
  const augmentation = readAugmentation(args.dataset);
  if (augmentation.manifest.augments_sha256 !== datasetManifest.sha256) throw new Error("augmentation belongs to another snapshot");
  const registry = createV1Registry();
  const sets = registerVariantSets(registry);
  const records = mergeAugmentation(readNdjsonGz(datasetManifest.uri.replace(/^file:\/\//, "")), augmentation);
  const res = runVariants({ records, registry, sets });
  const outDir = path.join(args.out || MODELS_ROOT, "seller_first_touch_reply", "v0", "variants");
  fs.mkdirSync(outDir, { recursive: true });
  const fId = uuidV5(`seller_first_touch_reply@0.variant_F@${datasetManifest.dataset_id}`, IC8_NAMESPACE);
  const fairness = buildFairnessReport(
    res.test.map((r, i) => ({ ...r, score: res.scores.F_broad_graph[i] })),
    { modelVersionId: fId, featureSetId: sets.F_broad_graph.featureSetId, datasetId: datasetManifest.dataset_id, generatedAt: datasetManifest.built_at, labelOf: (r) => r.y, scoreOf: (r) => r.score },
  );
  const artifact = {
    dataset_id: datasetManifest.dataset_id,
    augmentation_sha256: augmentation.manifest.sha256,
    variants: Object.fromEntries(
      Object.keys(VARIANTS).map((n) => {
        const { arm, model, l2 } = res.models[n];
        return [n, { feature_set_id: arm.featureSetId, feature_set_hash: arm.featureSetHash, members: arm.members, l2, column_transforms: arm.transforms, ...model, model_version_id: uuidV5(`seller_first_touch_reply@0.variant_${n}@${datasetManifest.dataset_id}`, IC8_NAMESPACE) }];
      }),
    ),
  };
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, "artifact.json"), artifactText);
  const json = {
    dataset_id: datasetManifest.dataset_id,
    artifact_sha256: createHash("sha256").update(artifactText).digest("hex"),
    split: { cutoff: res.split.cutoff, test_end: res.split.testEnd, train: res.train.length, test: res.test.length, purged: res.split.purged.length },
    reference_baseline: res.reference,
    metrics: res.metrics,
    comparisons: res.comparisons,
    thresholds: res.thresholds,
    market_balanced: res.balanced,
    market_calibration: res.calibration,
    segments: res.segments,
    permutation_importance: res.permutation,
    rolling: res.rolling,
    l2: Object.fromEntries(Object.entries(res.models).map(([n, m]) => [n, { l2: m.l2, grid: m.l2_grid, fit: m.model.fit }])),
  };
  fs.writeFileSync(path.join(outDir, "variants.json"), `${JSON.stringify(json, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "fairness-report-variant-F.json"), `${JSON.stringify(fairness, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), render(res, { datasetManifest, augManifest: augmentation.manifest, fairness }));
  for (const c of res.comparisons) console.log(`${c.label}: dAUC ${ciText(c.auc, 4)} dLL ${ciText(c.log_loss, 5)} -> ${verdictOf(c)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
