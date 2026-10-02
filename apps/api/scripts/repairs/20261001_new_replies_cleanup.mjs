#!/usr/bin/env node

/**
 * NEW REPLIES CLEANUP 7.2 — preview (default) and repair (--apply, after
 * owner approval only).
 *
 * PREVIEW (no production writes): reads every thread in
 * v_inbox_thread_state_buckets.in_new_replies (or a frozen snapshot), rebuilds
 * the conversation context from OUR previous outbound, reclassifies the latest
 * inbound with the live classifier (classify_js_context_v3_reply_disposition),
 * and writes:
 *   <out>/new-replies-cleanup.md           the owner report (summary + all rows)
 *   <out>/new-replies-cleanup-preview.json the same rows, redacted
 *   <out>/new-replies-eval-export.jsonl    de-identified evaluation export
 * Phones/emails are masked to their last 4 / first letter; ids are kept.
 *
 * Next contact is a PREVIEW: the existing waterfall ranks the owner's other
 * phones (public.phones) and emails (public.emails) with their suppression
 * facts. Nobody is contacted. The seller.* graph is not exposed through the
 * API, so modern-graph owners show "seller graph not readable via API".
 *
 * REPAIR (--apply --confirm=classifier_cleanup_20261001): executes each row's
 * plan through the canonical authorities (new-replies-cleanup-apply.js).
 * Compare-and-set per thread; a thread that changed since the preview is
 * skipped. Never sends, never queues a contact, never writes raw SQL.
 *
 * Usage (from apps/api):
 *   node --import ./scripts/register-aliases-ops.mjs scripts/repairs/20261001_new_replies_cleanup.mjs [--freeze=<file>] [--out=<dir>]
 *   node --import ./scripts/register-aliases-ops.mjs scripts/repairs/20261001_new_replies_cleanup.mjs --apply --confirm=classifier_cleanup_20261001
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import {
  planNewRepliesCleanup,
  summarizeCleanup,
  categorizeReply,
  planNextContact,
  buildEvaluationExport,
  CATEGORY_ORDER,
  CLEANUP_CATEGORY,
  CLEANUP_SOURCE,
  maskPhone,
} from "../../src/lib/domain/inbox/new-replies-cleanup.js";
import { applyNewRepliesCleanupPlan } from "../../src/lib/domain/inbox/new-replies-cleanup-apply.js";
import { extractAddresseeName } from "../../src/lib/domain/classification/reply-disposition-signals.js";

dotenv.config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name, fallback = null) => {
  const hit = flag(name);
  return hit && hit.includes("=") ? hit.split("=").slice(1).join("=") : fallback;
};
const APPLY = Boolean(flag("apply"));
const CONFIRM = value("confirm");
const FREEZE = value("freeze");
// Optional: reconcile against the other pending repairs (P7 placeholders,
// not-interested nurture). JSON produced from their own read-only previews.
const RECONCILE = value("reconcile");
// Optional: reviewed gold labels { labels: { <thread_id>: { gold_category, gold_new_replies, old_last_intent } } }.
const GOLD = value("gold");
// Outputs are derived from production data: they default OUTSIDE the repo.
const OUT = value("out", path.join(os.tmpdir(), "new-replies-cleanup"));

const clean = (v) => String(v ?? "").trim();
const variants = (k) => {
  const d = clean(k).replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return [...new Set([clean(k), t, `1${t}`, `+1${t}`])].filter(Boolean);
};

function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)");
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

async function loadLive(sb) {
  const { data: rows, error } = await sb.from("v_inbox_thread_state_buckets").select("*").eq("in_new_replies", true).limit(2000);
  if (error) throw error;
  const out = [];
  for (const thread of rows || []) {
    const v = variants(thread.thread_key);
    const [ev, opp] = await Promise.all([
      sb.from("message_events").select("id,direction,message_body,created_at,sent_at,received_at,detected_intent,language,template_id").eq("thread_key", thread.thread_key).order("created_at", { ascending: true }).limit(300),
      sb.from("acquisition_opportunities").select("id,acquisition_stage,opportunity_status,primary_thread_key,version").in("primary_thread_key", v).limit(5),
    ]);
    if (ev.error) throw ev.error;
    out.push({ thread, message_events: ev.data || [], opportunities: opp.data || [] });
  }
  return out;
}

/** Read-only candidate load for the waterfall (public tables only). */
function makeNextContactLoader(sb) {
  return async ({ thread }) => {
    const owner = clean(thread.master_owner_id);
    if (!owner) {
      return {
        channel: "none",
        candidate: null,
        eligibility: "unknown",
        suppression_state: "seller graph not readable via API",
        would_send: "nothing: candidates for this owner live in seller.owner_phone / seller.owner_email, which the API does not expose",
        why: "no master_owner_id on the thread (modern seller graph); see the report's seller-graph section",
        considered: [],
        email_considered: [],
      };
    }
    const [ph, em] = await Promise.all([
      sb.from("phones").select("phone_id,canonical_e164,phone_type,is_best_phone_for_owner,best_phone_score,contact_rank_position,contact_score_final,wrong_number_at,phone_contact_status,updated_at").eq("master_owner_id", owner).range(0, 99),
      sb.from("emails").select("email,email_rank,is_best_email_for_owner,email_score_final").eq("master_owner_id", owner).range(0, 49),
    ]);
    const phones = (ph.data || [])
      .filter((p) => clean(p.canonical_e164) && !variants(thread.thread_key).includes(clean(p.canonical_e164)))
      .map((p) => ({ ...p, phone_e164: p.canonical_e164, source: "public.phones", dnc: /dnc|do.?not.?call/i.test(clean(p.phone_contact_status)) }));
    const phoneKeys = phones.map((p) => p.phone_e164);
    const [supp, prior, threads] = await Promise.all([
      phoneKeys.length ? sb.from("sms_suppression_list").select("phone_e164,is_active").in("phone_e164", phoneKeys) : { data: [] },
      phoneKeys.length ? sb.from("send_queue").select("to_phone_number,queue_status").in("to_phone_number", phoneKeys).in("queue_status", ["sent", "delivered", "queued", "scheduled", "pending", "processing"]) : { data: [] },
      phoneKeys.length ? sb.from("inbox_thread_state").select("thread_key").in("thread_key", phoneKeys) : { data: [] },
    ]);
    const emails = (em.data || [])
      .sort((a, b) => (b.is_best_email_for_owner === true) - (a.is_best_email_for_owner === true) || (Number(a.email_rank) || 99) - (Number(b.email_rank) || 99))
      .map((e) => ({ email: clean(e.email).toLowerCase() }));
    const emailKeys = emails.map((e) => e.email).filter(Boolean);
    const esupp = emailKeys.length ? await sb.from("email_suppression").select("email_address,is_active").in("email_address", emailKeys) : { data: [] };
    return planNextContact({
      thread,
      phones,
      emails,
      suppressed_phones: (supp.data || []).filter((r) => r.is_active !== false).map((r) => r.phone_e164),
      active_thread_phones: [...(threads.data || []).map((r) => r.thread_key), ...(prior.data || []).map((r) => r.to_phone_number)],
      rejected_phones: [],
      suppressed_emails: (esupp.data || []).filter((r) => r.is_active !== false).map((r) => r.email_address),
    });
  };
}

