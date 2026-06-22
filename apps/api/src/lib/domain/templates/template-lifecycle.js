// Template lifecycle contract — active=true does not imply automation approval.

export const TEMPLATE_LIFECYCLE = Object.freeze({
  DRAFT: 'draft',
  REVIEW_REQUIRED: 'review_required',
  APPROVED: 'approved',
  APPROVED_AUTO_REPLY: 'approved_for_automatic_reply',
  DISABLED: 'disabled',
  RETIRED: 'retired',
});

const LEGACY_SAFE_AUTO_REPLY = 'safe_for_auto_reply';
const LEGACY_ACTIVE = 'is_active';

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Derive lifecycle status from Supabase row + optional metadata.lifecycle_status.
 */
export function resolveTemplateLifecycleStatus(template = {}) {
  const metadata = template.metadata && typeof template.metadata === 'object' ? template.metadata : {};
  const explicit = lower(metadata.lifecycle_status ?? template.lifecycle_status);
  if (explicit && Object.values(TEMPLATE_LIFECYCLE).includes(explicit)) {
    return explicit;
  }

  if (template.is_active === false) return TEMPLATE_LIFECYCLE.DISABLED;
  if (metadata.retired === true) return TEMPLATE_LIFECYCLE.RETIRED;

  if (template.safe_for_auto_reply === true) {
    return TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY;
  }

  if (template.is_active === true) {
    return TEMPLATE_LIFECYCLE.REVIEW_REQUIRED;
  }

  return TEMPLATE_LIFECYCLE.DRAFT;
}

export function isTemplateEligibleForSend(template = {}, { autonomous = false } = {}) {
  const status = resolveTemplateLifecycleStatus(template);
  if (status === TEMPLATE_LIFECYCLE.DISABLED || status === TEMPLATE_LIFECYCLE.RETIRED) {
    return { ok: false, reason: `template_${status}` };
  }
  if (status === TEMPLATE_LIFECYCLE.DRAFT || status === TEMPLATE_LIFECYCLE.REVIEW_REQUIRED) {
    return { ok: false, reason: 'template_not_approved' };
  }
  if (autonomous && status !== TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY) {
    return { ok: false, reason: 'template_not_approved_for_auto_reply' };
  }
  if (!autonomous && status !== TEMPLATE_LIFECYCLE.APPROVED && status !== TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY) {
    return { ok: false, reason: 'template_not_approved_for_send' };
  }
  return { ok: true, lifecycle_status: status };
}

export function mapLegacyTemplateFields(template = {}) {
  const lifecycle_status = resolveTemplateLifecycleStatus(template);
  return {
    ...template,
    lifecycle_status,
    [LEGACY_ACTIVE]: template.is_active,
    [LEGACY_SAFE_AUTO_REPLY]: lifecycle_status === TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY,
    approved_for_live_send:
      lifecycle_status === TEMPLATE_LIFECYCLE.APPROVED ||
      lifecycle_status === TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY,
    approved_for_automatic_reply: lifecycle_status === TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY,
  };
}

export default {
  TEMPLATE_LIFECYCLE,
  resolveTemplateLifecycleStatus,
  isTemplateEligibleForSend,
  mapLegacyTemplateFields,
};