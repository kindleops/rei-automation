import { useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Icon } from '../../../../shared/icons'
import { LCButton, cx, useLcReducedMotion } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS, type CostEstimate, type ResearchDepth } from '../../contracts/contracts'
import { sourceClass, toSourceRef, type SourceRef } from '../../model/evidence-class'
import type { ResearchView } from '../../model/research-model'
import { controlRun, dismissPreflight, launchLiveQuickScan, refreshLiveCapability, requestPreflight, useAgentUi, useLiveCapability, type RunSnapshot } from '../../runtime/agent-store'
import { fmtClock, fmtUsd, authorityLabel } from '../format'
import { ClassTag, Favicon, ProvenanceBadge } from '../primitives'

/**
 * MISSION PREFLIGHT (S3 directive P8) — nothing runs until Launch. The panel
 * states, exactly: the properties, the tier, the tools and sources the run
 * may touch, the maximum budget, what needs approval, and what Cancel does.
 * Every check row is a real, already-known fact (the selection, the server's
 * capability response) — the reveal is a stagger, not a fake "checking" wait.
 *
 * S3: Quick Scan is the only enabled tier — $0, T0 read-only, AI off. Deep
 * Research and Acquisition Diligence are shown, with their caps, disabled.
 */

const TIERS: Array<{ depth: ResearchDepth; cap: string; what: string }> = [
  { depth: 'quick', cap: '$0 · structural', what: 'LeadCommand records only · deterministic checks · seconds' },
  { depth: 'deep', cap: '$0.75 / property', what: 'Registry county sources · Haiku extraction · one synthesis' },
  { depth: 'diligence', cap: '$2.00 / property', what: 'Deep + lane-labelled economics · Sonnet by criteria' },
]

interface Check { label: string; state: 'ok' | 'wait' | 'no'; detail: string }

interface MissionSpec {
  mode: 'live' | 'fixture'
  depth: ResearchDepth
  title: string
  origin: string | null
  properties: Array<{ id: string; address: string; sub: string | null }>
  tools: Array<{ name: string; label: string; tier: string }>
  sources: SourceRef[]
  budget: { cap: number | null; note: string }
  estimate: CostEstimate | null
  approvals: string
  cancellation: string[]
  limits?: string[]
  scopeSentence?: string | null
  checks: Check[]
}

const mask = (id: string) => `••${id.replace(/[^a-z0-9]/gi, '').slice(-6)}`

/** The live Quick Scan preflight — renders exactly what the server's draft declares (POST …/quick-scan/preflight). */
export function LivePreflight() {
  const ui = useAgentUi()
  const cap = useLiveCapability()
  const pf = ui.preflight
  if (!pf) return null
  const d = pf.server
  const ids = d?.property_ids.length ? d.property_ids : pf.propertyIds
  const addrOf = (id: string) => pf.addresses[pf.propertyIds.indexOf(id)] ?? null
  const checks: Check[] = [
    { label: 'Selection', state: ids.length ? 'ok' : 'no', detail: `${ids.length} property id${ids.length === 1 ? '' : 's'} from ${pf.originLabel ?? 'the linked selection'}${d?.deferred_property_count ? ` · ${d.deferred_property_count} deferred (test-batch limit)` : ''}` },
    { label: 'Live route', state: cap.status === 'available' ? 'ok' : cap.status === 'checking' || cap.status === 'unknown' ? 'wait' : 'no', detail: cap.status === 'available' ? `Available · checked ${fmtClock(cap.checkedAt ? new Date(cap.checkedAt).toISOString() : null)}` : cap.status === 'unavailable' ? (cap.reason ?? 'Unavailable') : 'Checking with the API…' },
    { label: 'Server draft', state: pf.status === 'ready' || pf.status === 'launching' ? 'ok' : pf.status === 'loading' ? 'wait' : 'no', detail: pf.status === 'loading' ? 'The server is drafting the exact scope…' : d ? `Job ${d.job_id.slice(-8)} · scope ${d.scope_hash.slice(0, 10)}…${d.expires_at ? ` · expires ${fmtClock(d.expires_at)}` : ''}` : pf.error ?? 'Not drafted' },
    { label: 'Posture', state: d ? (d.mode === 'read' || d.mode === 'draft' || d.mode === 'write' || d.mode === 'full' ? 'ok' : 'no') : 'wait', detail: d ? `Agent mode “${d.mode ?? '—'}” · AI ${d.ai.enabled ? 'ON' : 'off'} · ${d.approval.required ? 'approval required' : 'no approval needed'}` : 'Declared by the server draft' },
    ...(d?.blockers ?? []).map((b) => ({ label: 'Blocker', state: 'no' as const, detail: b.message })),
  ]
  const spec: MissionSpec = {
    mode: 'live',
    depth: 'quick',
    title: ids.length === 1 ? (addrOf(ids[0]) ?? `Property ${mask(ids[0])}`) : `${ids.length} properties`,
    origin: pf.originLabel,
    properties: ids.map((id) => ({ id, address: addrOf(id) ?? `Property ${mask(id)}`, sub: `id ${id}` })),
    tools: (d?.tools ?? []).map((t) => ({ name: t.name, label: t.label, tier: t.tier })),
    sources: (d?.sources ?? []).map((x) => toSourceRef(x)),
    budget: { cap: d ? d.max_budget_usd : 0, note: d?.estimate_label ? `${d.estimate_label}. The server plans only non-billable LeadCommand reads and refuses anything else.` : 'Structural — no billable operation can be planned on a Quick Scan; the server refuses one.' },
    estimate: null,
    approvals: d?.approval.reason ?? 'Declared by the server draft.',
    cancellation: d?.cancellation ? d.cancellation.split(/(?<=\.)\s+/).filter(Boolean) : ['Declared by the server draft.'],
    limits: d ? [d.limits.concurrency ? `${d.limits.concurrency} properties at a time` : null, d.limits.test_batch_max ? `test batches ≤ ${d.limits.test_batch_max}` : null, d.limits.max_per_batch ? `≤ ${d.limits.max_per_batch} per batch` : null].filter(Boolean) as string[] : [],
    scopeSentence: d?.scope_sentence ?? null,
    checks,
  }
  const ready = pf.status === 'ready' && Boolean(d?.can_run) && checks.every((c) => c.state === 'ok')
  return (
    <Mission spec={spec}
      primary={<LCButton variant="primary" icon="play" disabled={!ready} onClick={() => void launchLiveQuickScan()} autoFocus>{pf.status === 'launching' ? 'Launching…' : 'Launch Quick Scan'}</LCButton>}
      secondary={<LCButton variant="quiet" onClick={() => dismissPreflight()}>Not now</LCButton>}
      extra={pf.status === 'error' || cap.status === 'unavailable' ? <button type="button" className="agx-link" onClick={() => { if (cap.status === 'unavailable') void refreshLiveCapability(); void requestPreflight() }}>Try the preflight again</button> : null} />
  )
}

