export const CANONICAL_THREAD_CONTROL_FOCUS_EVENT = 'deal-desk:focus-canonical-thread-control'

export type CanonicalThreadControlField =
  | 'lifecycle_stage'
  | 'operational_status'
  | 'lead_temperature'
  | 'automation_state'
  | 'manual_stage_lock'
  | 'is_read'

export function focusCanonicalThreadControl(field?: CanonicalThreadControlField): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CANONICAL_THREAD_CONTROL_FOCUS_EVENT, {
    detail: { field: field ?? null },
  }))
}
