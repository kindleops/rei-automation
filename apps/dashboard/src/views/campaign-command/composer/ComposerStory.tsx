import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { LCButton, LCTooltip, cx, useLcReducedMotion } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { AGENT_PROTOTYPE_ENABLED, sendAgentCommand } from '../../../modules/agent/agent-bridge'
import type { ComposerAudience, ComposerSample } from './composer-types'
import { audienceFunnel, fmt } from './composer-model'
import { reasonWords } from './composer-format'
import {
  assistPrompt,
  funnelBars,
  marketBars,
  phoneSample,
  sendableShare,
  smsSegments,
  storyProgress,
  type AssistContext,
  type AssistKind,
  type StoryStep,
} from './composer-story'
import './composer-story.css'

/**
 * CAMPAIGN COMPOSER · the premium story surfaces (presentation only — the
 * composition, save, build and launch are CampaignComposer's, unchanged):
 *
 *   StoryRail      audience → message → schedule → review, with a progress
 *                  track; a step click focuses its layer (the old spine's job)
 *   AudienceLens   the audience as a picture: sendable ring, the eligibility
 *                  funnel with counters that roll, the market mix
 *   PhonePreview   the rendered message on a phone, from real build samples
 *   AiAssist       hands a READ-ONLY question to the research agent dock
 *                  (explain this audience · suggest a segment · review the
 *                  angle); the operator applies anything by hand
 *
 * Motion respects prefers-reduced-motion and the LC Animations switch.
 */

/** Rolls to a value from the last one shown (0 first); immediate under reduced motion. */
export function useRolling(value: number | null, ms = 820): number | null {
  const reduced = useLcReducedMotion()
  const [shown, setShown] = useState<number | null>(() => (value === null ? null : reduced ? value : 0))
  const last = useRef(0)
  useEffect(() => {
    if (value === null) { setShown(null); return }
    if (reduced || typeof requestAnimationFrame !== 'function') { setShown(value); last.current = value; return }
    const from = last.current
    if (from === value) { setShown(value); return }
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms)
      const v = from + (value - from) * (1 - (1 - t) ** 3)
      last.current = t >= 1 ? value : v
      setShown(t >= 1 ? value : v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, reduced, ms])
  return shown
}

function Rolling({ value }: { value: number | null }) {
  const v = useRolling(value)
  return <>{v === null ? '—' : fmt(v)}</>
}

/* ── the story rail ─────────────────────────────────────────────────────── */

const STATE_WORD: Record<string, string> = { ok: 'Done', warn: 'Ready with warnings', block: 'Needs attention', checking: 'Checking', idle: 'Not started' }

