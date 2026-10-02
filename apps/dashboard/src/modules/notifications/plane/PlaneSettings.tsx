/**
 * NOTIFICATION CENTER 2.0 — Alerts & Signals, inside the plane.
 *
 * The plane's settings control used to send the operator to the legacy
 * Notifications panel. It now turns the same glass plane to its settings face:
 *   Rules     Signal Center rules — what each watches, armed or not (arm/disarm
 *             goes through the canonical /api/cockpit/signals/rules write, with
 *             the same LCConfirm effects as before)
 *   Watching  what the operator watches (the list the Inspector "Watch" writes)
 *   Alerts    in-app alert switches (the same AlertSettings the phone uses)
 * Fired signals are not listed here: they ARE stories, in Needs you / Now /
 * System. Nothing here decides a condition; it renders the server's model.
 */
import { LCEmpty, LCError, LCIconButton, LCSegmented, LCSkeleton, LCStatus } from '../../../shared/lc'
import { AlertSettings } from '../AlertSettings'
import { Rules, Watches } from '../signals/SignalsPanel'
import { useSignalCenter } from '../signals/useSignalCenter'
import type { SettingsFace } from './settings-face'
import { evaluatorState } from '../signals/signals-model'
import '../signals/signals-panel.css'

export function PlaneSettings({ face, onFace, focusRule, onBack }: { face: SettingsFace; onFace: (f: SettingsFace) => void; focusRule: string | null; onBack: () => void }) {
  const { status, model, error, refresh } = useSignalCenter()
  const ev = model ? evaluatorState(model) : null
  return (
    <div className="ncp-set">
      <header className="ncp__head ncp-set__head">
        <div className="ncp-set__title">
          <LCIconButton icon="chevron-left" label="Back to notifications" size="sm" onClick={onBack} />
          <div className="ncp__titles">
            <h2>Alerts &amp; Signals</h2>
            <p>{ev ? <>{ev.label}{model ? <> · {model.counts.armed_rules} of {model.rules.length} rules armed</> : null}</> : status === 'error' ? 'Signals unavailable' : 'Reading…'}</p>
          </div>
        </div>
      </header>
      <div className="ncp__lenses">
        <LCSegmented<SettingsFace>
          label="Settings"
          size="sm"
          value={face}
          onChange={onFace}
          options={[
            { value: 'rules', label: 'Signal rules' },
            { value: 'watching', label: 'Watching' },
            { value: 'alerts', label: 'Alerts' },
          ]}
        />
      </div>
      <div className="ncp__scroll ncp-set__body">
        {face === 'alerts' ? (
          <div className="ncp-set__alerts"><AlertSettings /></div>
        ) : !model ? (
          <div className="ncp__pad">
            {status === 'error' ? <LCError what="Signals didn’t load" detail={error ?? undefined} onRetry={refresh} /> : <LCSkeleton shape="rows" count={4} label="Loading signal rules" />}
          </div>
        ) : (
          <div className="lcsig ncp-set__sig">
            {ev ? (
              <div className="ncp-set__state">
                <LCStatus label={ev.label} tone={ev.tone} />
                <span>{ev.detail}</span>
              </div>
            ) : null}
            {face === 'rules'
              ? (model.rules.length ? <Rules model={model} onChanged={refresh} focusRule={focusRule} /> : <LCEmpty compact icon="radar" title="No signal rules" body="Signal Center has no rules defined." />)
              : <Watches model={model} onChanged={refresh} />}
            <p className="ncp-set__note">Fired signals appear as stories — Needs you, Now or System — never as a second list.</p>
          </div>
        )}
      </div>
    </div>
  )
}
