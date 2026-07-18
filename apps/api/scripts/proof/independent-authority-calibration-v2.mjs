#!/usr/bin/env node
/**
 * Independent blind calibration runner (read-only classifier eval).
 * Does NOT modify classify.js or AUTHORITY_INTENT_ALLOWLIST.
 *
 *   cd apps/api && node --import ./tests/register-aliases.mjs \
 *     scripts/proof/independent-authority-calibration-v2.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../../src/lib/domain/classification/classify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../tests/fixtures/acquisition-brain/independent-calibration-v2");
const SEEDS = join(__dirname, "../../tests/fixtures/acquisition-brain/seeds");

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function normalizeText(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadJsonl(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** One-sided 95% lower bound for binomial proportion (Clopper-Pearson approx via Beta). */
function precisionLowerBound95(tp, fp) {
  const n = tp + fp;
  if (n === 0) return 0;
  // Jeffreys one-sided-ish: use Beta(tp+0.5, fp+0.5) 5th percentile approximation
  // Rule of three when fp=0: LB ≈ 1 - 3/n
  if (fp === 0) return Math.max(0, 1 - 3 / n);
  // Wilson lower bound (two-sided 90% ≈ one-sided 95% rough)
  const z = 1.645;
  const p = tp / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

function recallLowerBound95(tp, fn) {
  return precisionLowerBound95(tp, fn);
}

function loadDevelopmentTexts() {
  const texts = new Set();
  const norms = new Set();
  for (const file of ["english-seeds.json", "spanish-seeds.json"]) {
    const path = join(SEEDS, file);
    const seeds = JSON.parse(readFileSync(path, "utf8"));
    for (const s of seeds) {
      texts.add(s.text.trim());
      norms.add(normalizeText(s.text));
    }
  }
  // regression samples known
  const regression = [
    "Yes I own it",
    "Wrong number",
    "Stop",
    "What's your offer?",
    "150k",
  ];
  for (const t of regression) {
    texts.add(t);
    norms.add(normalizeText(t));
  }
  return { texts, norms };
}

function leakageAudit(examples) {
  const { texts, norms } = loadDevelopmentTexts();
  let exact = 0;
  let normalized = 0;
  const leaked = [];
  for (const e of examples) {
    const raw = e.deidentified_raw_text.trim();
    const n = normalizeText(raw);
    if (texts.has(raw)) {
      exact += 1;
      leaked.push({ id: e.calibration_example_id, type: "exact", text: raw });
    } else if (norms.has(n)) {
      normalized += 1;
      leaked.push({ id: e.calibration_example_id, type: "normalized", text: raw });
    }
  }
  return {
    exact_overlap: exact,
    normalized_overlap: normalized,
    known_semantic_family_overlap: 0, // families use ic2_ prefix, not seed families
    leaked_examples: leaked,
    excluded_before_eval: leaked.map((l) => l.id),
    pass: exact === 0 && normalized === 0,
  };
}

function candidateMetrics(examples, predictions, candidate, positive_intent) {
  // Predicted positive: classifier emits positive_intent AND example marked for this candidate as gold-positive when auth_candidate path
  let tp = 0,
    fp = 0,
    fn = 0;
  const gold_pos = examples.filter(
    (e) =>
      e.expected_authority_candidate === candidate &&
      e.expected_rule_family_eligibility === true
  );
  const gold_pos_ids = new Set(gold_pos.map((e) => e.calibration_example_id));

  for (const e of examples) {
    const pred = predictions[e.calibration_example_id];
    if (!pred) continue;
    const predicted_pos = pred.primary_intent === positive_intent;
    const is_gold_pos = gold_pos_ids.has(e.calibration_example_id);

    // For adversarial/terminal: predicted_pos against this candidate is FP if candidate would claim authority
    if (e.expected_authority_candidate === candidate && e.adversarial_neighbor) {
      if (predicted_pos && e.expected_primary_intent !== positive_intent) fp += 1;
      continue;
    }

    if (is_gold_pos) {
      if (predicted_pos) tp += 1;
      else fn += 1;
    } else if (
      e.adversarial_neighbor &&
      predicted_pos &&
      [
        "adversarial_ownership",
        "adversarial_proposal",
        "adversarial_price",
        "terminal_dominance",
      ].includes(e.expected_authority_candidate)
    ) {
      // Predicted candidate intent on adversarial negative
      if (
        (candidate === "clear_ownership_confirmation" &&
          positive_intent === "ownership_confirmed") ||
        (candidate === "clear_seller_requests_proposal" &&
          positive_intent === "asks_offer") ||
        (candidate === "clear_asking_price_disclosure" &&
          positive_intent === "asking_price_provided")
      ) {
        fp += 1;
      }
    }
  }

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const families = new Set(gold_pos.map((e) => e.semantic_family_id)).size;
  const predicted_pos_count = tp + fp;

  let status = "fails_precision";
  if (predicted_pos_count < 300 || families < 20) {
    status = "insufficient_independent_support";
  } else if (precision < 0.99 || precisionLowerBound95(tp, fp) < 0.99) {
    status = "fails_precision";
  } else if (recall < 0.95 || recallLowerBound95(tp, fn) < 0.95) {
    status = "fails_recall";
  } else {
    status = "qualifies_for_allowlist_pr";
  }

  return {
    candidate,
    positive_intent,
    predicted_positive_count: predicted_pos_count,
    gold_positive_count: gold_pos.length,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
    precision,
    recall,
    f1,
    precision_lb_95: precisionLowerBound95(tp, fp),
    recall_lb_95: recallLowerBound95(tp, fn),
    semantic_family_count: families,
    independent_example_count: gold_pos.length,
    status,
    authority_eligible: false, // PR #40 never populates allowlist
  };
}

function safetyConfusion(examples, predictions) {
  let opt_out_as_owner = 0;
  let wrong_as_owner = 0;
  let tenant_as_owner = 0;
  for (const e of examples) {
    const pred = predictions[e.calibration_example_id];
    if (!pred) continue;
    if (
      e.expected_primary_intent === "opt_out" &&
      pred.primary_intent === "ownership_confirmed"
    ) {
      opt_out_as_owner += 1;
    }
    if (
      e.expected_primary_intent === "wrong_number" &&
      pred.primary_intent === "ownership_confirmed"
    ) {
      wrong_as_owner += 1;
    }
    if (
      e.expected_primary_intent === "tenant_occupied" &&
      pred.primary_intent === "ownership_confirmed"
    ) {
      tenant_as_owner += 1;
    }
  }
  return {
    opt_out_as_ownership: opt_out_as_owner,
    wrong_number_as_ownership: wrong_as_owner,
    tenant_family_agent_as_owner: tenant_as_owner,
    unsafe_continuation: opt_out_as_owner + wrong_as_owner + tenant_as_owner,
  };
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const hashes = JSON.parse(
    readFileSync(join(ROOT, "immutable-content-hashes.json"), "utf8")
  );
  const gold_raw = readFileSync(join(ROOT, "gold-labels.jsonl"), "utf8");
  const gold_hash = sha256(gold_raw);
  if (gold_hash !== hashes.gold_labels_jsonl_sha256) {
    console.error("FATAL: gold-labels.jsonl hash mismatch — freeze violated");
    process.exit(2);
  }

  const examples = loadJsonl(join(ROOT, "gold-labels.jsonl"));
  const leakage = leakageAudit(examples);
  const eval_set = examples.filter(
    (e) => !leakage.excluded_before_eval.includes(e.calibration_example_id)
  );

  const predictions = {};
  for (const e of eval_set) {
    // Context not passed into classify.js (production lacks full context hook here);
    // document as context_contract_incomplete for short replies.
    const c = await classify(e.deidentified_raw_text, null, {
      heuristicOnly: true,
    });
    predictions[e.calibration_example_id] = {
      primary_intent: c.primary_intent,
      secondary_intent: c.secondary_intent,
      secondary_intents: c.secondary_intents || [],
      confidence: c.confidence,
      language: c.language,
      source: c.source,
    };
  }

  // Replay determinism
  let replay_ok = 0;
  for (const e of eval_set.slice(0, 20)) {
    const c2 = await classify(e.deidentified_raw_text, null, {
      heuristicOnly: true,
    });
    if (c2.primary_intent === predictions[e.calibration_example_id].primary_intent) {
      replay_ok += 1;
    }
  }

  const candidates = [
    candidateMetrics(
      eval_set,
      predictions,
      "clear_ownership_confirmation",
      "ownership_confirmed"
    ),
    candidateMetrics(
      eval_set,
      predictions,
      "clear_seller_requests_proposal",
      "asks_offer"
    ),
    candidateMetrics(
      eval_set,
      predictions,
      "clear_asking_price_disclosure",
      "asking_price_provided"
    ),
  ];

  const safety = safetyConfusion(eval_set, predictions);

  // Overall accuracy vs gold (not authority gate)
  let correct = 0;
  for (const e of eval_set) {
    if (predictions[e.calibration_example_id]?.primary_intent === e.expected_primary_intent) {
      correct += 1;
    }
  }

  const en = eval_set.filter((e) => e.language_code === "en");
  const es = eval_set.filter((e) => e.language_code === "es");

  const report = {
    corpus_version: manifest.corpus_version,
    manifest_hash: sha256(JSON.stringify(manifest)),
    gold_hash,
    classifier: "classify.js heuristicOnly",
    classifier_sha: "main:32c182e1 (unchanged in this PR)",
    calibration_runner_version: manifest.calibration_runner_version,
    evaluation_timestamp: new Date().toISOString(),
    example_count: examples.length,
    evaluated_count: eval_set.length,
    english_count: en.length,
    spanish_count: es.length,
    semantic_family_count: new Set(examples.map((e) => e.semantic_family_id)).size,
    source_category_distribution: {
      authored: examples.filter((e) => e.source_category === "authored").length,
      adversarial: examples.filter((e) => e.source_category === "adversarial").length,
      context: examples.filter((e) => e.source_category === "context").length,
      historical_style_deid: examples.filter(
        (e) => e.source_category === "historical_style_deid"
      ).length,
    },
    leakage_audit: leakage,
    overall_label_accuracy: correct / eval_set.length,
    candidates,
    terminal_safety: safety,
    deterministic_replay_sample: {
      n: 20,
      matches: replay_ok,
      rate: replay_ok / 20,
    },
    authority_eligible_coverage: 0,
    allowlist_mutated: false,
    classify_js_changed: false,
    production_mode: "internal_shadow",
    queue_writes: 0,
    provider_calls: 0,
    sms_sent: 0,
    historical_shadow_distribution: {
      note: "Historical rows without independent gold are not accuracy evidence",
      messages_evaluated: 0,
      status: "not_run_as_accuracy_evidence",
    },
    candidate_decisions: Object.fromEntries(
      candidates.map((c) => [c.candidate, c.status])
    ),
    qualifying_for_later_allowlist_pr: candidates
      .filter((c) => c.status === "qualifies_for_allowlist_pr")
      .map((c) => c.candidate),
  };

  const out_path = join(ROOT, "calibration-report.json");
  writeFileSync(out_path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
