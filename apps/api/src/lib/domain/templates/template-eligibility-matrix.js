// ─── template-eligibility-matrix.js ──────────────────────────────────────────
//
// ⚠️ POLICY SCAFFOLDING — NO PRODUCTION CALL-SITE YET. Until this module is
// wired as the candidate source for the feeder scorer
// (supabase-candidate-feeder) and the inbound template query
// (apply-inbound-automation-decision), its eligibility and
// template_corpus_unavailable blocking semantics are NOT in force anywhere.
// The class-safety guarantees that ARE live today are enforced directly in
// template-selector.js (hard filters) and the render/safety gates. Planned
// wiring is tracked in the readiness report; do not describe this matrix as
// an active gate until then.
//
// G2 (spine §8): deterministic template eligibility matrix.
//
// For {campaign_type, property_communication_class, stage_code, use_case} this
// module produces the eligible template descriptors:
//
//   { template_id, approved, weight, cooldown, required_fields, forbidden_fields }
//
// built over the normalized template corpus (Supabase sms_templates via the
// loader normalizer, with the local template registry as the dev/test
// fallback).
//
// Determinism rules:
//   - No randomness anywhere. Descriptors are sorted by template_id.
//   - `weight` is constant 1: rotation stays deterministic hash bucketing
//     (load-template.js rotateVariant / feeder chooseRotatingTemplate).
//     Weighted rotation exists only in the shadow policy
//     (template-autopilot-policy.js) and the RETIRED dashboard queue engine
//     (apps/dashboard/api/internal/queue/templateSelection.ts) — neither is
//     adopted here.
//   - required_fields derive from the template's placeholders; forbidden
//     fields derive from the canonical property communication class rules.
//
// Fail-open fix: `loadTemplateEligibilityMatrix` treats a Supabase corpus-load
// FAILURE as blocking (`template_corpus_unavailable`) — it never degrades
// silently to the local registry. The local registry is only used when
// Supabase is not configured at all (dev/test) and `allow_local_fallback` is
// enabled.

import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { fetchSupabaseTemplateCandidatesDetailed } from "@/lib/domain/templates/load-supabase-template-candidates.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "@/lib/domain/templates/local-template-registry.js";
import {
  extractPlaceholders,
  LEGACY_PLACEHOLDER_ALIASES,
} from "@/lib/domain/templates/render-template.js";
import {
  canonicalizeTemplateUseCase,
  normalizeSelectorText,
  normalizeTemplatePropertyTypeScope,
  normalizeTemplateSelectorUseCase,
  scorePropertyTypeScopeMatch,
} from "@/lib/domain/templates/template-selector.js";
import {
  PROPERTY_COMMUNICATION_CLASS_VALUES,
  communicationClassToPropertyTypeScope,
  forbiddenTemplateFieldsForClass,
  isTemplateAllowedForCommunicationClass,
} from "@/lib/domain/properties/property-communication-class.js";

export const TEMPLATE_CORPUS_UNAVAILABLE = "template_corpus_unavailable";

function clean(value) {
  return String(value ?? "").trim();
}

function uniqSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

// ─── Corpus normalization ────────────────────────────────────────────────────

/**
 * Normalize a local-registry row into the matrix row shape. Supabase rows are
 * already normalized by normalizeSupabaseTemplateRow in the loader.
 */
function normalizeLocalRegistryRow(row = {}) {
  if (!row || !clean(row.item_id)) return null;
  return {
    ...row,
    source: "local_registry",
    template_resolution_source: "local_registry",
    item_id: clean(row.item_id),
    template_id: clean(row.template_id) || clean(row.item_id),
    template_body: clean(row.text) || "",
    text: clean(row.text) || "",
    stage_code: clean(row.stage_code) || null,
    property_type_scope: clean(row.property_type_scope) || null,
  };
}

function templateReferenceId(row = {}) {
  return clean(row.item_id) || clean(row.template_id) || clean(row.id);
}

function templateIsApproved(row = {}) {
  if (row.active !== undefined) return clean(row.active).toLowerCase() === "yes";
  if (row.is_active !== undefined) return row.is_active === true;
  return false;
}

