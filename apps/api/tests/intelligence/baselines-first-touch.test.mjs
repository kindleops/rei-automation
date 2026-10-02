import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  assignEpisodes,
  firstTouchKind,
  normalizePhone,
  pseudonymizeKey,
  rotationHashIndex,
  summarizeRotation,
  templateAttributes,
} from "../../scripts/intelligence/baselines/lib/first-touch.mjs";
import { inTile, rootTiles, splitTile, tileCircle, haversineMiles } from "../../scripts/intelligence/baselines/lib/geo-tiles.mjs";
import { familyPopulations, matureRows } from "../../scripts/intelligence/baselines/lib/populations.mjs";
import { pairCounts, stageEntries } from "../../scripts/intelligence/baselines/stage-feasibility.mjs";

const SECRET = "test-secret-0123456789abcdef";

test("pseudonyms: stable across phone spellings, letters only, secret-dependent", () => {
  const a = pseudonymizeKey("+16025551234", SECRET);
  assert.equal(a, pseudonymizeKey("6025551234", SECRET));
  assert.equal(a, pseudonymizeKey("16025551234", SECRET));
  assert.match(a, /^k_[a-p]{32}$/);
  assert.notEqual(a, pseudonymizeKey("+16025551234", `${SECRET}x`));
  assert.equal(normalizePhone("(602) 555-1234"), "+16025551234");
  assert.throws(() => pseudonymizeKey("+16025551234", "short"));
});

test("episodes: sends within 10 minutes on one thread form one episode led by the first", () => {
  const t = (m) => new Date(Date.UTC(2026, 4, 1, 15, m)).toISOString();
  const rows = [
    { id: "a", thread_key: "k1", sent_at: t(0), delivered_at: null },
    { id: "b", thread_key: "k1", sent_at: t(6), delivered_at: t(7) },
    { id: "c", thread_key: "k1", sent_at: t(30), delivered_at: t(31) },
    { id: "d", thread_key: "k2", sent_at: t(1), delivered_at: t(2) },
    { id: "e", thread_key: "k2", sent_at: null },
  ];
  const ep = assignEpisodes(rows);
  assert.equal(ep.get("a").position, 0);
  assert.equal(ep.get("b").lead_id, "a");
  assert.equal(ep.get("a").size, 2);
  assert.equal(ep.get("a").delivered_any, true);
  assert.equal(ep.get("a").lead_delivered, false);
  assert.equal(ep.get("c").position, 0, "30 minutes later starts a new episode");
  assert.equal(ep.has("e"), false, "unsent rows are not episodes");
});

test("send kind follows the data-audit rule for ownership_check rows", () => {
  assert.equal(firstTouchKind({ source: "map_command", campaign_id: "x" }), "first_touch_map_operator");
  assert.equal(firstTouchKind({ campaign_id: "x" }), "first_touch_campaign");
  assert.equal(firstTouchKind({ source: "feeder" }), "first_touch_legacy_feeder");
  assert.equal(firstTouchKind({ source: "internal_canary" }), "test");
  assert.equal(firstTouchKind({ metadata: { candidate_snapshot_internal_canary: "true" } }), "test");
});

test("rotation: reproduces the feeder hash (first 8 hex of sha1 mod pool) and drops the seed", () => {
  const seed = "mo_1|p_2|ph_3|English|ownership_check|S1|session|2026-05-01";
  const expected = Number.parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 8), 16) % 35;
  assert.equal(rotationHashIndex(seed, 35), expected);
  const pool = Array.from({ length: 35 }, (_, i) => `t${i}`);
  const s = summarizeRotation({ seed, poolSize: 35, selectedIndex: expected, candidateIds: pool, templateId: pool[expected] });
  assert.equal(s.hash_matches_logged_index, true);
  assert.equal(s.chosen_matches_pool_slot, true);
  assert.ok(!JSON.stringify(s).includes("mo_1"), "seed never persisted");
  assert.equal(summarizeRotation({ seed, poolSize: 35, selectedIndex: (expected + 1) % 35, candidateIds: pool, templateId: "t0" }).hash_matches_logged_index, false);
});

test("template attributes are text-free", () => {
  const a = templateAttributes("Hi {{first_name}}, do you still own {{property_address}}?");
  assert.equal(a.names_seller, true);
  assert.equal(a.names_property, true);
  assert.equal(a.has_question, true);
  assert.ok(!Object.values(a).some((v) => typeof v === "string" && v.includes("own")));
});

test("geo tiles: circumscribed circle covers the tile; split halves; roots only near points", () => {
  const tile = { lat0: 44.9, lng0: -93.3, size: 0.12 };
  const c = tileCircle(tile);
  for (const [lat, lng] of [[44.9, -93.3], [45.02, -93.18], [44.9, -93.18]]) assert.ok(haversineMiles(c.lat, c.lng, lat, lng) <= c.radius);
  const kids = splitTile(tile);
  assert.equal(kids.length, 4);
  assert.ok(inTile(kids[0], 44.9, -93.3) && !inTile(kids[0], 44.96, -93.3));
  const { tiles } = rootTiles([{ lat: 44.95, lng: -93.25 }], { size: 0.12, bufferMiles: 2.5 });
  assert.ok(tiles.length >= 1 && tiles.length <= 4);
});

test("family populations: reply/opt-out use delivered episode leads, filtering uses every send", () => {
  const rec = (id, lead, delivered, extra = {}) => ({
    subject_id: id,
    as_of: "2026-05-01T00:00:00Z",
    strata: { episode_lead: lead },
    outcomes: { "delivered@1": { status: "mature", value: delivered }, "reply_any@1": { status: "mature", value: false }, ...extra },
  });
  const pops = familyPopulations([rec("a", true, true), rec("b", false, true), rec("c", true, false)]);
  assert.deepEqual(pops.seller_first_touch_reply.rows.map((r) => r.subject_id), ["a"]);
  assert.equal(pops.send_carrier_filtering.rows.length, 3);
  const mature = matureRows([rec("p", true, true, { "x@1": { status: "pending", value: null } })], "x@1");
  assert.equal(mature.length, 0, "pending rows never become negatives");
});

test("stage entries: grouped per opportunity, valid-from respected, pairs counted", () => {
  const ev = [
    { id: "1", opportunity_id: "o", previous_value: "offer_interest", new_value: "asking_price", created_at: "2026-07-01T00:00:00Z" },
    { id: "2", opportunity_id: "o", previous_value: "asking_price", new_value: "offer", created_at: "2026-07-05T00:00:00Z" },
    { id: "3", opportunity_id: "p", previous_value: "offer_interest", new_value: "asking_price", created_at: "2026-06-01T00:00:00Z" },
  ];
  const subjects = stageEntries(ev, { groupOf: (e) => e.opportunity_id, validFrom: "2026-06-21T00:00:00Z" });
  assert.equal(subjects.length, 2);
  assert.equal(subjects[0].later.length, 1);
  assert.equal(pairCounts(ev)["offer_interest -> asking_price"], 2);
});
