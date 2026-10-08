// hotfix 8.4.8 · PROPOSED REPAIR (dry-run by default). Re-renders ONLY the
// pending Atlanta / St. Louis rows the planner marks `corrected` (fallback-
// rendered first touches: agent_name NULL, signed "Alex", no persona ever shown
// to that phone). Rows whose seller already saw a persona (Alex included) are
// untouched; conflicts are flagged, never rewritten. Fields written: message_body/message_text/rendered_message/character_count,
// agent_name (first name), metadata.agent_persona(+_source), and
// metadata.template_snapshot.rendered_message_preview/character_count.
//
// Guards (per row, in ONE transaction): queue_status in ('scheduled','queued')
// AND updated_at unchanged since the plan was read. A row that fails the guard
// is skipped (counted), never forced. Never touched: scheduled_for*, template,
// sender, queue_status, holds, retry metadata. No row is cancelled or rebuilt.
//
// --apply requires the OWNER: --apply --owner-approved=YES and a writable
// DATABASE_URL. Run only with outbound paused (queue_processor_mode=off) and
// AFTER 8.4.8 is deployed (so nothing new renders "Alex" behind the repair).
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs scripts/ops/hotfix-848/persona-pending-repair.mjs            # dry run
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs scripts/ops/hotfix-848/persona-pending-repair.mjs --apply --owner-approved=YES
import { createRequire } from "node:module";
import { connectReadOnly, arg } from "../r10-safety/_ro-db.mjs";
import { loadHistory, loadPendingRows, planRow, summarize } from "./persona-plan.mjs";

const apply = process.argv.includes("--apply");
if (apply && arg("owner-approved") !== "YES") {
  console.error("--apply requires --owner-approved=YES (owner decision). Nothing written.");
  process.exit(2);
}

const ro = await connectReadOnly();
const rows = await loadPendingRows(ro);
const history = await loadHistory(ro, rows);
const plans = rows.map((r) => planRow(r, history));
await ro.end();

const byId = new Map(rows.map((r) => [r.id, r]));
const writes = plans.filter((p) => p.decision === "corrected" && !p.held);
const result = { mode: apply ? "apply" : "dry_run", planned: summarize(plans), would_update: writes.length, conflict_flagged: plans.filter((p) => p.decision === "conflict_flagged").length };

if (apply) {
  const require = createRequire(import.meta.url);
  const pg = require("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("set statement_timeout='30s'");
  let updated = 0, skipped_guard = 0;
  try {
    await db.query("begin");
    for (const p of writes) {
      const row = byId.get(p.id);
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      const tpl = meta.template_snapshot && typeof meta.template_snapshot === "object" ? meta.template_snapshot : null;
      const patch = {
        agent_persona: p.persona,
        agent_persona_source: p.source,
        persona_repair_848: { at: new Date().toISOString(), from: "Alex", to: p.first_name, reason: "hardcoded_fallback_first_touch" },
        ...(tpl ? { template_snapshot: { ...tpl, rendered_message_preview: p.new_body, character_count: p.new_body.length } } : {}),
      };
      const res = await db.query(
        `update send_queue set
           message_body = $2,
           message_text = case when message_text is not distinct from message_body then $2 else message_text end,
           rendered_message = case when rendered_message is not distinct from message_body then $2 else rendered_message end,
           character_count = $3,
           agent_name = $4,
           metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb,
           updated_at = now()
         where id::text = $1 and queue_status in ('scheduled','queued') and updated_at is not distinct from $6
           and coalesce(metadata->>'hold', metadata->>'held', metadata->>'owner_hold') is null
           and agent_name is null and message_body = $7`,
        [p.id, p.new_body, p.new_body.length, p.first_name, JSON.stringify(patch), row.updated_at, p.current_body],
      );
      if (res.rowCount === 1) updated += 1;
      else skipped_guard += 1;
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    console.error("repair rolled back:", error?.message || error);
    process.exit(1);
  }
  await db.end();
  Object.assign(result, { updated, skipped_guard });
}
console.log(JSON.stringify(result, null, 1));
