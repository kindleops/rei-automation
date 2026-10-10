import type { ReactNode } from 'react'
import { cx } from '../../../shared/lc'
import { RESEARCH_PHASES, RESEARCH_PHASE_LABELS, type ResearchPhase } from '../contracts/contracts'
import { EVIDENCE_CLASS_META, type EvidenceClass, type SourceRef } from '../model/evidence-class'
import type { TimelineState } from '../model/research-model'
import type { RunMode } from '../runtime/agent-store'
import { VERDICT_LABEL, type Verdict } from './format'

/** The persistent honesty label for simulated surfaces. */
export function FixtureBadge({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cx('agx-fixture', compact && 'is-compact', className)} title="Simulated: fixture event log, synthetic properties, fixture sources. Nothing here was fetched, researched, priced or reasoned.">
      <i aria-hidden="true" />
      {compact ? 'Simulated' : 'Simulated · fixture data'}
    </span>
  )
}

/** Live runs: real LeadCommand data, read-only, $0, AI off. Never shown on a fixture. */
export function LiveBadge({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cx('agx-livebadge', compact && 'is-compact', className)} title="Live: real LeadCommand records read through the authorized read tools. Read-only — nothing is written, sent or billed. AI is off.">
      <i aria-hidden="true" />
      {compact ? 'Live · read-only' : 'Live · read-only · $0'}
    </span>
  )
}

/** The one provenance label: LIVE · READ-ONLY for live runs, SIMULATED for fixtures. */
export function ProvenanceBadge({ mode, compact, className }: { mode: RunMode | null | undefined; compact?: boolean; className?: string }) {
  if (mode === 'live') return <LiveBadge compact={compact} className={className} />
  if (mode === 'fixture') return <FixtureBadge compact={compact} className={className} />
  return null
}

/** Per-source / per-row marker for simulated items. Live rows never carry it. */
export const SimTag = ({ mode = 'fixture' }: { mode?: RunMode }) => (mode === 'fixture' ? <span className="agx-sim" title="Simulated fixture source — never contacted">SIM</span> : null)

/** A local monogram — favicons are never fetched from third parties. */
export function Favicon({ source, size = 18 }: { source: Pick<SourceRef, 'name' | 'authority_class'> | null; size?: number }) {
  const name = source?.name ?? '?'
  const letters = name.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'
  return <span className={cx('agx-fav', source && `is-${source.authority_class}`)} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }} aria-hidden="true">{letters}</span>
}


/** Evidence class mark (P4): official · LeadCommand · vendor · derived · unavailable — each with its own shape, not only a colour. */
export function ClassTag({ cls, compact }: { cls: EvidenceClass; compact?: boolean }) {
  const m = EVIDENCE_CLASS_META[cls]
  return (
    <span className={cx('agx-cls', `is-${cls}`, compact && 'is-compact')} title={`${m.label} — ${m.proves} ${m.limits}`}>
      <ClassGlyph cls={cls} />{compact ? m.short : m.label}
    </span>
  )
}

export function ClassGlyph({ cls }: { cls: EvidenceClass }) {
  switch (cls) {
    // a seal: official record
    case 'official': return <svg className="agx-clsg" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 7.3 2.4 9.1 2.3 9.4 4.1 10.8 5.3 9.9 6.9 10.2 8.7 8.4 9.2 7.4 10.7 6 9.9 4.6 10.7 3.6 9.2 1.8 8.7 2.1 6.9 1.2 5.3 2.6 4.1 2.9 2.3 4.7 2.4Z" /><path d="M4.3 6.1 5.5 7.2 7.8 4.9" className="agx-clsg__in" /></svg>
    // a database stack: internal records
    case 'internal': return <svg className="agx-clsg" viewBox="0 0 12 12" aria-hidden="true"><ellipse cx="6" cy="3" rx="4" ry="1.6" /><path d="M2 3v6c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6V3M2 6c0 .9 1.8 1.6 4 1.6S10 6.9 10 6" /></svg>
    // an outbound box: third-party vendor
    case 'vendor': return <svg className="agx-clsg" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.6" y="3.4" width="7" height="7" rx="1.4" /><path d="M6.4 1.6h4v4M10.4 1.6 5.6 6.4" /></svg>
    // a node graph: derived
    case 'derived': return <svg className="agx-clsg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="2.8" cy="3" r="1.4" /><circle cx="2.8" cy="9" r="1.4" /><circle cx="9.4" cy="6" r="1.5" /><path d="M4.1 3.6 8 5.4M4.1 8.4 8 6.6" /></svg>
    default: return <svg className="agx-clsg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.4" strokeDasharray="1.8 1.6" /><path d="M3.6 8.4 8.4 3.6" /></svg>
  }
}

