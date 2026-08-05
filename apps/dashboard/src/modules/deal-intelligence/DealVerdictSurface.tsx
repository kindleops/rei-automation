/**
 * Deal verdict — the decision surface (constitution §12.5, §0).
 *
 * This is the first thing an operator reads, and it must answer four questions
 * in one glance:
 *
 *   1. Is this an opportunity?   -> the verdict
 *   2. Why?                      -> the supporting signals, each with its value
 *   3. What is uncertain?        -> named explicitly, never implied by absence
 *   4. What happens next?        -> one action
 *
 * Everything here is read from `decision_snapshot` / `comps` / `property`.
 * Nothing is invented: when the decision engine has not run, the surface says
 * so and offers the run, rather than presenting a confident-looking verdict
 * derived from defaults.
 */
import { useMemo } from 'react'
import type {
  DealIntelligenceDossier,
  DealIntelligenceDecisionSnapshot,
} from '../../domain/deal-intelligence/deal-intelligence.types'
import './deal-verdict.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const money = (v: number | null): string | null =>
  v == null || v <= 0
    ? null
    : `$${Math.round(v).toLocaleString('en-US')}`

type VerdictTone = 'pursue' | 'watch' | 'pass' | 'unknown'

interface Verdict {
  tone: VerdictTone
  label: string
  /** One line the operator can act on without reading anything else. */
  headline: string
}

/**
 * Map the engine's decision tier to an operator verdict. When the engine has
 * not produced a tier we fall back to the baseline acquisition score, and we
 * label it as a baseline — never as an engine decision.
 */
function resolveVerdict(
  snapshot: DealIntelligenceDecisionSnapshot | undefined,
  baselineScore: number | null,
): Verdict {
  const tier = String(snapshot?.decision_tier ?? '').toLowerCase()
  if (tier) {
    if (/pursue|strong|prime|tier[_\s-]?1|a\b/.test(tier)) {
      return { tone: 'pursue', label: 'Pursue', headline: 'Engine rates this a priority acquisition.' }
    }
    if (/watch|monitor|tier[_\s-]?2|b\b|marginal/.test(tier)) {
      return { tone: 'watch', label: 'Watch', headline: 'Viable, but conditions are not yet in our favour.' }
    }
    if (/pass|reject|decline|tier[_\s-]?3|c\b|no[_\s-]?deal/.test(tier)) {
      return { tone: 'pass', label: 'Pass', headline: 'Engine does not support an acquisition here.' }
    }
  }

  if (baselineScore != null) {
    if (baselineScore >= 70) {
      return {
        tone: 'pursue',
        label: 'Pursue (baseline)',
        headline: 'Baseline acquisition score is strong. Run the engine to confirm.',
      }
    }
    if (baselineScore >= 45) {
      return {
        tone: 'watch',
        label: 'Watch (baseline)',
        headline: 'Baseline score is middling. Run the engine before committing.',
      }
    }
    return {
      tone: 'pass',
      label: 'Low (baseline)',
      headline: 'Baseline score is weak. Run the engine if the seller is motivated.',
    }
  }

  return {
    tone: 'unknown',
    label: 'Not assessed',
    headline: 'No decision has been computed for this property yet.',
  }
}

interface Signal {
  key: string
  label: string
  value: string
  tone?: 'positive' | 'caution' | 'critical' | 'neutral'
}

interface Props {
  dossier: DealIntelligenceDossier | null
  /** Composition band. `compact` is the 25% decision-only surface. */
  band?: 'compact' | 'wide'
  engineRunning?: boolean
  onRunEngine?: () => void
  className?: string
}

