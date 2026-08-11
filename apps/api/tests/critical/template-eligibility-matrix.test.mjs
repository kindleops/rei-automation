/**
 * template-eligibility-matrix.test.mjs
 *
 * G2: deterministic template eligibility matrix over the normalized corpus —
 * eligibility per (campaign_type × communication class × stage × use_case),
 * required/forbidden fields, coverage audit, and the fail-open fix
 * (corpus-load failure is a BLOCKING skip, never silent degradation).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TEMPLATE_CORPUS_UNAVAILABLE,
  buildTemplateEligibilityMatrix,
  loadTemplateEligibilityMatrix,
  resolveEligibleTemplates,
  auditTemplateCorpusCoverage,
  templateRequiredFields,
  templateEligibleCommunicationClasses,
} from "@/lib/domain/templates/template-eligibility-matrix.js";
import { normalizeSupabaseTemplateRow } from "@/lib/domain/templates/load-supabase-template-candidates.js";
import { loadTemplateCandidates } from "@/lib/domain/templates/load-template.js";
import { assignCampaignTargetTemplates } from "@/lib/domain/campaigns/campaign-target-template-assignment.js";

// ─── Corpus fixtures (raw sms_templates rows → loader normalizer) ────────────

const RAW_ROWS = [
  {
    id: "tpl-neutral",
    template_id: "tpl-neutral",
    is_active: true,
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    property_type_scope: "Any Residential",
    template_name: "Neutral Ownership",
    template_body: "Hi {{seller_first_name}}, do you still own {{property_address}}?",
  },
  {
    id: "tpl-5plus",
    template_id: "tpl-5plus",
    is_active: true,
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    property_type_scope: "5+ Units",
    template_name: "5+ Units Ownership",
    template_body:
      "Hi {{seller_first_name}}, do you still own the building at {{property_address}}? How many units are rented?",
  },
  {
    id: "tpl-duplex",
    template_id: "tpl-duplex",
    is_active: true,
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    property_type_scope: "Duplex",
    template_name: "Duplex Ownership",
    template_body: "Hi {{seller_first_name}}, is the duplex at {{property_address}} still yours?",
    cooldown_days: 5,
  },
  {
    id: "tpl-mf-rents",
    template_id: "tpl-mf-rents",
    is_active: true,
    use_case: "mf_rents",
    stage_code: "S2",
    language: "English",
    property_type_scope: "5+ Units",
    template_name: "MF Rents",
    template_body:
      "Thanks {{seller_first_name}} — what do the {{unit_count}} units bring in? Around {{monthly_rents}}?",
  },
  {
    id: "tpl-inactive",
    template_id: "tpl-inactive",
    is_active: false,
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    property_type_scope: "Any Residential",
    template_name: "Inactive",
    template_body: "Hi {{seller_first_name}}, quick question about {{property_address}}.",
  },
];

function makeMatrix() {
  return buildTemplateEligibilityMatrix(
    RAW_ROWS.map(normalizeSupabaseTemplateRow),
    { corpus_source: "supabase_sms_templates" }
  );
}

// ─── Matrix build ────────────────────────────────────────────────────────────

test("matrix build: deterministic, sorted, with derived fields", () => {
  const matrix = makeMatrix();
  assert.equal(matrix.ok, true);
  assert.equal(matrix.template_count, 5);
  const ids = matrix.entries.map((entry) => entry.template_id);
  assert.deepEqual(ids, [...ids].sort());

  const duplex = matrix.entries.find((entry) => entry.template_id === "tpl-duplex");
  assert.equal(duplex.approved, true);
  assert.equal(duplex.weight, 1);
  assert.equal(duplex.cooldown, 5);
  assert.deepEqual(duplex.required_fields, ["property_address", "seller_first_name"]);
  assert.deepEqual(duplex.eligible_communication_classes, ["duplex"]);

  const inactive = matrix.entries.find((entry) => entry.template_id === "tpl-inactive");
  assert.equal(inactive.approved, false);
});

test("matrix build: required_fields canonicalize legacy placeholder aliases", () => {
  assert.deepEqual(
    templateRequiredFields({
      template_body: "Hi {{first_name}}, about {{street_address}} — {{units}} total?",
    }),
    ["property_address", "seller_first_name", "unit_count"]
  );
});

test("matrix build: unit-worded template is eligible only for its classes", () => {
  const fivePlus = normalizeSupabaseTemplateRow(RAW_ROWS[1]);
  assert.deepEqual(templateEligibleCommunicationClasses(fivePlus), ["multifamily_5_plus"]);
  const neutral = normalizeSupabaseTemplateRow(RAW_ROWS[0]);
  const neutralClasses = templateEligibleCommunicationClasses(neutral);
  assert.ok(neutralClasses.includes("single_family"));
  assert.ok(neutralClasses.includes("unknown"));
  assert.ok(neutralClasses.includes("multifamily_5_plus"));
});

// ─── Eligibility resolution ──────────────────────────────────────────────────

test("matrix resolve: multifamily_5_plus cell gets 5+ wording, single_family cannot", () => {
  const matrix = makeMatrix();

  const mf = resolveEligibleTemplates(matrix, {
    campaign_type: "ownership_check",
    property_communication_class: "multifamily_5_plus",
    stage_code: "S1",
    use_case: "ownership_check",
  });
  assert.equal(mf.ok, true);
  assert.deepEqual(
    mf.descriptors.map((d) => d.template_id),
    ["tpl-5plus", "tpl-neutral"]
  );

  const sfr = resolveEligibleTemplates(matrix, {
    campaign_type: "ownership_check",
    property_communication_class: "single_family",
    stage_code: "S1",
    use_case: "ownership_check",
  });
  assert.deepEqual(
    sfr.descriptors.map((d) => d.template_id),
    ["tpl-neutral"]
  );
  assert.deepEqual(sfr.descriptors[0].forbidden_fields, [
    "unit_count",
    "occupied_units",
    "monthly_rents",
    "monthly_expenses",
  ]);
});

test("matrix resolve: unknown class gets property-neutral templates only", () => {
  const matrix = makeMatrix();
  const unknown = resolveEligibleTemplates(matrix, {
    property_communication_class: "unknown",
    stage_code: "S1",
    use_case: "ownership_check",
  });
  assert.deepEqual(
    unknown.descriptors.map((d) => d.template_id),
    ["tpl-neutral"]
  );
});

test("matrix resolve: required unit placeholders are forbidden for single_family/unknown", () => {
  const matrix = makeMatrix();
  // mf_rents requires unit_count + monthly_rents — never eligible for
  // single_family or unknown regardless of scope tags.
  for (const cls of ["single_family", "unknown"]) {
    const resolved = resolveEligibleTemplates(matrix, {
      property_communication_class: cls,
      stage_code: "S2",
      use_case: "mf_rents",
    });
    assert.deepEqual(resolved.descriptors, [], cls);
  }
  const mf = resolveEligibleTemplates(matrix, {
    property_communication_class: "multifamily_5_plus",
    stage_code: "S2",
    use_case: "mf_rents",
  });
  assert.deepEqual(mf.descriptors.map((d) => d.template_id), ["tpl-mf-rents"]);
  assert.deepEqual(mf.descriptors[0].required_fields, [
    "monthly_rents",
    "seller_first_name",
    "unit_count",
  ]);
});

test("matrix resolve: stage and use_case dimensions filter; inactive excluded", () => {
  const matrix = makeMatrix();
  const wrongStage = resolveEligibleTemplates(matrix, {
    property_communication_class: "multifamily_5_plus",
    stage_code: "S3",
    use_case: "mf_rents",
  });
  assert.deepEqual(wrongStage.descriptors, []);

  const all = resolveEligibleTemplates(matrix, {
    property_communication_class: "single_family",
    stage_code: "S1",
    use_case: "ownership_check",
  });
  assert.ok(!all.descriptors.some((d) => d.template_id === "tpl-inactive"));
});

test("matrix resolve: campaign_type is recorded on descriptors", () => {
  const matrix = makeMatrix();
  const resolved = resolveEligibleTemplates(matrix, {
    campaign_type: "cold_acquisition",
    property_communication_class: "duplex",
    stage_code: "S1",
    use_case: "ownership_check",
  });
  assert.ok(resolved.descriptors.length >= 1);
  for (const descriptor of resolved.descriptors) {
    assert.equal(descriptor.campaign_type, "cold_acquisition");
    assert.equal(descriptor.weight, 1);
  }
});

test("matrix resolve: failed matrix propagates the blocking skip reason", () => {
  const failed = { ok: false, skip_reason: TEMPLATE_CORPUS_UNAVAILABLE, entries: [] };
  const resolved = resolveEligibleTemplates(failed, {
    property_communication_class: "single_family",
    use_case: "ownership_check",
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.skip_reason, "template_corpus_unavailable");
  assert.deepEqual(resolved.descriptors, []);
});

// ─── Coverage audit ──────────────────────────────────────────────────────────

test("coverage audit: missing multifamily coverage is visible as gaps, not silent", () => {
  // Corpus with ONLY the neutral template: every class still has ownership
  // coverage via neutral wording, but a corpus with only unit-worded rows
  // exposes single_family/unknown gaps.
  const unitOnly = buildTemplateEligibilityMatrix(
    [normalizeSupabaseTemplateRow(RAW_ROWS[1])],
    { corpus_source: "supabase_sms_templates" }
  );
  const audit = auditTemplateCorpusCoverage(unitOnly, {
    use_cases: ["ownership_check"],
    stage_codes: ["S1"],
  });
  assert.equal(audit.ok, true);
  assert.equal(audit.cells.length, 6);
  const gapClasses = audit.gaps.map((cell) => cell.property_communication_class).sort();
  assert.deepEqual(gapClasses, ["duplex", "fourplex", "single_family", "triplex", "unknown"]);
  const covered = audit.cells.find(
    (cell) => cell.property_communication_class === "multifamily_5_plus"
  );
  assert.equal(covered.eligible_count, 1);
  assert.ok(audit.coverage_ratio > 0 && audit.coverage_ratio < 1);
});

test("coverage audit: failed matrix reports blocking skip reason", () => {
  const audit = auditTemplateCorpusCoverage({ ok: false, skip_reason: TEMPLATE_CORPUS_UNAVAILABLE });
  assert.equal(audit.ok, false);
  assert.equal(audit.skip_reason, "template_corpus_unavailable");
});

// ─── Corpus loading: blocking failure vs dev/test local fallback ─────────────

function makeFailingSupabase() {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                or: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
                eq: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
                then: (resolve) => resolve({ data: null, error: { message: "connection refused" } }),
              };
            },
          };
        },
      };
    },
  };
}

function makeWorkingSupabase(rows) {
  const resolved = { data: rows, error: null };
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                or: () => Promise.resolve(resolved),
                eq: () => Promise.resolve(resolved),
                then: (resolve) => resolve(resolved),
              };
            },
          };
        },
      };
    },
  };
}

test("corpus load: supabase failure is BLOCKING — never a silent local fallback", async () => {
  const matrix = await loadTemplateEligibilityMatrix({ supabase_client: makeFailingSupabase() });
  assert.equal(matrix.ok, false);
  assert.equal(matrix.skip_reason, "template_corpus_unavailable");
  assert.equal(matrix.template_count, 0);
  assert.equal(matrix.corpus_source, "supabase_sms_templates");
});

test("corpus load: working supabase builds the supabase-sourced matrix", async () => {
  const matrix = await loadTemplateEligibilityMatrix({
    supabase_client: makeWorkingSupabase(RAW_ROWS),
  });
  assert.equal(matrix.ok, true);
  assert.equal(matrix.corpus_source, "supabase_sms_templates");
  assert.equal(matrix.template_count, 5);
});

test("corpus load: dev/test without supabase config uses the labeled local registry", async () => {
  // critical-test-environment deletes SUPABASE_* so hasSupabaseConfig() is false.
  const matrix = await loadTemplateEligibilityMatrix({});
  assert.equal(matrix.ok, true);
  assert.equal(matrix.corpus_source, "local_registry");
  assert.ok(matrix.template_count > 0);

  const strict = await loadTemplateEligibilityMatrix({ allow_local_fallback: false });
  assert.equal(strict.ok, false);
  assert.equal(strict.skip_reason, "template_corpus_unavailable");
});

// ─── Fail-open fix in the shared loader path ─────────────────────────────────

test("loader fail-open fix: require_template_corpus turns corpus failure into a typed block", async () => {
  const failing_fetcher = async () => ({
    ok: false,
    reason: "template_corpus_unavailable",
    error: new Error("connection refused"),
    candidates: [],
  });

  await assert.rejects(
    loadTemplateCandidates({
      use_case: "ownership_check",
      language: "English",
      skip_render_validation: true,
      supabase_fetcher: failing_fetcher,
      require_template_corpus: true,
      remote_fetcher: async () => [],
    }),
    (error) => error?.code === "template_corpus_unavailable"
  );

  // Without the flag the legacy fail-open behavior is preserved (falls through
  // to Podio / local registry) so dev/test flows keep working.
  const relaxed = await loadTemplateCandidates({
    use_case: "ownership_check",
    language: "English",
    skip_render_validation: true,
    supabase_fetcher: failing_fetcher,
    require_template_corpus: false,
    remote_fetcher: async () => [],
  });
  assert.ok(Array.isArray(relaxed));
});

test("assignment path: corpus failure blocks with template_corpus_unavailable", async () => {
  const campaign = {
    id: "camp-corpus",
    objective: "ownership_check",
    metadata: { stage_code: "S1", template_use_case: "ownership_check" },
  };
  const supabase = {
    from(table) {
      if (table === "campaigns") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: campaign, error: null }) }),
          }),
        };
      }
      if (table === "sms_templates") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: async () => ({ data: null, error: { message: "connection refused" } }),
                }),
                limit: async () => ({ data: null, error: { message: "connection refused" } }),
              }),
              limit: async () => ({ data: null, error: { message: "connection refused" } }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      };
    },
  };
  const result = await assignCampaignTargetTemplates("camp-corpus", { supabase });
  assert.equal(result.ok, false);
  assert.equal(result.error, "template_corpus_unavailable");
});
