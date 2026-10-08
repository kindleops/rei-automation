// hotfix 8.4.8 · shared planner for the pending-row persona preview/repair.
// Decides, per pending campaign row, whether the body needs correction:
//   unchanged_established  — the phone already SAW a persona and this row uses it (incl. Alex)
//   corrected              — a fallback-rendered first touch (agent_name NULL, signed "Alex"
//                            with no Alex ever shown) or a row contradicting the ONE shown persona
//   conflict_flagged       — the phone already saw two different personas: owner review
//   unchanged_no_agent_token / unchanged_resolved — nothing to correct
// Pure over rows fetched by the caller. Prints/returns no phones or seller names.
import crypto from "node:crypto";
import { personaFirstName, personaStableKey, resolveOutboundPersona, shownPersonas, SHOWN_STATUSES } from "@/lib/domain/outbound/outbound-persona.js";

export const CAMPAIGNS = {
  atlanta: "f20fbf0b-447c-48b4-948b-72ad4262e032",
  st_louis: "56f74b21-aa3e-4477-ae31-ebe12a094732",
};
export const PENDING = ["scheduled", "queued"];
const AGENT_TOKEN = /\{\{?\s*(agent_name|agent_first_name|sms_agent_name|sender_name|rep_name)\s*\}?\}/;
const clean = (v) => (v == null ? "" : String(v).trim());
const SALT = "lc-848-2026-10-08";
export const threadHash = (phone) => crypto.createHash("sha256").update(`${SALT}:${personaStableKey(phone)}`).digest("hex").slice(0, 12);
export const last4 = (phone) => `***${personaStableKey(phone).slice(-4)}`;

export async function loadPendingRows(db, campaignIds = Object.values(CAMPAIGNS)) {
  const { rows } = await db.query(
    `select q.id::text, q.campaign_id::text, q.queue_status, q.updated_at, q.scheduled_for_utc, q.to_phone_number, q.from_phone_number,
            q.master_owner_id::text, q.agent_name, q.language, q.seller_first_name, q.property_address, q.message_body, q.source, q.type,
            q.template_id::text, q.metadata, t.template_body, c.agent_persona as campaign_persona, mo.agent_persona as owner_persona
       from send_queue q
       left join sms_templates t on t.template_id::text = q.template_id::text
       left join campaigns c on c.id = q.campaign_id
       left join master_owners mo on mo.master_owner_id::text = q.master_owner_id::text
      where q.campaign_id = any($1::uuid[]) and q.queue_status = any($2)
      order by q.campaign_id, q.scheduled_for_utc, q.id`,
    [campaignIds, PENDING],
  );
  return rows;
}

/** Per phone: shown personas (sent/delivered history) + attempt/retry history counts. */
export async function loadHistory(db, rows) {
  const keys = [...new Set(rows.map((r) => personaStableKey(r.to_phone_number)).filter((k) => /^\d{10}$/.test(k)))];
  const exclude = rows.map((r) => r.id);
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const variants = keys.slice(i, i + 100).flatMap((k) => [`+1${k}`, `1${k}`, k]);
    const { rows: hist } = await db.query(
      `select to_phone_number, queue_status, agent_name, metadata, message_body, created_at from send_queue
        where to_phone_number = any($1) and not (id::text = any($2)) order by created_at desc limit 5000`,
      [variants, exclude],
    );
    for (const h of hist) {
      const k = personaStableKey(h.to_phone_number);
      if (!out.has(k)) out.set(k, { shownRows: [], attempts: 0, delivered: 0, failed: 0, spam_retries: 0 });
      const e = out.get(k);
      e.attempts += 1;
      if (SHOWN_STATUSES.includes(h.queue_status)) e.shownRows.push(h);
      if (h.queue_status === "delivered") e.delivered += 1;
      if (/fail/.test(h.queue_status || "")) e.failed += 1;
      if (Number(h.metadata?.spam_retry_generation) > 0) e.spam_retries += 1;
    }
  }
  for (const e of out.values()) e.shown = shownPersonas(e.shownRows);
  return out;
}

const signedAlex = (body) => (body.match(/\bAlex\b/g) || []).length;