const esc = (s) => clean(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");

/**
 * RECONCILIATION with the other pending repairs on the same threads/deals.
 * Order rule (evidence below): P7 -> not-interested nurture (WITHOUT
 * --include-legacy) -> New Replies. Hard rules: no thread gets two follow-ups,
 * a waiting seller is never cleared, every P7 active-unanswered seller is in
 * KEEP or on the operator-response list.
 */
function renderReconciliation(plans, reconcile, byId) {
  const L = [];
  const short = (id) => String(id || "").slice(0, 8);
  const k10 = (v) => clean(v).replace(/\D/g, "").slice(-10);
  const nurture = reconcile.nurture_dryrun_file && fs.existsSync(reconcile.nurture_dryrun_file)
    ? JSON.parse(fs.readFileSync(reconcile.nurture_dryrun_file, "utf8"))
    : { sellers: [], counts: {} };
  const nurtureByK10 = new Map((nurture.sellers || []).map((s) => [k10(s.thread_key), s]));
  const p7Threads = new Set(reconcile.p7_threads_flagged || []);
  const p7Deals = reconcile.p7_deal_flags_by_thread || {};
  const deadDeals = reconcile.dead_closed_deal_by_thread || {};
  const planById = new Map(plans.map((p) => [String(p.thread_id), p]));

  L.push("## Reconciliation with the other pending repairs");
  L.push("");
  L.push(`Sources: ${reconcile.sources?.p7 || "P7 preview"}; ${reconcile.sources?.nurture || "nurture dry run"}. Nurture dry run counts: ${JSON.stringify(nurture.counts || {})}.`);
  L.push("");
  L.push("**Apply order at deploy (owner decision C, 2026-10-01): P7 → not-interested nurture (as previewed, WITHOUT `--include-legacy`) → New Replies 7.2.** P7 is approved for the deploy window: it clears 4,373 thread flags and 52 deal flags and leaves the 64 operator-touched deals alone.");
  L.push("- P7 cannot touch any thread below: every one has an unanswered seller message last, which is P7's own P6 stop. Its sweep flag stays on them and is cleared by the New Replies repair only where the conversation is resolved (archive / nurture set the next action).");
  const nurtureOverlap = plans.map((p) => ({ p, n: nurtureByK10.get(k10((byId.get(String(p.thread_id))?.thread || byId.get(String(p.thread_id)) || {}).thread_key)) })).filter((x) => x.n);
  const legacyKeep = nurtureOverlap.filter((x) => x.n.action === "LEGACY_JUL01" && x.p.new_replies === "keep");
  const repairOverlap = nurtureOverlap.filter((x) => x.n.action === "REPAIR");
  const nrNurture = plans.filter((p) => p.category === CLEANUP_CATEGORY.NOT_INTERESTED || p.category === CLEANUP_CATEGORY.NOT_FOR_SALE).length;
  L.push(`- The nurture repair, run as previewed (without \`--include-legacy\`), repairs ${repairOverlap.length} of these threads. ${legacyKeep.length ? `If the owner chooses \`--include-legacy\`, exclude the ${legacyKeep.length} LEGACY_JUL01 thread(s) this plan KEEPS (${legacyKeep.map((x) => String(x.p.thread_id).slice(0, 8)).join(", ")}): nurturing genuine engagement is a high-risk error.` : "No LEGACY_JUL01 thread here is one this plan keeps, so `--include-legacy` would only nurture threads this plan also nurtures."}`);
  L.push(`- No thread can get two follow-ups: both repairs schedule through \`scheduleFollowUp('not_interested', thread)\` (dedupe key \`seller_followup:<thread>:not_interested\`, unique while live); ${nrNurture} New Replies threads are nurtured by this plan and ${repairOverlap.length} of them are also in the nurture REPAIR set.`);
  L.push("");
  L.push("| Thread | Repairs touching it | New Replies plan | Final state after all | Note |");
  L.push("|---|---|---|---|---|");
  let multi = 0;
  for (const p of plans) {
    const id = String(p.thread_id);
    const item = byId.get(id);
    const t = item?.thread || item || {};
    const touches = ["New Replies"];
    const notes = [];
    if (p7Threads.has(id)) { touches.push("P7 thread flag (not cleared: seller waiting)"); }
    if (p7Deals[id]) { touches.push(`P7 deal flag ${p7Deals[id]} (not cleared)`); }
    const n = nurtureByK10.get(k10(t.thread_key));
    if (n) {
      touches.push(`nurture: ${n.action}`);
      if (n.action === "LEGACY_JUL01" && p.new_replies === "keep") notes.push("EXCLUDE from any --include-legacy nurture run");
    }
    if (deadDeals[id] && (p.category === CLEANUP_CATEGORY.NOT_INTERESTED || p.category === CLEANUP_CATEGORY.NOT_FOR_SALE)) {
      notes.push(`deal ${deadDeals[id]} is dead/closed: nurture the thread; reopening the deal to nurture is an owner decision`);
    }
    if (touches.length < 2) continue;
    multi += 1;
    const final = p.new_replies === "keep"
      ? `stays in New Replies (${p.category}); sweep flag kept until a person answers`
      : `${p.proposed_state?.bucket || "-"}${p.proposed_state?.archived ? ", archived" : ""}${p.follow_up === "30-day" ? ", one 30-day nurture row" : ""}; sweep flag cleared`;
    L.push(`| ${short(id)} | ${touches.join("; ")} | ${p.category} | ${final} | ${notes.join("; ") || "-"} |`);
  }
  L.push("");
  L.push(`${multi} of ${plans.length} threads are touched by more than one repair.`);
  L.push("");
  L.push("### P7 active unanswered sellers (operator-response list, never dropped)");
  L.push("");
  L.push("| Deal | Where after New Replies |");
  L.push("|---|---|");
  for (const a of reconcile.p7_active_unanswered || []) {
    if (a.outside) {
      L.push(`| ${a.deal} | not in New Replies today: ${a.outside} (${a.last_intent}); untouched by this repair, still on the operator list |`);
      continue;
    }
    const p = [...planById.values()].find((x) => String(x.thread_id).startsWith(a.thread));
    const where = !p
      ? "thread not found in this snapshot"
      : p.new_replies === "keep"
        ? `KEEP in New Replies (${p.category})`
        : `${p.category}: leaves New Replies by an owner rule; listed here for the operator`;
    L.push(`| ${a.deal} | ${where} |`);
  }
  L.push("");
  return L.join("\n");
}

