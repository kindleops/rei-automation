#!/usr/bin/env node
/**
 * SELLER AUTOPILOT S1–S4 v2 — reply audit (READ-ONLY).
 *
 * For every inbound seller message in the window: the prior question and its
 * use case, the classified intent, whether an auto-reply went out, and if not
 * the exact reason, bucketed into one category. Then every message is
 * replayed OFFLINE through this checkout's real classifier + orchestrator +
 * executor against an in-memory copy of its own thread (prior outbounds,
 * prior inbounds, the active template catalog, the property's Decision Engine
 * snapshot):
 *   A  feat HEAD, SELLER_AUTOPILOT_V2 off      (what deploying 8.4.2 changes)
 *   B  feat HEAD, SELLER_AUTOPILOT_V2 on       (today's approved templates)
 *   C  B + the proposed v2 rows and the proposed safe-flag rows approved
 *
 * Safety: the DB session is BEGIN READ ONLY with statement_timeout 30s and is
 * closed before any pipeline module loads; the replay runs with fetch
 * disabled, Supabase env scrubbed and an isolated runtime-state root. Nothing
 * is written anywhere except the report file. Output text is redacted.
 *
 * Usage (from apps/api):
 *   nice -n 15 node --import ./scripts/register-aliases-ops.mjs scripts/ops/autopilot-v2-audit.mjs \
 *     --from 2026-10-05 --to 2026-10-06 --db-url-file /tmp/.dburl --out <file>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as rq from "./reply-quality-report.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const lc = (v) => String(v ?? "").trim().toLowerCase();
const addDays = (d, n) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};

export const CATEGORIES = Object.freeze({
  REPLIED: "auto-replied",
  BY_DESIGN: "no reply by design (opt-out/wrong-number suppressed, not-interested nurture, reaction, burst-superseded)",
  CLASSIFIER_MISS: "classifier miss",
  CONTEXT_MISS: "context miss",
  NO_TEMPLATE: "no template for intent/stage/language",
  NOT_SAFE: "template exists but not safe_for_auto_reply (or reply_mode=manual)",
  RENDER: "render failure",
  TRANSPORT: "cap / transport block",
  POLICY: "review-required policy",
  NO_TRANSITION: "no flow transition defined",
});
const C = CATEGORIES;

const BARE_NO = /^\s*(?:no|nope|nah)[\s.!]*$/i;
const bareNoToOwnership = (r) => BARE_NO.test(r.body) && lc(r.prior?.use_case) === "ownership_check";
const BARE_SHORT = /^\s*(?:y(?:es|ea|eah|ep|up)|si|sí|sure|ok(?:ay)?|correct|no|nope|nah|是|sim|oui|tak|da)[\s.!👍]*$/iu;

/** Production outcome → category (+ exact reason). */
export function categorizeProduction(r, { catalog }) {
  const reason = String(r.reason || "");
  const intent = lc(r.intent);
  if (r.base === "AUTO_OK") return { cat: C.REPLIED, why: reason };
  if (r.base === "SUPPRESSED_OK" || r.base === "NO_REPLY_BY_DESIGN") return { cat: C.BY_DESIGN, why: reason };
  if (r.base === "AUTO_PENDING") return { cat: C.REPLIED, why: `${reason} (in flight)` };
  if (/daily_limit|sender_ineligible|failed_transport|delivery_failed|\bblocked\b/.test(reason)) return { cat: C.TRANSPORT, why: reason };
  if (/render/.test(reason)) return { cat: C.RENDER, why: reason };
  if (/no_safe_template|language_template_missing/.test(reason)) {
    const lang = r.seller_language || "English";
    const unsafe = catalog.some((t) => t.is_active && lc(t.language) === lc(lang) && lc(t.use_case) === lc(r.reply?.use_case || ""));
    return { cat: unsafe ? C.NOT_SAFE : C.NO_TEMPLATE, why: `${reason} (${lang})` };
  }
  if (bareNoToOwnership(r)) return { cat: C.POLICY, why: "bare 'No' to the ownership question held for review (LC_BARE_NO_OWNERSHIP_MODE — owner decision)" };
  if (/latent_interest|seller_interested/.test(intent) && /\bnot\b[^.]*interest/i.test(r.body)) return { cat: C.CLASSIFIER_MISS, why: `"not … interested" read as ${intent}` };
  if (/unclear_low_confidence/.test(reason)) {
    if (BARE_SHORT.test(r.body) && r.prior) return { cat: C.CONTEXT_MISS, why: `bare reply not bound to ${r.prior.kind}:${r.prior.use_case} (unclear_low_confidence)` };
    return { cat: C.CLASSIFIER_MISS, why: "unclear_low_confidence" };
  }
  if (/automation_review_required/.test(reason)) {
    if (r.prior?.kind !== "campaign" && intent === "ownership_confirmed") return { cat: C.CONTEXT_MISS, why: `yes to ${r.prior?.kind}:${r.prior?.use_case} read as ownership_confirmed → review` };
    return { cat: C.POLICY, why: `automation_review_required (${intent})` };
  }
  if (/no reply, no review flag/.test(reason)) return { cat: C.NO_TRANSITION, why: reason };
  if (/empty|media/.test(reason)) return { cat: C.POLICY, why: reason };
  return { cat: C.POLICY, why: reason };
}

