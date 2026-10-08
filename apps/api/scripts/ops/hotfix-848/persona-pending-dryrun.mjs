// hotfix 8.4.8 · READ-ONLY preview of the pending Atlanta / St. Louis rows:
// per row the decision (unchanged_established / corrected / conflict_flagged /
// unchanged_*), current vs proposed body (seller name + address masked),
// established persona(s) on the thread, template, schedule, prior delivery and
// retry history. Recipient = masked last-4 + salted thread hash only.
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs scripts/ops/hotfix-848/persona-pending-dryrun.mjs --out=/path/dir
import { connectReadOnly, arg, writeOut, csv } from "../r10-safety/_ro-db.mjs";
import { CAMPAIGNS, last4, loadHistory, loadPendingRows, maskBody, planRow, summarize, threadHash } from "./persona-plan.mjs";

const OUT = arg("out") || "/tmp";
const db = await connectReadOnly();
const rows = await loadPendingRows(db);
const history = await loadHistory(db, rows);
await db.end();
const names = Object.fromEntries(Object.entries(CAMPAIGNS).map(([k, v]) => [v, k]));
const byId = new Map(rows.map((r) => [r.id, r]));
const plans = rows.map((r) => planRow(r, history));

const header = ["campaign", "queue_row_id", "recipient", "thread_hash", "queue_status", "template_id", "scheduled_for_utc", "sender", "decision", "why", "current_name", "proposed_name", "proposed_persona", "persona_source", "established_personas", "prior_attempts", "prior_delivered", "prior_failed", "prior_spam_retries", "spam_retry_generation", "held", "current_body_masked", "proposed_body_masked"];
const lines = [header.join(",")];
for (const p of plans) {
  const r = byId.get(p.id);
  lines.push([
    names[p.campaign_id] || p.campaign_id, p.id, last4(r.to_phone_number), threadHash(r.to_phone_number), p.queue_status, p.template_id,
    p.scheduled_for_utc ? new Date(p.scheduled_for_utc).toISOString() : "", last4(r.from_phone_number), p.decision, p.why || "",
    /\bAlex\b/.test(p.current_body) ? "Alex" : (r.agent_name || ""), p.decision === "corrected" ? p.first_name : "", p.decision === "corrected" ? p.persona : "",
    p.source || "", p.established.join("|"), p.prior_attempts, p.prior_delivered, p.prior_failed, p.prior_spam_retries, p.spam_retry_generation, p.held,
    maskBody(p.current_body, r), maskBody(p.new_body, r),
  ].map(csv).join(","));
}
const summary = Object.fromEntries(Object.entries(summarize(plans)).map(([id, s]) => [names[id] || id, s]));
const report = { at: new Date().toISOString(), pending_rows: rows.length, summary };
writeOut(OUT, "queued-preview.csv", lines.join("\n") + "\n");
writeOut(OUT, "queued-preview-summary.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