/** Accuracy against reviewed gold labels: the OLD state (everything in New Replies) vs the NEW classifier. */
function renderMetrics(plans, gold) {
  const L = [];
  const labels = gold.labels || {};
  const rows = plans.filter((p) => labels[p.thread_id]).map((p) => ({ p, g: labels[p.thread_id] }));
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
  const oldCategory = (r) => categorizeReply({ classification: { primary_intent: r.g.old_last_intent }, body: r.p._texts?.reply || "" });
  L.push("## Evaluation against reviewed labels");
  L.push("");
  L.push(`Reviewed gold labels: ${rows.length} threads (every body read by hand; overrides noted in the gold file). OLD = the stored classification and the fact that all ${rows.length} sat in New Replies; NEW = this branch's classifier and plan.`);
  L.push("");
  const catNew = rows.filter((r) => r.p.category === r.g.gold_category).length;
  const catOld = rows.filter((r) => oldCategory(r) === r.g.gold_category).length;
  const actNew = rows.filter((r) => r.p.new_replies === r.g.gold_new_replies).length;
  const actOld = rows.filter((r) => r.g.gold_new_replies === "keep").length;
  L.push(`- Category accuracy: OLD ${pct(catOld, rows.length)} → NEW ${pct(catNew, rows.length)}.`);
  L.push(`- New Replies keep/remove accuracy: OLD ${pct(actOld, rows.length)} (everything kept) → NEW ${pct(actNew, rows.length)}.`);
  const fp = rows.filter((r) => r.p.new_replies === "keep" && r.g.gold_new_replies === "remove");
  const fn = rows.filter((r) => r.p.new_replies === "remove" && r.g.gold_new_replies === "keep");
  L.push(`- NEW false positives (kept, should leave): ${fp.length}${fp.length ? ` (${fp.map((r) => String(r.p.thread_id).slice(0, 8)).join(", ")})` : ""}. NEW false negatives (removed, should stay): ${fn.length}${fn.length ? ` (${fn.map((r) => String(r.p.thread_id).slice(0, 8)).join(", ")})` : ""}.`);
  const precision = (cats) => {
    const predicted = rows.filter((r) => cats.includes(r.p.category));
    return `${predicted.filter((r) => cats.includes(r.g.gold_category)).length}/${predicted.length}`;
  };
  const recall = (cats) => {
    const actual = rows.filter((r) => cats.includes(r.g.gold_category));
    return `${actual.filter((r) => cats.includes(r.p.category)).length}/${actual.length}`;
  };
  L.push(`- Opt-out precision ${precision([CLEANUP_CATEGORY.OPT_OUT])}, recall ${recall([CLEANUP_CATEGORY.OPT_OUT])}.`);
  L.push(`- Wrong-person precision ${precision([CLEANUP_CATEGORY.WRONG_PERSON])}, recall ${recall([CLEANUP_CATEGORY.WRONG_PERSON])}.`);
  L.push(`- Not-interested / not-for-sale precision ${precision([CLEANUP_CATEGORY.NOT_INTERESTED, CLEANUP_CATEGORY.NOT_FOR_SALE])}, recall ${recall([CLEANUP_CATEGORY.NOT_INTERESTED, CLEANUP_CATEGORY.NOT_FOR_SALE])}.`);
  L.push(`- Call-request recall ${recall([CLEANUP_CATEGORY.CALL_REQUEST])}.`);
  L.push(`- Emoji / reaction contextual accuracy ${recall([CLEANUP_CATEGORY.EMOJI_CLARIFY, CLEANUP_CATEGORY.EMOJI_ACK])}.`);
  L.push(`- Language accuracy ${recall([CLEANUP_CATEGORY.LANGUAGE])}.`);
  L.push("");
  L.push("| Gold category | Threads | OLD correct | NEW correct |");
  L.push("|---|---:|---:|---:|");
  for (const c of CATEGORY_ORDER) {
    const inCat = rows.filter((r) => r.g.gold_category === c);
    if (!inCat.length) continue;
    L.push(`| ${c} | ${inCat.length} | ${inCat.filter((r) => oldCategory(r) === c).length} | ${inCat.filter((r) => r.p.category === c).length} |`);
  }
  L.push("");
  const hr = (pred) => rows.filter(pred).length;
  L.push("### High-risk errors (OLD → NEW)");
  L.push("");
  L.push(`- Opt-out missed: ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.OPT_OUT && oldCategory(r) !== CLEANUP_CATEGORY.OPT_OUT)} → ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.OPT_OUT && r.p.category !== CLEANUP_CATEGORY.OPT_OUT)}`);
  L.push(`- Wrong person left open to be texted again (no relationship mark, still in New Replies): ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.WRONG_PERSON)} → ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.WRONG_PERSON && r.p.new_replies === "keep")}`);
  L.push(`- Hostile seller auto-nurtured: 0 → ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.HOSTILE && r.p.follow_up === "30-day")}`);
  L.push(`- Sold property kept active: ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.SOLD)} → ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.SOLD && r.p.new_replies === "keep")}`);
  L.push(`- Real call request marked not interested: ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.CALL_REQUEST && r.p.current_state?.disposition === "not_interested")} → ${hr((r) => r.g.gold_category === CLEANUP_CATEGORY.CALL_REQUEST && [CLEANUP_CATEGORY.NOT_INTERESTED, CLEANUP_CATEGORY.NOT_FOR_SALE].includes(r.p.category))}`);
  L.push(`- Emoji fact wrongly persisted: 0 stored in prod (it kept reaction_only); the pre-fix branch classifier read both 👍 tapbacks as ownership_confirmed@0.90 → ${hr((r) => r.p.emoji?.only && r.p.factual_commitment === "CONFIRMED")}`);
  L.push(`- Genuine engagement discarded: 0 → ${hr((r) => r.g.gold_new_replies === "keep" && r.p.new_replies === "remove")}`);
  L.push("");
  return L.join("\n");
}

