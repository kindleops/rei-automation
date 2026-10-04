/** The comp card's navigation (no writes). */
import { isWorkspaceRunning, openApp } from '../../../../modules/desktop/workspace/workspace-store'
import { pushRoutePath } from '../../../../app/router'

/** Comp Intelligence beside the Map, on the subject (or this sale's parcel). Navigation only. */
export function openCompsBeside(propertyId: string): 'beside' | 'navigated' | 'refused' {
  const path = `/comp-intelligence?property_id=${encodeURIComponent(propertyId)}`
  if (!isWorkspaceRunning()) { pushRoutePath(path); return 'navigated' }
  return openApp(path, 'beside') === 'refused' ? 'refused' : 'beside'
}
