import test from "node:test";
import assert from "node:assert/strict";
import { targetLanguageHold, templateLanguageHold } from "../../src/lib/sms/language_aliases.js";
import {
  summarizeLanguageHolds,
  sendableAfterPersonalization,
  sendableAfterLanguageHolds,
} from "../../src/lib/domain/campaigns/campaign-audience-funnel.js";
import { eligibleMembers } from "../../src/lib/domain/campaigns/campaign-composer.js";
import { launchCandidateFromTarget } from "../../src/lib/domain/campaigns/campaign-automation-service.js";
import { renderOutboundTemplate } from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";

/**
 * The Composer funnel must show sellers the renderer will refuse for language
 * (2026-10-04): counted with the renderer's own predicate so the funnel and
 * send time cannot disagree.
 */

const LANGUAGES = [
  "Farsi", "Thai", "Pashtu/Pashto", "persian", "THAI", "Pashto",
  "English", "Spanish", "Asian Indian (Hindi or Other)", "Indian (Hindi or Other)", "Mandarin",
  "auto", "unknown", "", null, "Klingon",
];

const target = (language, extra = {}) => ({
  id: `t-${language}`,
  market: "Minneapolis, MN",
  language,
  metadata: { candidate_snapshot: { seller_first_name: "Sam", property_address: "1 Main St", language: null } },
  ...extra,
});

const emptySupabase = {
  from() {
    const b = { select: () => b, eq: () => b, ilike: () => b, in: () => b, order: () => b, limit: () => Promise.resolve({ data: [], error: null }) };
    return b;
  },
};

test("funnel predicate agrees with the renderer for every language value", async () => {
  for (const language of LANGUAGES) {
    const row = target(language);
    const funnelHeld = targetLanguageHold(row) !== null;
    const candidate = launchCandidateFromTarget(row, { id: "camp" });
    const rendered = await renderOutboundTemplate(candidate, { template_use_case: "ownership_check", first_touch: true }, { supabase: emptySupabase });
    const renderHeld = rendered.ok === false && rendered.reason === "unsupported_language";
    assert.equal(funnelHeld, renderHeld, `funnel vs renderer disagree on ${JSON.stringify(language)}`);
  }
});

test("hold predicate: unsupported only; policy tokens and empty are English", () => {
  assert.equal(templateLanguageHold("Farsi"), "Farsi");
  assert.equal(templateLanguageHold("Pashtu/Pashto"), "Pashto");
  assert.equal(templateLanguageHold("Asian Indian (Hindi or Other)"), null);
  assert.equal(templateLanguageHold("auto"), null);
  assert.equal(templateLanguageHold(""), null);
  // snapshot language is read when the target has none, as launchCandidateFromTarget does
  assert.equal(targetLanguageHold({ language: null, metadata: { candidate_snapshot: { language: "Thai" } } }), "Thai");
});

test("summarizeLanguageHolds gives a per-language breakdown and avoids double-counting lint refusals", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => target("Farsi")),
    ...Array.from({ length: 3 }, () => target("Thai")),
    target("Pashtu/Pashto", { market: "Dallas, TX" }),
    target("Spanish"),
    target("English"),
  ];
  const kinds = rows.map((_, i) => (i === 0 ? "none" : "first_name"));
  const holds = summarizeLanguageHolds(rows, kinds);
  assert.equal(holds.held, 10);
  assert.deepEqual(holds.by_language, { Farsi: 6, Thai: 3, Pashto: 1 });
  assert.equal(holds.held_and_refused, 1);
  assert.deepEqual(holds.by_market_unrefused, { "Minneapolis, MN": 8, "Dallas, TX": 1 });
  assert.deepEqual(holds.by_market, { "Minneapolis, MN": 9, "Dallas, TX": 1 });
});

test("sendable counts subtract language holds only in sendable markets, once", () => {
  const markets = [{ market: "Minneapolis, MN", sendable: true }, { market: "Dallas, TX", sendable: false }];
  const personalization = { none_by_market: { "Minneapolis, MN": 4 } };
  const holds = { by_market: { "Minneapolis, MN": 9, "Dallas, TX": 1 }, by_market_unrefused: { "Minneapolis, MN": 8, "Dallas, TX": 1 } };
  assert.equal(sendableAfterPersonalization(100, markets, personalization, holds), 100 - 4 - 8);
  assert.equal(sendableAfterPersonalization(100, markets, personalization), 96, "no holds -> unchanged behaviour");
  assert.equal(sendableAfterLanguageHolds(100, markets, holds), 91);
  assert.equal(sendableAfterLanguageHolds(100, markets, null), 100);
});

test("map eligibility excludes language-held members, matching the cohort count", () => {
  const members = [
    { property_id: "a", market: "Minneapolis, MN", greeting: "first_name", language_hold: null },
    { property_id: "b", market: "Minneapolis, MN", greeting: "first_name", language_hold: "Farsi" },
    { property_id: "c", market: "Minneapolis, MN", greeting: "none", language_hold: "Thai" },
  ];
  const r = eligibleMembers(members, [{ market: "Minneapolis, MN", sendable: true }]);
  assert.deepEqual(r.eligible.map((m) => m.property_id), ["a"]);
  assert.equal(r.language_held, 1);
  assert.equal(r.no_greeting, 1);
});
