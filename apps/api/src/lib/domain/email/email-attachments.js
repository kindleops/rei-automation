/**
 * Email attachments → the private `email-attachments` bucket (the document
 * store for email files; none existed). Bytes arrive two ways:
 *   Cloudflare Email Routing — inside the raw MIME, stored at ingest,
 *   Brevo inbound parse       — a download token, fetched by the worker.
 * Classification happened at ingest (filename rules); storage never changes
 * review state — a stored file is not a trusted file.
 */
import crypto from 'node:crypto'

const BUCKET = 'email-attachments'
const BREVO_ATTACHMENT_URL = 'https://api.brevo.com/v3/inbound/attachments/'
const clean = (v) => String(v ?? '').trim()

const safeName = (n) => clean(n).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file'

export async function storeAttachmentBytes(db, att, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const path = `${att.thread_id || 'unthreaded'}/${att.inbound_message_id || att.queue_id}/${sha256.slice(0, 12)}-${safeName(att.filename)}`
  const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: att.content_type || 'application/octet-stream', upsert: true })
  if (up?.error) {
    await db.from('email_attachments').update({ fetch_status: 'failed' }).eq('id', att.id)
    return { ok: false, error: up.error.message }
  }
  await db.from('email_attachments').update({ fetch_status: 'stored', storage_bucket: BUCKET, storage_path: path, sha256, size_bytes: buf.length, provider_download_token: null }).eq('id', att.id)
  return { ok: true, path, sha256 }
}

/** Worker step: pull pending Brevo attachments by download token (bounded). */
export async function fetchPendingBrevoAttachments(db, { env = process.env, limit = 10, fetchImpl = fetch } = {}) {
  const key = clean(env.BREVO_INBOUND_API_KEY || env.BREVO_API_KEY)
  const { data } = await db.from('email_attachments').select('*').eq('fetch_status', 'pending').limit(limit)
  const rows = (data || []).filter((a) => a.provider_download_token)
  if (!rows.length) return { fetched: 0, failed: 0 }
  if (!key) return { fetched: 0, failed: 0, skipped: 'provider_key_missing', pending: rows.length }
  let fetched = 0
  let failed = 0
  for (const a of rows) {
    try {
      const res = await fetchImpl(`${BREVO_ATTACHMENT_URL}${encodeURIComponent(a.provider_download_token)}`, { headers: { 'api-key': key, accept: 'application/octet-stream' } })
      if (!res.ok) throw new Error(`http_${res.status}`)
      const r = await storeAttachmentBytes(db, a, Buffer.from(await res.arrayBuffer()))
      if (r.ok) fetched++; else failed++
    } catch {
      failed++
      await db.from('email_attachments').update({ fetch_status: 'failed' }).eq('id', a.id)
    }
  }
  return { fetched, failed }
}

/** Short-lived signed URL for an operator to view a stored file. */
export async function signedAttachmentUrl(db, att, seconds = 300) {
  if (att?.fetch_status !== 'stored' || !att.storage_path) return null
  const { data } = await db.storage.from(att.storage_bucket || BUCKET).createSignedUrl(att.storage_path, seconds)
  return data?.signedUrl || null
}
