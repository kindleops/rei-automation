import type { ReactNode } from 'react'
import { LCTooltip, cx } from '../../../shared/lc'
import { BAND_LABEL, RANK_SOURCE_LABEL, SEGMENT_ORDER, TIER_LABEL, TIER_ORDER, coverageVerdict, fmtN, languageLabel, share, situationLabel, titleCase } from './intelligence-model'
import type { Counted, QualityExample, QualityReport, RankSource } from './intelligence-types'

/**
 * CAMPAIGN QUALITY REPORT (Acquisition OS §19/§70). Read-only, before launch.
 * Every share is drawn from its count AND denominator; nothing is estimated
 * here — the cohort split, coverage and context are the server's.
 */

function Share({ count, of, strong }: { count: number; of: number; strong?: boolean }) {
  const s = share(count, of)
  return (
    <span className={cx('aqi-share', strong && 'is-strong')}>
      <b className="aqi-num">{fmtN(count)}</b>
      {s.pct ? <em className="aqi-num">{s.pct}</em> : null}
    </span>
  )
}

function Bar({ parts, of, label }: { parts: Array<{ key: string; count: number; tone: string; label: string }>; of: number; label: string }) {
  return (
    <div className="aqi-bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${share(p.count, of).text}`).join(', ')}`}>
      {parts.filter((p) => p.count > 0).map((p) => (
        <LCTooltip key={p.key} content={`${p.label} · ${share(p.count, of).text} (${share(p.count, of).pct ?? '—'})`}>
          <i className={cx('aqi-bar__seg', `is-${p.tone}`)} style={{ flexGrow: p.count }} />
        </LCTooltip>
      ))}
    </div>
  )
}

function List({ title, rows, of, label = (k: string) => k, extra }: { title: string; rows: Counted[]; of: number; label?: (k: string) => string; extra?: ReactNode }) {
  return (
    <section className="aqi-block">
      <h4 className="aqi-eyebrow">{title}</h4>
      <ul className="aqi-list">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="aqi-list__k">{label(r.key)}</span>
            <span className="aqi-list__meter" aria-hidden="true"><i style={{ width: `${Math.max(2, (share(r.count, of).ratio ?? 0) * 100)}%` }} /></span>
            <Share count={r.count} of={of} />
          </li>
        ))}
      </ul>
      {extra}
    </section>
  )
}

const TIER_TONE = { A: 'crit-soft', B: 'attn', C: 'neutral', UNKNOWN: 'void' } as const
const SEGMENT_TONE: Record<string, string> = { acute: 'crit-soft', tax_lien: 'attn', vacancy_repair: 'flow', stacked_landlord: 'exec', other_soft: 'neutral', unknown_score: 'void' }

export function Example({ x, onOpen }: { x: QualityExample; onOpen?: (id: string) => void }) {
  return (
    <li className="aqi-ex">
      <button type="button" className="aqi-ex__head" onClick={onOpen ? () => onOpen(x.property_id) : undefined} disabled={!onOpen}>
        <span className={cx('aqi-tier', `is-${x.tier}`)}>{x.tier === 'UNKNOWN' ? '?' : x.tier}</span>
        <span className="aqi-ex__where">{x.market ?? '—'} <span className="aqi-num">{x.zip ?? ''}</span></span>
        <span className="aqi-ex__score aqi-num">{x.score === null ? '—' : x.score.toFixed(1)}</span>
      </button>
      <div className="aqi-why">{x.why.slice(0, 7).map((w) => <span key={w} className="aqi-why__chip">{w}</span>)}</div>
    </li>
  )
}