function renderReport(plans, summary, meta) {
  const L = [];
  L.push("# New Replies cleanup 7.2 — preview (no production writes)");
  L.push("");
  L.push(`Generated ${meta.generated_at} from ${meta.source}. Classifier \`${meta.classifier_version}\`. Source tag \`${CLEANUP_SOURCE}\`.`);
  L.push("Phones are masked to the last 4 digits; ids are kept. Message text is not reproduced here (raw text stays in the job tmp freeze).");
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| Category | Threads |");
  L.push("|---|---:|");
  for (const c of CATEGORY_ORDER) L.push(`| ${c} | ${summary.counts[c] || 0} |`);
  L.push(`| **Total** | **${summary.total}** |`);
  L.push("");
  L.push(`- Identity questions ("who is this"): **${plans.filter((p) => p.current_classification === "who_is_this").length}** stored today → **${summary.who_is_this}** after reclassification, all KEEP (engagement that needs an answer; reported separately, never noise).`);
  L.push(`- New Replies today: **${summary.total}** → after the repair: **${summary.remain_in_new_replies}** (${summary.leave_new_replies} leave).`);
  L.push(`- Proposed sends after approval (nurture rows, clarifications, language resends; all through the queue): **${summary.proposed_sends_after_approval}**. None are sent by this preview.`);
  L.push(`- Next contact for wrong person: phone ${summary.next_contact.phone} · email (pending, sending off) ${summary.next_contact.email} · none ${summary.next_contact.none}.`);
  L.push("- **Dates.** The July-01 import rewrote `received_at` on the April-May replies; ordering is by each row's EARLIEST timestamp (created_at holds the real receipt time), and the seller's whole unanswered burst is classified as one reply, as the live path does.");
  const answered = plans.filter((p) => p.we_replied_last);
  L.push(`- In true order **${answered.length}** of these threads end with OUR message (the import made them look unanswered): ${answered.map((p) => String(p.thread_id).slice(0, 8)).join(", ") || "none"}. They are planned like the rest (no row is dropped); the operator checks that our last message really answered the seller before the view moves them to Waiting.`);
  L.push("");
  L.push("## Every thread");
  L.push("");
  L.push("| # | Thread / property | Current → correct classification | Current → proposed state | New Replies | Follow-up | Next contact | Proposed send | Why |");
  L.push("|---:|---|---|---|---|---|---|---|---|");
  plans.forEach((p, i) => {
    const nc = p.next_contact || {};
    const ncText = nc.channel && nc.channel !== "none"
      ? `${nc.channel} ${nc.candidate || ""} (${nc.contact_type || "-"}) · ${nc.eligibility} · ${nc.suppression_state} · would send: ${nc.would_send} · ${nc.why}`
      : `none — ${nc.why || "-"}`;
    const proposed = p.proposed_state || {};
    const proposedText = Object.entries(proposed)
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
    L.push(`| ${i + 1} | ${esc(String(p.thread_id).slice(0, 8))} · ${esc(p.phone)} · prop ${esc(p.property_id || "-")} · owner ${esc(p.master_owner_id || "-")} | ${esc(p.current_classification)} → **${esc(p.correct_classification)}** (${esc(p.category)}${p.emoji ? `; emoji ${esc(p.emoji.family)}/${esc(p.emoji.signal)}` : ""}${p.factual_commitment ? `; fact ${esc(p.factual_commitment)}` : ""}) | ${esc(`bucket=${p.current_state.bucket}, disposition=${p.current_state.disposition || "none"}`)} → ${esc(proposedText)} | ${p.new_replies} | ${p.follow_up} | ${esc(ncText)} | ${esc(p.proposed_send)} | ${esc(p.why)} |`);
  });
  L.push("");
  return L.join("\n");
}

