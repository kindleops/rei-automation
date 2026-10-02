/**
 * IC8 baselines: markdown + JSON renderers for model reports, model cards and
 * registry-ingestable manifests. Pure string/object builders (the caller
 * writes files). No timestamps other than those passed in, so reruns match.
 */

const f = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : Number(v).toFixed(d));
const pct = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${(100 * v).toFixed(d)}%`);
const ciText = (m, d = 3) => (m && m.estimate !== undefined ? `${f(m.estimate, d)} [${f(m.lower, d)}, ${f(m.upper, d)}]` : "n/a");

export function verdictOf(cmp) {
  const aucBetter = cmp.auc.lower !== null && cmp.auc.lower > 0;
  const llBetter = cmp.log_loss.upper !== null && cmp.log_loss.upper < 0;
  const aucWorse = cmp.auc.upper !== null && cmp.auc.upper < 0;
  const llWorse = cmp.log_loss.lower !== null && cmp.log_loss.lower > 0;
  if (aucBetter && llBetter) return "BEATS (AUC and log loss, CIs exclude 0)";
  if (aucBetter || llBetter) return `PARTIAL (${aucBetter ? "AUC" : "log loss"} only, CI excludes 0)`;
  if (aucWorse || llWorse) return `WORSE (${aucWorse ? "AUC" : ""}${aucWorse && llWorse ? " and " : ""}${llWorse ? "log loss" : ""} CI excludes 0)`;
  return "NO DETECTABLE DIFFERENCE (CIs include 0)";
}

function metricsTable(result, names) {
  const lines = ["| predictor | AUC [95% CI] | PR-AUC [95% CI] | log loss | Brier | ECE (uniform 10) | top-decile lift |", "|---|---|---|---|---|---|---|"];
  for (const name of names) {
    const m = result.metrics[name];
    lines.push(
      `| ${name} | ${ciText(m.auc)} | ${ciText(m.pr_auc)} | ${f(m.log_loss, 4)} | ${f(m.brier, 4)} | ${f(m.calibration.ece, 4)} | ${f(m.lift.rows[0].lift, 2)} |`,
    );
  }
  return lines;
}

function comparisonLines(result) {
  const lines = ["| comparison (A - B) | dAUC [95% CI] | dPR-AUC [95% CI] | dlog loss [95% CI] (negative = A better) | verdict |", "|---|---|---|---|---|"];
  for (const [name, c] of Object.entries(result.comparisons)) {
    lines.push(`| ${name} | ${ciText(c.auc, 4)} | ${ciText(c.pr_auc, 4)} | ${ciText(c.log_loss, 5)} | ${verdictOf(c)} |`);
  }
  return lines;
}

function reliabilityLines(m) {
  const lines = ["| bin (quantile) | n | mean predicted | observed | gap |", "|---|---|---|---|---|"];
  for (const b of m.reliability_quantile.bins) lines.push(`| ${b.index + 1} | ${b.n} | ${f(b.mean_predicted, 4)} | ${f(b.observed_rate, 4)} | ${f(b.gap, 4)} |`);
  lines.push("", `ECE (quantile bins) ${f(m.reliability_quantile.ece, 4)}; MCE ${f(m.reliability_quantile.mce, 4)}.`);
  return lines;
}

function liftLines(m) {
  const lines = ["| decile | n | positives | rate | lift | cumulative capture |", "|---|---|---|---|---|---|"];
  for (const r of m.lift.rows) lines.push(`| ${r.decile} | ${r.n} | ${r.positives} | ${pct(r.rate)} | ${f(r.lift, 2)} | ${pct(r.cumulative_capture, 1)} |`);
  return lines;
}

function segmentLines(segments, names) {
  const out = [];
  for (const [segName, table] of Object.entries(segments)) {
    out.push("", `#### By ${segName}`, "", `| ${segName} | n | positives | rate | support | ${names.map((n) => `${n} AUC [CI]`).join(" | ")} |`, `|---|---|---|---|---|${names.map(() => "---").join("|")}|`);
    for (const [key, e] of Object.entries(table)) {
      out.push(`| ${key} | ${e.n} | ${e.positives} | ${pct(e.rate)} | ${e.low_support ? "LOW SUPPORT" : "ok"} | ${names.map((n) => ciText(e[n]?.auc)).join(" | ")} |`);
    }
  }
  return out;
}

