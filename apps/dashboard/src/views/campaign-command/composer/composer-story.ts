/**
 * CAMPAIGN COMPOSER · the story layer (premium redesign, owner 2026-10-12:
 * "the composer feels very basic … it doesn't feel good").
 *
 * PRESENTATION ONLY. Everything here re-reads numbers the Composer already
 * has (the audience read, the readiness checks) and turns them into the
 * visual story — audience → message → schedule → review. Nothing here
 * changes the composition, the save, the build or the launch, and nothing
 * here can send.
 */
import type { ComposerAudience, ComposerSample } from './composer-types'
import type { CheckState, FunnelStage, Layer } from './composer-model'

export type StoryStepId = 'audience' | 'message' | 'schedule' | 'review'
export type StoryState = CheckState | 'idle'
export type StoryStep = { id: StoryStepId; index: number; label: string; line: string; state: StoryState; layer: Layer; layers: Layer[] }

const SEVERITY: Record<StoryState, number> = { idle: 0, ok: 1, checking: 2, warn: 3, block: 4 }
/** The step's state is its worst layer's ("idle" only when every layer is idle). */
export function worstState(states: StoryState[]): StoryState {
  if (!states.length) return 'idle'
  const real = states.filter((s) => s !== 'idle')
  if (!real.length) return 'idle'
  return real.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), real[0])
}

/**
 * The four story steps over the five composition layers: Message is the
 * strategy layer (what is said), Schedule is delivery + schedule (how fast,
 * when), Review is readiness + launch. A step click focuses its first layer —
 * the same focusLayer the old spine called.
 */
export function storySteps(lines: Partial<Record<Layer, string>>, stateOf: (l: Layer) => StoryState): StoryStep[] {
  const defs: Array<{ id: StoryStepId; label: string; layers: Layer[]; line: (l: Partial<Record<Layer, string>>) => string }> = [
    { id: 'audience', label: 'Audience', layers: ['audience'], line: (l) => l.audience ?? '' },
    { id: 'message', label: 'Message', layers: ['strategy'], line: (l) => l.strategy ?? '' },
    { id: 'schedule', label: 'Schedule', layers: ['delivery', 'schedule'], line: (l) => [l.schedule, l.delivery].filter((x) => x && x !== '—').join(' · ') || '—' },
    { id: 'review', label: 'Review', layers: ['launch'], line: (l) => l.launch ?? '' },
  ]
  return defs.map((d, i) => ({ id: d.id, index: i + 1, label: d.label, line: d.line(lines), layers: d.layers, layer: d.layers[0], state: worstState(d.layers.map(stateOf)) }))
}

/** How far the story is told: steps that are ok (or warn — ready with warnings), 0..1. */
export function storyProgress(steps: StoryStep[]): number {
  if (!steps.length) return 0
  return steps.filter((s) => s.state === 'ok' || s.state === 'warn').length / steps.length
}

/** The measured funnel stages as tapered bars (an unmeasured stage is skipped, never drawn as 0). */
export type FunnelBar = { key: string; label: string; count: number; share: number; dropped: number | null }
export function funnelBars(stages: FunnelStage[]): FunnelBar[] {
  const measured = stages.filter((s): s is FunnelStage & { count: number } => typeof s.count === 'number')
  const top = measured[0]?.count ?? 0
  return measured.map((s) => ({ key: s.key, label: s.label, count: s.count, share: top > 0 ? Math.max(0.015, Math.min(1, s.count / top)) : 0, dropped: s.dropped }))
}

/** The audience's largest markets (the server's distribution), with a share of the matched audience. */
export function marketBars(audience: ComposerAudience | null, top = 6): Array<{ key: string; label: string; count: number; share: number }> {
  const rows = [...(audience?.distributions.markets ?? [])].filter((b) => b.count > 0).sort((a, b) => b.count - a.count)
  const max = rows[0]?.count ?? 0
  const head = rows.slice(0, top).map((b) => ({ key: b.value, label: b.label || b.value, count: b.count, share: max ? b.count / max : 0 }))
  const rest = rows.slice(top).reduce((a, b) => a + b.count, 0)
  if (rest) head.push({ key: '__rest', label: `${rows.length - top} more`, count: rest, share: max ? Math.min(1, rest / max) : 0 })
  return head
}