/** Timeline state glyph (Planned hollow · Running arc · Completed · Failed · Blocked · Needs input …). */
export function StateGlyph({ state }: { state: TimelineState }) {
  switch (state) {
    case 'running':
      return <svg className="agx-glyph is-running" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" className="agx-glyph__track" /><path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" className="agx-glyph__arc" /></svg>
    case 'completed':
      return <svg className="agx-glyph is-completed" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M5.2 8.3 7.2 10.2 10.9 6" /></svg>
    case 'failed':
      return <svg className="agx-glyph is-failed" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M6 6l4 4M10 6l-4 4" /></svg>
    case 'blocked':
      return <svg className="agx-glyph is-blocked" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M4.6 11.4 11.4 4.6" /></svg>
    case 'needs_input':
      return <svg className="agx-glyph is-input" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.5-.7 1v.4" /><circle cx="8" cy="11.3" r=".55" className="agx-glyph__dot" /></svg>
    case 'unavailable':
      return <svg className="agx-glyph is-unavailable" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" strokeDasharray="2.2 2.2" /><path d="M5.6 8h4.8" /></svg>
    case 'cancelled':
      return <svg className="agx-glyph is-cancelled" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M5.6 8h4.8" /></svg>
    case 'skipped':
      return <svg className="agx-glyph is-skipped" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M5.5 8.2 7.4 10 10.6 6.3" strokeDasharray="1.6 1.6" /></svg>
    default:
      return <svg className="agx-glyph is-planned" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" /></svg>
  }
}


export function VerdictTag({ verdict, compact }: { verdict: Verdict; compact?: boolean }) {
  return <span className={cx('agx-verdict', `is-${verdict}`, compact && 'is-compact')}><i aria-hidden="true" />{VERDICT_LABEL[verdict]}</span>
}

/** Shimmer text — only while an operation is truly running (CSS stops it under reduced motion). */
export function Shimmer({ active, children, className }: { active: boolean; children: ReactNode; className?: string }) {
  return <span className={cx('agx-shimmer', active && 'is-active', className)}>{children}</span>
}

export function ProgressBar({ fraction, segments, label }: { fraction: number; segments?: Array<{ value: number; tone: 'ok' | 'blocked' | 'failed' | 'running' | 'rest' }>; label: string }) {
  const total = segments?.reduce((s, x) => s + x.value, 0) ?? 0
  return (
    <div className="agx-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
      {segments && total ? segments.map((s, i) => <span key={i} className={cx('agx-progress__seg', `is-${s.tone}`)} style={{ flexGrow: s.value, flexBasis: 0 }} />) : <span className="agx-progress__fill" style={{ width: `${Math.min(100, fraction * 100)}%` }} />}
    </div>
  )
}

/** Phase pill rail: a phase is a job state, never a timer. */
export function PhaseRail({ phase, terminal }: { phase: ResearchPhase | null; terminal: boolean }) {
  const idx = phase ? RESEARCH_PHASES.indexOf(phase) : -1
  return (
    <ol className="agx-phases" aria-label="Research phase">
      {RESEARCH_PHASES.map((p, i) => (
        <li key={p} className={cx('agx-phases__step', i < idx && 'is-past', i === idx && 'is-now', i === idx && terminal && 'is-done')} aria-current={i === idx ? 'step' : undefined}>
          <i aria-hidden="true" />{RESEARCH_PHASE_LABELS[p]}
        </li>
      ))}
    </ol>
  )
}

/** The agent's mark: a calm orb; it breathes (once per arrival, not a loop) only while computing. */
export function AgentOrb({ live, size = 22 }: { live: boolean; size?: number }) {
  return (
    <span className={cx('agx-orb', live && 'is-live')} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M12 3.2c.6 3.9 2.9 6.2 6.8 6.8-3.9.6-6.2 2.9-6.8 6.8-.6-3.9-2.9-6.2-6.8-6.8 3.9-.6 6.2-2.9 6.8-6.8Z" /><path d="M18.4 15.6c.2 1.3 1 2.1 2.3 2.3-1.3.2-2.1 1-2.3 2.3-.2-1.3-1-2.1-2.3-2.3 1.3-.2 2.1-1 2.3-2.3Z" className="agx-orb__spark" /></svg>
    </span>
  )
}