function rollingLines(rolling, names) {
  const lines = [`| origin (test month) | train n | test n | test positives | support | ${names.map((n) => `${n} AUC [CI] / log loss`).join(" | ")} |`, `|---|---|---|---|---|${names.map(() => "---").join("|")}|`];
  for (const r of rolling) {
    if (r.skipped) {
      lines.push(`| ${r.origin.slice(0, 7)} | ${r.train_n} | ${r.test_n} | ${r.test_positives} | skipped: ${r.skipped} | ${names.map(() => "-").join(" | ")} |`);
      continue;
    }
    lines.push(
      `| ${r.origin.slice(0, 7)} | ${r.train_n} | ${r.test_n} | ${r.test_positives} | ${r.low_support ? "LOW SUPPORT" : "ok"} | ${names.map((n) => `${ciText(r.results[n]?.auc)} / ${f(r.results[n]?.log_loss, 4)}`).join(" | ")} |`,
    );
  }
  return lines;
}

function learningLines(lc, armNames) {
  const lines = [`| training fraction | train n | train positives | ${armNames.map((n) => `${n} test AUC [CI] / log loss`).join(" | ")} |`, `|---|---|---|${armNames.map(() => "---").join("|")}|`];
  for (const e of lc) lines.push(`| ${e.fraction} | ${e.train_n} | ${e.train_positives} | ${armNames.map((n) => `${ciText(e.results[n].auc)} / ${f(e.results[n].log_loss, 4)}`).join(" | ")} |`);
  return lines;
}

function driftLines(drift) {
  const lines = ["| feature | kind | PSI train -> test |", "|---|---|---|"];
  for (const [k, v] of Object.entries(drift.features).sort((a, b) => (b[1].psi ?? 0) - (a[1].psi ?? 0))) {
    lines.push(`| ${k} | ${v.kind} | ${f(v.psi, 3)}${v.psi > 0.25 ? " (major shift)" : v.psi > 0.1 ? " (moderate)" : ""} |`);
  }
  lines.push("", `Score PSI (train scores -> test scores): ${f(drift.score_psi, 3)}.`);
  return lines;
}

/** One target's evaluation section. */
export function evaluationSection(result, { title, target }) {
  const armNames = result.models.map((m) => m.arm.name);
  const names = [...Object.keys(result.baselines), ...armNames];
  const segNames = [result.reference_baseline, ...armNames];
  const s = result.split;
  const out = [];
  out.push(`## ${title}`, "");
  out.push(`- **Target:** \`${target}\` (mature rows only).`);
  out.push(`- **Temporal split:** train < ${s.cutoff.slice(0, 10)} (purged by the ${s.horizon_ms / 3600e3}h horizon: ${s.purged} rows removed), test ${s.cutoff.slice(0, 10)} to ${s.test_end.slice(0, 10)}.`);
  out.push(`- **Train:** n=${s.train.n}, positives=${s.train.positives} (${pct(s.train.rate)}), ${String(s.train.from).slice(0, 10)} to ${String(s.train.to).slice(0, 10)}.`);
  out.push(`- **Test:** n=${s.test.n}, positives=${s.test.positives} (${pct(s.test.rate)}), ${String(s.test.from).slice(0, 10)} to ${String(s.test.to).slice(0, 10)}.`);
  out.push(`- **Reference baseline (best baseline on test log loss):** \`${result.reference_baseline}\`.`);
  out.push(`- **L2 chosen on a time-ordered inner validation (last 20% of train, purged):** ${result.models.map((m) => `${m.arm.name} l2=${m.l2}`).join(", ")}.`, "");
  out.push("### Test metrics", "", ...metricsTable(result, names), "");
  out.push("### Model vs baseline (paired bootstrap, 1,000 resamples)", "", ...comparisonLines(result), "");
  for (const arm of armNames) {
    out.push(`### Calibration: ${arm} (reliability, quantile bins)`, "", ...reliabilityLines(result.metrics[arm]), "");
    out.push(`### Decile lift: ${arm}`, "", ...liftLines(result.metrics[arm]), "");
  }
  out.push("### Segments (test window; LOW SUPPORT = n < 200 or < 20 positives/negatives)", ...segmentLines(result.segments, segNames), "");
  out.push("### Rolling origin (refit at each month start; test = that month)", "", ...rollingLines(result.rolling, [...Object.keys(result.baselines), ...armNames]), "");
  out.push("### Learning curve (seeded subsamples of the training window; fixed test)", "", ...learningLines(result.learning_curve, armNames), "");
  for (const arm of armNames) out.push(`### Drift train -> test: ${arm} inputs (PSI)`, "", ...driftLines(result.drift[arm]), "");
  for (const { arm, model } of result.models) {
    const top = model.feature_names
      .map((name, j) => ({ name, coef: model.coef[j] }))
      .sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef) || a.name.localeCompare(b.name))
      .slice(0, 15);
    out.push(`### Largest standardised coefficients: ${arm.name} (log-odds per unit / per level)`, "", "| column | coefficient |", "|---|---|", ...top.map((t) => `| ${t.name} | ${f(t.coef, 3)} |`), "");
  }
  return out;
}

