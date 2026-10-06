# Command Wall V1 — Architecture, security, operations

Companion to `AUDIT.md`. Code: `apps/api/src/lib/domain/command-wall/`, `apps/api/src/app/api/wall/*`,
`apps/api/src/app/api/cockpit/wall/*`, `apps/dashboard/src/modules/command-wall/`.

## Client
- `/wall` and `/wall/diagnostics` mount from `main.tsx` **before** the operator `App`, so there is no AuthProvider,
  no RequireAuth, no desktop or mobile shell, and no operator session. The wall code is a lazy chunk (~52 KB plus
  the MapLibre vendor chunk).
- **One channel per page** (`wall-channel.ts`). Every widget reads from it.
  - Cadence: events every 15 s, state every 30 s, heartbeat every 60 s.
  - That is about 7 requests/min per display, and zero while the page is hidden.
  - On `visibilitychange`, `online` or `pageshow` it catches up immediately.
- **Render modes** (`render-mode.ts`) are chosen by a pure capability probe; `?render=` forces one.
  - FULL: the WebGL map with blur glass.
  - LITE: the WebGL map without blur, pixel ratio capped at 1 on 4K, at most 3 pulses at a time, no fades.
  - SAFE: an SVG atlas of the shipped `/geo/us-states.json`.
  - If WebGL context is lost or the style takes more than 25 s, the wall switches to SAFE for 10 minutes and then retries. The screen is never blank.
- **Map.** The wall uses the Map engine's style system (`commandMapThemes`, `map-basemap-paint`) and the owned `nx-*`
  layer contract, plus the desktop camera/crime/presence context layers. All of it is read-only: no handlers and no clicks.

## Pairing and display authentication
1. **TV.** `POST /api/wall/pair {action:'start'}` returns:
   - an 8-character code (`ABCD-2345`, with no I/O/0/1), valid for 10 minutes;
   - a pairing id;
   - a poll secret, held only in the tab's sessionStorage.
2. **Operator.** Settings → Displays sends `POST /api/cockpit/wall/displays {code,…}`.
   - This is a cockpit route, so it goes through the Worker's session gate and the operator allowlist.
   - The pairing moves `pending → claimed` with a compare-and-set, and a display row is created.
3. **TV.** `POST /api/wall/pair {action:'poll'}` consumes the claim with a compare-and-set (`claimed → consumed`) and mints the display token **once**.
   - Concurrent polls cannot both succeed; there is a test for this.
4. **Limits.**
   - Pairing starts: 6 per client per 10 min, and 60 globally.
   - Pending pairings: at most 20.
   - Polls: 40/min per pairing.
   - Claims: 10 per operator per 10 min, plus 30 failed claims globally per 10 min.
   - The code space is 24⁴·8⁴ ≈ 1.36 × 10⁹.

**The token** is `lcw_` followed by 256 random bits.
- **Storage.** Only `HMAC-SHA256(COMMAND_WALL_TOKEN_PEPPER, token)` is stored (plain SHA-256 if no pepper is set). The raw token, the pairing code and the poll secret are never stored.
- **Lifetime.**
  - It expires after 180 days.
  - The heartbeat rotates it after 30 days, and the previous hash stays valid for 10 more minutes so in-flight requests don't fail.
  - Revoking clears the hash. That takes effect immediately in the same process, and within 30 s (the authenticator cache) in any other process.
  - "Regenerate pairing" kills the token and the TV shows a new code. The operator can re-pair the same display.

**Token storage tradeoff (§8).** The default is an `HttpOnly; SameSite=Strict; Path=/api/wall; Secure` cookie.
- Script on the page can't read it, so an XSS can't exfiltrate it.
- The browser never sends it to any other API path.
- **Fallback for TVs that drop cookies:** when `navigator.cookieEnabled === false`, the poll asks for `delivery:'bearer'`. The token is then stored in localStorage and sent as `x-lc-display-token`.
  - Any script on this origin can read it there.
  - That is acceptable only because the token is read-only, scoped to the wall, revocable and rotating, and the middleware refuses it everywhere else. It would never be acceptable for an operator credential.