function templateCooldown(row = {}) {
  const raw = row.cooldown_days ?? row.metadata?.cooldown_days;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Canonical placeholder fields required to render a template — extracted from
 * its body, legacy aliases resolved (render-template.js vocabulary).
 */
export function templateRequiredFields(row = {}) {
  const bodies = [row.template_body, row.text]
    .map((body) => clean(body))
    .filter(Boolean);
  const names = new Set();
  for (const body of bodies) {
    for (const placeholder of extractPlaceholders(body)) {
      names.add(LEGACY_PLACEHOLDER_ALIASES[placeholder] || placeholder);
    }
  }
  return uniqSorted([...names]);
}

/**
 * Communication classes a template is eligible for: the hard wording rules
 * (spine §7) AND template-scope compatibility must both pass. Scope
 * compatibility uses the selector's scoring semantic — score 0 is the hard
 * scope block (unit-specific mismatch), while positive scores (including the
 * Any Residential fallback at 60 and generic Multifamily at 85) are eligible.
 */
export function templateEligibleCommunicationClasses(row = {}) {
  const template_scope = normalizeTemplatePropertyTypeScope(row);
  return PROPERTY_COMMUNICATION_CLASS_VALUES.filter((communication_class) => {
    if (!isTemplateAllowedForCommunicationClass(row, communication_class).allowed) return false;
    return (
      scorePropertyTypeScopeMatch({
        requested_property_type_scope: communicationClassToPropertyTypeScope(communication_class),
        template_property_type_scope: template_scope,
      }) > 0
    );
  });
}

// ─── Matrix build ────────────────────────────────────────────────────────────

/**
 * Build the deterministic eligibility matrix over normalized template rows.
 *
 * @param {object[]} rows          normalized template rows
 * @param {object}   [options]
 * @param {string}   [options.corpus_source]
 */
export function buildTemplateEligibilityMatrix(rows = [], { corpus_source = null } = {}) {
  const entries = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const template_id = templateReferenceId(row);
    if (!template_id) continue;
    const selector_use_case = normalizeTemplateSelectorUseCase(row) || clean(row.use_case) || null;
    entries.push({
      template_id,
      template_name: clean(row.template_name) || null,
      source: clean(row.source) || corpus_source || null,
      language: clean(row.language) || "English",
      use_case: selector_use_case,
      canonical_use_case: canonicalizeTemplateUseCase(
        selector_use_case,
        clean(row.variant_group) || clean(row.stage_label) || null
      ),
      stage_code: clean(row.stage_code) || null,
      property_type_scope: normalizeTemplatePropertyTypeScope(row) || null,
      approved: templateIsApproved(row),
      // Deterministic constant — see module header. Reserved for a future
      // OPERATOR-controlled weighting policy; never a random draw input.
      weight: 1,
      cooldown: templateCooldown(row),
      required_fields: templateRequiredFields(row),
      eligible_communication_classes: templateEligibleCommunicationClasses(row),
      row,
    });
  }
  entries.sort((left, right) => left.template_id.localeCompare(right.template_id));
  return {
    ok: true,
    corpus_source: corpus_source || null,
    template_count: entries.length,
    entries,
  };
}

/**
 * Load the corpus and build the matrix.
 *
 * Blocking semantics (G2): when Supabase IS configured (or a client is
 * injected) and the corpus load fails, this returns
 * `{ok:false, skip_reason:"template_corpus_unavailable"}` — it never falls
 * back to the local registry. The local registry serves only the
 * not-configured dev/test path, and that use is labeled in `corpus_source`.
 *
 * @param {object}      [options]
 * @param {object|null} [options.supabase_client]     injectable client
 * @param {object[]}    [options.local_rows]          local registry override (tests)
 * @param {boolean}     [options.allow_local_fallback] default true
 */
export async function loadTemplateEligibilityMatrix({
  supabase_client = null,
  local_rows = null,
  allow_local_fallback = true,
} = {}) {
  const supabase_available = Boolean(supabase_client) || hasSupabaseConfig();

  if (supabase_available) {
    const detailed = await fetchSupabaseTemplateCandidatesDetailed(
      {},
      { supabase_client }
    );
    if (!detailed.ok) {
      return {
        ok: false,
        skip_reason: TEMPLATE_CORPUS_UNAVAILABLE,
        reason: detailed.reason || TEMPLATE_CORPUS_UNAVAILABLE,
        error_message: clean(detailed.error?.message) || null,
        corpus_source: "supabase_sms_templates",
        template_count: 0,
        entries: [],
      };
    }
    return buildTemplateEligibilityMatrix(detailed.candidates, {
      corpus_source: "supabase_sms_templates",
    });
  }

  if (!allow_local_fallback) {
    return {
      ok: false,
      skip_reason: TEMPLATE_CORPUS_UNAVAILABLE,
      reason: "supabase_not_configured",
      error_message: null,
      corpus_source: null,
      template_count: 0,
      entries: [],
    };
  }

  const rows = (Array.isArray(local_rows) ? local_rows : LOCAL_TEMPLATE_CANDIDATES)
    .map(normalizeLocalRegistryRow)
    .filter(Boolean);
  return buildTemplateEligibilityMatrix(rows, { corpus_source: "local_registry" });
}

// ─── Eligibility resolution ──────────────────────────────────────────────────

function stageMatches(entry_stage, requested_stage) {
  const requested = normalizeSelectorText(requested_stage);
  if (!requested) return true;
  const entry = normalizeSelectorText(entry_stage);
  if (!entry) return true; // stage-agnostic template
  return entry === requested;
}

function useCaseMatches(entry, requested_use_case) {
  const requested = normalizeSelectorText(requested_use_case);
  if (!requested) return true;
  return (
    normalizeSelectorText(entry.use_case) === requested ||
    normalizeSelectorText(entry.canonical_use_case) === requested
  );
}