/** The fixture scope gate (job.created → confirm), as the same mission panel — SIMULATED. */
export function FixturePreflight({ snap, view }: { snap: RunSnapshot; view: ResearchView }) {
  const [ok, setOk] = useState(false)
  const depth = view.depth ?? 'deep'
  const n = view.property_count
  const props = snap.properties.slice(0, 12)
  const sentence = n > 1 ? `Replay ${n} synthetic properties · ${RESEARCH_DEPTH_LABELS[depth]} · batch cap ${fmtUsd(view.cap_usd)}` : `Replay 1 synthetic property · ${RESEARCH_DEPTH_LABELS[depth]} · cap ${fmtUsd(view.cap_usd)}`
  const spec: MissionSpec = {
    mode: 'fixture',
    depth,
    title: snap.title,
    origin: 'Design fixture',
    properties: props.map((p) => ({ id: p.property_id, address: p.address, sub: p.jurisdiction })),
    tools: [],
    sources: Object.values(snap.sources),
    budget: { cap: view.cap_usd, note: 'Fixture prices — a replay bills nothing. Caps can be lowered, never raised above the owner ceiling.' },
    estimate: view.estimate,
    approvals: depth === 'quick' ? 'None — T0 reads.' : 'In the live product a paid tier needs a T3 budget approval naming this exact scope and cap.',
    cancellation: ['Queued operations are cancelled.', 'Running operations stop at their next source boundary.', 'An in-flight model call settles at its real cost and is marked “after cancel”.', 'Findings gathered so far stay in the brief.'],
    checks: [
      { label: 'Data', state: 'no', detail: 'Synthetic properties and fixture sources — nothing is fetched' },
      { label: 'Concurrency', state: 'ok', detail: '2 investigations · org-wide cap' },
      { label: 'Model spend', state: 'ok', detail: 'Haiku first · Sonnet only by criteria · Opus off' },
    ],
  }
  return (
    <Mission spec={spec} moreProperties={n - props.length}
      confirm={<label className={cx('agx-mission__confirm', ok && 'is-on')}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /><span>{sentence}</span></label>}
      primary={<LCButton variant="primary" icon="play" disabled={!ok} onClick={() => controlRun(snap.record.runId, 'confirm')}>Start replay</LCButton>} />
  )
}