/** Replay outcome → category (+ exact reason). */
export function categorizeReplay(rep, { catalog, row }) {
  if (!rep) return { cat: "n/a", why: "not replayed" };
  if (rep.error) return { cat: "replay error", why: rep.error };
  if (rep.queued) return { cat: C.REPLIED, why: `${rep.use_case} [${rep.language}]${rep.v2 ? ` via ${rep.v2}` : ""}` };
  const audit = String(rep.audit || "");
  const intent = lc(rep.intent);
  if (rep.suppressed || ["opt_out", "wrong_number"].includes(intent)) return { cat: C.BY_DESIGN, why: `suppressed (${rep.suppression_reason || intent})` };
  if (rep.followups?.length && /not_interested|need_time|nurture|do_not_reply|s1_not_for_sale/.test(`${intent} ${audit}`)) return { cat: C.BY_DESIGN, why: `30-day nurture (${rep.followups.join(",")})` };
  if (row.is_tapback || /reaction|tapback/.test(intent)) return { cat: C.BY_DESIGN, why: "reaction / tapback" };
  if (!String(row.body || "").trim()) return { cat: C.POLICY, why: "empty / media-only inbound" };
  if (/template_render_failed|unrendered/.test(audit)) return { cat: C.RENDER, why: audit };
  if (bareNoToOwnership(row) && !rep.queued) return { cat: C.POLICY, why: "bare 'No' to the ownership question held for review (LC_BARE_NO_OWNERSHIP_MODE — owner decision)" };
  if (/no_safe_template|language_template_missing/.test(audit) || /language_template_missing/.test(rep.review_reason || "")) {
    const wanted = (rep.detail || "").match(/template for (\S+)/)?.[1] || rep.route || "";
    const lang = rep.language || "English";
    const exists = catalog.some((t) => t.is_active && lc(t.language) === lc(lang) && lc(t.use_case) === lc(wanted));
    return { cat: exists ? C.NOT_SAFE : C.NO_TEMPLATE, why: `${rep.detail || audit}${wanted ? "" : ` (${lang})`}` };
  }
  if (/^v2_hold_|^v2_language_not_enabled|negotiation_quote_log_failed/.test(audit)) return { cat: C.POLICY, why: rep.review_reason || audit };
  if (/classifier_human_review_required|classifier_auto_reply_not_allowed|unclear_low_confidence|ambiguous/.test(audit)) {
    if (BARE_SHORT.test(row.body) && rep.context_status !== "valid") return { cat: C.CONTEXT_MISS, why: `${audit} (context ${rep.context_status})` };
    return { cat: C.CLASSIFIER_MISS, why: `${audit} (${intent})` };
  }
  if (/relationship|hold_|referral|llc|trust|hostile|legal|authority|sold|former_owner|non_owner|review/i.test(audit)) return { cat: C.POLICY, why: audit };
  if (intent === "acknowledgement") return { cat: C.BY_DESIGN, why: "acknowledgement" };
  return { cat: C.NO_TRANSITION, why: audit || "no decision" };
}

/** pg returns Date objects; the in-memory PostgREST double compares strings, so every timestamp becomes ISO. */
function isoRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

