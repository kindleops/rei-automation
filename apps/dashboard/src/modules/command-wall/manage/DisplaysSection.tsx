/**
 * Settings → Displays (§7, §37, §39, §72): pair a TV, see it live, change what
 * it shows, send a view to it, regenerate its pairing, revoke it. Every action
 * here is display configuration — none reaches sends, campaigns, routing,
 * queue or Signal state.
 */
import { useCallback, useEffect, useState } from 'react'
import { LCButton, LCConfirm, LCEmpty, LCSegmented, LCSelect, LCStatus, LCSwitch } from '../../../shared/lc'
import { claimDisplay, listDisplays, regeneratePairing, revokeDisplay, sendView, updateDisplay, type ApiFail, type ManagedDisplay } from './displays-api'
import { WALL_PRESETS, WALL_PRESET_IDS } from '../wall-presets'
import type { WallDisplayConfig, WallOledLevel, WallPresetId, WallPrivacyMode, WallThemeId } from '../wall-types'
import './displays.css'

const PRESET_OPTIONS = WALL_PRESET_IDS.map((id) => ({ value: id, label: WALL_PRESETS[id].label }))
const THEME_OPTIONS: { value: WallThemeId; label: string }[] = [{ value: 'dark', label: 'Dark' }, { value: 'true_black', label: 'True Black' }, { value: 'light', label: 'Light' }, { value: 'red_ops', label: 'Red Ops' }]
const PRIVACY_OPTIONS: { value: WallPrivacyMode; label: string; hint: string }[] = [
  { value: 'operations', label: 'Operations', hint: 'Campaign names, ZIP-level geography, amounts' },
  { value: 'privacy', label: 'Privacy', hint: 'Geography and aggregates only (default)' },
  { value: 'public_safe', label: 'Public-safe', hint: 'Market-level only' },
]
const OLED_OPTIONS: { value: WallOledLevel; label: string }[] = [{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]
const DEFAULT_ROTATION = [{ preset: 'national_command' as const, minutes: 4 }, { preset: 'acquisition_pulse' as const, minutes: 3 }, { preset: 'market_intelligence' as const, minutes: 3 }, { preset: 'campaign_operations' as const, minutes: 2 }]
const MARKET_ID = /^[a-z0-9][a-z0-9-]{1,62}$/

const isFail = (x: unknown): x is ApiFail => Boolean(x && typeof x === 'object' && (x as { ok?: unknown }).ok === false)

function age(iso: string | null, now: number) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function connectionStatus(d: ManagedDisplay) {
  switch (d.connection) {
    case 'online': return <LCStatus label="Online" tone="ok" />
    case 'degraded': return <LCStatus state="degraded" />
    case 'offline': return <LCStatus label="Offline" tone="neutral" />
    case 'revoked': return <LCStatus label="Revoked" tone="neutral" hollow />
    case 'awaiting_handoff': return <LCStatus label="Waiting for the TV" tone="exec" quiet />
    case 'pairing_required': return <LCStatus label="Needs pairing" tone="attn" />
    default: return <LCStatus label="Unknown" tone="neutral" />
  }
}

export function DisplaysSection() {
  const [displays, setDisplays] = useState<ManagedDisplay[] | null>(null)
  const [problem, setProblem] = useState<ApiFail | null>(null)
  const [adding, setAdding] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = async () => {
      const r = await listDisplays(ctrl.signal)
      if (ctrl.signal.aborted) return
      setNow(Date.now())
      if (isFail(r)) setProblem(r)
      else { setProblem(null); setDisplays(r.displays) }
      // registry view refresh: one small indexed read every 30 s while this section is open
      timer = setTimeout(load, 30_000)
    }
    void load()
    return () => { ctrl.abort(); if (timer) clearTimeout(timer) }
  }, [reload])

  const refresh = useCallback(() => setReload((n) => n + 1), [])
  const replace = useCallback((d: ManagedDisplay) => setDisplays((list) => (list ? list.map((x) => (x.id === d.id ? d : x)) : [d])), [])

  if (problem && !displays) {
    return (
      <section className="cwm">
        <LCEmpty title={problem.code === 'display_registry_unprovisioned' ? 'Command Wall isn’t enabled yet' : 'Displays unavailable'} body={problem.message} icon="radar" action={{ label: 'Try again', onClick: refresh }} />
      </section>
    )
  }

  const live = (displays || []).filter((d) => d.status !== 'revoked')
  const revoked = (displays || []).filter((d) => d.status === 'revoked')
  return (
    <section className="cwm">
      <div className="cwm__intro">
        <div>
          <small>A read-only operations display for a TV. Open <code>/wall</code> on the TV, then pair it here with the code it shows. A display can never send, launch, route or change anything.</small>
        </div>
        {!adding ? <LCButton variant="primary" icon="plus" onClick={() => setAdding(true)}>Add display</LCButton> : null}
      </div>
      {adding ? <PairForm repairable={live.filter((d) => d.status === 'pairing_required')} onDone={(d) => { setAdding(false); if (d) setDisplays((list) => [...(list || []).filter((x) => x.id !== d.id), d]) }} /> : null}
      {displays === null ? <div className="cwm__loading">Loading displays…</div> : null}
      {displays && !live.length && !adding ? <LCEmpty title="No displays yet" body="Open /wall on a TV browser and add it with the code on screen." icon="radar" compact /> : null}
      {live.map((d) => <DisplayCard key={d.id} display={d} now={now} onChange={replace} onRemoved={refresh} />)}
      {revoked.length ? <div className="cwm__revoked">{revoked.length} revoked display{revoked.length === 1 ? '' : 's'} kept in the audit trail.</div> : null}
    </section>
  )
}