/** Sendable share of the matched audience, 0..1 (null when either side was not measured). */
export function sendableShare(eligible: number | null, matched: number | null | undefined): number | null {
  if (typeof eligible !== 'number' || typeof matched !== 'number' || matched <= 0) return null
  return Math.max(0, Math.min(1, eligible / matched))
}

/** The sample a phone shows: the next rendered one (a failed render is shown as held, honestly). */
export function phoneSample(samples: ComposerSample[], index: number): ComposerSample | null {
  if (!samples.length) return null
  return samples[((index % samples.length) + samples.length) % samples.length]
}

/** GSM-7 basic + extension characters (an extension character costs two septets). */
const GSM_BASIC = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'])
const GSM_EXT = new Set([...'^{}\\[~]|€'])

/** SMS segments of a rendered message (GSM-7: 160 / 153 per part; anything else → UCS-2: 70 / 67). */
export function smsSegments(text: string | null | undefined): { chars: number; segments: number; unicode: boolean } {
  const chars = [...String(text ?? '')]
  if (!chars.length) return { chars: 0, segments: 0, unicode: false }
  const unicode = chars.some((c) => !GSM_BASIC.has(c) && !GSM_EXT.has(c))
  const units = unicode ? chars.length : chars.reduce((a, c) => a + (GSM_EXT.has(c) ? 2 : 1), 0)
  const single = unicode ? 70 : 160
  const multi = unicode ? 67 : 153
  return { chars: chars.length, unicode, segments: units <= single ? 1 : Math.ceil(units / multi) }
}

/* ── AI assist (the read-only research agent) ─────────────────────────── */

export type AssistKind = 'explain' | 'segment' | 'message'
export type AssistContext = {
  name: string
  filters: Array<{ label: string; value: string }>
  matched: number | null
  eligible: number | null
  markets: string[]
  strategy: string | null
}

const n = (v: number | null) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : 'not measured')

/**
 * The question handed to the research agent. READ-ONLY by construction: it
 * asks for an explanation or a suggestion the operator may apply by hand —
 * never to change the draft, build targets, launch or send. It carries only
 * the composition's own aggregates (filter labels, counts, market names) —
 * no seller names, phones or addresses.
 */
export function assistPrompt(kind: AssistKind, ctx: AssistContext): string {
  const filters = ctx.filters.length ? ctx.filters.map((f) => `${f.label}: ${f.value}`).join('; ') : 'no filters yet'
  const facts = `Campaign draft "${ctx.name.trim() || 'untitled'}" — filters: ${filters}. Matched ${n(ctx.matched)} properties; ${n(ctx.eligible)} sendable today. Markets: ${ctx.markets.slice(0, 6).join(', ') || 'none'}.${ctx.strategy ? ` Strategy: ${ctx.strategy}.` : ''}`
  const guard = 'Read-only: explain and suggest only. Do not change the draft, build targets, launch or send anything.'
  if (kind === 'explain') return `${guard} Explain this audience: who is in it, why the funnel narrows from matched to sendable, and what the biggest exclusions mean. ${facts}`
  if (kind === 'segment') return `${guard} Suggest one or two tighter or higher-intent segments of this audience (filters I could add by hand) and the trade-off in reach for each. ${facts}`
  return `${guard} Review the message strategy for this audience: is the angle right for who is in it, and what should I watch in replies? ${facts}`
}

/** The draft's filters as the agent reads them: labels and short values — an id list is a count, never the ids. */
export function assistFilters(filters: Array<{ fieldKey: string; label: string; value: unknown }>): AssistContext['filters'] {
  return filters.map((f) => {
    const v = f.value
    if (f.fieldKey === 'properties.property_id' || f.fieldKey === 'properties.drawn_area') {
      const count = Array.isArray(v) ? v.length : null
      return { label: f.label, value: count === null ? 'a drawn area' : `${count.toLocaleString('en-US')} selected` }
    }
    if (Array.isArray(v)) return { label: f.label, value: v.length > 4 ? `${v.slice(0, 4).map(String).join(', ')} +${v.length - 4}` : v.map(String).join(', ') }
    if (v && typeof v === 'object') return { label: f.label, value: Object.values(v as Record<string, unknown>).map(String).join('–') }
    return { label: f.label, value: v === '' || v === null || v === undefined ? 'yes' : String(v) }
  })
}
