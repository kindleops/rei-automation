#!/usr/bin/env node
/**
 * IC8 Phase 4 -- first offline baseline models over ONE sealed snapshot.
 * Offline, deterministic, seeded; reads no database.
 *
 *   seller_first_touch_reply  reply_any@1 (primary) + reply_meaningful@1
 *                             arms: base (seller_first_touch@1) and
 *                             all_fields (seller_first_touch_all@1)
 *                             + the fairness group report for each arm
 *   send_opt_out_risk         opt_out_keyword@1, base arm (delivery_risk
 *                             families take permitted inputs only)
 *   send_carrier_filtering    carrier_filtered@1, base arm
 *
 * Outputs per family, in <out>/<family>/v0/: report.md, model-card.md,
 * manifest.json (intelligence.model_versions rows), artifact.json
 * (coefficients + standardisation), evaluation.json (all numbers), and for
 * the reply family fairness-report.json. Status: BACKTEST.
 *
 * Run from apps/api:
 *   node --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/train-first-touch-baselines.mjs --dataset=<dataset dir> [--out=<models root>]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readNdjsonGz } from "../../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { buildFairnessReport, validateFairnessReport } from "../../../src/lib/domain/intelligence/fairness/group-audit.js";
import { createV1Registry } from "../../../src/lib/domain/intelligence/features/v1-features.js";
import { IC8_NAMESPACE, stableStringify, uuidV5 } from "../../../src/lib/domain/intelligence/util/hash.js";
import { armFromSet, ENCODER_DEFAULTS, runFamily, UNAVAILABLE_FEATURES } from "./lib/modeling.mjs";
import { familyPopulations, FAMILY_TARGETS, matureRows } from "./lib/populations.mjs";
import { evaluationSection, fairnessSection, f, headline, modelVersionRow, pct, verdictOf } from "./lib/report-writers.mjs";

export const MODELS_ROOT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/models";
const SEED = "ic8-phase4-v0";

const TRANSFORM_DOC = Object.freeze({
  log1p_units: "log1p(min(units_count, 500))",
  log_sqft: "log(clamp(living_sqft, 200, 200000))",
  bedrooms: "min(bedrooms, 20)",
  bathrooms: "min(bathrooms, 15)",
  year_built: "year_built",
  prior_touches: "min(prior_touch_count, 10)",
  log1p_days_since_touch: "log1p(max(0, days_since_last_touch))",
  prior_delivered: "min(prior_delivered_count, 10)",
});

const SEGMENTS = Object.freeze({
  market: (r) => r.features["property.market"],
  template_language: (r) => r.strata?.template_language,
  asset_family: (r) => r.features["property.asset_family"],
});

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function stripRuntime(result) {
  const { models, scores, test, train, ...rest } = result;
  return { ...rest, models: models.map((m) => ({ arm: m.arm.name, feature_set_id: m.arm.featureSetId, l2: m.l2, fit: m.model.fit })) };
}

function artifactFor(model, arm) {
  return {
    ...model,
    arm: { name: arm.name, feature_set_id: arm.featureSetId, feature_set_hash: arm.featureSetHash, members: arm.members, excluded_unavailable: arm.excluded_unavailable },
    column_transforms: Object.fromEntries(arm.numeric.map((n) => [n, TRANSFORM_DOC[n] || arm.transforms[n] || null])),
    scoring: "p = sigmoid(intercept + sum(coef_j * x_j)); numeric x = (transform(value) - mean) / std (missing -> 0 plus its __missing__ indicator); categorical one-hot over frozen levels, unseen -> __other__",
  };
}

function trainWindowOf(result) {
  return { from: result.split.train.from, to_exclusive: result.split.cutoff, test_from: result.split.cutoff, test_to_exclusive: result.split.test_end };
}

function cardMarkdown(card) {
  const lines = [`# Model card: ${card.family} v0 (${card.status})`, ""];
  for (const [k, v] of Object.entries(card)) {
    if (k === "family" || k === "status") continue;
    if (Array.isArray(v)) {
      lines.push(`## ${k.replace(/_/g, " ")}`, "", ...v.map((x) => `- ${x}`), "");
    } else if (v && typeof v === "object") {
      lines.push(`## ${k.replace(/_/g, " ")}`, "", ...Object.entries(v).map(([a, b]) => `- **${a}:** ${typeof b === "string" ? b : JSON.stringify(b)}`), "");
    } else {
      lines.push(`## ${k.replace(/_/g, " ")}`, "", String(v), "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function metricSummary(result, name) {
  const m = result.metrics[name];
  return `AUC ${f(m.auc.estimate)} [${f(m.auc.lower)}, ${f(m.auc.upper)}], PR-AUC ${f(m.pr_auc.estimate)} [${f(m.pr_auc.lower)}, ${f(m.pr_auc.upper)}], log loss ${f(m.log_loss, 4)}, Brier ${f(m.brier, 4)}, ECE ${f(m.calibration.ece, 4)} (test n=${m.n}, positives=${m.positives})`;
}

const COMMON_LIMITATIONS = [
  "The Jul-Sep test window is a different sending system (Map operator sends in July, campaign sends in September) from the Apr-Jun legacy-feeder training window: the test measures transfer across that shift, and most test templates were never seen in training (they fall to __other__).",
  "Most markets have no or LOW SUPPORT test rows; per-market results are descriptive only.",
  "property.years_since_last_recorded_sale and property.recorded_mortgage_count were not readable (seller.* is not exposed via PostgREST; direct Postgres credentials are stale) and are excluded.",
  "properties was bulk-rewritten in 2026-08: structural facts may include later corrections (documented PIT caveat).",
  "Labels are thread-level (seller = phone); a later send on the thread inside the horizon is not removed (labeler v1).",
  "One snapshot, one test window: the confidence intervals are bootstrap intervals over test rows and do not cover the regime shift itself.",
];

function writeFamily({ outDir, family, datasetManifest, results, fairness, card, versions }) {
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = { family, dataset_id: datasetManifest.dataset_id, arms: {} };
  for (const v of versions) artifact.arms[v.arm.name] = artifactFor(v.model, v.arm);
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, "artifact.json"), artifactText);
  const artifactSha = sha256(artifactText);
  const rows = versions.map((v) =>
    modelVersionRow({
      modelVersionId: v.modelVersionId,
      family,
      version: v.version,
      datasetManifest,
      arm: v.arm,
      params: {
        algorithm: "logistic_l2_irls (models/logistic.js)",
        l2: v.l2,
        l2_selection: "time-ordered inner validation, last 20% of train, purged by horizon, grid [1,3,10,30,100,300], min log loss",
        encoder: ENCODER_DEFAULTS,
        max_iter: 50,
        excluded_unavailable_features: [...UNAVAILABLE_FEATURES],
        seed: SEED,
      },
      trainWindow: trainWindowOf(results.primary),
      codeCommit: datasetManifest.code_commit,
      metrics: { target: card.target, test: headline(results.primary.metrics[v.arm.name]), vs_reference_baseline: results.primary.comparisons[`${v.arm.name}_vs_${results.primary.reference_baseline}`] },
      baselineMetrics: Object.fromEntries(Object.keys(results.primary.baselines).map((b) => [b, headline(results.primary.metrics[b])])),
      artifact: artifact.arms[v.arm.name],
      artifactSha256: artifactSha,
      artifactUri: `file://${path.join(outDir, "artifact.json")}#arms.${v.arm.name}`,
      modelCard: card,
    }),
  );
  writeJson(path.join(outDir, "manifest.json"), { schema: "intelligence.model_versions (architecture §2)", model_versions: rows });
  writeJson(
    path.join(outDir, "evaluation.json"),
    Object.fromEntries(Object.entries(results).map(([k, r]) => [k, stripRuntime(r)])),
  );
  if (fairness) writeJson(path.join(outDir, "fairness-report.json"), fairness);
  fs.writeFileSync(path.join(outDir, "model-card.md"), cardMarkdown(card));
}

export async function trainAll({ datasetDir, outRoot = MODELS_ROOT, log = console.log }) {
  const datasetManifest = JSON.parse(fs.readFileSync(path.join(datasetDir, "manifest.json"), "utf8"));
  const records = readNdjsonGz(datasetManifest.uri.replace(/^file:\/\//, ""));
  const registry = createV1Registry();
  const sets = {
    base_v1: registry.getSet("seller_first_touch@1"),
    base: registry.getSet("seller_first_touch@3"),
    all_fields: registry.getSet("seller_first_touch_all@3"),
  };
  if (datasetManifest.feature_set_id !== sets.all_fields.featureSetId || datasetManifest.feature_set_hash !== sets.all_fields.definitionHash) {
    throw new Error("snapshot feature set does not match seller_first_touch_all@3 in this registry");
  }
  for (const set of Object.values(sets)) registry.assertSetForFamily(set.featureSetId, "seller_first_touch_reply");
  for (const family of ["send_opt_out_risk", "send_carrier_filtering"]) {
    registry.assertSetForFamily(sets.base.featureSetId, family);
    registry.assertSetForFamily(sets.base_v1.featureSetId, family);
  }
  const arms = Object.fromEntries(Object.entries(sets).map(([name, set]) => [name, armFromSet(set, name)]));
  const armBase = arms.base;
  const armAll = arms.all_fields;
  const replyArms = [arms.base, arms.all_fields];
  const replyPairs = [["all_fields", "base"]];
  const pops = familyPopulations(records);
  const ds = datasetManifest.dataset_id;
  const summary = {};

  // ── seller_first_touch_reply ──
  {
    const family = "seller_first_touch_reply";
    log(`${family}: reply_any@1`);
    const primary = runFamily({ family, rows: matureRows(pops[family].rows, "reply_any@1"), arms: replyArms, pairs: replyPairs, horizonMs: FAMILY_TARGETS[family].horizonMs, seed: SEED, segments: SEGMENTS });
    log(`${family}: reply_meaningful@1`);
    const secondary = runFamily({ family: `${family}:meaningful`, rows: matureRows(pops[family].rows, "reply_meaningful@1"), arms: replyArms, pairs: replyPairs, horizonMs: FAMILY_TARGETS[family].horizonMs, seed: SEED, segments: SEGMENTS });
    const versions = primary.models.map((m) => ({
      ...m,
      version: `0.${m.arm.name}`,
      modelVersionId: uuidV5(`${family}@0.${m.arm.name}@${ds}`, IC8_NAMESPACE),
    }));
    const fairness = {};
    for (const v of versions.filter((x) => x.arm.name === "base" || x.arm.name === "all_fields")) {
      const scored = primary.test.map((r, i) => ({ ...r, score: primary.scores[v.arm.name][i] }));
      const report = buildFairnessReport(scored, {
        modelVersionId: v.modelVersionId,
        featureSetId: v.arm.featureSetId,
        datasetId: ds,
        generatedAt: datasetManifest.built_at,
        labelOf: (r) => r.y,
        scoreOf: (r) => r.score,
      });
      const valid = validateFairnessReport(report, { modelVersionId: v.modelVersionId });
      if (!valid.ok) throw new Error(`fairness report invalid: ${valid.problems.join("; ")}`);
      fairness[v.arm.name] = report;
    }
    const outDir = path.join(outRoot, family, "v0");
    const lift = primary.comparisons[`all_fields_vs_base`];
    const card = {
      family,
      status: "BACKTEST",
      purpose: "Estimate P(any reply within 72h | delivered first-touch ownership_check send) for offline research on who is likely to respond. Not wired to any decision.",
      target: "reply_any@1 (behaviour, 72h); secondary reply_meaningful@1 (rules meaningful_reply@1 + stop_family_exact@1)",
      data: { dataset_id: ds, dataset_sha256: datasetManifest.sha256, population: "episode leads (one row per first-touch burst) whose lead send was delivered", window: `${datasetManifest.spec.asOfWindow.from} to ${datasetManifest.spec.asOfWindow.to}`, label_cutoff: datasetManifest.spec.labelNow },
      arms: {
        base: `seller_first_touch@3 minus unavailable features: ${armBase.members.length} inputs (permitted: operational, property, school district, market, owner entity class, 40 market_investor_activity)`,
        all_fields: `seller_first_touch_all@3 minus unavailable features: ${armAll.members.length} inputs (adds gender, marital status, owner language, agent persona, age band, income band, education, occupation and the two modeled-wealth bands; owner decisions 2026-10-01/02)`,
        variants: "variants/report.md: A-F incremental lift, block ablation (incl. separate wealth, school district, investor, prospect rows), permutation importance, market-balanced metrics",
      },
      metrics: {
        base: metricSummary(primary, "base"),
        all_fields: metricSummary(primary, "all_fields"),
        reference_baseline: `${primary.reference_baseline}: ${metricSummary(primary, primary.reference_baseline)}`,
        base_vs_baseline: verdictOf(primary.comparisons[`base_vs_${primary.reference_baseline}`]),
        all_fields_vs_baseline: verdictOf(primary.comparisons[`all_fields_vs_${primary.reference_baseline}`]),
        all_fields_vs_base: `dAUC ${f(lift.auc.estimate, 4)} [${f(lift.auc.lower, 4)}, ${f(lift.auc.upper, 4)}], dlog loss ${f(lift.log_loss.estimate, 5)} [${f(lift.log_loss.lower, 5)}, ${f(lift.log_loss.upper, 5)}]: ${verdictOf(lift)}`,

      },
      fairness: "fairness-report.json: performance and score distribution by each personal-attribute group for both arms (test window).",
      limitations: COMMON_LIMITATIONS,
      prohibited_uses: [
        "Any live decision, ranking, suppression or send while status is BACKTEST (promotion goes through the model registry gates).",
        "Valuation, offer, negotiation or buyer selection.",
        "Use as a label or as ground truth for another model.",
        "Showing a seller's personal attributes, or attribute-driven reasons, to operators as a justification.",
        "Overriding any deterministic rule: DNC/STOP, wrong number, contact windows, sender health, caps, compliance.",
      ],
      reproducibility: "deterministic IRLS, seeded bootstrap; rerunning on the same snapshot reproduces every output byte (see determinism.json)",
    };
    writeFamily({ outDir, family, datasetManifest, results: { primary, secondary }, fairness, card, versions });
    const report = [
      `# ${family} v0: evaluation report (BACKTEST)`,
      "",
      `Dataset \`${ds}\` (sha256 \`${datasetManifest.sha256}\`), ${records.length} snapshot rows; population ${pops[family].rows.length} delivered episode leads. Period ${datasetManifest.spec.asOfWindow.from.slice(0, 10)} to ${datasetManifest.spec.asOfWindow.to.slice(0, 10)} (exclusive); labels as of ${datasetManifest.spec.labelNow}.`,
      "",
      "**Arms (the foundation's per-model contracts).** The A-F variant study with block ablations is in `variants/report.md`.",
      `- base (seller_first_touch@3): ${arms.base_v1.members.join(", ")}, school district, plus the 40 market_investor_activity features.`,
      `- all_fields (seller_first_touch_all@3): base + ${armAll.members.filter((m) => !armBase.members.includes(m)).join(", ")}.`,
      `- excluded (unreadable source): ${UNAVAILABLE_FEATURES.join(", ")}.`,
      "",
      "**Baselines.** base_rate (training mean); market_rate and template_rate (beta-binomial empirical-Bayes shrunk rates by property market / template id, unseen keys get the prior mean).",
      "",
      "## Verdict",
      "",
      `- reply_any@1: base vs ${primary.reference_baseline}: **${verdictOf(primary.comparisons[`base_vs_${primary.reference_baseline}`])}**; all_fields vs ${primary.reference_baseline}: **${verdictOf(primary.comparisons[`all_fields_vs_${primary.reference_baseline}`])}**; all_fields vs base (personal attributes + wealth): **${verdictOf(lift)}**.`,
      `- reply_meaningful@1: base vs ${secondary.reference_baseline}: **${verdictOf(secondary.comparisons[`base_vs_${secondary.reference_baseline}`])}**; all_fields vs base: **${verdictOf(secondary.comparisons.all_fields_vs_base)}**.`,
      "",
      ...evaluationSection(primary, { title: "Primary target: reply_any@1 (72h)", target: "reply_any@1" }),
      ...evaluationSection(secondary, { title: "Secondary target: reply_meaningful@1 (72h, rules meaningful_reply@1)", target: "reply_meaningful@1" }),
      ...fairnessSection(fairness.all_fields, { title: "Fairness group report: all_fields arm (test window)" }),
      ...fairnessSection(fairness.base, { title: "Fairness group report: base arm (same groups, for comparison)" }),
      "## Known limitations",
      "",
      ...COMMON_LIMITATIONS.map((x) => `- ${x}`),
      "",
    ];
    fs.writeFileSync(path.join(outDir, "report.md"), `${report.join("\n")}\n`);
    summary[family] = { primary: stripRuntime(primary).comparisons, reference: primary.reference_baseline };
  }

  // ── delivery-risk families (base arm only) ──
  for (const family of ["send_opt_out_risk", "send_carrier_filtering"]) {
    const { target, horizonMs } = FAMILY_TARGETS[family];
    log(`${family}: ${target}`);
    const primary = runFamily({ family, rows: matureRows(pops[family].rows, target), arms: [arms.base_v1, armBase], pairs: [["base", "base_v1"]], horizonMs, seed: SEED, segments: SEGMENTS });
    const versions = primary.models.map((m) => ({ ...m, version: m.arm.name === "base" ? "0" : "0.base_v1", modelVersionId: uuidV5(`${family}@${m.arm.name === "base" ? "0" : "0.base_v1"}@${ds}`, IC8_NAMESPACE) }));
    const outDir = path.join(outRoot, family, "v0");
    const population = family === "send_carrier_filtering" ? "every sent first-touch send (a filtered send is never delivered)" : "delivered episode leads (same rows as the reply family)";
    const card = {
      family,
      status: "BACKTEST",
      purpose:
        family === "send_carrier_filtering"
          ? "Estimate P(carrier spam filtering within 24h | sent first touch), a safety metric for the campaign controller."
          : "Estimate P(exact STOP-family keyword within 7 days | delivered first touch), a safety metric for the campaign controller.",
      target: `${target} (${family === "send_carrier_filtering" ? "behaviour" : "deterministic rule stop_family_exact@1"})`,
      data: { dataset_id: ds, dataset_sha256: datasetManifest.sha256, population, window: `${datasetManifest.spec.asOfWindow.from} to ${datasetManifest.spec.asOfWindow.to}`, label_cutoff: datasetManifest.spec.labelNow },
      arms: {
        base: `seller_first_touch@3 minus unavailable features (${armBase.members.length} inputs, incl. school district and the 40 market_investor_activity features). delivery_risk families take permitted inputs only.`,
        base_v1: `seller_first_touch@1 (${arms.base_v1.members.length} inputs): ablation without the investor block and school district`,
      },
      metrics: {
        base: metricSummary(primary, "base"),
        base_v1: metricSummary(primary, "base_v1"),
        investor_and_school_block: `base vs base_v1: ${verdictOf(primary.comparisons.base_vs_base_v1)}`,
        reference_baseline: `${primary.reference_baseline}: ${metricSummary(primary, primary.reference_baseline)}`,
        base_vs_baseline: verdictOf(primary.comparisons[`base_vs_${primary.reference_baseline}`]),
      },
      limitations: [
        ...COMMON_LIMITATIONS,
        family === "send_carrier_filtering"
          ? "Carrier filtering depends on wording, sender number and carrier policy at send time; sender number and carrier are not features in v1, and the 2026-09-28 wording regime differs from Apr-Aug."
          : "Opt-out positives are small; sends after 2026-09-25 are still pending at the label cutoff and excluded.",
      ],
      prohibited_uses: [
        "Any live decision while status is BACKTEST.",
        "Use as a label or ground truth.",
        "Overriding any deterministic rule (STOP/DNC, windows, sender health, caps).",
      ],
      reproducibility: "deterministic IRLS, seeded bootstrap; rerunning on the same snapshot reproduces every output byte (see determinism.json)",
    };
    writeFamily({ outDir, family, datasetManifest, results: { primary }, fairness: null, card, versions });
    const report = [
      `# ${family} v0: evaluation report (BACKTEST)`,
      "",
      `Dataset \`${ds}\` (sha256 \`${datasetManifest.sha256}\`); population: ${population}, ${pops[family].rows.length} rows. Labels as of ${datasetManifest.spec.labelNow}.`,
      "",
      `**Features.** base (seller_first_touch@3): ${arms.base_v1.members.join(", ")} + school district + the 40 market_investor_activity features; base_v1 (@1): without them. Excluded (unreadable source): ${UNAVAILABLE_FEATURES.join(", ")}.`,
      "",
      "**Baselines.** base_rate; market_rate and template_rate (beta-binomial shrunk).",
      "",
      "## Verdict",
      "",
      `- base vs ${primary.reference_baseline}: **${verdictOf(primary.comparisons[`base_vs_${primary.reference_baseline}`])}**; base_v1 vs ${primary.reference_baseline}: **${verdictOf(primary.comparisons[`base_v1_vs_${primary.reference_baseline}`])}**; investor activity + school district block (base vs base_v1): **${verdictOf(primary.comparisons.base_vs_base_v1)}**.`,
      "",
      ...evaluationSection(primary, { title: `Target: ${target}`, target }),
      "## Known limitations",
      "",
      ...card.limitations.map((x) => `- ${x}`),
      "",
    ];
    fs.writeFileSync(path.join(outDir, "report.md"), `${report.join("\n")}\n`);
    summary[family] = { primary: stripRuntime(primary).comparisons, reference: primary.reference_baseline };
  }
  return { summary, datasetId: ds };
}

/** sha256 of every file under a root (relative paths), for the determinism proof. */
export function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name !== "determinism.json") out[path.relative(root, full)] = sha256(fs.readFileSync(full, "utf8").split(root).join("<root>"));
    }
  };
  walk(root);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  if (!args.dataset) {
    console.error("usage: --dataset=<sealed dataset dir> [--out=<models root>]");
    process.exit(2);
  }
  trainAll({ datasetDir: args.dataset, outRoot: args.out || MODELS_ROOT })
    .then(({ summary }) => console.log(stableStringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Object.fromEntries(Object.entries(v.primary).map(([c, d]) => [c, { auc: d.auc.estimate, auc_ci: [d.auc.lower, d.auc.upper], ll: d.log_loss.estimate, ll_ci: [d.log_loss.lower, d.log_loss.upper] }]))])))))
    .catch((error) => {
      console.error(String(error?.stack || error).slice(0, 1200));
      process.exit(1);
    });
}

export { pct };
