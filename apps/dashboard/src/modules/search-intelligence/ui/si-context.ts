import { createContext, useContext } from 'react'
import type { ObjectRef, PageStatus, SearchProperty, Severity } from '../domain/types'
import type { SiData } from './useSearchIntelligence'
import type { SiState, ViewId } from './state'

/* ── app context ────────────────────────────────────────────────────────── */

export interface SiActions {
  setView: (v: ViewId) => void
  setProperty: (id: string | null) => void
  inspect: (ref: ObjectRef | null) => void
  setPagesView: (v: string) => void
}
export interface SiCtx { data: SiData; state: SiState; actions: SiActions }
export const SiContext = createContext<SiCtx | null>(null)
export function useSi(): SiCtx {
  const c = useContext(SiContext)
  if (!c) throw new Error('Search Intelligence context missing')
  return c
}

/* ── tones ──────────────────────────────────────────────────────────────── */

export type Tone = 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'

export const STATUS_TONE: Record<PageStatus, Tone> = {
  PLANNED: 'neutral', RESEARCHED: 'neutral', COPY_READY: 'flow', BUILDING: 'exec', QA: 'exec', READY: 'ok', PUBLISHED: 'ok', INDEXED: 'ok', NEEDS_WORK: 'attn',
}
export const STATUS_LABEL: Record<PageStatus, string> = {
  PLANNED: 'Planned', RESEARCHED: 'Researched', COPY_READY: 'Copy ready', BUILDING: 'Building', QA: 'QA', READY: 'Ready', PUBLISHED: 'Published', INDEXED: 'Indexed', NEEDS_WORK: 'Needs work',
}
export const SEVERITY_TONE: Record<Severity, Tone> = { BLOCKER: 'crit', HIGH: 'attn', MEDIUM: 'exec', LOW: 'neutral' }
export const SEVERITY_LABEL: Record<Severity, string> = { BLOCKER: 'Blocker', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }

export const ACCENT_VAR: Record<SearchProperty['accent'], string> = {
  exec: 'var(--lc-exec)', flow: 'var(--lc-flow)', ok: 'var(--lc-ok)', attn: 'var(--lc-attn)', cobalt: 'var(--lc-cobalt)', neutral: 'var(--lc-ink-2)',
}

export const fmt = (n: number) => n.toLocaleString('en-US')
export const pct = (x: number) => `${Math.round(x * 100)}%`


export function refLabel(ctx: SiCtx, r: ObjectRef): string {
  const m = ctx.data.model
  switch (r.kind) {
    case 'page': return m.page.get(r.id)?.path ?? r.id
    case 'cluster': { const c = m.cluster.get(r.id); return c ? (c.primaryKeyword ?? c.label) : r.id }
    case 'keyword': return m.keyword.get(r.id)?.query ?? r.id
    case 'geography': { const g = m.geo.get(r.id); return g ? (g.kind !== 'STATE' && g.stateCode ? `${g.name}, ${g.stateCode}` : g.name) : r.id }
    case 'wave': return m.wave.get(r.id)?.label ?? r.id
    case 'property': return m.property.get(r.id)?.brand ?? r.id
    case 'opportunity': return ctx.data.opportunities.find((o) => o.id === r.id)?.title ?? r.id
  }
}

