/**
 * Scheduling core — Google Calendar over its REST API (no SDK dependency).
 *
 * Google is a connected calendar and a busy-time source. This client is only
 * ever called server-side; access tokens live in memory for one operation and
 * refresh tokens are decrypted only to mint them. Errors carry a stable `code`
 * and never the token or Google's raw response body.
 */

const OAUTH_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events', // create/move/remove our events; read event times for busy sync
  'https://www.googleapis.com/auth/calendar.freebusy', // authoritative busy check at booking time
];

export class GoogleCalendarError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function googleConfig(env = process.env) {
  const clientId = String(env.GOOGLE_CALENDAR_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CALENDAR_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.GOOGLE_CALENDAR_REDIRECT_URI || '').trim();
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret && redirectUri) };
}

export function createGoogleCalendarClient(deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const metrics = deps.metrics ?? (() => {});
  const cfg = googleConfig(env);

  async function call(label, url, init = {}) {
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 8000) });
    } catch (error) {
      metrics({ op: label, ms: Date.now() - started, ok: false, code: 'network' });
      throw new GoogleCalendarError('google_unreachable', 503);
    }
    metrics({ op: label, ms: Date.now() - started, ok: res.ok, status: res.status });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error === 'invalid_grant' ? 'google_invalid_grant'
        : res.status === 401 ? 'google_unauthorized'
          : res.status === 403 ? 'google_forbidden'
            : res.status === 404 ? 'google_not_found'
              : res.status === 410 ? 'google_gone'
                : res.status === 429 ? 'google_rate_limited'
                  : 'google_error';
      throw new GoogleCalendarError(reason, res.status);
    }
    return body;
  }

  const bearer = (accessToken, extra = {}) => ({ authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...extra });

  return {
    config: cfg,

    authorizationUrl({ state, codeChallenge, loginHint }) {
      const p = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
        include_granted_scopes: 'true', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
      });
      if (loginHint) p.set('login_hint', loginHint);
      return `${OAUTH_AUTHORIZE}?${p}`;
    },

    async exchangeCode({ code, codeVerifier }) {
      const body = await call('oauth_exchange', OAUTH_TOKEN, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, code_verifier: codeVerifier, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }),
      });
      let email = null;
      try {
        // Received directly from Google's token endpoint over TLS; only the email claim is used.
        email = JSON.parse(Buffer.from(String(body.id_token).split('.')[1], 'base64url').toString('utf8')).email ?? null;
      } catch { /* email is informational */ }
      return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, scopes: String(body.scope || '').split(' ').filter(Boolean), email };
    },

    async accessToken(refreshToken) {
      const body = await call('oauth_refresh', OAUTH_TOKEN, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' }),
      });
      return body.access_token;
    },

    async revoke(token) {
      await call('oauth_revoke', `${OAUTH_REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => null);
    },

    /** Busy intervals only — freeBusy never returns titles or attendees. */
    async freeBusy(accessToken, { calendarId = 'primary', timeMin, timeMax }) {
      const body = await call('freebusy', `${API}/freeBusy`, {
        method: 'POST', headers: bearer(accessToken),
        body: JSON.stringify({ timeMin, timeMax, items: [{ id: calendarId }] }),
      });
      const cal = body?.calendars?.[calendarId];
      if (cal?.errors?.length) throw new GoogleCalendarError('google_freebusy_unavailable', 502);
      return (cal?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
    },

    async insertEvent(accessToken, calendarId, event) {
      return call('event_insert', `${API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, { method: 'POST', headers: bearer(accessToken), body: JSON.stringify(event) });
    },
    async patchEvent(accessToken, calendarId, eventId, patch) {
      return call('event_patch', `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(patch) });
    },
    async deleteEvent(accessToken, calendarId, eventId) {
      try {
        await call('event_delete', `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE', headers: bearer(accessToken) });
      } catch (error) {
        if (error.code === 'google_gone' || error.code === 'google_not_found') return; // already gone
        throw error;
      }
    },

    /**
     * Incremental event sync. With a syncToken returns only changes; a 410
     * means the token expired and the caller must resync from scratch.
     * Only times, status, transparency and our own private marker are read.
     */
    async listEvents(accessToken, calendarId, { syncToken, timeMin, pageToken } = {}) {
      const p = new URLSearchParams({ singleEvents: 'true', maxResults: '250', fields: 'nextPageToken,nextSyncToken,items(id,status,transparency,start,end,extendedProperties/private)' });
      if (syncToken) p.set('syncToken', syncToken);
      else if (timeMin) p.set('timeMin', timeMin);
      if (pageToken) p.set('pageToken', pageToken);
      return call('events_list', `${API}/calendars/${encodeURIComponent(calendarId)}/events?${p}`, { headers: bearer(accessToken) });
    },

    async watch(accessToken, calendarId, { id, token, address, ttlSeconds = 604800 }) {
      return call('events_watch', `${API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
        method: 'POST', headers: bearer(accessToken),
        body: JSON.stringify({ id, type: 'web_hook', address, token, params: { ttl: String(ttlSeconds) } }),
      });
    },
    async stopChannel(accessToken, { id, resourceId }) {
      await call('channel_stop', `${API}/channels/stop`, { method: 'POST', headers: bearer(accessToken), body: JSON.stringify({ id, resourceId }) }).catch(() => null);
    },
  };
}