export function fairnessSection(report, { title }) {
  const out = [`## ${title}`, "", `Report \`${report.report_version}\`, model \`${report.model_version_id}\`, feature set \`${report.feature_set_id}\`, rows ${report.overall.n} (test window), base rate ${pct(report.overall.base_rate)}, mean score ${f(report.overall.mean_score, 4)}. Groups with fewer than ${report.min_group_size} rows are suppressed.`, ""];
  for (const [field, data] of Object.entries(report.fields)) {
    out.push(`### ${field}`, "", `Reported groups ${data.reported_groups}, suppressed ${data.suppressed_groups} (${data.suppressed_rows} rows), missing ${data.missing_rows} rows; min/max mean-score ratio ${f(data.mean_score_ratio_min_max, 3)}.`, "");
    out.push("| group | n | positives | observed rate | mean score | AUC | ECE (5 bins) | share in top decile |", "|---|---|---|---|---|---|---|---|");
    for (const [g, v] of Object.entries(data.groups)) {
      out.push(`| ${g} | ${v.n} | ${v.positives} | ${pct(v.base_rate)} | ${f(v.mean_score, 4)} | ${f(v.auc, 3)} | ${f(v.calibration_ece, 4)} | ${pct(v.top_decile_share, 1)} |`);
    }
    out.push("");
  }
  return out;
}

/** Row matching intelligence.model_versions (architecture §2). */
export function modelVersionRow({ modelVersionId, family, version, datasetManifest, arm, params, trainWindow, codeCommit, metrics, baselineMetrics, artifact, artifactSha256, artifactUri, modelCard }) {
  const inline = JSON.stringify(artifact).length <= 100 * 1024;
  return {
    model_version_id: modelVersionId,
    model_family: family,
    version,
    status: "backtest",
    dataset_snapshot_id: datasetManifest.dataset_id,
    feature_set_id: arm.featureSetId,
    training_window: trainWindow,
    code_commit: codeCommit,
    params,
    metrics,
    baseline_metrics: baselineMetrics,
    artifact: inline ? artifact : null,
    artifact_uri: artifactUri,
    artifact_sha256: artifactSha256,
    model_card: modelCard,
    created_at: datasetManifest.built_at,
    promoted_at: null,
    retired_at: null,
  };
}

export function headline(m) {
  return { n: m.n, positives: m.positives, auc: m.auc, pr_auc: m.pr_auc, log_loss: m.log_loss, brier: m.brier, ece: m.calibration.ece, low_support: m.low_support };
}

export { ciText, f, pct };