export function StoryRail({ steps, onStep, focused }: { steps: StoryStep[]; onStep: (s: StoryStep) => void; focused?: string | null }) {
  const progress = storyProgress(steps)
  return (
    <nav className="ccz-story" aria-label="Composition story" style={{ '--p': progress } as CSSProperties}>
      <span className="ccz-story__track" aria-hidden="true"><i /></span>
      <ol className="ccz-story__steps">
        {steps.map((s) => (
          <li key={s.id}>
            <button type="button" className={cx('ccz-story__step', `is-${s.state}`, focused && s.layers.includes(focused as StoryStep['layer']) && 'is-focused')} onClick={() => onStep(s)} aria-label={`${s.index}. ${s.label} — ${STATE_WORD[s.state] ?? s.state}${s.line ? ` · ${s.line}` : ''}`}>
              <span className="ccz-story__dot" aria-hidden="true">{s.state === 'ok' ? <Icon name="check" size={12} /> : s.state === 'block' ? <Icon name="alert" size={12} /> : <b>{s.index}</b>}</span>
              <span className="ccz-story__txt"><strong>{s.label}</strong><em>{s.line || STATE_WORD[s.state]}</em></span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/* ── the audience lens ──────────────────────────────────────────────────── */

function Ring({ share }: { share: number | null }) {
  const r = 34
  const c = 2 * Math.PI * r
  const v = share ?? 0
  return (
    <svg className="ccz-ring" viewBox="0 0 84 84" role="img" aria-label={share === null ? 'Sendable share not measured' : `${Math.round(v * 100)}% of matched are sendable today`}>
      <circle className="ccz-ring__bg" cx="42" cy="42" r={r} />
      <circle className="ccz-ring__fg" cx="42" cy="42" r={r} style={{ strokeDasharray: c, strokeDashoffset: c * (1 - v) } as CSSProperties} />
      <text x="42" y="40" textAnchor="middle" className="ccz-ring__v">{share === null ? '—' : `${v >= 0.1 ? Math.round(v * 100) : (v * 100).toFixed(1)}%`}</text>
      <text x="42" y="54" textAnchor="middle" className="ccz-ring__k">sendable</text>
    </svg>
  )
}

export function AudienceLens({ audience, eligible, loading, labelOf, assist }: {
  audience: ComposerAudience | null
  eligible: number | null
  loading: boolean
  labelOf: (key: string) => string
  assist?: AssistContext | null
}) {
  if (!audience) {
    return loading ? <div className="ccz-lens is-loading" aria-busy="true"><i className="lc-skel ccz-lens__skel" /><i className="lc-skel ccz-lens__skel" /><i className="lc-skel ccz-lens__skel" /></div> : null
  }
  const bars = funnelBars(audienceFunnel(audience, labelOf))
  const markets = marketBars(audience)
  const share = sendableShare(eligible, audience.matched)
  return (
    <div className="ccz-lens-wrap">
    <section className={cx('ccz-lens', loading && 'is-settling')} aria-label="Audience at a glance">
      <div className="ccz-lens__ring">
        <Ring share={share} />
        <dl className="ccz-lens__facts">
          <div><dt>Matched</dt><dd><Rolling value={audience.matched} /></dd></div>
          <div><dt>Sendable today</dt><dd className="is-hero"><Rolling value={eligible} /></dd></div>
        </dl>
      </div>
      <figure className="ccz-lens__funnel" aria-label="Eligibility funnel">
        <figcaption className="ccz-kicker">Eligibility</figcaption>
        <ol>
          {bars.map((b, i) => (
            <li key={b.key} style={{ '--v': b.share, '--i': i } as CSSProperties}>
              <span className="ccz-lens__label">{b.label}</span>
              <span className="ccz-lens__bar" aria-hidden="true"><i /></span>
              <b className="ccz-lens__n"><Rolling value={b.count} /></b>
              <em className="ccz-lens__drop">{b.dropped ? `−${fmt(b.dropped)}` : ''}</em>
            </li>
          ))}
        </ol>
      </figure>
      {markets.length ? (
        <figure className="ccz-lens__markets" aria-label="Market mix">
          <figcaption className="ccz-kicker">Markets</figcaption>
          <ol>
            {markets.map((m, i) => (
              <li key={m.key} className={cx(m.key === '__rest' && 'is-rest')} style={{ '--v': m.share, '--i': i } as CSSProperties}>
                <span className="ccz-lens__label">{m.label}</span>
                <span className="ccz-lens__bar" aria-hidden="true"><i /></span>
                <b className="ccz-lens__n">{fmt(m.count)}</b>
              </li>
            ))}
          </ol>
        </figure>
      ) : null}
      {assist ? <AiAssist context={assist} kinds={['explain', 'segment']} /> : null}
    </section>
    </div>
  )
}

/* ── AI assist (read-only research agent) ───────────────────────────────── */

const ASSIST: Record<AssistKind, { label: string; hint: string }> = {
  explain: { label: 'Explain this audience', hint: 'Who is in it and why the funnel narrows' },
  segment: { label: 'Suggest a segment', hint: 'Tighter, higher-intent slices to add by hand' },
  message: { label: 'Review the angle', hint: 'Is the message right for this audience?' },
}

export function AiAssist({ context, kinds, enabled = AGENT_PROTOTYPE_ENABLED, send = sendAgentCommand }: {
  context: AssistContext
  kinds: AssistKind[]
  /** injectable for tests */
  enabled?: boolean
  send?: typeof sendAgentCommand
}) {
  return (
    <div className="ccz-assist" role="group" aria-label="AI assist (read-only)">
      <span className="ccz-assist__tag"><Icon name="spark" size={12} /> AI assist <em>read-only</em></span>
      {kinds.map((k) => (
        <LCTooltip key={k} content={enabled ? `${ASSIST[k].hint} — opens the research agent with this question; it can only read, never edit or send` : 'The research agent is not enabled in this build'}>
          <span>
            <button type="button" className="ccz-assist__btn" disabled={!enabled} onClick={() => send({ kind: 'agent', action: 'ask', query: assistPrompt(k, context) })}>
              {ASSIST[k].label}
            </button>
          </span>
        </LCTooltip>
      ))}
    </div>
  )
}

/* ── the phone ──────────────────────────────────────────────────────────── */

export function PhonePreview({ samples, loading, onInspect, assist }: {
  samples: ComposerSample[]
  loading: boolean
  onInspect?: (sample: ComposerSample) => void
  assist?: AssistContext | null
}) {
  const [i, setI] = useState(0)
  const sample = phoneSample(samples, i)
  const seg = smsSegments(sample?.ok ? sample.text : '')
  return (
    <figure className="ccz-phone" aria-label="Message preview">
      <div className="ccz-phone__device">
        <div className="ccz-phone__notch" aria-hidden="true" />
        <header className="ccz-phone__bar">
          <span className="ccz-phone__avatar" aria-hidden="true"><Icon name="message" size={12} /></span>
          <span className="ccz-phone__who"><b>{sample?.market ?? 'Seller'}</b><em>Text message</em></span>
        </header>
        <div className="ccz-phone__thread" aria-live="polite">
          {sample ? (
            sample.ok ? (
              <p key={sample.id} className="ccz-phone__bubble">{sample.text}</p>
            ) : (
              <p key={sample.id} className="ccz-phone__held"><Icon name="alert" size={12} /> Not rendered — {reasonWords(sample.reason)}. This seller is held at build.</p>
            )
          ) : (
            <p className="ccz-phone__empty">{loading ? 'Rendering from real targets…' : 'The preview renders from real targets once the audience is counted.'}</p>
          )}
        </div>
        <footer className="ccz-phone__compose" aria-hidden="true"><span>Text message</span><i /></footer>
      </div>
      <figcaption className="ccz-phone__cap">
        {sample?.ok ? <span>{seg.chars} chars · {seg.segments} {seg.segments === 1 ? 'segment' : 'segments'}{seg.unicode ? ' · unicode' : ''} · template {sample.template_id ?? '—'} · {sample.template_language ?? 'English'}</span> : <span>Rotation may pick a sibling template at send.</span>}
        {samples.length > 1 ? (
          <span className="ccz-phone__cycle">
            <button type="button" aria-label="Previous sample" onClick={() => setI((x) => x - 1)}><Icon name="chevron-left" size={13} /></button>
            <span className="ccz-mono">{((i % samples.length) + samples.length) % samples.length + 1}/{samples.length}</span>
            <button type="button" aria-label="Next sample" onClick={() => setI((x) => x + 1)}><Icon name="chevron-right" size={13} /></button>
          </span>
        ) : null}
        {sample?.property_id && onInspect ? <LCButton size="sm" variant="ghost" icon="eye" onClick={() => onInspect(sample)}>Inspect</LCButton> : null}
      </figcaption>
      {assist ? <AiAssist context={assist} kinds={['message']} /> : null}
    </figure>
  )
}