function PairForm({ onDone, repairable }: { onDone: (d: ManagedDisplay | null) => void; repairable: ManagedDisplay[] }) {
  const [target, setTarget] = useState<string>('new')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<WallPresetId>('national_command')
  const [theme, setTheme] = useState<WallThemeId>('dark')
  const [privacy, setPrivacy] = useState<WallPrivacyMode>('privacy')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = /^[A-Za-z]{4}-?[2-9]{4}$/.test(code.trim()) && (target !== 'new' || name.trim().length > 0)
  const submit = async () => {
    setBusy(true); setError(null)
    const r = await claimDisplay({ code: code.trim(), name: name.trim(), preset, theme, privacy_mode: privacy, ...(target !== 'new' ? { display_id: target } : {}) })
    setBusy(false)
    if (isFail(r)) { setError(r.message); return }
    onDone(r.display)
  }
  return (
    <div className="cwm-card cwm-card--form">
      <div className="cwm-card__title">Pair a display</div>
      <div className="cwm-grid">
        <label className="cwm-field"><span>Code on the TV</span><input className="st-input cwm-code" value={code} maxLength={9} placeholder="ABCD-2345" autoFocus onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
        {repairable.length ? <div className="cwm-field"><span>Pair as</span><LCSelect value={target} onChange={setTarget} options={[{ value: 'new', label: 'New display' }, ...repairable.map((d) => ({ value: d.id, label: `Re-pair ${d.name}` }))]} label="Pair as" /></div> : null}
        <label className="cwm-field"><span>Name</span><input className="st-input" value={name} maxLength={48} placeholder="Living Room TV" onChange={(e) => setName(e.target.value)} /></label>
        <div className="cwm-field"><span>Preset</span><LCSelect value={preset} onChange={setPreset} options={PRESET_OPTIONS} label="Preset" /></div>
        <div className="cwm-field"><span>Theme</span><LCSelect value={theme} onChange={setTheme} options={THEME_OPTIONS} label="Theme" /></div>
        <div className="cwm-field"><span>Privacy</span><LCSelect value={privacy} onChange={setPrivacy} options={PRIVACY_OPTIONS} label="Privacy" /></div>
      </div>
      {error ? <div className="cwm-error" role="alert">{error}</div> : null}
      <div className="cwm-actions">
        <LCButton variant="quiet" onClick={() => onDone(null)}>Cancel</LCButton>
        <LCButton variant="primary" disabled={!valid} loading={busy} onClick={() => { void submit() }}>Pair display</LCButton>
      </div>
    </div>
  )
}