async function main() {
  const startedAt = new Date().toISOString();
  let threads;
  let source;
  if (FREEZE) {
    const frozen = JSON.parse(fs.readFileSync(FREEZE, "utf8"));
    threads = frozen.threads;
    source = `freeze ${path.basename(FREEZE)} (${frozen.frozen_at})`;
  } else {
    threads = await loadLive(db());
    source = "live read of v_inbox_thread_state_buckets.in_new_replies";
  }

  const sb = FREEZE && !APPLY && !process.env.SUPABASE_URL ? null : db();
  const plans = await planNewRepliesCleanup(threads, {
    loadNextContact: sb ? makeNextContactLoader(sb) : null,
  });
  const summary = summarizeCleanup(plans);
  const classifier_version = plans[0]?.provenance?.classifier_version || null;

  fs.mkdirSync(OUT, { recursive: true });
  const byIdEarly = new Map(threads.map((t) => [String((t.thread || t).id), t]));
  const reconcileSection = RECONCILE ? renderReconciliation(plans, JSON.parse(fs.readFileSync(RECONCILE, "utf8")), byIdEarly) : "";
  fs.writeFileSync(
    path.join(OUT, "new-replies-cleanup.md"),
    renderReport(plans, summary, { generated_at: startedAt, source, classifier_version }) +
      (GOLD ? `\n${renderMetrics(plans, JSON.parse(fs.readFileSync(GOLD, "utf8")))}\n` : "") +
      (reconcileSection ? `\n${reconcileSection}\n` : ""),
  );
  fs.writeFileSync(
    path.join(OUT, "new-replies-cleanup-preview.json"),
    JSON.stringify({ generated_at: startedAt, source, summary, rows: plans.map(({ _texts, ...row }) => row) }, null, 1),
  );
  const byId = new Map(threads.map((t) => [String((t.thread || t).id), t]));
  const evalRows = buildEvaluationExport(plans, {
    namesFor: (p) => {
      const t = byId.get(String(p.thread_id));
      const events = t?.message_events || [];
      return events
        .filter((e) => String(e.direction).toLowerCase() === "outbound")
        .flatMap((e) => {
          const greeted = extractAddresseeName(e.message_body);
          const agent = /\bthis is ([A-Z][a-z]+)\b|\b([A-Z][a-z]+) (?:here|aqui|aquí)\b|\bsoy ([A-Z][a-z]+)\b|\bsou ([A-Z][a-z]+)\b|\btoi la ([A-Z][a-z]+)\b/.exec(String(e.message_body || ""));
          return [greeted, agent && (agent[1] || agent[2] || agent[3] || agent[4] || agent[5])].filter(Boolean);
        });
    },
  });
  fs.writeFileSync(path.join(OUT, "new-replies-eval-export.jsonl"), evalRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  console.log(JSON.stringify({ mode: APPLY ? "apply" : "preview", source, ...summary }, null, 2));

  if (!APPLY) return;
  if (CONFIRM !== CLEANUP_SOURCE) {
    console.error(`--apply requires --confirm=${CLEANUP_SOURCE} (owner approval). Nothing written.`);
    process.exitCode = 2;
    return;
  }
  const [{ applyClassifierCorrection }, { patchUniversalLeadState }, { recordContactOutcome }, { applyInboundSuppression }, { transitionOpportunityStage }, scheduler] = await Promise.all([
    import("../../src/lib/domain/inbox/reconcile-inbox-thread-state.js"),
    import("../../src/lib/domain/lead-state/patch-universal-lead-state.js"),
    import("../../src/lib/domain/seller-flow/contact-resolution-repository.js"),
    import("../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js"),
    import("../../src/lib/domain/opportunity/opportunity-service.js"),
    import("../../src/lib/domain/seller-flow/seller-followup-scheduler.js"),
  ]);
  const results = [];
  for (const plan of plans) {
    const item = byId.get(String(plan.thread_id));
    const thread = item?.thread || item;
    // Re-read the live row: the compare-and-set needs its current updated_at.
    const { data: live } = await sb.from("inbox_thread_state").select("*").eq("id", plan.thread_id).maybeSingle();
    if (!live) {
      results.push({ thread_id: plan.thread_id, ok: false, reason: "thread_missing" });
      continue;
    }
    if (live.updated_at !== thread.updated_at) {
      results.push({ thread_id: plan.thread_id, ok: false, reason: "thread_changed_since_preview_rerun_preview" });
      continue;
    }
    results.push({
      thread_id: plan.thread_id,
      ...(await applyNewRepliesCleanupPlan(plan, { thread: live, opportunity: (item?.opportunities || [])[0] || null }, {
        supabase: sb,
        applyClassifierCorrection,
        patchUniversalLeadState,
        recordContactOutcome,
        applyInboundSuppression,
        transitionOpportunityStage,
        cancelPendingFollowUpsForThread: scheduler.cancelPendingFollowUpsForThread,
        scheduleFollowUp: scheduler.scheduleFollowUp,
      })),
    });
  }
  fs.writeFileSync(path.join(OUT, "new-replies-cleanup-apply-result.json"), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ applied: results.filter((r) => r.ok).length, failed_or_skipped: results.filter((r) => !r.ok).length }));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

export { maskPhone, CLEANUP_CATEGORY };
