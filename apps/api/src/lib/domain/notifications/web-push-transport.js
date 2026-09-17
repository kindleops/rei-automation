/**
 * WEB PUSH TRANSPORT — RFC 8291 / RFC 8292, through the reference implementation.
 *
 * There was no push path in this product at all: sw.js had no `push` listener, no
 * subscription store existed, and nothing ever called a push service. This module is
 * the whole server side of it.
 *
 * Two rules govern everything here, both from §5:
 *
 *   1. NEVER FAKE A SUCCESSFUL PUSH STATE. If VAPID is not configured, this module
 *      says so — `resolvePushConfig()` returns `configured: false` with the reason,
 *      the client surfaces that verbatim, and no code path pretends a subscription
 *      was created. Silence is not success.
 *   2. NO HARDCODED SECRETS. The keypair lives in VAPID_PUBLIC_KEY /
 *      VAPID_PRIVATE_KEY / VAPID_SUBJECT. The public key is public by design — it is
 *      handed to the browser — but the private key never leaves the server, which is
 *      why the config endpoint returns only the public half.
 *
 * Generating a keypair (once, then set the two env vars):
 *   node -e "console.log(require('web-push').generateVAPIDKeys())"
 */
import webpush from 'web-push'
import { supabase } from '@/lib/supabase/client.js'
import { child } from '@/lib/logging/logger.js'

const logger = child({ module: 'domain.notifications.web-push' })

export const PUSH_SUBSCRIPTION_TABLE = 'push_subscriptions'

let configuredOnce = false

/**
 * @returns {{ configured: boolean, publicKey: string|null, reason: string|null }}
 */
export function resolvePushConfig() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim()
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim()
  const subject = (process.env.VAPID_SUBJECT || '').trim()

  if (!publicKey || !privateKey) {
    return {
      configured: false,
      publicKey: null,
      reason: 'vapid_keys_not_configured',
    }
  }

  /**
   * A subject is REQUIRED by RFC 8292 — push services reject a JWT without one.
   * Defaulting it silently would produce subscriptions that look fine and then fail
   * at delivery time, which is the failure mode rule 1 exists to prevent.
   */
  if (!subject || !/^(mailto:|https:)/.test(subject)) {
    return {
      configured: false,
      publicKey: null,
      reason: 'vapid_subject_missing_or_invalid',
    }
  }

  if (!configuredOnce) {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    configuredOnce = true
  }

  return { configured: true, publicKey, reason: null }
}

function db() {
  return supabase
}

/**
 * Store (or refresh) a subscription. The endpoint IS the identity — the browser
 * reissues the same endpoint for the same registration, so this is an upsert rather
 * than an insert, and a re-subscribe after a permission toggle does not accumulate
 * duplicate rows that would each deliver the same alert.
 */
export async function savePushSubscription({ subscription, userKey, userAgent }) {
  const endpoint = subscription?.endpoint
  const p256dh = subscription?.keys?.p256dh
  const auth = subscription?.keys?.auth

  if (!endpoint || !p256dh || !auth) {
    return { ok: false, error: 'invalid_subscription' }
  }

  const row = {
    endpoint,
    p256dh,
    auth,
    user_key: userKey || null,
    user_agent: userAgent ? String(userAgent).slice(0, 400) : null,
    revoked_at: null,
    failure_count: 0,
    updated_at: new Date().toISOString(),
  }

  const { error } = await db()
    .from(PUSH_SUBSCRIPTION_TABLE)
    .upsert(row, { onConflict: 'endpoint' })

  if (error) {
    logger.warn('push.subscribe_failed', { error: error.message })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function removePushSubscription(endpoint) {
  if (!endpoint) return { ok: false, error: 'endpoint_required' }
  const { error } = await db()
    .from(PUSH_SUBSCRIPTION_TABLE)
    .delete()
    .eq('endpoint', endpoint)

  if (error) {
    logger.warn('push.unsubscribe_failed', { error: error.message })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * A 404 or 410 from a push service means the subscription is GONE — the browser was
 * uninstalled, the site data cleared, or the user revoked permission. Keeping it
 * would mean retrying a dead endpoint on every notification forever, so those are
 * deleted rather than counted.
 */
async function handleSendFailure(endpoint, statusCode) {
  if (statusCode === 404 || statusCode === 410) {
    await removePushSubscription(endpoint)
    return
  }
  await db()
    .from(PUSH_SUBSCRIPTION_TABLE)
    .update({ failure_count: 1, updated_at: new Date().toISOString() })
    .eq('endpoint', endpoint)
}

/**
 * Deliver one notification to every live subscription.
 *
 * Fire-and-forget by contract: the caller is the notification writer, and a push
 * service being slow or down must never fail or delay the write that produced the
 * in-app notification. The in-app centre is the source of truth; push is a courtesy
 * copy of it, which is also why the payload carries the notification id and the same
 * deep link the centre would use.
 */
export async function deliverPushNotification(payload) {
  const config = resolvePushConfig()
  if (!config.configured) {
    return { ok: false, skipped: true, reason: config.reason, sent: 0 }
  }

  const { data: subscriptions, error } = await db()
    .from(PUSH_SUBSCRIPTION_TABLE)
    .select('endpoint, p256dh, auth')
    .is('revoked_at', null)
    .limit(500)

  if (error) {
    logger.warn('push.subscription_read_failed', { error: error.message })
    return { ok: false, skipped: false, reason: error.message, sent: 0 }
  }
  if (!subscriptions?.length) {
    return { ok: true, skipped: true, reason: 'no_subscriptions', sent: 0 }
  }

  const body = JSON.stringify(payload)
  let sent = 0

  await Promise.all(subscriptions.map(async (row) => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { TTL: 3600, urgency: payload.severity === 'critical' ? 'high' : 'normal' },
      )
      sent += 1
    } catch (err) {
      await handleSendFailure(row.endpoint, err?.statusCode).catch(() => undefined)
      logger.warn('push.send_failed', { status: err?.statusCode ?? null })
    }
  }))

  return { ok: true, skipped: false, reason: null, sent }
}
