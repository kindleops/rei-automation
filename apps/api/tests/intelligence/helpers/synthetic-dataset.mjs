/**
 * Deterministic synthetic first-touch data + an in-memory dataset source for
 * IC8 tests. No network, no database. Phone numbers are fictional 555 lines.
 */

const HOUR = 3_600_000;
const BASE = Date.parse("2026-05-01T15:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

const PROPERTIES = [
  { property_id: "p-az", canonical_market_id: "Phoenix", property_address_state: "AZ", property_address_zip: "85001", property_type: "SFR", units_count: 1, building_square_feet: 1400, total_bedrooms: 3, total_baths: 2, year_built: 1978 },
  { property_id: "p-mn", canonical_market_id: "Minneapolis", property_address_state: "MN", property_address_zip: "55411", property_type: "Multi-Family", units_count: 2, building_square_feet: 2100, total_bedrooms: 4, total_baths: 2, year_built: 1925 },
  { property_id: "p-tx", canonical_market_id: "Dallas", property_address_state: "TX", property_address_zip: "75201", property_type: "SFR", units_count: 1, building_square_feet: 1800, total_bedrooms: 3, total_baths: 2.5, year_built: 2001 },
];
const TEMPLATES = ["tpl-a", "tpl-b", "tpl-c"];

/** n synthetic send rows; reply/STOP/delivery patterns are pure functions of the index. */
export function syntheticSends(n = 24) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const property = PROPERTIES[i % PROPERTIES.length];
    const sentMs = BASE + i * 7 * HOUR;
    const threadKey = `+1602555${String(1000 + i).padStart(4, "0")}`;
    const delivered = i % 5 !== 4;
    const replies = i % 3 === 0 && delivered;
    const stop = i % 11 === 5;
    const inbound = [];
    if (replies) inbound.push({ id: `in-${i}-a`, direction: "inbound", event_type: "inbound_sms", created_at: iso(sentMs + 2 * HOUR), message_body: i % 2 ? "yes I own it" : "who is this?" });
    if (stop) inbound.push({ id: `in-${i}-s`, direction: "inbound", event_type: "inbound_sms", created_at: iso(sentMs + 3 * HOUR), message_body: "STOP" });
    const send = {
      id: `send-${String(i).padStart(3, "0")}`,
      thread_key: threadKey,
      to_phone_number: threadKey,
      property_id: property.property_id,
      master_owner_id: `mo-${i}`,
      template_id: TEMPLATES[i % TEMPLATES.length],
      use_case_template: "ownership_check",
      source: "legacy_feeder",
      created_at: iso(sentMs - 60_000),
      sent_at: iso(sentMs),
      delivered_at: delivered ? iso(sentMs + 30_000) : null,
      queue_status: delivered ? "delivered" : "failed_transport",
    };
    rows.push({
      ...send,
      template_language: i % 4 === 0 ? "Spanish" : "English",
      bundle: {
        property: property,
        owner_profile: { master_owner_id: `mo-${i}`, owner_type_guess: i % 4 === 0 ? "LLC/CORP | ABSENTEE" : "INDIVIDUAL | ABSENTEE" },
        sends: i > 0 ? [{ id: `prior-${i}`, thread_key: threadKey, sent_at: iso(sentMs - 48 * HOUR), created_at: iso(sentMs - 48 * HOUR - 1000), delivered_at: iso(sentMs - 48 * HOUR + 5000) }] : [],
        recorded_sales: [{ property_id: property.property_id, event_date: "2012-06-30" }],
        recorded_mortgages: i % 2 ? [{ property_id: property.property_id, recording_date: "2016-02-01" }] : [],
      },
      reads: { inbound, laterSends: [] },
    });
  }
  // two rows that the exclusions must drop
  rows.push({ ...rows[0], id: "send-canary", thread_key: "+16127433952", to_phone_number: "+16127433952", bundle: rows[0].bundle, reads: rows[0].reads });
  rows.push({ ...rows[1], id: "send-proof", source: "internal_canary", bundle: rows[1].bundle, reads: rows[1].reads });
  return rows;
}

/** In-memory keyset source. failOnPage: throw once when that page index is requested. */
export function createInMemorySource(rows, { failOnPage = null, leakPhoneInStrata = false } = {}) {
  let failed = false;
  let reads = 0;
  return {
    get pageReads() {
      return reads;
    },
    async readPage({ cursor, limit }) {
      const start = cursor ? Number(cursor) : 0;
      if (failOnPage !== null && !failed && Math.floor(start / limit) === failOnPage) {
        failed = true;
        throw new Error("simulated source outage");
      }
      reads += 1;
      const page = rows.slice(start, start + limit);
      return { rows: page, nextCursor: start + limit < rows.length ? String(start + limit) : null };
    },
    subjectOf(row) {
      return { id: row.id, asOf: row.sent_at || row.created_at, entity: row, threadKey: row.thread_key };
    },
    loadFeatureBundle(row) {
      return row.bundle;
    },
    loadOutcomeReads(row) {
      return row.reads;
    },
    strataOf(row) {
      return { template_language: leakPhoneInStrata ? row.thread_key : row.template_language };
    },
  };
}

export const SYNTHETIC_SPEC = Object.freeze({
  name: "seller_first_touch_reply_test",
  subjectType: "send",
  population: { description: "synthetic first touches" },
  asOfWindow: { from: "2026-04-20T00:00:00Z", to: "2026-09-29T00:00:00Z" },
  featureSetId: "seller_first_touch@1",
  outcomes: [
    { key: "reply_any", version: 1 },
    { key: "reply_meaningful", version: 1 },
    { key: "opt_out_keyword", version: 1 },
  ],
  labelNow: "2026-09-30T00:00:00Z",
  pageSize: 5,
  paceMs: 0,
  strata: ["template_language"],
});

export const TEST_SALT = "ic8-test-salt-0123456789abcdef";
