#!/usr/bin/env node
/**
 * Hardened leakage audit (read-only). Compares development pack gold to prior corpora.
 * Does not rewrite gold.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const V3 = join(__dirname, "..");
const FIX = join(V3, "..");

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}
function norm(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(t) {
  return new Set(norm(t).split(" ").filter((x) => x.length > 2));
}
function jaccard(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
function charNgrams(t, n = 3) {
  const s = norm(t).replace(/\s/g, "");
  const g = new Set();
  for (let i = 0; i <= s.length - n; i++) g.add(s.slice(i, i + n));
  return g;
}
function ngramJaccard(a, b, n = 3) {
  const A = charNgrams(a, n);
  const B = charNgrams(b, n);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

function loadPrior() {
  const items = [];
  const push = (text, source, id) => {
    if (!text) return;
    items.push({ text, source, id: id || sha256(text).slice(0, 12) });
  };

  const v2gold = join(FIX, "independent-calibration-v2/gold-labels.jsonl");
  if (existsSync(v2gold)) {
    for (const line of readFileSync(v2gold, "utf8").trim().split("\n")) {
      if (!line) continue;
      const o = JSON.parse(line);
      push(o.deidentified_raw_text, "ic2_gold", o.calibration_example_id);
    }
  }
  for (const name of ["adversarial-neighbors.jsonl", "context-fixtures.jsonl"]) {
    const p = join(FIX, "independent-calibration-v2", name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").trim().split("\n")) {
      if (!line) continue;
      const o = JSON.parse(line);
      push(o.deidentified_raw_text || o.text, `ic2_${name}`, o.calibration_example_id || o.id);
    }
  }
  for (const seed of ["english-seeds.json", "spanish-seeds.json", "spanish-context-v2-dev.json"]) {
    const p = join(FIX, "seeds", seed);
    if (!existsSync(p)) continue;
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(data)) continue;
    data.forEach((s, i) => push(s.text || s.deidentified_raw_text, `seed_${seed}`, s.family || String(i)));
  }
  const rem = join(FIX, "v2-remediation/development-fixtures.json");
  if (existsSync(rem)) {
    for (const s of JSON.parse(readFileSync(rem, "utf8"))) {
      push(s.text, "v2_remediation_dev", s.id || s.source_calibration_example_id);
    }
  }
  return items;
}

function main() {
  const gold = readFileSync(join(V3, "gold-labels.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const prior = loadPrior();
  const exact = new Map(prior.map((p) => [p.text.trim(), p]));
  const norms = new Map(prior.map((p) => [norm(p.text), p]));

  const exclusions = [];
  const suspicious = [];

  for (const g of gold) {
    const raw = g.deidentified_raw_text;
    const n = norm(raw);
    if (exact.has(raw.trim())) {
      exclusions.push({
        id: g.calibration_example_id,
        method: "exact",
        prior: exact.get(raw.trim()),
        reason: "exact_match_prior",
      });
      continue;
    }
    if (norms.has(n)) {
      exclusions.push({
        id: g.calibration_example_id,
        method: "normalized",
        prior: norms.get(n),
        reason: "normalized_match_prior",
      });
      continue;
    }
    // sample token / ngram against prior (bounded)
    let bestTok = 0;
    let bestNg = 0;
    let bestP = null;
    for (const p of prior) {
      const jt = jaccard(raw, p.text);
      const jn = ngramJaccard(raw, p.text, 3);
      if (jt > bestTok) {
        bestTok = jt;
        bestP = p;
      }
      if (jn > bestNg) {
        bestNg = jn;
        if (jn >= bestTok) bestP = p;
      }
    }
    if (bestTok >= 0.85 || bestNg >= 0.75) {
      suspicious.push({
        id: g.calibration_example_id,
        method: bestTok >= bestNg ? "token_set" : "char_3gram",
        token_jaccard: Number(bestTok.toFixed(3)),
        ngram_jaccard: Number(bestNg.toFixed(3)),
        prior: bestP,
        reason: "high_similarity_review",
      });
    }
  }

  // Bilingual translation-equivalent heuristic: same number sequence / shared rare tokens across langs
  const en = gold.filter((g) => g.language_code === "en");
  const es = gold.filter((g) => g.language_code === "es");
  const translationSuspects = [];
  for (const a of en) {
    const numsA = (a.deidentified_raw_text.match(/\d[\d,]*/g) || []).join("|");
    if (!numsA || numsA.length < 3) continue;
    for (const b of es) {
      const numsB = (b.deidentified_raw_text.match(/\d[\d,]*/g) || []).join("|");
      if (numsA && numsA === numsB && numsA.length >= 5) {
        translationSuspects.push({
          en: a.calibration_example_id,
          es: b.calibration_example_id,
          shared_numbers: numsA,
          reason: "shared_numeric_span_cross_lang_review",
        });
      }
    }
  }

  const report = {
    audit_version: "hardened_leakage_audit_v1",
    gold_count: gold.length,
    prior_count: prior.length,
    exact_or_normalized_hits_in_pack: exclusions.length,
    high_similarity_suspicious_pairs: suspicious.length,
    translation_equivalent_suspects: translationSuspects.length,
    sample_suspicious: suspicious.slice(0, 25),
    sample_translation_suspects: translationSuspects.slice(0, 25),
    notes: [
      "Pack was filtered at original freeze for exact/normalized; hardened audit surfaces residual similarity for review.",
      "Shared family IDs across languages are not used as proof of non-translation.",
      "True blind v3.1 must re-run this audit against this development pack as a prior corpus.",
    ],
  };

  writeFileSync(join(V3, "hardened-leakage-audit-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, ...report, sample_suspicious: undefined, sample_translation_suspects: undefined }, null, 2));
}

main();