export function planRow(row, history) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const h = history.get(personaStableKey(row.to_phone_number)) || { shown: [], attempts: 0, delivered: 0, failed: 0, spam_retries: 0 };
  const body = clean(row.message_body);
  const base = {
    id: row.id,
    campaign_id: row.campaign_id,
    updated_at: row.updated_at,
    queue_status: row.queue_status,
    template_id: row.template_id,
    scheduled_for_utc: row.scheduled_for_utc,
    established: h.shown.map(personaFirstName),
    prior_attempts: h.attempts,
    prior_delivered: h.delivered,
    prior_failed: h.failed,
    prior_spam_retries: h.spam_retries,
    spam_retry_generation: Number(meta.spam_retry_generation) || 0,
    held: Boolean(meta.hold || meta.held || meta.owner_hold),
    current_body: body,
    new_body: body,
  };
  if (!AGENT_TOKEN.test(row.template_body || "")) return { ...base, decision: "unchanged_no_agent_token" };
  if (h.shown.length > 1) return { ...base, decision: "conflict_flagged", why: "multiple_personas_already_shown" };

  const current = signedAlex(body) ? "Alex" : personaFirstName(row.agent_name) || null;
  const resolved = resolveOutboundPersona({
    thread_persona: h.shown,
    campaign_persona: row.campaign_persona,
    owner_persona: row.owner_persona,
    stable_key: row.to_phone_number,
    language: clean(row.language) || clean(meta.candidate_snapshot?.language),
  });
  if (!resolved.ok) return { ...base, decision: "conflict_flagged", why: resolved.reason };
  const out = { ...base, persona: resolved.persona, first_name: resolved.first_name, source: resolved.source };

  if (current && current.toLowerCase() === resolved.first_name.toLowerCase()) {
    return { ...out, decision: h.shown.length ? "unchanged_established" : "unchanged_resolved" };
  }
  // Only the fallback-rendered rows are corrected: agent_name NULL (no persona
  // was ever resolved) and the body signs the literal fallback.
  const fallbackRendered = !clean(row.agent_name) && signedAlex(body) === 1;
  if (!fallbackRendered) return { ...out, decision: "conflict_flagged", why: "row_persona_differs_not_fallback" };
  if (/^alex/i.test(clean(row.seller_first_name))) return { ...out, decision: "conflict_flagged", why: "seller_named_alex_ambiguous" };
  const at = body.search(/\bAlex\b/);
  const new_body = body.slice(0, at) + resolved.first_name + body.slice(at + 4);
  return { ...out, decision: "corrected", new_body, from: "Alex" };
}

/** Body with the seller's name and street address masked (preview file only). */
export function maskBody(body, row) {
  let text = clean(body);
  const snap = row.metadata?.candidate_snapshot || {};
  // The greeted name (where the seller's name sits in every opener), then any
  // remaining occurrence of the known first/full name.
  text = text.replace(/^((?:hey|hi|hello|hola|ola|olá|oi|xin chào|chào)[\s,]+)([\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*)?)(?=\s*[,!.])/iu, "$1[seller]");
  for (const name of [clean(row.seller_first_name), clean(snap.seller_first_name), clean(snap.seller_full_name), clean(snap.owner_display_name)]) {
    if (name.length > 2) text = text.split(name).join("[seller]");
  }
  const addr = clean(row.property_address) || clean(snap.property_address_full).split(",")[0];
  if (addr.length > 3) text = text.split(addr).join("[address]");
  return text.replace(/\b\d{2,6}\s+[A-Z][\w.]*(\s+[A-Z][\w.]*){0,4}\b/g, "[address]");
}

export function summarize(plans) {
  const out = {};
  for (const p of plans) {
    const c = (out[p.campaign_id] ||= { total: 0, by_decision: {}, corrected_to: {}, flagged_reasons: {}, established_alex_kept: 0, rows_with_prior_history: 0, rows_with_spam_retry_history: 0, held: 0 });
    c.total += 1;
    c.by_decision[p.decision] = (c.by_decision[p.decision] || 0) + 1;
    if (p.decision === "corrected") c.corrected_to[p.first_name] = (c.corrected_to[p.first_name] || 0) + 1;
    if (p.why) c.flagged_reasons[p.why] = (c.flagged_reasons[p.why] || 0) + 1;
    if (p.decision === "unchanged_established" && p.first_name === "Alex") c.established_alex_kept += 1;
    if (p.prior_attempts) c.rows_with_prior_history += 1;
    if (p.prior_spam_retries || p.spam_retry_generation) c.rows_with_spam_retry_history += 1;
    if (p.held) c.held += 1;
  }
  return out;
}
