import { useMemo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { LCButton, LCConfirm, LCEmpty, LCError, LCFacts, LCSkeleton, LCStatus, LCTabs, cx } from '../../../shared/lc'
import { formatRelativeTime } from '../../../shared/formatters'
import { setWatched, useWatches } from '../../../lib/data/watchStore'
import type { WatchEntityType } from '../../../lib/data/watchlistData'
import { acknowledgeSignal, resolveSignal, setRuleArmed } from './signals-api'
import { useSignalCenter } from './useSignalCenter'
import {
  evaluatorState, evidenceFacts, ledgerEmpty, ruleSource, SEVERITY_LABEL, SEVERITY_TONE, SIGNAL_SORT, SUBJECT_LABEL,
  type SignalCenterModel, type SignalRow, type SignalRule,
} from './signals-model'
import './signals-panel.css'

/**
 * SIGNAL CENTER — the Signals lens of the Notifications app (desktop).
 *   Signals  the fired-signal ledger with its evidence (acknowledge / resolve)
 *   Watches  what the operator watches (the same list the Inspector "Watch" writes)
 *   Rules    the built-in v1 rules: what each reads, armed or not, what it retires
 * Everything renders the server's read model; nothing here decides a condition.
 */

type Lens = 'signals' | 'watches' | 'rules'

export function SignalsPanel() {
  const { status, model, error, at, refresh } = useSignalCenter()
  const [lens, setLens] = useState<Lens>('signals')

  if (!model) {
    return (
      <div className="lcsig">
        {status === 'error'
          ? <LCError what="Signals didn’t load" onRetry={refresh} detail={error ?? undefined} />
          : <LCSkeleton shape="rows" count={5} label="Loading signals" />}
      </div>
    )
  }

  const ev = evaluatorState(model)
  const signals = [...model.signals].sort(SIGNAL_SORT)
  return (
    <div className="lcsig" data-ready={model.tables_ready ? 'true' : 'false'}>
      <section className="lcsig-state" aria-label="Evaluator state">
        <div className="lcsig-state__row">
          <LCStatus label={ev.label} tone={ev.tone} />
          <span className="lcsig-state__counts lc-num">
            <b>{model.counts.armed_rules}</b> of {model.rules.length} rules armed · <b>{model.watches.count}</b> watched
          </span>
        </div>
        <p className="lcsig-state__detail">{ev.detail}</p>
      </section>

      {status === 'error' ? <LCError compact what="Signals didn’t refresh" staleSince={at} onRetry={refresh} /> : null}

      <LCTabs<Lens>
        label="Signal Center"
        className="lcsig-tabs"
        value={lens}
        onChange={setLens}
        items={[
          { id: 'signals', label: 'Signals', count: model.tables_ready ? model.counts.open : null },
          { id: 'watches', label: 'Watches', count: model.watches.count },
          { id: 'rules', label: 'Rules', count: model.rules.length },
        ]}
      />

      <div className="lcsig-body" role="tabpanel">
        {lens === 'signals' ? <Ledger model={model} signals={signals} onChanged={refresh} /> : null}
        {lens === 'watches' ? <Watches model={model} onChanged={refresh} /> : null}
        {lens === 'rules' ? <Rules model={model} onChanged={refresh} /> : null}
      </div>
    </div>
  )
}

/* ── ledger ─────────────────────────────────────────────────────────── */

function Ledger({ model, signals, onChanged }: { model: SignalCenterModel; signals: SignalRow[]; onChanged: () => void }) {
  if (!signals.length) {
    const e = ledgerEmpty(model)
    return <LCEmpty compact icon="radar" title={e.title} body={e.body} />
  }
  return (
    <ol className="lcsig-list" aria-label="Fired signals">
      {signals.map((s) => <SignalItem key={s.id} s={s} onChanged={onChanged} />)}
    </ol>
  )
}

function SignalItem({ s, onChanged }: { s: SignalRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<null | 'ack' | 'resolve'>(null)
  const [err, setErr] = useState<string | null>(null)
  const facts = useMemo(() => evidenceFacts(s), [s])
  const act = async (kind: 'ack' | 'resolve') => {
    setBusy(kind); setErr(null)
    try { await (kind === 'ack' ? acknowledgeSignal(s.id) : resolveSignal(s.id)); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    finally { setBusy(null) }
  }
  return (
    <li className={cx('lcsig-item', `is-${s.status}`)} data-tone={SEVERITY_TONE[s.severity]}>
      <button type="button" className="lcsig-item__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="lcsig-item__rail" aria-hidden="true" />
        <span className="lcsig-item__main">
          <span className="lcsig-item__title">{s.title}</span>
          {s.body ? <span className="lcsig-item__body">{s.body}</span> : null}
        </span>
        <span className="lcsig-item__meta">
          <time className="lc-num" dateTime={s.fired_at}>{formatRelativeTime(s.fired_at)}</time>
          <LCStatus label={s.status === 'new' ? SEVERITY_LABEL[s.severity] : s.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'} tone={s.status === 'resolved' ? 'neutral' : SEVERITY_TONE[s.severity]} quiet={s.status !== 'new'} />
        </span>
      </button>
      {open ? (
        <div className="lcsig-item__detail">
          {s.subject_type ? <p className="lcsig-item__subject">{SUBJECT_LABEL[s.subject_type] || s.subject_type}{s.subject_id ? <> · <span className="lc-num">{s.subject_id}</span></> : null}</p> : null}
          {facts.length ? <LCFacts rows={facts} /> : null}
          {s.resolved_at ? <p className="lcsig-item__note">Resolved {formatRelativeTime(s.resolved_at)}{s.resolve_reason === 'condition_cleared' ? ' — the condition cleared' : s.resolve_reason === 'operator' ? ' by an operator' : ''}.</p> : null}
          {err ? <p className="lcsig-item__err" role="alert">{err}</p> : null}
          <div className="lcsig-item__actions">
            {s.deep_link ? <LCButton size="sm" variant="secondary" icon="arrow-up-right" onClick={() => pushRoutePath(s.deep_link as string)}>Open evidence</LCButton> : null}
            {s.status === 'new' ? <LCButton size="sm" variant="ghost" loading={busy === 'ack'} onClick={() => void act('ack')}>Acknowledge</LCButton> : null}
            {s.status !== 'resolved' ? <LCButton size="sm" variant="ghost" loading={busy === 'resolve'} onClick={() => void act('resolve')}>Resolve</LCButton> : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

/* ── watches ────────────────────────────────────────────────────────── */

export function Watches({ model, onChanged }: { model: SignalCenterModel; onChanged: () => void }) {
  const store = useWatches()
  const [err, setErr] = useState<string | null>(null)
  const items = model.watches.items
  if (model.watches.error) return <LCError what="Watches didn’t load" onRetry={onChanged} />
  if (!items.length) {
    return <LCEmpty compact icon="eye" title="Nothing watched" body="Open a seller, property or campaign in the inspector and choose Watch. Watched activity becomes a signal once its rule is armed." />
  }
  const unwatch = async (type: string, id: string) => {
    setErr(null)
    try { await setWatched(type as WatchEntityType, id, false); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
  }
  return (
    <>
      {err ? <p className="lcsig-item__err" role="alert">{err}</p> : null}
      <ul className="lcsig-watch" aria-label="Watched subjects">
        {items.map((w) => {
          const pending = store.pending.has(`${w.entity_type}:${w.entity_id}`)
          return (
            <li key={w.id} className="lcsig-watch__row">
              <span className="lcsig-watch__type">{SUBJECT_LABEL[w.entity_type] || w.entity_type}</span>
              <span className="lcsig-watch__name">
                <b>{w.label || w.address || w.entity_id}</b>
                {w.label || w.address ? <span className="lc-num">{w.entity_id}</span> : null}
              </span>
              <time className="lcsig-watch__at lc-num" dateTime={w.created_at}>since {formatRelativeTime(w.created_at)}</time>
              {(['seller', 'property', 'campaign'] as string[]).includes(w.entity_type)
                ? <LCButton size="sm" variant="ghost" loading={pending} onClick={() => void unwatch(w.entity_type, w.entity_id)}>Unwatch</LCButton>
                : null}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/* ── rules ──────────────────────────────────────────────────────────── */

export function Rules({ model, onChanged, focusRule = null }: { model: SignalCenterModel; onChanged: () => void; focusRule?: string | null }) {
  const [confirm, setConfirm] = useState<SignalRule | null>(null)
  return (
    <>
      <ul className="lcsig-rules" aria-label="Signal rules">
        {model.rules.map((r) => (
          <li key={r.rule_key} className={cx('lcsig-rule', r.is_enabled && 'is-armed', focusRule === r.rule_key && 'is-focus')} data-rule={r.rule_key} ref={focusRule === r.rule_key ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
            <div className="lcsig-rule__head">
              <span className="lcsig-rule__name">{r.label}</span>
              <LCStatus label={r.is_enabled ? 'Armed' : 'Disarmed'} tone={r.is_enabled ? 'exec' : 'neutral'} quiet={!r.is_enabled} />
            </div>
            <p className="lcsig-rule__src">{ruleSource(r)}</p>
            <div className="lcsig-rule__foot">
              <span className="lcsig-rule__sev" data-tone={SEVERITY_TONE[r.severity]}>{SEVERITY_LABEL[r.severity]}</span>
              {r.firing.length ? <span className="lcsig-rule__firing lc-num">{r.firing.length} firing</span> : null}
              {r.replaces_legacy.length ? <span className="lcsig-rule__retires" title={r.replaces_legacy.join(', ')}>Retires {r.replaces_legacy.length} legacy check{r.replaces_legacy.length === 1 ? '' : 's'}</span> : null}
              {model.tables_ready && r.seeded
                ? <LCButton size="sm" variant={r.is_enabled ? 'ghost' : 'secondary'} className="lcsig-rule__arm" onClick={() => setConfirm(r)}>{r.is_enabled ? 'Disarm' : 'Arm'}</LCButton>
                : null}
            </div>
          </li>
        ))}
      </ul>
      {confirm ? (
        <LCConfirm
          open
          onOpenChange={(o) => { if (!o) setConfirm(null) }}
          title={confirm.is_enabled ? `Disarm “${confirm.label}”?` : `Arm “${confirm.label}”?`}
          confirmLabel={confirm.is_enabled ? 'Disarm rule' : 'Arm rule'}
          effects={confirm.is_enabled
            ? [{ text: 'The rule stops evaluating; open signals stay in the ledger.', kind: 'stops' }, ...(confirm.replaces_legacy.length ? [{ text: `Legacy checks it retired resume: ${confirm.replaces_legacy.join(', ')}.`, kind: 'note' as const }] : [])]
            : [
                { text: model.gate.live ? 'The evaluator starts checking this rule on its next run.' : 'The evaluator is off — nothing runs until it is switched on.', kind: 'note' },
                { text: 'Fired signals raise a notification here. Nothing is sent to sellers.', kind: 'keeps' },
                ...(confirm.replaces_legacy.length ? [{ text: `While armed and live it retires: ${confirm.replaces_legacy.join(', ')}.`, kind: 'stops' as const }] : []),
              ]}
          onConfirm={async () => { await setRuleArmed(confirm.rule_key, !confirm.is_enabled); setConfirm(null); onChanged() }}
        />
      ) : null}
    </>
  )
}
