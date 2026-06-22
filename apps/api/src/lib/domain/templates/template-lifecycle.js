// Template lifecycle contract — draft / enabled / disabled / retired only.
// enabled templates are automation-eligible when metadata matches.

export const TEMPLATE_LIFECYCLE = Object.freeze({
  DRAFT: 'draft',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  RETIRED: 'retired',
});

/** @deprecated Legacy states mapped during transition — not runtime gates */
export const LEGACY_LIFECYCLE_ALIASES = Object.freeze({
  review_required: TEMPLATE_LIFECYCLE.DRAFT,
  approved: TEMPLATE_LIFECYCLE.ENABLED,
  approved_for_automatic_reply: TEMPLATE_LIFECYCLE.ENABLED,
});

const LEGACY_SAFE_AUTO_REPLY = 'safe_for_auto_reply';

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Derive lifecycle status from Supabase row + optional metadata.lifecycle_status.
 * Does not auto-enable drafts. safe_for_auto_reply is preserved as metadata only.
 */
export function resolveTemplateLifecycleStatus(template = {}) {
  const metadata = template.metadata && typeof template.metadata === 'object' ? template.metadata : {};
  const explicit = lower(metadata.lifecycle_status ?? template.lifecycle_status);

  if (explicit === TEMPLATE_LIFECYCLE.RETIRED || metadata.retired === true) {
    return TEMPLATE_LIFECYCLE.RETIRED;
  }
  if (explicit === TEMPLATE_LIFECYCLE.DISABLED) {
    return TEMPLATE_LIFECYCLE.DISABLED;
  }
  if (explicit === TEMPLATE_LIFECYCLE.DRAFT) {
    return TEMPLATE_LIFECYCLE.DRAFT;
  }
  if (explicit === TEMPLATE_LIFECYCLE.ENABLED) {
    return TEMPLATE_LIFECYCLE.ENABLED;
  }

  // Map legacy explicit states
  if (explicit && LEGACY_LIFECYCLE_ALIASES[explicit]) {
    return LEGACY_LIFECYCLE_ALIASES[explicit];
  }

  if (template.is_active === false) return TEMPLATE_LIFECYCLE.DISABLED;

  // Active without explicit lifecycle → enabled (metadata-complete templates are selectable)
  if (template.is_active === true) {
    return TEMPLATE_LIFECYCLE.ENABLED;
  }

  return TEMPLATE_LIFECYCLE.DRAFT;
}

/**
 * Whether a template may be selected at runtime.
 * autonomous flag retained for API compatibility — enabled is sufficient for automation.
 */
export function isTemplateEligibleForSend(template = {}, { autonomous = false } = {}) {
  void autonomous;
  const status = resolveTemplateLifecycleStatus(template);
  if (status === TEMPLATE_LIFECYCLE.DISABLED) {
    return { ok: false, reason: 'template_disabled' };
  }
  if (status === TEMPLATE_LIFECYCLE.RETIRED) {
    return { ok: false, reason: 'template_retired' };
  }
  if (status === TEMPLATE_LIFECYCLE.DRAFT) {
    return { ok: false, reason: 'template_draft' };
  }
  if (status !== TEMPLATE_LIFECYCLE.ENABLED) {
    return { ok: false, reason: 'template_not_enabled' };
  }
  return { ok: true, lifecycle_status: status };
}

export function isTemplateSelectable(template = {}) {
  return isTemplateEligibleForSend(template).ok;
}

export function mapLegacyTemplateFields(template = {}) {
  const lifecycle_status = resolveTemplateLifecycleStatus(template);
  const enabled = lifecycle_status === TEMPLATE_LIFECYCLE.ENABLED;
  return {
    ...template,
    lifecycle_status,
    is_active: enabled ? true : template.is_active,
    [LEGACY_SAFE_AUTO_REPLY]: template.safe_for_auto_reply ?? enabled,
    approved_for_live_send: enabled,
    approved_for_automatic_reply: enabled,
  };
}

export default {
  TEMPLATE_LIFECYCLE,
  LEGACY_LIFECYCLE_ALIASES,
  resolveTemplateLifecycleStatus,
  isTemplateEligibleForSend,
  isTemplateSelectable,
  mapLegacyTemplateFields,
};