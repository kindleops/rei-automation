import { pushRoutePath } from '../../app/router'
import type { LCMenuEntry } from '../../shared/lc/menu-model'
import { announceWorkspace, isWorkspaceRunning, openApp } from '../desktop/workspace/workspace-store'
import type { DestinationType } from './destinations/types'
import { intentPath, newNonce, type BrowserIntent, type ResearchRole } from './intent'

/**
 * Launch research from anywhere — object menus, the Command Deck, app
 * buttons. Light on purpose (no registry, no React): it only names the
 * intent; the Browser resolves it against the canonical record.
 *
 * Research opens BESIDE the operator's pane (the subject stays in view); an
 * open Browser is focused and given the intent, never duplicated.
 */
export function launchBrowser(intent: BrowserIntent, where: 'beside' | 'here' = 'beside'): 'beside' | 'focused' | 'navigated' {
  const path = intentPath(intent)
  if (where === 'here' || !isWorkspaceRunning()) { pushRoutePath(path); return 'navigated' }
  const r = openApp(path, 'beside')
  if (r === 'refused') {
    announceWorkspace('No room beside — Browser opened in this pane.')
    pushRoutePath(path)
    return 'navigated'
  }
  return r === 'focused' ? 'focused' : 'beside'
}

export interface ResearchTarget { kind: 'property' | 'company'; id: string; label: string | null; role?: ResearchRole }

export const researchProperty = (t: ResearchTarget, type?: DestinationType) =>
  launchBrowser(type
    ? { do: 'dest', type, kind: t.kind, id: t.id, label: t.label, role: t.role ?? 'subject', nonce: newNonce() }
    : { do: 'research', kind: t.kind, id: t.id, label: t.label, role: t.role ?? 'subject', nonce: newNonce() })

/** Minimal shape of an object reference (the universal object registry's EntityRef). */
interface RefLike { type: string; id: string; label?: string | null; hint?: Readonly<Record<string, string | null | undefined>> | null }

const hint = (ref: RefLike, k: string) => { const v = ref.hint?.[k]; return typeof v === 'string' && v.trim() ? v.trim() : null }

/** A property-shaped object's research target (itself, or the property it belongs to). */
export function researchTargetOf(ref: RefLike): ResearchTarget | null {
  if (ref.type === 'property') {
    // a recorded-sale-only comp is still a real address on record: research it as a comp
    const id = hint(ref, 'property_id') ?? ref.id
    return id ? { kind: 'property', id, label: ref.label ?? null, role: hint(ref, 'canonical') === 'false' || hint(ref, 'source') === 'comp-intelligence' ? 'comp' : 'subject' } : null
  }
  if (ref.type === 'company') {
    const label = ref.label ?? null
    return label ? { kind: 'company', id: hint(ref, 'organization_id') ?? ref.id, label } : null
  }
  const pid = hint(ref, 'property_id')
  if (pid && (ref.type === 'seller' || ref.type === 'deal' || ref.type === 'closing')) return { kind: 'property', id: pid, label: hint(ref, 'property_label'), role: 'subject' }
  return null
}

/**
 * The Research group of the one object menu (contributed to the universal
 * object registry's menu — it never replaces Open / Inspect / Show on Map).
 */
export function researchMenuEntries(ref: RefLike): LCMenuEntry[] {
  const target = researchTargetOf(ref)
  if (!target) return []
  if (target.kind === 'company') {
    return [{
      kind: 'sub', id: 'research', label: 'Research', icon: 'compass',
      items: [
        { id: 'research:company', label: 'Research company', icon: 'compass', onSelect: () => { researchProperty(target) } },
        { id: 'research:corp', label: 'State corporate records', icon: 'file-text', onSelect: () => { researchProperty(target, 'STATE_CORPORATE') } },
        { id: 'research:web', label: 'Search web', icon: 'search', onSelect: () => { researchProperty(target, 'WEB_SEARCH') } },
      ],
    }]
  }
  return [{
    kind: 'sub', id: 'research', label: 'Research', icon: 'compass',
    items: [
      { id: 'research:open', label: target.role === 'comp' ? 'Research this comp' : 'Research', icon: 'compass', onSelect: () => { researchProperty(target) } },
      { kind: 'separator', id: 'research:sep' },
      { id: 'research:assessor', label: 'Open assessor', icon: 'file-text', onSelect: () => { researchProperty(target, 'ASSESSOR') } },
      { id: 'research:county', label: 'County records', icon: 'database', onSelect: () => { researchProperty(target, 'COUNTY_PROPERTY_SEARCH') } },
      { id: 'research:gis', label: 'GIS', icon: 'map', onSelect: () => { researchProperty(target, 'GIS') } },
      { id: 'research:recorder', label: 'Recorder', icon: 'bookmark', onSelect: () => { researchProperty(target, 'RECORDER') } },
      { id: 'research:web', label: 'Search web', icon: 'search', onSelect: () => { researchProperty(target, 'WEB_SEARCH') } },
    ],
  }]
}