export function DealVerdictSurface({
  dossier,
  band = 'compact',
  engineRunning = false,
  onRunEngine,
  className = '',
}: Props) {
  const snapshot = dossier?.decision_snapshot
  const property = dossier?.property
  const comps = dossier?.comps

  const baselineScore = useMemo(
    () =>
      num(snapshot?.baseline_acquisition_score) ??
      num(dossier?.baseline_scores?.acquisition_score) ??
      num(property?.acquisition_score),
    [snapshot, dossier, property],
  )

  const verdict = useMemo(() => resolveVerdict(snapshot, baselineScore), [snapshot, baselineScore])

  // ── 2. Why — supporting signals, each carrying its own value ────────────
  const signals = useMemo<Signal[]>(() => {
    const out: Signal[] = []
    const offer = num(snapshot?.recommended_cash_offer)
    const value = num(snapshot?.value) ?? num(property?.value)
    if (offer && value && value > 0) {
      const pct = Math.round((offer / value) * 100)
      out.push({
        key: 'offer',
        label: 'Offer vs value',
        value: `${money(offer)} · ${pct}% of ${money(value)}`,
        tone: pct <= 70 ? 'positive' : pct <= 80 ? 'caution' : 'critical',
      })
    } else if (value) {
      out.push({ key: 'value', label: 'Estimated value', value: money(value) as string, tone: 'neutral' })
    }

    const equityPct = num(snapshot?.equity_percentage) ?? num(property?.equity_percentage)
    const equityAmt = num(snapshot?.equity_amount) ?? num(property?.equity_amount)
    if (equityPct != null || equityAmt != null) {
      out.push({
        key: 'equity',
        label: 'Equity',
        value: [money(equityAmt), equityPct != null ? `${Math.round(equityPct)}%` : null]
          .filter(Boolean)
          .join(' · '),
        tone: (equityPct ?? 0) >= 50 ? 'positive' : (equityPct ?? 0) >= 25 ? 'caution' : 'neutral',
      })
    }

    const motivation = num(snapshot?.motivation_score) ?? num(property?.motivation_score)
    if (motivation != null) {
      out.push({
        key: 'motivation',
        label: 'Seller motivation',
        value: `${Math.round(motivation)} / 100`,
        tone: motivation >= 70 ? 'positive' : motivation >= 40 ? 'caution' : 'neutral',
      })
    }

    const buyerSignal = snapshot?.buyer_market_signal
    if (buyerSignal) {
      out.push({
        key: 'buyers',
        label: 'Buyer market',
        value: String(buyerSignal),
        tone: /strong|active/i.test(String(buyerSignal))
          ? 'positive'
          : /thin|no coverage/i.test(String(buyerSignal))
            ? 'critical'
            : 'caution',
      })
    }

    const repair = num(snapshot?.repair_estimate) ?? num(property?.repair_estimate)
    if (repair) {
      out.push({
        key: 'repair',
        label: 'Repair estimate',
        value: money(repair) as string,
        tone: repair > 60000 ? 'critical' : repair > 25000 ? 'caution' : 'positive',
      })
    }

    return out.slice(0, band === 'compact' ? 4 : 6)
  }, [snapshot, property, band])

  // ── 3. What is uncertain — named, never implied by absence ──────────────
  const uncertainties = useMemo<string[]>(() => {
    const out: string[] = []

    if (snapshot?.engine_available === false || !snapshot?.engine_computed_at) {
      out.push('The decision engine has not run for this property — figures below are baseline record values, not an underwritten decision.')
    }

    const confidence = num(snapshot?.confidence) ?? num(snapshot?.valuation_range?.confidence)
    if (confidence != null && confidence < 60) {
      out.push(`Valuation confidence is ${Math.round(confidence)}% — treat the offer as indicative.`)
    }

    const usable = num(comps?.usable_count) ?? num(comps?.comp_count)
    if (usable != null && usable < 3) {
      out.push(`Only ${usable} usable comp${usable === 1 ? '' : 's'} qualified — the valuation range is thin.`)
    }

    const risk = snapshot?.largest_risk
    if (risk?.label) {
      out.push(
        risk.score != null
          ? `Largest modelled risk: ${risk.label} (${Math.round(Number(risk.score))}).`
          : `Largest modelled risk: ${risk.label}.`,
      )
    }

    if (property?.latitude == null || property?.longitude == null) {
      out.push('No coordinates on the property record — imagery and comp geography are address-derived.')
    }

    if (!out.length) out.push('No material gaps flagged on this record.')
    return out.slice(0, band === 'compact' ? 2 : 4)
  }, [snapshot, comps, property, band])

  // ── 4. What happens next ───────────────────────────────────────────────
  const nextAction = snapshot?.recommended_next_action?.trim() || null
  const engineNotRun = snapshot?.engine_available === false || !snapshot?.engine_computed_at

  if (!dossier) return null

  return (
    <section
      className={cls('lc-verdict', `is-${verdict.tone}`, band === 'compact' && 'is-compact', className)}
      aria-label="Deal verdict"
    >
      <header className="lc-verdict__head">
        <span className="lc-verdict__eyebrow">Verdict</span>
        <span className={cls('lc-verdict__badge', `is-${verdict.tone}`)}>
          <span className="lc-verdict__dot" aria-hidden />
          {verdict.label}
        </span>
        {baselineScore != null ? (
          <span className="lc-verdict__score" title="Baseline acquisition score">
            {Math.round(baselineScore)}
          </span>
        ) : null}
      </header>

      <p className="lc-verdict__headline">{verdict.headline}</p>

      {signals.length ? (
        <dl className="lc-verdict__signals">
          {signals.map((s) => (
            <div key={s.key} className={cls('lc-verdict__signal', s.tone && `is-${s.tone}`)}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="lc-verdict__uncertain">
        <span className="lc-verdict__eyebrow">Uncertain</span>
        <ul>
          {uncertainties.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </div>

      <footer className="lc-verdict__next">
        <span className="lc-verdict__eyebrow">Next</span>
        {nextAction ? (
          <p className="lc-verdict__next-text">{nextAction}</p>
        ) : engineNotRun ? (
          <p className="lc-verdict__next-text">Run the decision engine to produce an underwritten offer and next action.</p>
        ) : (
          <p className="lc-verdict__next-text">No next action recorded. Advance the conversation from the composer.</p>
        )}
        {engineNotRun && onRunEngine ? (
          <button
            type="button"
            className="lc-verdict__cta"
            onClick={onRunEngine}
            disabled={engineRunning}
          >
            {engineRunning ? 'Running…' : 'Run decision engine'}
          </button>
        ) : null}
      </footer>
    </section>
  )
}