async function loadExtra(client, data) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const outIds = data.outbound.map((o) => o.id);
  const propByOut = outIds.length
    ? await q(`select id::text, property_id::text from send_queue where id::text = any($1) and property_id is not null`, [outIds])
    : [];
  const propertyIds = [...new Set(propByOut.map((r) => r.property_id).filter(Boolean))];
  const scores = propertyIds.length
    ? await q(`select * from property_acquisition_scores where property_id = any($1)`, [propertyIds])
    : [];
  const properties = propertyIds.length
    ? await q(`select property_id::text, property_type, units_count from properties where property_id::text = any($1)`, [propertyIds])
    : [];
  const catalog = await q(
    `select template_id, id::text, use_case, stage_code, stage_label, template_name, language, reply_mode, property_type_scope,
            null::text[] allowed_property_groups, null::text[] prohibited_property_groups, usage_count, null::numeric success_rate,
            updated_at, is_active, safe_for_auto_reply, template_body
       from sms_templates where is_active`
  );
  return { propByOut, scores, properties, catalog };
}

async function main() {
  const tz = arg("tz", "America/Chicago");
  const from = arg("from");
  const to = arg("to") || from;
  const start = rq.localMidnightUtc(from, tz);
  const end = new Date(Math.min(rq.localMidnightUtc(addDays(to, 1), tz).getTime(), Date.now()));
  const url = String(readFileSync(arg("db-url-file", "/tmp/.dburl"), "utf8")).trim();
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let data;
  let extra;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    data = await rq.loadData(client, start.toISOString(), end.toISOString());
    extra = await loadExtra(client, data);
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  for (const key of ["inbound", "decisions", "replies", "autopilot", "outbound", "templates", "history"]) data[key] = (data[key] || []).map(isoRow);
  for (const key of ["propByOut", "scores", "properties", "catalog"]) extra[key] = (extra[key] || []).map(isoRow);

  // ── offline from here on ──────────────────────────────────────────────────
  for (const k of Object.keys(process.env)) if (/SUPABASE|DATABASE_URL|PG(HOST|USER|PASSWORD|DATABASE)|TEXTGRID|OPENAI|BREVO|DISCORD_WEBHOOK/.test(k)) delete process.env[k];
  process.env.RUNTIME_STATE_ROOT = `/tmp/ap2-audit-runtime-${process.pid}`;
  globalThis.fetch = async () => {
    throw new Error("network disabled during autopilot-v2 audit replay");
  };

  const { isInternalTestPhone } = await import("../../src/lib/config/internal-phones.js");
  const bcc = await import("../../src/lib/domain/classification/build-conversation-context.js");
  const { identifyReplyLanguage } = await import("../../src/lib/domain/classification/seller-reply-language.js");
  const harness = await import("../../tests/helpers/seller-autopilot-v2-harness.mjs");
  const { proposedTemplateRows } = await import("./seller-autopilot-v2-templates.proposed.mjs");

  const tplUseCase = new Map(data.templates.map((t) => [t.template_id, t.use_case]));
  const rows = rq.assembleRows(data, { isInternal: isInternalTestPhone, tplUseCase, mapUseCase: bcc.mapMessageTypeToUseCase, deriveUseCase: bcc.deriveUseCaseFromBody });
  for (const r of rows) {
    const b = rq.baseBucket(r);
    r.base = b.bucket;
    r.reason = b.reason;
    r.seller_reply_language = identifyReplyLanguage(r.body, { detected_language: r.classified_language, explicit: false });
  }

  const propOfOut = new Map(extra.propByOut.map((x) => [x.id, x.property_id]));
  const scoreOf = new Map(extra.scores.map((s) => [String(s.property_id), s]));
  const propRow = new Map(extra.properties.map((p) => [String(p.property_id), p]));
  const safeCatalog = extra.catalog.filter((t) => t.safe_for_auto_reply);
  const SAFE_FLAG_IDS = new Set([
    ...["400003", "400004", "400005", "400006", "400007", "400008", "400009", "400010", "400011", "400012", "400013", "400014", "400015", "400016"],
    ...["840003", "840004", "840005", "840006", "840007", "840008", "840009", "840010", "840011", "840012", "840013", "840014", "840015", "840016"],
    ...["540001", "540101", "540206", "540306", "540406", "540506", "540606", "540706", "540806"],
    ...["550202", "550302", "550402", "550502", "550602", "550702", "550802"],
  ]);
  const approvedCatalog = [
    ...safeCatalog,
    ...extra.catalog.filter((t) => SAFE_FLAG_IDS.has(String(t.template_id)) && !t.safe_for_auto_reply).map((t) => ({ ...t, safe_for_auto_reply: true, reply_mode: "auto" })),
    ...proposedTemplateRows().map((p) => harness.tpl(p.template_id, p.use_case, p.language, p.template_body)),
  ];
  const outByThread = new Map();
  for (const o of data.outbound) {
    const k = String(o.to_phone_number || "").replace(/\D/g, "").slice(-10);
    if (!outByThread.has(k)) outByThread.set(k, []);
    outByThread.get(k).push(o);
  }
  const histByThread = new Map();
  for (const h of data.history) {
    if (!histByThread.has(h.thread_key)) histByThread.set(h.thread_key, []);
    histByThread.get(h.thread_key).push(h);
  }

  const silence = { log: console.log, info: console.info, warn: console.warn, debug: console.debug, error: console.error };
  async function replay(r, { flag, catalog }) {
    const thread = r.thread_key;
    const t = Date.parse(r.at);
    const outs = (outByThread.get(String(thread).replace(/\D/g, "").slice(-10)) || []).filter((o) => Date.parse(o.sent_at) <= t);
    const property_id = outs.map((o) => propOfOut.get(o.id)).find(Boolean) || null;
    const ade = property_id ? scoreOf.get(property_id) || null : null;
    const prop = property_id ? propRow.get(property_id) || {} : {};
    const db = harness.memoryDb({
      sms_templates: catalog,
      send_queue: outs.map((o) => ({ ...o, thread_key: thread, created_at: o.sent_at })),
      message_events: (histByThread.get(thread) || [])
        .filter((h) => Date.parse(h.created_at) < t)
        .map((h) => ({ ...h, direction: "inbound" })),
    });
    if (flag) process.env.SELLER_AUTOPILOT_V2 = "true";
    else delete process.env.SELLER_AUTOPILOT_V2;
    console.log = console.info = console.warn = console.debug = console.error = () => {};
    try {
      const res = await harness.runSellerTurn({
        db,
        thread,
        message: r.body,
        receivedAt: new Date(t).toISOString(),
        propertyId: property_id || "unknown-property",
        stageBefore: r.stage_before && !/null/.test(r.stage_before) ? r.stage_before : "ownership_check",
        ade,
        propertySummary: { property_type: prop.property_type || undefined, unit_count: prop.units_count ?? undefined },
      });
      const ex = res.out?.execution || {};
      const ins = res.inserts[0] || null;
      const p = res.out?.seller_autopilot_v2?.plan || null;
      return {
        queued: Boolean(ins),
        use_case: ins?.use_case_template || null,
        language: ins?.metadata?.selected_template_snapshot?.language || res.out?.classification?.language || res.classification.language,
        body: ins?.message_body || null,
        intent: res.out?.classification?.primary_intent || res.classification.primary_intent,
        audit: ex.audit_reason || ex.automation_decision?.audit_reason || res.out?.reason || null,
        review_reason: ex.automation_decision?.human_review_reason || null,
        detail: ex.automation_decision?.human_review_detail || null,
        route: ex.automation_decision?.route_hint || null,
        suppressed: ex.automation_decision?.should_suppress_contact === true,
        suppression_reason: ex.automation_decision?.suppression_reason || null,
        followups: res.followups,
        context_status: res.classification.context_status || null,
        v2: p ? `${p.action}:${p.reasoning_code}` : null,
        v2_amount: p?.monetary?.amount ?? null,
        ade: ade ? `${ade.decision_tier}/${ade.computed_at?.toISOString?.() || ade.computed_at}` : null,
      };
    } catch (e) {
      return { error: e?.message || String(e) };
    } finally {
      Object.assign(console, silence);
    }
  }

  for (const r of rows) {
    r.prod = categorizeProduction(r, { catalog: extra.catalog });
    r.repA = await replay(r, { flag: false, catalog: safeCatalog });
    r.catA = categorizeReplay(r.repA, { catalog: extra.catalog, row: r });
    r.repB = await replay(r, { flag: true, catalog: safeCatalog });
    r.catB = categorizeReplay(r.repB, { catalog: extra.catalog, row: r });
    r.repC = await replay(r, { flag: true, catalog: approvedCatalog });
    r.catC = categorizeReplay(r.repC, { catalog: approvedCatalog, row: r });
  }

  // ── render ────────────────────────────────────────────────────────────────
  const order = Object.values(C);
  const count = (key) => {
    const m = new Map(order.map((c) => [c, 0]));
    for (const r of rows) m.set(r[key].cat, (m.get(r[key].cat) || 0) + 1);
    return m;
  };
  const P = count("prod"), A = count("catA"), B = count("catB"), Cc = count("catC");
  const out = [];
  const pad = (s, n) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? "").padEnd(n));
  out.push(`SELLER AUTOPILOT S1–S4 v2 — REPLY AUDIT ${from}..${to} (${tz}) · generated ${new Date().toISOString()} · read-only · redacted`);
  out.push(`${rows.length} inbound seller messages on ${new Set(rows.map((r) => r.thread_key)).size} threads (internal test phones excluded).`);
  out.push("Columns: PROD = what production did (c8177c9b) · A = replay at feat HEAD, flag OFF (= RC 8.4.2 B) · B = feat HEAD + SELLER_AUTOPILOT_V2 on, today's templates · C = B + proposed v2 rows and proposed safe flags approved.");
  out.push("Replay = this checkout's real classifier, context builder, orchestrator and executor over an in-memory copy of the thread (prior outbounds/inbounds, active catalog, the property's property_acquisition_scores row). Transport (sender caps, carrier) is not replayable; a replay 'auto-replied' on a transport-blocked row means the decision is now a send.");
  out.push("");
  out.push(`${pad("CATEGORY", 82)} ${"PROD".padStart(5)} ${"A".padStart(5)} ${"B".padStart(5)} ${"C".padStart(5)}`);
  for (const c of order) out.push(`${pad(c, 82)} ${String(P.get(c) || 0).padStart(5)} ${String(A.get(c) || 0).padStart(5)} ${String(B.get(c) || 0).padStart(5)} ${String(Cc.get(c) || 0).padStart(5)}`);
  const extraCats = [...new Set(rows.flatMap((r) => [r.catA.cat, r.catB.cat, r.catC.cat]).filter((c) => !order.includes(c)))];
  for (const c of extraCats) out.push(`${pad(c, 82)} ${"0".padStart(5)} ${String(A.get(c) || 0).padStart(5)} ${String(B.get(c) || 0).padStart(5)} ${String(Cc.get(c) || 0).padStart(5)}`);
  const substantive = rows.filter((r) => r.prod.cat !== C.BY_DESIGN).length;
  const replied = (m) => m.get(C.REPLIED) || 0;
  out.push("");
  out.push(`Auto-replied of messages that needed a reply (excl. by-design): PROD ${replied(P)}/${substantive} · A ${replied(A)} · B ${replied(B)} · C ${replied(Cc)}`);
  out.push("");
  // reason detail per category
  for (const [label, key] of [["PROD", "prod"], ["A", "catA"], ["B", "catB"], ["C", "catC"]]) {
    out.push(`── exact reasons (${label}) ${"─".repeat(60)}`);
    const m = new Map();
    for (const r of rows) {
      if (r[key].cat === C.REPLIED || r[key].cat === C.BY_DESIGN) continue;
      const k = `${r[key].cat} :: ${r[key].why}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) out.push(`  ${String(n).padStart(3)}  ${k}`);
    out.push("");
  }
  out.push(`── every message ${"─".repeat(70)}`);
  for (const r of rows) {
    const red = (s) => rq.redactText(s, { names: r.names, addresses: r.addresses }).replace(/\s+/g, " ").trim();
    out.push(`${rq.localDate(Date.parse(r.at), tz)} ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(r.at))} ${pad(r.seller_initials, 6)} ${pad(r.market || "—", 14)} "${pad(red(r.body), 80)}"`);
    out.push(`    prior: ${r.prior ? `${r.prior.kind}:${r.prior.use_case || "?"} — "${pad(red(r.prior.body), 70)}"` : "none"} · stage ${r.stage_before || "?"}→${r.stage_after || "?"} · intent ${r.intent || "—"}${r.confidence != null ? ` ${Number(r.confidence).toFixed(2)}` : ""} · lang ${r.seller_language || "?"}`);
    out.push(`    PROD: ${r.prod.cat} — ${r.prod.why}`);
    for (const [label, rep, cat] of [["A", r.repA, r.catA], ["B", r.repB, r.catB], ["C", r.repC, r.catC]]) {
      out.push(`    ${label}: ${cat.cat} — ${cat.why}${rep?.intent ? ` · intent ${rep.intent}` : ""}${rep?.v2 && !rep.queued ? ` · v2 ${rep.v2}` : ""}${rep?.v2_amount ? ` · X=$${rep.v2_amount.toLocaleString("en-US")}` : ""}${rep?.ade ? ` · ADE ${rep.ade}` : ""}`);
    }
  }
  out.push("");
  const file = arg("out");
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(path.resolve(file), out.join("\n"));
  silence.log(`audit → ${path.resolve(file)} (${rows.length} messages)`);
}

if (process.argv[1] && process.argv[1].endsWith("autopilot-v2-audit.mjs")) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || e);
    process.exit(1);
  });
}
