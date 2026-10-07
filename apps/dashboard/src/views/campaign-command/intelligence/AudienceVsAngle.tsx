import { useEffect, useState } from 'react'
import { LCError, LCSkeleton, LCTooltip, cx } from '../../../shared/lc'
import { readAudienceAngle, type AudienceAngle, type IntelResult } from './intelligence-api'
import { titleCase } from './intelligence-model'
import './intelligence.css'

/**
 * AUDIENCE FILTERS vs MESSAGE ANGLE — two separately labelled sections that are
 * never visually merged (owner 2026-10-07). "Audience filters" = what actually
 * restricted who was selected (saved target filters). "Message angle /
 * template" = what we said (strategy use case + the templates sent, or the
 * strategy's pool for a draft). A term the campaign name or copy implies but
 * no filter applies carries an "angle-only, not filtered" badge.
 * Read-only; derived from stored rows (works for every historical campaign).
 */
function valueText(v: unknown): string {
  if (Array.isArray(v)) return v.length > 6 ? `${v.slice(0, 6).map(String).join(', ')} +${v.length - 6} more` : v.map(String).join(', ')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v ?? '')
}

export function AudienceVsAngleView({ data, compact = false }: { data: AudienceAngle; compact?: boolean }) {
  const t = data.message_angle
  return (
    <div className={cx('aqi-aa', compact && 'is-compact')}>
      {data.badges.length ? (
        <div className="aqi-aa__badges" role="note">
          {data.badges.map((b) => (
            <LCTooltip key={b.key} content={`Implied by ${b.implied_by.map((x) => x.replace('_', ' ')).join(' and ')} — no saved audience filter applies it.`}>
              <span className="aqi-flag is-attn">{b.label}</span>
            </LCTooltip>
          ))}
        </div>
      ) : null}
      <div className="aqi-aa__grid">
        <section className="aqi-block aqi-aa__aud" aria-label="Audience filters">
          <h4 className="aqi-eyebrow">Audience filters · what restricted who was selected</h4>
          {data.audience_filters.length ? (
            <ul className="aqi-aa__list">
              {data.audience_filters.map((f, i) => (
                <li key={`${f.field_key}-${i}`}>
                  <span className="aqi-aa__k">{titleCase(f.label)}</span>
                  <span className="aqi-aa__op">{f.operator.replace(/_/g, ' ')}</span>
                  <span className="aqi-aa__v aqi-num">{valueText(f.value)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="aqi-muted">No saved audience filter — the audience was not restricted by any field.</p>}
          {data.terms.filter((x) => x.status !== 'angle_only_not_filtered').length ? (
            <p className="aqi-foot">Targeting applied: {data.terms.filter((x) => x.status !== 'angle_only_not_filtered').map((x) => x.label).join(' · ')}</p>
          ) : null}
        </section>
        <section className="aqi-block aqi-aa__ang" aria-label="Message angle and template">
          <h4 className="aqi-eyebrow">Message angle / template · what we said</h4>
          <p className="aqi-aa__uc"><b>{t.use_case ? titleCase(t.use_case) : 'No strategy recorded'}</b>{t.stage_code ? <span className="aqi-muted"> · {t.stage_code}</span> : null}</p>
          {t.templates.length ? (
            <ul className="aqi-aa__tpl">
              {t.templates.slice(0, compact ? 3 : 6).map((x) => (
                <li key={x.template_id}>
                  <span className="aqi-aa__tname">{x.name ?? x.template_id}</span>
                  {x.sends ? <span className="aqi-num aqi-muted">{x.sends.toLocaleString()} sent</span> : null}
                  {x.body_preview ? <p className="aqi-aa__body">“{x.body_preview}”</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="aqi-muted">No template sent yet.</p>}
          <p className="aqi-foot aqi-muted">{t.template_source}</p>
        </section>
      </div>
    </div>
  )
}

/** Self-loading panel for a saved campaign or a Composer composition. */
export function AudienceVsAngle({ campaignId, spec, specKey, compact }: { campaignId?: string | null; spec?: Record<string, unknown>; specKey?: string; compact?: boolean }) {
  const key = campaignId ? `c:${campaignId}` : `s:${specKey ?? JSON.stringify(spec ?? {})}`
  const [state, setState] = useState<{ key: string; res: IntelResult<AudienceAngle> } | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!campaignId && !spec) return
    const ctl = new AbortController()
    readAudienceAngle(campaignId ? { campaignId } : { spec }, ctl.signal).then((res) => { if (!ctl.signal.aborted) setState({ key: `${key}|${nonce}`, res }) })
    return () => ctl.abort()
    // spec is derived from key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce])
  const now = state?.key === `${key}|${nonce}` ? state.res : null
  const data = now?.ok ? (now.data.campaigns ? now.data.campaigns[0] ?? null : now.data) : null
  return (
    <section className="aqi aqi-aa-wrap" aria-label="Audience filters versus message angle">
      {!now ? <LCSkeleton shape="lines" count={3} label="Reading audience filters and message angle" /> : null}
      {now && !now.ok && !now.off ? <LCError what="Audience vs angle didn’t load" detail={now.message} onRetry={() => setNonce((x) => x + 1)} compact /> : null}
      {data ? <AudienceVsAngleView data={data} compact={compact} /> : null}
    </section>
  )
}