/**
 * Resolve the eligible template descriptors for one matrix cell.
 *
 * `campaign_type` is a recorded dimension (campaign objective vocabulary); the
 * corpus carries no campaign-type-specific columns today, so it never filters
 * — it is stamped on each descriptor for provenance and future policy.
 *
 * @param {object} matrix   result of buildTemplateEligibilityMatrix / load…
 * @param {object} cell     {campaign_type, property_communication_class, stage_code, use_case, language}
 * @returns {{ok: boolean, skip_reason: string|null, descriptors: object[]}}
 */
export function resolveEligibleTemplates(matrix = {}, cell = {}) {
  if (!matrix || matrix.ok === false) {
    return {
      ok: false,
      skip_reason: matrix?.skip_reason || TEMPLATE_CORPUS_UNAVAILABLE,
      descriptors: [],
    };
  }

  const communication_class = clean(cell.property_communication_class) || "unknown";
  const requested_language = normalizeSelectorText(cell.language);
  const forbidden_fields = forbiddenTemplateFieldsForClass(communication_class);

  const descriptors = (matrix.entries || [])
    .filter((entry) => entry.approved)
    .filter((entry) => useCaseMatches(entry, cell.use_case))
    .filter((entry) => stageMatches(entry.stage_code, cell.stage_code))
    .filter((entry) =>
      requested_language ? normalizeSelectorText(entry.language) === requested_language : true
    )
    .filter((entry) => entry.eligible_communication_classes.includes(communication_class))
    // Hard guarantee restated at the matrix boundary: a template requiring a
    // field the class forbids is ineligible (single_family/unknown must never
    // see unit placeholders).
    .filter((entry) => !entry.required_fields.some((field) => forbidden_fields.includes(field)))
    .map((entry) => ({
      template_id: entry.template_id,
      approved: entry.approved,
      weight: entry.weight,
      cooldown: entry.cooldown,
      required_fields: entry.required_fields,
      forbidden_fields,
      language: entry.language,
      use_case: entry.use_case,
      stage_code: entry.stage_code,
      property_type_scope: entry.property_type_scope,
      property_communication_class: communication_class,
      campaign_type: clean(cell.campaign_type) || null,
      source: entry.source,
    }));

  return { ok: true, skip_reason: null, descriptors };
}

// ─── Coverage audit ──────────────────────────────────────────────────────────

/**
 * Report corpus coverage per (communication class × stage × use_case) so
 * missing multifamily templates are VISIBLE instead of silently degrading to
 * neutral wording.
 *
 * @param {object}   matrix
 * @param {object}   [dims]
 * @param {string[]} [dims.classes]     default: all six communication classes
 * @param {string[]} [dims.stage_codes] default: distinct stages in the corpus
 * @param {string[]} [dims.use_cases]   default: distinct use cases in the corpus
 * @param {string}   [dims.language]    optional language constraint
 */
export function auditTemplateCorpusCoverage(matrix = {}, dims = {}) {
  if (!matrix || matrix.ok === false) {
    return {
      ok: false,
      skip_reason: matrix?.skip_reason || TEMPLATE_CORPUS_UNAVAILABLE,
      cells: [],
      gaps: [],
      coverage_ratio: 0,
      corpus_source: matrix?.corpus_source || null,
      template_count: 0,
    };
  }

  const classes = Array.isArray(dims.classes) && dims.classes.length
    ? dims.classes
    : [...PROPERTY_COMMUNICATION_CLASS_VALUES];
  const use_cases = Array.isArray(dims.use_cases) && dims.use_cases.length
    ? dims.use_cases
    : uniqSorted((matrix.entries || []).map((entry) => entry.use_case));
  const stage_codes = Array.isArray(dims.stage_codes) && dims.stage_codes.length
    ? dims.stage_codes
    : uniqSorted((matrix.entries || []).map((entry) => entry.stage_code));

  const cells = [];
  for (const use_case of use_cases) {
    for (const stage_code of stage_codes.length ? stage_codes : [null]) {
      for (const communication_class of classes) {
        const resolved = resolveEligibleTemplates(matrix, {
          use_case,
          stage_code,
          property_communication_class: communication_class,
          language: dims.language || null,
        });
        cells.push({
          use_case,
          stage_code: stage_code || null,
          property_communication_class: communication_class,
          eligible_count: resolved.descriptors.length,
          template_ids: resolved.descriptors.slice(0, 5).map((d) => d.template_id),
        });
      }
    }
  }

  const gaps = cells.filter((cell) => cell.eligible_count === 0);
  return {
    ok: true,
    skip_reason: null,
    corpus_source: matrix.corpus_source || null,
    template_count: matrix.template_count || 0,
    cells,
    gaps,
    coverage_ratio: cells.length ? (cells.length - gaps.length) / cells.length : 0,
  };
}

export default {
  TEMPLATE_CORPUS_UNAVAILABLE,
  buildTemplateEligibilityMatrix,
  loadTemplateEligibilityMatrix,
  resolveEligibleTemplates,
  auditTemplateCorpusCoverage,
  templateRequiredFields,
  templateEligibleCommunicationClasses,
};