**Read-only enforcement (§5, §58)** is three independent layers, all on the server:
1. **Worker.** A display token is not a Supabase JWT, so `/auth/v1/user` rejects it and every cockpit, intel or internal-dashboard route returns 401.
2. **Container gate.** It is not the dashboard secret, so `requireOpsDashboardAuth` returns 401. A test calls real handlers to prove this.
3. **API middleware (new, tightening only).**
   - Any request that carries a display credential gets **403** on every `/api/*` path outside `/api/wall/*`.
   - "Carries" covers six carriers: the cookie, the header, a Bearer token, or the token smuggled inside `x-ops-dashboard-secret`, `x-internal-api-secret`, and so on.
   - The matcher was widened to `/api/:path*`. CORS behaviour is unchanged.
   - The test enumerates all 232 mutation route files from disk on every run.

The wall namespace itself exposes only two writes:
- `pair`;
- `heartbeat`, which updates `last_seen` at most once a minute, plus build changes and rotation.

It imports no send, queue, routing, campaign, Signal or settings code; a test asserts that.

## Realtime projection and aggregation (§24, §25, §64)
- **One shared tick per process**, single-flight, at most every 15 s, whether one display is polling or many. Each tick reads:
  - `notification_story_inputs` since the cursor (indexed on `occurred_at`; a 10-minute overlap absorbs projector lag, and dedupe handles the overlap);
  - `send_queue` rows sent since the cursor (indexed on `sent_at`; 4 columns);
  - geography, only for property ids it hasn't seen.
- The tick folds these into a bounded log: 6 h and at most 1,500 events, each with a monotonic `seq` and a process `epoch`.
- Clients poll `after=<seq>`. If the epoch changed (restart or deploy), the server resends the window.
- **Classification.** High-value events stay individual: P1 is reply, interest, asking price, offer, counter, deal. Bulk sends become per-market 2-minute aggregates (P3). Opt-outs become per-market 10-minute aggregates.
- **Signals.** Only notifications of type `signal_*` reach the wall. Inbox notifications carry phone numbers in their titles.
- **Source text never crosses.** Wall events use a closed vocabulary. No summary, title, preview, seller label, address, phone or deep link is ever copied from a source row.
- **The shared snapshot** is rebuilt at most every 30 s for all displays. It reads:
  - the ops metrics RPC;
  - the queue health RPC, with no 14-query fallback;
  - fleet;
  - campaigns;
  - open signals, collapsed to one line per rule;
  - the count of today's offers.

  MI is cached for 5 min. Context layers use viewports snapped to 0.1° and are cached for 10 min.
- **Failure honesty.** A part that couldn't be read is `unavailable`, never 0. A part that failed after an earlier success is `stale`, with its last value and its age.

## Privacy modes (§15, §43, §65)
`projectEvent` / `projectSnapshot` run per display, on the way out.

| Mode | What the display shows |
|---|---|
| OPERATIONS | Campaign names; property position rounded to about 100 m |
| PRIVACY (default) | ZIP centroid (or a ~2 km grid); market and ZIP; no names or amounts |
| PUBLIC-SAFE | Market centroid only; no ZIP; no campaign names or counts; signal shown only as "System attention"; no crime layer |

## Recovery (§28–§31)
- **The ladder.** Repeated failures escalate in this order:

  | Consecutive failures | Action |
  |---|---|
  | 1–3 | Retry, backing off 2 → 4 → 8 s |
  | 4–6 | Reconnect, backing off 16 → 30 s |
  | 7 | Refresh all data |
  | 10 | Soft reload (remount; at most 1 per 10 min) |
  | 16 | Full reload (at most 1 per 30 min and 3 per day) |

  - The full-reload budget is persisted in localStorage, so it survives the reload it causes.
  - While the browser reports offline, the ladder only ever retries.
  - The backoff resets only after 60 s of continuous health.
