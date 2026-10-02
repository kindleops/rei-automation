/**
 * IC8 baselines: dataset card (markdown) for a sealed first-touch snapshot.
 * Aggregates only; no ids, no group values per row.
 */

import fs from "node:fs";
import path from "node:path";

import { readNdjsonGz } from "../../../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { ruleRef } from "../../../../src/lib/domain/intelligence/outcomes/taxonomy.js";
import { MEANINGFUL_REPLY_RULES_V1, STOP_FAMILY_RULES_V1 } from "../../../../src/lib/domain/intelligence/outcomes/rules.js";
import { familyPopulations } from "./populations.mjs";

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)}%` : "n/a");

function monthOf(iso) {
  return String(iso).slice(0, 7);
}

function outcomeTally(records, id) {
  const t = { mature: 0, pending: 0, censored: 0, positive: 0 };
  for (const r of records) {
    const o = r.outcomes[id];
    if (!o) continue;
    t[o.status] += 1;
    if (o.status === "mature" && o.value === true) t.positive += 1;
  }
  return t;
}

export function writeDatasetCard({ dir, manifest, extractManifest, registry }) {
  const records = readNdjsonGz(manifest.uri.replace(/^file:\/\//, ""));
  const pops = familyPopulations(records);
  const ex = manifest.counts.exclusions;
  const set = registry.getSet(manifest.feature_set_id);
  const lines = [];
  lines.push(`# Dataset card: ${manifest.name}`, "");
  lines.push(`- **dataset_id:** \`${manifest.dataset_id}\``);
  lines.push(`- **sha256 (gz):** \`${manifest.sha256}\``);
  lines.push(`- **content sha256:** \`${manifest.content_sha256}\``);
  lines.push(`- **rows:** ${manifest.row_count} (read ${manifest.counts.rows_read}; outside window ${manifest.counts.outside_window})`);
  lines.push(`- **built:** ${manifest.built_at} by ${manifest.builder_version}, code commit \`${manifest.code_commit}\``);
  lines.push(`- **label cutoff (labelNow):** ${manifest.spec.labelNow}`);
  lines.push(`- **as-of window:** ${manifest.spec.asOfWindow.from} to ${manifest.spec.asOfWindow.to} (exclusive)`);
  lines.push(`- **feature set:** \`${manifest.feature_set_id}\` (hash \`${manifest.feature_set_hash.slice(0, 16)}\`). ${manifest.spec.population.feature_set_note || ""}`);
  lines.push(`- **status:** sealed, BACKTEST research use only`, "");

  lines.push("## Target and labels", "");
  lines.push(`- Primary target: \`reply_any@1\` at 72h (behaviour: any inbound on the thread in (send, send+72h], true time = message_events.created_at).`);
  lines.push(
    `- Secondary: \`reply_meaningful@1\` at 72h, deterministic rules \`${MEANINGFUL_REPLY_RULES_V1.id}@${MEANINGFUL_REPLY_RULES_V1.version}\` (hash \`${ruleRef(MEANINGFUL_REPLY_RULES_V1).hash.slice(0, 16)}\`) + \`${STOP_FAMILY_RULES_V1.id}@${STOP_FAMILY_RULES_V1.version}\`. Not yet validated against the 7.2 operator-reviewed corpus.`,
  );
  lines.push("- Also labelled: `opt_out_keyword@1` (7d, exact STOP-family keyword), `carrier_filtered@1` (24h, failure_bucket Spam), `delivered@1` (24h).");
  lines.push("- Labeler: `ic8_labeler@1`. Pending and censored rows are never negatives; models train on mature rows only.", "");

  lines.push("## Population", "");
  for (const [k, v] of Object.entries(manifest.spec.population)) lines.push(`- **${k}:** ${typeof v === "string" ? v : JSON.stringify(v)}`);
  lines.push("", "| sub-population | rows | mature (target) | positives | rate |", "|---|---|---|---|---|");
  for (const [name, pop] of Object.entries(pops)) {
    const t = outcomeTally(pop.rows, pop.target);
    lines.push(`| ${name} (${pop.target}) | ${pop.rows.length} | ${t.mature} | ${t.positive} | ${pct(t.positive, t.mature)} |`);
  }
  lines.push("", "### By month (reply population, `reply_any@1` mature / positives)", "", "| month | rows | legacy feeder | campaign | map operator | mature | positives | rate |", "|---|---|---|---|---|---|---|---|");
  const months = new Map();
  for (const r of pops.seller_first_touch_reply.rows) {
    const m = monthOf(r.as_of);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(r);
  }
  for (const m of [...months.keys()].sort()) {
    const rows = months.get(m);
    const t = outcomeTally(rows, "reply_any@1");
    const kind = (k) => rows.filter((r) => r.strata.kind === k).length;
    lines.push(`| ${m} | ${rows.length} | ${kind("first_touch_legacy_feeder")} | ${kind("first_touch_campaign")} | ${kind("first_touch_map_operator")} | ${t.mature} | ${t.positive} | ${pct(t.positive, t.mature)} |`);
  }

  lines.push("", "## Exclusions (ic8_exclusions@1, counted by the builder)", "");
  lines.push(`- rows seen ${ex.rows_seen}, dropped ${ex.rows_dropped}, pending owner confirmation ${ex.pending_owner_confirmation}`);
  for (const [k, v] of Object.entries(ex.dropped_by_reason)) lines.push(`- dropped \`${k}\`: ${v}`);
  for (const [k, v] of Object.entries(ex.annotated)) lines.push(`- kept + flagged \`${k}\`: ${v}`);
  if (!Object.keys(ex.annotated).length) lines.push("- no row was annotated (no wrong-tz or spam-retry row survived into the window)");
  lines.push("- P7 placeholders, parse-junk asks and bulk-created opportunity dates apply to thread/opportunity subjects, not to send rows.");

  lines.push("", "## Outcome status (all rows)", "", "| outcome | mature | pending | censored | positives |", "|---|---|---|---|---|");
  for (const [k, v] of Object.entries(manifest.counts.outcome_status)) lines.push(`| ${k} | ${v.mature} | ${v.pending} | ${v.censored} | ${v.positive} |`);

  lines.push("", "## Features and missingness", "");
  lines.push(`Members: ${set.members.map((m) => `\`${m.key}@${m.version}\``).join(", ")}.`, "");
  lines.push("| feature | rows missing | share |", "|---|---|---|");
  for (const m of set.members) {
    const miss = manifest.counts.feature_missing[m.key] || 0;
    lines.push(`| ${m.key} | ${miss} | ${pct(miss, manifest.row_count)} |`);
  }
  lines.push("", `Compute errors: ${JSON.stringify(manifest.counts.feature_errors)}.`);

  lines.push("", "## Point-in-time caveats", "");
  lines.push("- Sends placed by coalesce(sent_at, created_at); inbound by message_events.created_at (received_at/event_timestamp were rewritten to 2026-07-01 for ~1,096 Apr-Jun rows and are never read).");
  lines.push("- Local hour/weekday use the PROPERTY zone (state + ZIP3), never the stored send_queue.timezone (wrong on 366 legacy sends).");
  lines.push("- Prior-touch features see only sends strictly before the decision; a prior send counts as delivered only if its receipt was before the decision.");
  lines.push("- `properties` was bulk-rewritten in 2026-08 (169,795 of 169,802 rows): structural facts include later data-quality corrections (small, documented leak).");
  lines.push("- Person attributes (prospects/master_owners) come from the 2026-04 import; treated as static.");
  lines.push("- **Unavailable:** `property.years_since_last_recorded_sale` (missing on every row) and `property.recorded_mortgage_count` (a constant 0 that means NOT READ, not zero mortgages): `seller.*` is not exposed by PostgREST and direct Postgres credentials are stale. Both are excluded from every model.");
  lines.push("", "## Known biases", "");
  for (const b of manifest.card.known_biases) lines.push(`- ${b}`);
  lines.push("", "## PII", "");
  lines.push(`- Unit = salted hash of a keyed pseudonym of the thread key (salt fingerprint \`${manifest.pii.salt_fingerprint}\`); no names, phones, emails, addresses; no message text.`);
  lines.push(`- Extract: ${extractManifest.pii}.`);
  lines.push(`- Source reads: ${extractManifest.access}; ${extractManifest.stats.calls} REST calls for the extract.`);
  fs.writeFileSync(path.join(dir, "dataset-card.md"), `${lines.join("\n")}\n`);
}