function Mission({ spec, primary, secondary, confirm, extra, moreProperties = 0 }: { spec: MissionSpec; primary: ReactNode; secondary?: ReactNode; confirm?: ReactNode; extra?: ReactNode; moreProperties?: number }) {
  const reduced = useLcReducedMotion()
  const item = (i: number) => (reduced ? {} : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.22, delay: 0.04 * i, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } })
  return (
    <section className={cx('agx-mission', `is-${spec.mode}`)} aria-label="Mission preflight">
      <motion.header className="agx-mission__head" {...item(0)}>
        <div className="agx-mission__eyebrow"><span className="agx-eyebrow">Preflight · nothing runs until you launch</span><ProvenanceBadge mode={spec.mode} /></div>
        <h3>{RESEARCH_DEPTH_LABELS[spec.depth]} <span>· {spec.title}</span></h3>
        {spec.scopeSentence ? <p className="agx-mission__scope">{spec.scopeSentence}</p> : null}
        {spec.origin ? <p>From {spec.origin}</p> : null}
      </motion.header>

      <motion.ol className="agx-mission__checks" aria-label="Preflight checks" {...item(1)}>
        {spec.checks.map((c) => (
          <li key={c.label} className={`is-${c.state}`}>
            <span className="agx-mission__ck" aria-hidden="true">{c.state === 'ok' ? <Icon name="check" size={11} /> : c.state === 'wait' ? <i /> : <Icon name="slash" size={11} />}</span>
            <b>{c.label}</b><span>{c.detail}</span>
          </li>
        ))}
      </motion.ol>

      <div className="agx-mission__grid">
        <motion.section className="agx-mission__block is-props" {...item(1)}>
          <h5><Icon name="home" size={12} />Exact properties <small>{spec.properties.length + moreProperties}</small></h5>
          <ul className="agx-mission__props">
            {spec.properties.map((p) => <li key={p.id}><b>{p.address}</b>{p.sub ? <small>{p.sub}</small> : null}</li>)}
            {moreProperties > 0 ? <li className="agx-muted">+ {moreProperties} more</li> : null}
          </ul>
        </motion.section>

        <motion.section className="agx-mission__block is-tier" {...item(2)}>
          <h5><Icon name="layers" size={12} />Tier</h5>
          <div className="agx-tiers" role="radiogroup" aria-label="Research tier">
            {TIERS.map((t) => {
              const selected = t.depth === spec.depth
              const disabled = spec.mode === 'live' ? t.depth !== 'quick' : !selected
              return (
                <div key={t.depth} role="radio" aria-checked={selected} aria-disabled={disabled} className={cx('agx-tier', selected && 'is-on', disabled && 'is-off')}>
                  <span className="agx-tier__t"><b>{RESEARCH_DEPTH_LABELS[t.depth]}</b><span>{t.cap}</span></span>
                  <small>{t.what}</small>
                  {spec.mode === 'live' && t.depth !== 'quick' ? <em>Paid · disabled in S3</em> : null}
                </div>
              )
            })}
          </div>
        </motion.section>

        <motion.section className="agx-mission__block is-tools" {...item(3)}>
          <h5><Icon name="database" size={12} />Tools & sources it may touch</h5>
          {spec.tools.length ? (
            <ul className="agx-mission__tools">
              {spec.tools.map((t) => <li key={t.name}><code>{t.name}</code><span>{t.label}</span><b className="agx-tier-pill">{t.tier}</b></li>)}
            </ul>
          ) : spec.mode === 'live' ? <p className="agx-muted">The server did not list its tools; the run reports each one as it is called.</p> : null}
          {spec.sources.length ? (
            <ul className="agx-mission__srcs">
              {spec.sources.slice(0, 10).map((s) => { const cls = sourceClass(s); return <li key={s.source_id}><Favicon source={s} size={16} /><span>{s.name}</span>{cls ? <ClassTag cls={cls} compact /> : <small>{authorityLabel(s)}</small>}</li> })}
              {spec.sources.length > 10 ? <li className="agx-muted">+ {spec.sources.length - 10} more</li> : null}
            </ul>
          ) : spec.mode === 'live' ? <p className="agx-muted">Sources are declared by the server per run.</p> : null}
        </motion.section>

        <motion.section className="agx-mission__block is-budget" {...item(4)}>
          <h5><Icon name="dollar-sign" size={12} />Maximum budget</h5>
          <p className="agx-mission__big">{spec.budget.cap === 0 ? '$0.00' : fmtUsd(spec.budget.cap)}</p>
          <p className="agx-muted">{spec.budget.note}</p>
          {spec.estimate ? <p className="agx-muted">Estimate {fmtUsd(spec.estimate.low_usd)}–{fmtUsd(spec.estimate.high_usd)} · {spec.estimate.basis === 'worst_case' ? `worst case ${fmtUsd(spec.estimate.worst_case_usd)}` : 'measured p50–p90'} — an estimate, not a charge.</p> : null}
        </motion.section>

        <motion.section className="agx-mission__block is-approvals" {...item(5)}>
          <h5><Icon name="shield" size={12} />Approvals</h5>
          <p>{spec.approvals}</p>
        </motion.section>

        <motion.section className="agx-mission__block is-cancel" {...item(6)}>
          <h5><Icon name="x" size={12} />If you cancel</h5>
          <ul className="agx-mission__list">{spec.cancellation.map((c) => <li key={c}>{c}</li>)}</ul>
          {spec.limits?.length ? <p className="agx-muted">Limits: {spec.limits.join(' · ')}</p> : null}
        </motion.section>
      </div>

      <motion.footer className="agx-mission__foot" {...item(8)}>
        {confirm}
        <div className="agx-mission__acts">{extra}{secondary}{primary}</div>
      </motion.footer>
    </section>
  )
}
