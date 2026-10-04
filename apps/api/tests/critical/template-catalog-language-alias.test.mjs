import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLanguage,
  resolveLanguage,
  templateCatalogLanguageName,
  sameTemplateLanguage,
  unsupportedTemplateLanguage,
} from "../../src/lib/sms/language_aliases.js";
import { templateCatalogLanguage } from "../../src/lib/domain/campaigns/campaign-canonical-language.js";
import { renderOutboundTemplate } from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";

/**
 * LANGUAGE TEMPLATE COVERAGE SEAM (2026-10-04).
 *
 * Seller data writes the Hindi family as "Asian Indian (Hindi or Other)",
 * which is also the runtime canonical. Every Hindi row in sms_templates is
 * labelled "Indian (Hindi or Other)". The send-time renderer filtered the
 * catalog with .ilike("language", canonical), matched nothing, and held the
 * seller at launch (11 eligible Minneapolis sellers). The fix maps the
 * canonical to the catalog label at lookup; source data is untouched.
 *
 * Audit of the same night: the seller graph also carries "Pashtu/Pashto",
 * which matched neither the unsupported list ("Pashto") nor a template.
 */

test("catalog alias: the Hindi family resolves to the sms_templates label", () => {
  for (const raw of ["Asian Indian (Hindi or Other)", "asian indian (hindi or other)", " Indian (Hindi or Other) ", "Hindi", "hi"]) {
    assert.equal(templateCatalogLanguageName(raw), "Indian (Hindi or Other)", raw);
  }
  // The runtime canonical (used by classifier, brain, Podio) is unchanged.
  assert.equal(normalizeLanguage("Indian (Hindi or Other)"), "Asian Indian (Hindi or Other)");
});

test("catalog alias: every other catalog language maps to itself", () => {
  for (const language of ["English", "Spanish", "Portuguese", "Italian", "French", "German", "Greek", "Hebrew", "Mandarin", "Japanese", "Korean", "Russian", "Arabic", "Polish", "Vietnamese"]) {
    assert.equal(templateCatalogLanguageName(language), language);
  }
  assert.equal(templateCatalogLanguageName(""), null);
  assert.equal(templateCatalogLanguageName("Klingon"), "Klingon", "unknown labels pass through trimmed");
});

test("sameTemplateLanguage compares through the alias, case-insensitively", () => {
  assert.equal(sameTemplateLanguage("Asian Indian (Hindi or Other)", "Indian (Hindi or Other)"), true);
  assert.equal(sameTemplateLanguage("spanish", "Spanish"), true);
  assert.equal(sameTemplateLanguage("Spanish", "English"), false);
  assert.equal(sameTemplateLanguage("", "English"), false);
});

test("campaign templateCatalogLanguage delegates to the shared alias", () => {
  assert.deepEqual(templateCatalogLanguage("Asian Indian (Hindi or Other)"), { language: "Indian (Hindi or Other)", unsupported: false });
  assert.deepEqual(templateCatalogLanguage("Spanish"), { language: "Spanish", unsupported: false });
  assert.equal(templateCatalogLanguage("Farsi").unsupported, true);
});

test("unsupported languages are recognised in their source spellings and still hold", () => {
  assert.equal(unsupportedTemplateLanguage("Pashtu/Pashto"), "Pashto");
  assert.equal(unsupportedTemplateLanguage("persian"), "Farsi");
  assert.equal(unsupportedTemplateLanguage("thai"), "Thai");
  assert.equal(unsupportedTemplateLanguage("Spanish"), null);
  assert.deepEqual(resolveLanguage("Pashtu/Pashto"), { canonical: "Pashto", unsupported: true });
  assert.deepEqual(resolveLanguage("Farsi"), { canonical: "Farsi", unsupported: true });
  assert.deepEqual(resolveLanguage("Thai"), { canonical: "Thai", unsupported: true });
});

function recordingSupabase(rows) {
  const filters = [];
  const builder = (state) => {
    const b = {
      select: () => b,
      eq: () => b,
      ilike: (column, value) => { state.ilike = [column, value]; filters.push(value); return b; },
      order: () => b,
      limit: () => Promise.resolve({
        data: state.ilike ? rows.filter((row) => row.language.toLowerCase() === String(state.ilike[1]).toLowerCase()) : rows,
        error: null,
      }),
    };
    return b;
  };
  return {
    filters,
    from(table) {
      if (table === "sms_templates") return builder({});
      const empty = { select: () => empty, eq: () => empty, ilike: () => empty, in: () => empty, order: () => empty, limit: () => Promise.resolve({ data: [], error: null }), then: (r) => r({ data: [], error: null }) };
      return empty;
    },
  };
}

const HINDI_TEMPLATE = {
  id: "200006",
  template_id: "200006",
  is_active: true,
  use_case: "ownership_check",
  language: "Indian (Hindi or Other)",
  stage_code: "S1",
  is_first_touch: true,
  template_body: "Namaste {{seller_first_name}}, main {{agent_name}} hoon. Kya aap abhi bhi {{property_address}} ke malik hain?",
  allowed_property_groups: ["sfr"],
  prohibited_property_groups: [],
};

function hindiCandidate(language) {
  return {
    master_owner_id: "mo_hindi",
    property_id: "prop_hindi",
    phone_id: "ph_hindi",
    canonical_e164: "+16125550100",
    canonical_property_group: "sfr",
    property_type: "SFR",
    market: "Minneapolis, MN",
    timezone: "America/Chicago",
    matching_flags: "Likely Owner",
    identity_alignment: { status: "probable", eligible: true, score: 75, reasons: [] },
    touch_number: 1,
    stage_code: "S1",
    agent_name: "Alex",
    owner_display_name: "Raj Patel",
    seller_first_name: "Raj",
    prospect_first_name: "Raj",
    property_address: "123 Main St",
    property_address_full: "123 Main St, Minneapolis, MN 55401",
    language,
  };
}

test("renderer: an 'Asian Indian (Hindi or Other)' seller fetches and renders the Hindi catalog", async () => {
  const supabase = recordingSupabase([HINDI_TEMPLATE]);
  const result = await renderOutboundTemplate(
    hindiCandidate("Asian Indian (Hindi or Other)"),
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase }
  );
  assert.equal(supabase.filters[0], "Indian (Hindi or Other)", "the fetch filter is the catalog label");
  assert.equal(result.ok, true, `expected a render, got ${result.reason_code}/${result.reason}`);
  assert.match(String(result.rendered_message_body || ""), /^Namaste Raj,/);
});

test("renderer: Farsi still holds as unsupported_language (no English fallback)", async () => {
  const supabase = recordingSupabase([HINDI_TEMPLATE, { ...HINDI_TEMPLATE, id: "200001", template_id: "200001", language: "English", template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?" }]);
  const result = await renderOutboundTemplate(
    hindiCandidate("Farsi"),
    { template_use_case: "ownership_check", within_contact_window_now: false, now: new Date().toISOString() },
    { supabase }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_language");
  assert.equal(supabase.filters.length, 0, "an unsupported language never queries the catalog");
});
