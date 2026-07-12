// ─── outbound-attribution.js ─────────────────────────────────────────────────
// ONE canonical builder for the attribution that every automated seller-facing
// send must carry (activation spec Mission 5). It does not resolve templates or
// send — it stamps a deterministic provenance block onto a send_queue row's
// metadata so send/reply/KPI surfaces can attribute every outbound to the exact
// template version, stage, outcome, experiment variant, and origin.
//
// Migration-free: the block lives in the existing `metadata` jsonb today; the
// same fields are promoted to first-class columns by the proposed migration in
// docs/automation/TEMPLATE_SYSTEM_AUDIT.md.

import { createHash } from "node:crypto";

export const OUTBOUND_ATTRIBUTION_VERSION = "outbound_attribution_v1";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Surrogate immutable version id until a `template_versions` table exists:
 * a content hash ties a historical send to the exact body it used, so editing
 * a template later never rewrites past attribution.
 */
export function templateVersionHash(templateBody) {
  const body = clean(templateBody);
  if (!body) return null;
  return `sha1:${createHash("sha1").update(body).digest("hex")}`;
}

/**
 * Build the canonical attribution block for an automated send.
 *
 * @param {object} args
 * @param {object} args.template - resolved template (template_id/id, template_body, use_case, stage_code, language, version).
 * @param {string} [args.templateKey] - stable template key (use_case or template_id).
 * @param {string} [args.stage] - canonical lifecycle/stage code for the send.
 * @param {string} [args.classifiedOutcome] - canonical intent that drove the reply.
 * @param {string} [args.language] - resolved send language.
 * @param {object} [args.experiment] - { experiment_id, variant_id } or null.
 * @param {number} [args.touchNumber] - touch index for the thread.
 * @param {string} [args.parentOutboundEventId] - prior outbound event this send follows (null for a fresh reply).
 * @param {string} [args.automationOrigin] - which engine/path produced the send.
 * @returns {object} attribution block (also the shape promoted to columns later).
 */
export function buildOutboundTemplateAttribution({
  template = null,
  templateKey = null,
  stage = null,
  classifiedOutcome = null,
  language = null,
  experiment = null,
  touchNumber = null,
  parentOutboundEventId = null,
  automationOrigin = null,
} = {}) {
  const template_id = clean(template?.template_id || template?.id) || null;
  const template_body = template?.template_body ?? template?.text ?? null;
  return {
    attribution_version: OUTBOUND_ATTRIBUTION_VERSION,
    template_id,
    // Immutable version surrogate (content hash) + the mutable catalog version.
    template_version_id: templateVersionHash(template_body),
    template_catalog_version: template?.version ?? null,
    template_key: clean(templateKey) || clean(template?.use_case) || template_id,
    stage: clean(stage) || clean(template?.stage_code) || null,
    classified_outcome: clean(classifiedOutcome) || null,
    language: clean(language) || clean(template?.language) || null,
    experiment_id: clean(experiment?.experiment_id) || null,
    experiment_variant_id: clean(experiment?.variant_id) || null,
    touch_number: Number.isFinite(Number(touchNumber)) ? Number(touchNumber) : null,
    parent_outbound_event_id: clean(parentOutboundEventId) || null,
    automation_origin: clean(automationOrigin) || null,
  };
}

/**
 * True when an attribution block is complete enough to send under autopilot:
 * a resolved template identity, an immutable version, a stage, a language, and
 * an origin. Missing any of these means the send is anonymous → must fail closed.
 */
export function isDispatchableAttribution(attribution = null) {
  if (!attribution || typeof attribution !== "object") return false;
  return Boolean(
    attribution.template_id &&
      attribution.template_version_id &&
      attribution.stage &&
      attribution.language &&
      attribution.automation_origin
  );
}

export default buildOutboundTemplateAttribution;
