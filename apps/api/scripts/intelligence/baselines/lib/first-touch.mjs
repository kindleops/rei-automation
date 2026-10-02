/**
 * IC8 baselines: pure first-touch population logic (no I/O).
 *
 *   - pseudonymous thread keys (keyed HMAC; the raw phone never reaches disk);
 *   - first-touch EPISODES: sent ownership_check rows on one thread within
 *     10 minutes of the previous one form one episode (portfolio owners get
 *     one text per property; IC8 data audit §3.0). The episode lead is the
 *     first send; reply models use one row per episode so a thread-level reply
 *     is never counted twice;
 *   - send kind (data audit §2a rule, ownership_check rows only);
 *   - reproduction of the legacy feeder's template draw:
 *     index = parseInt(sha1(seed).slice(0, 8), 16) mod |pool|
 *     (supabase-candidate-feeder.js stableSeedModulo / chooseRotatingTemplate),
 *     so the logged propensity of the chosen template is 1/|pool|.
 */

import { createHash, createHmac } from "node:crypto";

export const EPISODE_GAP_MS = 10 * 60 * 1000;

/** +1XXXXXXXXXX for 10/11-digit NANP spellings, else the trimmed input. */
export function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

const HEX_TO_LETTER = "abcdefghijklmnop";
/**
 * Keyed pseudonym for a phone/thread key. Letters only (a-p), so no later
 * phone-shaped normalisation can ever read digits out of it.
 */
export function pseudonymizeKey(value, secret) {
  if (!secret || String(secret).length < 16) throw new TypeError("pseudonymizeKey needs a secret of >= 16 chars");
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  const hex = createHmac("sha256", String(secret)).update(normalized).digest("hex").slice(0, 32);
  return `k_${[...hex].map((c) => HEX_TO_LETTER[parseInt(c, 16)]).join("")}`;
}

const lower = (v) => String(v ?? "").trim().toLowerCase();

/** Data audit §2a send-kind rule, restricted to what an ownership_check row can be. */
export function firstTouchKind(row) {
  const md = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (
    ["internal_canary", "queue_limited_cap_proof", "inbox_lock_certification"].includes(lower(row.source)) ||
    lower(row.message_type) === "self test" ||
    lower(row.use_case_template) === "debug" ||
    lower(md.candidate_snapshot_internal_canary) === "true"
  ) {
    return "test";
  }
  if (lower(row.source) === "map_command") return "first_touch_map_operator";
  if (row.campaign_id) return "first_touch_campaign";
  return "first_touch_legacy_feeder";
}

const sendTime = (row) => {
  const t = Date.parse(row.sent_at || row.created_at || "");
  return Number.isFinite(t) ? t : null;
};

/**
 * Group sent rows into episodes per thread. Returns Map id -> { episode_id,
 * lead_id, position, size, delivered_any, lead_delivered }.
 */
export function assignEpisodes(rows, { gapMs = EPISODE_GAP_MS, threadOf = (r) => r.thread_key } = {}) {
  const byThread = new Map();
  for (const row of rows) {
    const key = threadOf(row);
    const t = sendTime(row);
    if (!key || t === null || !row.sent_at) continue;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push({ row, t });
  }
  const out = new Map();
  for (const key of [...byThread.keys()].sort()) {
    const list = byThread.get(key).sort((a, b) => a.t - b.t || String(a.row.id).localeCompare(String(b.row.id)));
    let current = null;
    let prevT = null;
    const episodes = [];
    for (const entry of list) {
      if (!current || entry.t - prevT > gapMs) {
        current = [];
        episodes.push(current);
      }
      current.push(entry);
      prevT = entry.t;
    }
    for (const members of episodes) {
      const lead = members[0].row;
      const deliveredAny = members.some((m) => Boolean(m.row.delivered_at));
      members.forEach((m, position) => {
        out.set(String(m.row.id), {
          episode_id: String(lead.id),
          lead_id: String(lead.id),
          position,
          size: members.length,
          delivered_any: deliveredAny,
          lead_delivered: Boolean(lead.delivered_at),
        });
      });
    }
  }
  return out;
}

/** The feeder's hash index for a logged seed and pool size. */
export function rotationHashIndex(seed, poolSize) {
  const k = Math.max(1, Number(poolSize) || 1);
  const digest = createHash("sha1").update(String(seed ?? "").trim()).digest("hex");
  const numeric = Number.parseInt(digest.slice(0, 8), 16);
  return Number.isFinite(numeric) ? numeric % k : 0;
}

/**
 * Verify one logged draw and reduce it to what may be persisted (the seed
 * embeds owner/property/phone ids and is never written).
 */
export function summarizeRotation({ seed, poolSize, selectedIndex, candidateIds, templateId }) {
  const k = Number(poolSize);
  if (!seed || !Number.isInteger(k) || k < 1) return null;
  const ids = Array.isArray(candidateIds) ? candidateIds.map(String) : [];
  const idx = Number(selectedIndex);
  const hashIndex = rotationHashIndex(seed, k);
  return {
    pool_size: k,
    pool_ids: ids,
    selected_index: Number.isInteger(idx) ? idx : null,
    hash_matches_logged_index: Number.isInteger(idx) && hashIndex === idx,
    pool_logged_completely: ids.length === k,
    chosen_in_pool: templateId ? ids.includes(String(templateId)) : false,
    chosen_matches_pool_slot: Number.isInteger(idx) && ids[idx] === String(templateId ?? ""),
  };
}

/**
 * Derived, text-free attributes of OUR template copy (never seller text), for
 * coarse template-policy evaluation only.
 */
export function templateAttributes(body) {
  const text = String(body ?? "");
  const placeholders = text.match(/\{\{?\s*[\w.]+\s*\}?\}|\[[A-Za-z_ ]+\]/g) || [];
  const names = placeholders.filter((p) => /name/i.test(p));
  const address = placeholders.filter((p) => /address|street|property/i.test(p));
  const plain = text.replace(/\{\{?\s*[\w.]+\s*\}?\}/g, "X");
  return {
    length: plain.length,
    length_band: plain.length < 100 ? "short_lt100" : plain.length < 160 ? "medium_100_159" : "long_160_plus",
    has_question: /\?/.test(plain),
    names_seller: names.length > 0,
    names_property: address.length > 0,
    placeholder_count: placeholders.length,
  };
}