function DisplayCard({ display: d, now, onChange, onRemoved }: { display: ManagedDisplay; now: number; onChange: (d: ManagedDisplay) => void; onRemoved: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'revoke' | 'repair' | null>(null)
  const [viewPreset, setViewPreset] = useState<WallPresetId>('market_intelligence')
  const [viewMarket, setViewMarket] = useState('')
  const [markets, setMarkets] = useState(d.config.watched_markets.join(', '))
  const cfg = d.config

  const patch = async (p: Partial<WallDisplayConfig> & { name?: string }) => {
    setError(null)
    const r = await updateDisplay(d.id, p)
    if (isFail(r)) setError(r.message)
    else onChange(r.display)
  }
  const c = d.client
  const facts = [
    c.browser, c.width && c.height ? `${c.width}×${c.height}${c.dpr && c.dpr !== 1 ? ` @${c.dpr}x` : ''}` : null, c.render_mode ? c.render_mode.toUpperCase() : null,
    c.build ? `build ${c.build}` : null, c.uptime_s !== null && c.uptime_s !== undefined ? `up ${Math.round(c.uptime_s / 3600)} h` : null,
    c.reconnects ? `${c.reconnects} reconnects` : null,
  ].filter(Boolean)
  const marketsValid = markets.split(',').map((s) => s.trim()).filter(Boolean).every((m) => MARKET_ID.test(m))
  return (
    <div className="cwm-card" data-connection={d.connection}>
      <div className="cwm-card__head">
        <div>
          <div className="cwm-card__title">{d.name}</div>
          <div className="cwm-card__spec">
            {[WALL_PRESETS[cfg.preset]?.label, THEME_OPTIONS.find((t) => t.value === cfg.theme)?.label, PRIVACY_OPTIONS.find((p) => p.value === cfg.privacy_mode)?.label, cfg.rotation.enabled ? 'Rotation on' : null, `last seen ${age(d.last_seen_at, now)}`].filter(Boolean).join(' · ')}
          </div>
          {facts.length ? <div className="cwm-card__facts">{facts.join(' · ')}</div> : null}
        </div>
        {connectionStatus(d)}
      </div>

      <div className="cwm-grid">
        <div className="cwm-field"><span>Preset</span><LCSelect value={cfg.preset} onChange={(v) => { void patch({ preset: v }) }} options={PRESET_OPTIONS} label="Preset" /></div>
        <div className="cwm-field"><span>Theme</span><LCSelect value={cfg.theme} onChange={(v) => { void patch({ theme: v }) }} options={THEME_OPTIONS} label="Theme" /></div>
        <div className="cwm-field"><span>Privacy</span><LCSelect value={cfg.privacy_mode} onChange={(v) => { void patch({ privacy_mode: v }) }} options={PRIVACY_OPTIONS} label="Privacy" /></div>
        <div className="cwm-field"><span>OLED protection</span><LCSegmented value={cfg.oled_protection} onChange={(v) => { void patch({ oled_protection: v }) }} options={OLED_OPTIONS} label="OLED protection" size="sm" /></div>
        <div className="cwm-field cwm-field--switches">
          <LCSwitch checked={cfg.rotation.enabled} onCheckedChange={(on) => { void patch({ rotation: { enabled: on, steps: cfg.rotation.steps.length > 1 ? cfg.rotation.steps : DEFAULT_ROTATION } }) }} label="Auto rotation" hint="National 4m → Pulse 3m → MI 3m → Campaign Ops 2m" size="sm" />
          <LCSwitch checked={cfg.show_feed} onCheckedChange={(on) => { void patch({ show_feed: on }) }} label="Activity feed" size="sm" />
          <LCSwitch checked={cfg.overnight_low_light} onCheckedChange={(on) => { void patch({ overnight_low_light: on }) }} label="Overnight low light" hint="Dims 11 PM – 6 AM" size="sm" />
        </div>
        <label className="cwm-field cwm-field--wide"><span>Watched markets</span>
          <span className="cwm-inline">
            <input className="st-input" value={markets} placeholder="dallas-tx, houston-tx" onChange={(e) => setMarkets(e.target.value)} />
            <LCButton size="sm" disabled={!marketsValid || markets === cfg.watched_markets.join(', ')} onClick={() => { void patch({ watched_markets: markets.split(',').map((s) => s.trim()).filter(Boolean) }) }}>Save markets</LCButton>
          </span>
        </label>
      </div>

      <div className="cwm-send">
        <span className="cwm-send__k">Send to this wall</span>
        <LCSelect value={viewPreset} onChange={setViewPreset} options={PRESET_OPTIONS.filter((o) => o.value !== 'custom')} label="View" size="sm" />
        <input className="st-input cwm-send__market" value={viewMarket} placeholder="market (optional)" onChange={(e) => setViewMarket(e.target.value.trim().toLowerCase())} />
        <LCButton size="sm" disabled={Boolean(viewMarket) && !MARKET_ID.test(viewMarket)} onClick={() => { void sendView(d.id, { preset: viewPreset, market: viewMarket || null, hold_minutes: 30 }).then((r) => { if (isFail(r)) setError(r.message); else onChange(r.display) }) }}>Show for 30 min</LCButton>
        {d.view_command ? <span className="cwm-send__now">Showing {WALL_PRESETS[d.view_command.preset || cfg.preset]?.label}{d.view_command.market ? ` · ${d.view_command.market}` : ''} until {new Date(d.view_command.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span> : null}
      </div>

      {error ? <div className="cwm-error" role="alert">{error}</div> : null}
      <div className="cwm-actions">
        <LCButton variant="quiet" onClick={() => setConfirm('repair')}>Regenerate pairing</LCButton>
        <LCButton variant="danger" onClick={() => setConfirm('revoke')}>Revoke</LCButton>
      </div>

      <LCConfirm
        open={confirm === 'revoke'}
        onOpenChange={(o) => { if (!o) setConfirm(null) }}
        title={`Revoke ${d.name}?`}
        effects={[{ text: 'Its credential stops working immediately and the TV returns to its pairing screen.', kind: 'stops' }, { text: 'Its history stays in the audit trail.', kind: 'keeps' }]}
        confirmLabel="Revoke display"
        tone="danger"
        onConfirm={async () => { const r = await revokeDisplay(d.id); if (isFail(r)) throw new Error(r.message); onRemoved() }}
      />
      <LCConfirm
        open={confirm === 'repair'}
        onOpenChange={(o) => { if (!o) setConfirm(null) }}
        title={`Regenerate pairing for ${d.name}?`}
        effects={[{ text: 'The current credential stops working now; the TV shows a new code.', kind: 'stops' }, { text: 'Enter the new code with Add display to re-pair this same display.', kind: 'note' }]}
        confirmLabel="Regenerate pairing"
        onConfirm={async () => { const r = await regeneratePairing(d.id); if (isFail(r)) throw new Error(r.message); onChange(r.display) }}
      />
    </div>
  )
}