- **Credential failures.** A 401 `display_*` stops the channel and shows the pairing screen; there is no retry storm. A 429 honours `retry_after_ms`.
- **Version updates.** These reuse the build-freshness poll (`subscribeFreshnessNotice`). The wall reloads only at a quiet moment (no P0/P1 event for 2 min) and within the full-reload budget, behind "Updating Command Wall…".
- **Offline.** The last view stays on screen with "Offline · Reconnecting… · last update 4:03 AM" over it. There is no error page.

## OLED (§32)
| Element | Behaviour |
|---|---|
| Surface drift | Lissajous path at ±3 px (Low) or ±6 px (High), periods 11 and 17 min, moving under 0.08 px/s |
| Rail | Steps ±4 px (Low) or ±8 px (High) every 20 min |
| Map | Drifts up to 6 px (Low) or 12 px (High) over a 37-min cycle |
| Layout | The feed and panel swap sides every 2 h |
| Idle dimming | After 45 min with no P0–P2 activity: 0.88 (Low) or 0.78 (High) |
| Overnight low light | Optional, 23:00–06:00, at 0.62 |
| Logo | Never fixed white: an accent mark at 32–50 % opacity that drifts with the surface |

All transforms are 20 s compositor transitions. Measured in the captures (High): surface x moved between +5.3 and −4.6 px, the rail by −8 px, and the map by up to 11 px.

## TV input (§51, §52)
Enter/OK opens a small menu with Preset, Theme, Rotation pause, Feed and "Use display settings". Arrows and Tab move; Esc or Back closes. There is no hover anywhere and the cursor is hidden.

TV-local choices last until the operator changes the configuration from the desktop.

## HDMI fallback device (§54), with no hardware chosen
The device needs:
- a current Chromium or WebKit browser with hardware WebGL2 (diagnostics should report FULL or LITE);
- HDMI 2.0 for 4K60;
- a kiosk or fullscreen mode;
- auto-launch to `https://ops.leadcommand.ai/wall`;
- wake-on-power (HDMI-CEC);
- the OS screensaver and sleep disabled;
- persistent cookies, or the Bearer fallback.

The software behaves the same whether it runs on the TV's browser or on this device.

## PROPOSED database (not applied)
`supabase/migrations/PROPOSED_20261006150000_command_wall_displays.sql` (with a rollback file) creates:
- `command_wall_displays`, holding the hash only, with check constraints on hash shape and "revoked ⇒ no hash";
- `command_wall_pairings`;
- `command_wall_audit`.

All three have RLS on and anon/authenticated access revoked. Until the migration is applied, the registry routes return **503** and fail closed. For local development, set `COMMAND_WALL_STORE=memory` (refused in production).

## Gaps (V1)
- **Transport.** Realtime is a 15 s cursor poll over a server tick, and the projector adds up to about 30 s. End-to-end latency is ≤ 45 s, not push. SSE was deferred: it is unverified through the Worker→Container path on TV browsers.
- **Not built:**
  - audio playback (the setting is stored, but no sounds are wired, per the agent rules);
  - QR code (it needs a dependency approval);
  - a "Send to Command Wall" entry in the desktop Map context menu (the API exists and Settings → Displays uses it);
  - a phone controller (the API is designed for one);
  - a dedicated `wall.leadcommand.ai`.
- **Bundle and service worker.**
  - The wall still loads the main entry bundle, because `App` is imported statically in `main.tsx`. A separate HTML entry would be lighter on TVs.
  - The service worker's `controllerchange` handler reloads immediately, which bypasses the quiet-moment rule.
- **Testing.** No smart-TV device has been tested (Tizen and webOS are covered by user-agent unit tests only). The real device model is needed.
