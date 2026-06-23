// Workflow Studio V2 — canonical dedupe key builders and duplicate detection.

function clean(value) {
  return String(value ?? '').trim();
}

export function isDuplicateError(error) {
  return error?.code === '23505';
}

export function buildRunDedupeKey(enrollmentId, nodeId, tick) {
  return [
    'wfv2-run',
    clean(enrollmentId) || 'no_enrollment',
    clean(nodeId) || 'no_node',
    clean(tick) || '0',
  ].join(':');
}

export function buildActionDedupeKey(enrollmentId, nodeId, actionType) {
  return [
    'wfv2-action',
    clean(enrollmentId) || 'no_enrollment',
    clean(nodeId) || 'no_node',
    clean(actionType) || 'no_action',
  ].join(':');
}

export function buildQueueDedupeKey({
  enrollmentId,
  nodeId,
  channel = 'sms',
  templateUseCase = null,
  touchNumber = 0,
  masterOwnerId = null,
  propertyId = null,
  toAddress = null,
} = {}) {
  return [
    'wfv2-queue',
    clean(enrollmentId) || 'no_enrollment',
    clean(nodeId) || 'no_node',
    clean(channel) || 'sms',
    clean(templateUseCase) || 'no_use_case',
    String(touchNumber ?? 0),
    clean(masterOwnerId) || 'no_owner',
    clean(propertyId) || 'no_property',
    clean(toAddress) || 'no_address',
  ].join(':');
}