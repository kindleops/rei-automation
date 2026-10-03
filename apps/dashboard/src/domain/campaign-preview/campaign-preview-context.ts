import { useSyncExternalStore } from 'react'

/**
 * CAMPAIGN PREVIEW CONTEXT — what an open Composer is composing, published so
 * a Map pane can draw it (Campaign Map Preview).
 *
 * The Composer PUBLISHES; Map panes CONSUME. Nothing here is an audience: the
 * context carries the server spec (filters + strategy) and the Composer's own
 * numbers; the Map asks the server (part=geo) for the eligible set. One entry
 * per Composer session (its composer_key), alive exactly while that Composer
 * is mounted — closing the Composer ends its preview, so a stale preview can
 * never stay attached to a campaign nobody is composing.
 *
 * In-memory and same-tab only (workspace panes share one realm). Display
 * context, never a source of business truth.
 */

export interface CampaignPreviewSpec {
  /** serialized filter clauses exactly as the Composer sends them to the server */
  filters: Record<string, Array<Record<string, unknown>>>
  template_use_case: string
}

export interface CampaignPreviewContext {
  /** the Composer session (composer_key) — the preview's identity */
  key: string
  /** the saved draft, when there is one */
  draftId: string | null
  name: string
  /** markets in the audience's market clause, in the order they were chosen */
  markets: string[]
  /** the market the operator touched last (the newest in the clause) */
  activeMarket: string | null
  spec: CampaignPreviewSpec
  /** stable identity of `spec` (what changes the server's answer) */
  specKey: string
  /** the Composer's own Eligible (whole cohort) — for display reconciliation only */
  composerEligible: number | null
  /** the Composer section in focus, when useful (audience · strategy · …) */
  section: string | null
  updatedAt: number
}

const live = new Map<string, CampaignPreviewContext>()
const listeners = new Set<() => void>()
let version = 0
let latestKey: string | null = null
const emit = () => { version += 1; listeners.forEach((l) => l()) }

/** Publish (or update) a Composer's preview. Unchanged content does not notify. */
export function publishCampaignPreview(ctx: Omit<CampaignPreviewContext, 'updatedAt'>) {
  const prev = live.get(ctx.key)
  if (prev && sameContext(prev, ctx)) return
  live.set(ctx.key, { ...ctx, updatedAt: Date.now() })
  latestKey = ctx.key
  emit()
}

/** The Composer closed (or reset): its preview ends everywhere at once. */
export function clearCampaignPreview(key: string) {
  if (!live.delete(key)) return
  if (latestKey === key) latestKey = [...live.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.key ?? null
  emit()
}

export function getCampaignPreview(key: string | null): CampaignPreviewContext | null {
  return key ? live.get(key) ?? null : null
}

export const latestCampaignPreviewKey = () => latestKey

function sameContext(a: Omit<CampaignPreviewContext, 'updatedAt'>, b: Omit<CampaignPreviewContext, 'updatedAt'>) {
  return a.key === b.key && a.draftId === b.draftId && a.name === b.name && a.specKey === b.specKey
    && a.activeMarket === b.activeMarket && a.composerEligible === b.composerEligible && a.section === b.section
    && a.markets.length === b.markets.length && a.markets.every((m, i) => m === b.markets[i])
}

/* ── which preview a Map pane shows ─────────────────────────────────────── */

export type PreviewBindingReason = 'path' | 'latest' | 'pinned' | 'independent' | 'none'
export interface PreviewBinding { key: string | null; reason: PreviewBindingReason }

/**
 * A Map pane binds to:
 *   1. the preview named in its own path (opened from that Composer), while it lives;
 *   2. otherwise — unpinned and following the workspace — the newest live preview;
 *   3. otherwise nothing. A PINNED pane never adopts a preview it was not opened
 *      with (it never flies away); a pane named for an ended preview falls back
 *      to (2), never keeps the ended one.
 */
export function resolvePreviewBinding(input: { pathKey: string | null; pinned: boolean; follows: boolean; isLive: (key: string) => boolean; latest: string | null }): PreviewBinding {
  if (input.pathKey && input.isLive(input.pathKey)) return { key: input.pathKey, reason: 'path' }
  if (input.pinned) return { key: null, reason: 'pinned' }
  if (!input.follows) return { key: null, reason: 'independent' }
  if (input.latest && input.isLive(input.latest)) return { key: input.latest, reason: 'latest' }
  return { key: null, reason: 'none' }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => version

/** The bound preview for a Map pane, re-rendering when any preview changes. */
export function useCampaignPreviewBinding(input: { pathKey: string | null; pinned: boolean; follows: boolean }): { binding: PreviewBinding; context: CampaignPreviewContext | null } {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  const binding = resolvePreviewBinding({ ...input, isLive: (k) => live.has(k), latest: latestKey })
  return { binding, context: getCampaignPreview(binding.key) }
}

/** The audience's markets from the Composer's serialized clauses (in the order chosen). */
export function marketsOfSpec(filters: Record<string, Array<Record<string, unknown>>> | null | undefined): string[] {
  const out: string[] = []
  for (const group of Object.values(filters ?? {})) {
    for (const clause of group ?? []) {
      if (clause?.field_key !== 'properties.market') continue
      const v = clause.value
      for (const m of Array.isArray(v) ? v : [v]) {
        const s = String(m ?? '').trim()
        if (s && !out.includes(s)) out.push(s)
      }
    }
  }
  return out
}

/** What changes the server's answer (the cohort cache key's own fields). */
export const previewSpecKey = (spec: CampaignPreviewSpec) => JSON.stringify({ f: spec.filters, u: spec.template_use_case })

/** The path a Map opens at to preview this Composer's campaign. */
export const campaignPreviewMapPath = (key: string) => `/map?campaignPreview=${encodeURIComponent(key)}`
export const CAMPAIGN_PREVIEW_PARAM = 'campaignPreview'

export const __campaignPreviewTest = { reset: () => { live.clear(); latestKey = null; emit() } }