export function CampaignQualityReport({ report, onOpenProperty }: { report: QualityReport; onOpenProperty?: (id: string) => void }) {
  const n = report.denominator
  const tiers = TIER_ORDER.map((t) => ({ key: t, count: report.tiers[t] ?? 0, tone: TIER_TONE[t], label: TIER_LABEL[t] }))
  const segments = SEGMENT_ORDER.map((k) => report.segments.find((s) => s.key === k)).filter((s): s is NonNullable<typeof s> => Boolean(s))
  const sources: RankSource[] = ['v2', 'legacy_fallback', 'v2_no_situation', 'unranked']
  const cov = Object.values(report.coverage)
  const lt = report.contactability.line_type
  const liq = report.buyer_liquidity
  const touch = report.prior_property_touch
  const softShare = share(report.tiers.C ?? 0, n)
  return (
    <div className="aqi-qr">
      <header className="aqi-qr__lede">
        <div>
          <span className="aqi-eyebrow">Cohort quality · {fmtN(n)} sellers</span>
          <p className="aqi-qr__line">
            <b className="aqi-num">{fmtN(report.tiers.A ?? 0)}</b> acute · <b className="aqi-num">{fmtN(report.tiers.B ?? 0)}</b> stacked · <b className="aqi-num">{fmtN(report.tiers.C ?? 0)}</b> soft
            {softShare.ratio !== null && softShare.ratio >= 0.5 ? <span className="aqi-flag is-attn">Mostly soft signals — {softShare.pct} tier C ({softShare.text})</span> : null}
          </p>
        </div>
        <dl className="aqi-qr__meta">
          <div><dt>Ranked</dt><dd>{sources.filter((s) => report.ranking[s]).map((s) => `${RANK_SOURCE_LABEL[s]} ${fmtN(report.ranking[s])}`).join(' · ') || '—'}</dd></div>
          <div><dt>Model</dt><dd>{report.version}</dd></div>
        </dl>
      </header>

      <section className="aqi-block aqi-block--wide">
        <h4 className="aqi-eyebrow">Opportunity tier</h4>
        <Bar parts={tiers} of={n} label="Opportunity tier split" />
        <ul className="aqi-legend">
          {tiers.map((t) => <li key={t.key}><i className={cx('aqi-dot', `is-${t.tone}`)} />{t.label}<Share count={t.count} of={n} /></li>)}
        </ul>
      </section>

      <section className="aqi-block aqi-block--wide">
        <h4 className="aqi-eyebrow">What the cohort actually is</h4>
        <Bar parts={segments.map((s) => ({ key: s.key, count: s.count, tone: SEGMENT_TONE[s.key] ?? 'neutral', label: s.label }))} of={n} label="Cohort segments" />
        <ul className="aqi-legend aqi-legend--cols">
          {segments.map((s) => <li key={s.key}><i className={cx('aqi-dot', `is-${SEGMENT_TONE[s.key]}`)} />{s.label}<Share count={s.count} of={n} /></li>)}
        </ul>
      </section>

      <div className="aqi-qr__grid">
        <section className="aqi-block">
          <h4 className="aqi-eyebrow">Score coverage</h4>
          <ul className="aqi-cov">
            {cov.map((c) => (
              <li key={c.key} className={cx(!c.exposed && 'is-off')}>
                <LCTooltip content={coverageVerdict(c)}><span className="aqi-cov__k">{c.label}</span></LCTooltip>
                <span className="aqi-cov__v aqi-num">{share(c.known, c.total).pct ?? '—'}</span>
                <span className={cx('aqi-cov__state', c.exposed ? 'is-ok' : 'is-attn')}>{c.exposed ? 'exposed' : 'not exposed'}</span>
              </li>
            ))}
          </ul>
        </section>
        <List title="Markets" rows={report.markets.slice(0, 8)} of={n} />
        <List title="ZIPs" rows={report.zips.slice(0, 8)} of={n} />
        <List title="Seller situation" rows={report.situations.known.slice(0, 8)} of={n} label={situationLabel}
          extra={report.situations.unknown ? <p className="aqi-foot">Not scored: <span className="aqi-num">{share(report.situations.unknown, n).text}</span></p> : null} />
        <List title="Language (known)" rows={report.language.known.slice(0, 8)} of={n} label={languageLabel}
          extra={<p className="aqi-foot">Unknown language: <b className="aqi-num">{share(report.language.unknown, n).text}</b> <span className="aqi-muted">— not assumed English</span></p>} />
        <section className="aqi-block">
          <h4 className="aqi-eyebrow">Contactability</h4>
          <ul className="aqi-kv">
            <li><span>Mobile line</span><Share count={lt.mobile} of={n} /></li>
            <li><span>Landline</span><Share count={lt.landline} of={n} /></li>
            <li><span>Line type unknown</span><Share count={lt.unknown} of={n} /></li>
          </ul>
          <ul className="aqi-kv aqi-kv--sub">
            {report.contactability.identity.map((r) => <li key={r.key}><span>Identity · {titleCase(r.key)}</span><Share count={r.count} of={n} /></li>)}
          </ul>
        </section>
        {report.equity || report.contact_confidence ? (
          <section className="aqi-block">
            <h4 className="aqi-eyebrow">Equity · contact confidence</h4>
            {report.equity ? (
              <>
                <Bar parts={[{ key: 'high', count: report.equity.high, tone: 'ok', label: 'High equity' }, { key: 'low', count: report.equity.low, tone: 'attn', label: 'Low equity' }, { key: 'unknown', count: report.equity.unknown, tone: 'void', label: 'Equity unknown' }]} of={n} label="Equity class" />
                <ul className="aqi-kv">
                  <li><span>High equity</span><Share count={report.equity.high} of={n} /></li>
                  <li><span>Low equity</span><Share count={report.equity.low} of={n} /></li>
                  <li><LCTooltip content={`Unknown is never shown as 100%. Rule: ${report.equity.rule}`}><span>Equity unknown</span></LCTooltip><Share count={report.equity.unknown} of={n} /></li>
                  <li><span>Equity % known (loan + value)</span><Share count={report.equity.known_percent} of={n} /></li>
                </ul>
              </>
            ) : null}
            {report.contact_confidence ? (
              <ul className="aqi-kv aqi-kv--sub">
                <li><span>Contact confidence · high</span><Share count={report.contact_confidence.high} of={n} /></li>
                <li><span>Contact confidence · medium</span><Share count={report.contact_confidence.medium} of={n} /></li>
                <li><span>Contact confidence · low</span><Share count={report.contact_confidence.low} of={n} /></li>
                {(report.matching_tags || []).slice(0, 5).map((t) => <li key={t.key}><span>Match tag · {t.key === 'missing' ? 'not recorded' : titleCase(t.key)}</span><Share count={t.count} of={n} /></li>)}
              </ul>
            ) : null}
          </section>
        ) : null}
        <section className="aqi-block">
          <h4 className="aqi-eyebrow">Touch · review · liquidity</h4>
          <ul className="aqi-kv">
            <li><span>Property already touched</span><Share count={touch.touched} of={n} /></li>
            <li><span>Never touched</span><Share count={touch.never} of={n} /></li>
            {touch.unknown ? <li><span>Touch unknown</span><Share count={touch.unknown} of={n} /></li> : null}
            <li><LCTooltip content={`Rule: ${report.expected_review_only.rule}`}><span>Expected review-only</span></LCTooltip><Share count={report.expected_review_only.count} of={n} /></li>
          </ul>
          <Bar parts={[{ key: 'strong', count: liq.strong, tone: 'ok', label: 'Strong buyer liquidity' }, { key: 'moderate', count: liq.moderate, tone: 'exec', label: 'Moderate' }, { key: 'thin', count: liq.thin, tone: 'attn', label: 'Thin' }, { key: 'unknown', count: liq.unknown, tone: 'void', label: 'Not measured' }]} of={n} label="Buyer liquidity in ZIP" />
          <p className="aqi-foot aqi-num">Buyer liquidity in ZIP — strong {fmtN(liq.strong)} · moderate {fmtN(liq.moderate)} · thin {fmtN(liq.thin)} · not measured {fmtN(liq.unknown)}</p>
        </section>
      </div>

      {report.examples.top_ranked.length || report.examples.soft_only.length ? (
        <section className="aqi-block aqi-block--wide">
          <h4 className="aqi-eyebrow">Why targeted · examples</h4>
          <div className="aqi-exgrid">
            <div>
              <span className="aqi-sub">Top ranked</span>
              <ul className="aqi-exlist">{report.examples.top_ranked.slice(0, 5).map((x) => <Example key={x.property_id} x={x} onOpen={onOpenProperty} />)}</ul>
            </div>
            {report.examples.soft_only.length ? (
              <div>
                <span className="aqi-sub">Soft only (tier C)</span>
                <ul className="aqi-exlist">{report.examples.soft_only.slice(0, 3).map((x) => <Example key={x.property_id} x={x} onOpen={onOpenProperty} />)}</ul>
              </div>
            ) : null}
          </div>
          <p className="aqi-foot aqi-muted">{BAND_LABEL.FALLBACK} rows never carry a v2 reason; internal evidence is never shown to sellers.</p>
        </section>
      ) : null}
    </div>
  )
}
