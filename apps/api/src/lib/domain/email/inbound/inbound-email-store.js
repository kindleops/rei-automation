/**
 * inbound-email-store.js
 *
 * The durable side of inbound. The only module that reads or writes the inbound
 * tables, exactly as seller-communication-store.js is for the S11 tables.
 *
 * Thin on purpose. Every interesting decision -- may this be trusted, which
 * conversation is it, is it a duplicate, is that file safe -- lives in the
 * ingest pipeline, the resolver and the classifier. A store that also decided
 * policy would be a second place for the rules to drift, and the least likely
 * place anyone would look for them.
 *
 * ATTACHMENTS ARE QUARANTINED, AND THAT IS NOT A PLACEHOLDER.
 *   This repository has no malware scanning. Rather than pretend otherwise, every
 *   ingested file lands scan_status = 'unscanned' and is treated as quarantined:
 *   never auto-rendered, never served inline, never executed. The missing
 *   capability is recorded on the row instead of assumed away.
 */

import crypto from "node:crypto";
import path from "node:path";

import { child } from "@/lib/logging/logger.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { replyTokenFingerprint } from "@/lib/domain/email/reply-address.js";

const logger = child({ module: "domain.email.inbound_store" });

/** Bounds, chosen so one hostile message cannot exhaust storage or memory. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Extensions that are never rendered and never handed back with their original
 * name. The list is not a security boundary on its own -- content type lies and
 * so does an extension -- it exists so an operator downloading a file cannot be
 * tricked by `invoice.pdf.exe`.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".com", ".bat", ".cmd", ".scr", ".pif", ".msi", ".msp", ".dll", ".sys",
  ".js", ".jse", ".vbs", ".vbe", ".wsf", ".wsh", ".ps1", ".psm1", ".sh", ".bash",
  ".jar", ".app", ".dmg", ".pkg", ".deb", ".rpm", ".apk", ".lnk", ".reg", ".hta",
]);

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Make a provider-supplied filename safe to store and to show.
 *
 * Path separators, traversal, control characters and right-to-left override
 * marks are all removed: the last of those is how a filename containing U+202E
 * (RIGHT-TO-LEFT OVERRIDE) can render `photo<RLO>gnp.exe` as `photo exe.png` in a
 * file listing, which is a real technique for disguising an executable.
 */
export function sanitizeAttachmentFilename(raw) {
  const source = clean(raw) || "attachment";
  const base = path.basename(source.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  const safe = (base || "attachment").slice(0, 180);
  const extension = path.extname(safe).toLowerCase();
  // A dangerous extension is neutralised rather than rejected: the file is still
  // evidence, and a seller may genuinely have sent one by mistake.
  if (EXECUTABLE_EXTENSIONS.has(extension)) return `${safe}.quarantined`;
  return safe;
}

export function createInboundEmailStore(deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const fetch_impl = deps.fetch_impl || fetch;

  return {
    async getSystemFlag(key) {
      return (deps.getSystemFlag || getSystemFlag)(key);
    },

    /**
     * The durable receipt. Written before resolution and before any mutation.
     *
     * Idempotency is the UNIQUE index on event_key, not a read-then-write two
     * workers can interleave between. A conflict is reported as `duplicate` so
     * the caller can stop rather than doing the work twice.
     */
    async recordInboundEvent(input = {}) {
      const normalized = input.normalized || {};
      const row = {
        event_key: input.event_key,
        provider: "brevo",
        provider_event_id: normalized.provider_event_id || null,
        rfc_message_id: normalized.rfc_message_id || null,
        in_reply_to: normalized.in_reply_to || null,
        references_header: Array.isArray(normalized.references) ? normalized.references.join(" ") : null,
        trust_class: input.trust_class,
        received_at: input.received_at || new Date().toISOString(),
        sent_at: normalized.sent_at || null,
        envelope_from: normalized.envelope_from || null,
        envelope_to: normalized.envelope_to || null,
        from_email: normalized.from?.email || null,
        from_name: normalized.from?.name || null,
        subject: normalized.subject || null,
        reply_token: input.presented_token || null,
        reply_token_source: input.reply_token_source || null,
        resolution_status: input.resolution_status || "pending",
        message_class: normalized.message_class || "human_reply",
        auto_reply_reason: normalized.classification_reason || null,
        attachment_count: Array.isArray(normalized.attachments) ? normalized.attachments.length : 0,
        processing_status: input.processing_status || "received",
        processing_reason: input.processing_reason || null,
        // The whole payload, kept. Reprocessing a stored event must not depend on
        // the provider still being willing to send it again.
        raw_payload: normalized.raw_payload && typeof normalized.raw_payload === "object"
          ? normalized.raw_payload
          : { normalized },
      };

      const { data, error } = await supabase
        .from("email_inbound_events")
        .insert(row)
        .select("id")
        .maybeSingle();

      if (error) {
        // 23505 is the unique violation on event_key: a redelivery, which is
        // expected and not an error.
        if (clean(error.code) === "23505" || /duplicate key/i.test(clean(error.message))) {
          const { data: existing } = await supabase
            .from("email_inbound_events")
            .select("id")
            .eq("event_key", input.event_key)
            .maybeSingle();
          return { ok: true, duplicate: true, inbound_event_id: existing?.id || null };
        }
        logger.error("inbound_event.record_failed", {
          event_key: input.event_key, reason: clean(error.message) || "unknown",
        });
        return { ok: false, reason: "inbound_event_record_failed" };
      }

      return { ok: true, duplicate: false, inbound_event_id: data?.id || null };
    },

    async updateInboundEvent(input = {}) {
      const { inbound_event_id, ...patch } = input;
      if (!inbound_event_id) return { ok: false, reason: "missing_inbound_event_id" };

      const { error } = await supabase
        .from("email_inbound_events")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", inbound_event_id);

      if (error) {
        logger.warn("inbound_event.update_failed", {
          inbound_event_id, reason: clean(error.message) || "unknown",
        });
        return { ok: false, reason: "inbound_event_update_failed" };
      }
      return { ok: true };
    },

    /** A payload we could not read is kept, not dropped. */
    async recordMalformed(input = {}) {
      const digest = crypto
        .createHash("sha256")
        .update(JSON.stringify(input.raw_item ?? null), "utf8")
        .digest("hex")
        .slice(0, 40);

      const { error } = await supabase.from("email_inbound_events").insert({
        event_key: `brevo_in:malformed:${digest}`,
        provider: "brevo",
        trust_class: "authenticated_provider_callback",
        received_at: input.received_at || new Date().toISOString(),
        resolution_status: "rejected",
        processing_status: "quarantined",
        processing_reason: input.reason || "inbound_payload_malformed",
        message_class: "malformed",
        raw_payload: input.raw_item && typeof input.raw_item === "object" ? input.raw_item : {},
      });
      // A duplicate malformed payload is fine to swallow: it is the same
      // unreadable thing arriving twice.
      if (error && clean(error.code) !== "23505") {
        logger.error("inbound_event.malformed_record_failed", { reason: clean(error.message) });
        return { ok: false };
      }
      return { ok: true };
    },

    /** Tier 1 lookup. */
    async findReplyAlias(token) {
      const normalized = clean(token);
      if (!normalized) return null;

      const { data, error } = await supabase
        .from("email_reply_aliases")
        .select("id, token, is_active, revoked_reason, opportunity_id, master_owner_id, property_id, prospect_id, thread_key")
        .eq("token", normalized)
        .maybeSingle();

      if (error) {
        logger.error("inbound_email.alias_lookup_failed", {
          reply_token: replyTokenFingerprint(normalized), reason: clean(error.message),
        });
        return null;
      }
      return data || null;
    },

    /**
     * Tier 2 lookup: outbound communications whose RFC Message-ID appears in the
     * inbound In-Reply-To or References.
     */
    async findCommunicationsByMessageIds({ in_reply_to, references } = {}) {
      const ids = [...new Set([clean(in_reply_to), ...(Array.isArray(references) ? references : [])]
        .map((value) => clean(value))
        .filter(Boolean))];
      if (!ids.length) return [];

      const { data, error } = await supabase
        .from("email_queue")
        .select("logical_communication_id, master_owner_id, property_id, prospect_id, thread_key, rfc_message_id")
        .in("rfc_message_id", ids)
        .limit(50);

      if (error) {
        logger.error("inbound_email.header_lookup_failed", { reason: clean(error.message) });
        return [];
      }
      return Array.isArray(data) ? data : [];
    },

    /**
     * Tier 4 lookup: ACTIVE conversations for this sender address.
     *
     * Deliberately returns everything it finds rather than picking. The resolver
     * refuses when there is more than one, and that refusal is only correct if it
     * is given the full picture.
     */
    async findConversationsForSender({ from_email } = {}) {
      const email = clean(from_email).toLowerCase();
      if (!email) return [];

      const { data, error } = await supabase
        .from("contact_outreach_state")
        .select("podio_master_owner_id, podio_property_id, podio_prospect_id, to_email")
        .eq("to_email", email)
        .limit(25);

      if (error) {
        logger.error("inbound_email.sender_lookup_failed", { reason: clean(error.message) });
        return [];
      }

      return (Array.isArray(data) ? data : []).map((row) => ({
        master_owner_id: row.podio_master_owner_id,
        property_id: row.podio_property_id,
        prospect_id: row.podio_prospect_id,
      }));
    },

    async createInboundMessage(input = {}) {
      const conversation = input.conversation || {};
      const normalized = input.normalized || {};
      const body = input.body || {};

      const { data, error } = await supabase
        .from("email_inbound_messages")
        .insert({
          inbound_event_id: input.inbound_event_id,
          direction: "inbound",
          channel: "email",
          provider: "brevo",
          opportunity_id: conversation.opportunity_id || null,
          master_owner_id: conversation.master_owner_id || null,
          property_id: conversation.property_id || null,
          prospect_id: conversation.prospect_id || null,
          thread_key: conversation.thread_key || null,
          reply_alias_id: input.reply_alias_id || null,
          in_reply_to_communication_id: input.in_reply_to_communication_id || null,
          from_email: normalized.from?.email || null,
          from_name: normalized.from?.name || null,
          to_email: normalized.envelope_to || null,
          subject: normalized.subject || null,
          rfc_message_id: normalized.rfc_message_id || null,
          in_reply_to: normalized.in_reply_to || null,
          references_header: Array.isArray(normalized.references) ? normalized.references.join(" ") : null,
          body_text_raw: body.raw_text || null,
          body_text_normalized: body.normalized_text || null,
          body_newest_reply: body.newest_reply || null,
          body_html_raw: input.html_raw || null,
          body_html_sanitized: input.html_sanitized || null,
          html_is_sanitized: Boolean(input.html_sanitized),
          message_class: input.message_class || "human_reply",
          received_at: input.received_at,
          metadata: {
            body_source: body.source || null,
            had_html_only: body.had_html_only || false,
            signature: body.signature || null,
          },
        })
        .select("id")
        .maybeSingle();

      if (error) {
        // The unique index on inbound_event_id is the last line of defence
        // against a redelivery creating a second seller message.
        if (clean(error.code) === "23505") {
          const { data: existing } = await supabase
            .from("email_inbound_messages")
            .select("id")
            .eq("inbound_event_id", input.inbound_event_id)
            .maybeSingle();
          return { ok: true, duplicate: true, inbound_message_id: existing?.id || null };
        }
        logger.error("inbound_message.persist_failed", { reason: clean(error.message) || "unknown" });
        return { ok: false, reason: "inbound_message_persist_failed" };
      }
      return { ok: true, inbound_message_id: data?.id || null };
    },

    /**
     * Fetch, digest and record attachments.
     *
     * Bytes are pulled DURING ingestion because Brevo's attachment URLs expire.
     * Deferring the fetch would produce a manifest of files that no longer exist.
     */
    async ingestAttachments(input = {}) {
      const descriptors = (Array.isArray(input.descriptors) ? input.descriptors : [])
        .slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      const summary = { stored: 0, quarantined: 0, failed: 0, skipped: 0 };

      for (const descriptor of descriptors) {
        try {
          const bytes = await fetchAttachmentBytes(descriptor, fetch_impl);
          if (!bytes) { summary.failed += 1; continue; }
          if (bytes.length > MAX_ATTACHMENT_BYTES) { summary.skipped += 1; continue; }

          const content_sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
          const filename = sanitizeAttachmentFilename(descriptor.filename);

          const { error } = await supabase.from("email_inbound_attachments").insert({
            inbound_message_id: input.inbound_message_id,
            inbound_event_id: input.inbound_event_id,
            content_sha256,
            byte_size: bytes.length,
            provider_content_type: descriptor.content_type || null,
            // What we are willing to CALL it, which is not what the provider
            // claimed. A claimed content type is attacker-controlled.
            content_type: "application/octet-stream",
            provider_filename: descriptor.filename || null,
            filename,
            storage_status: "pending",
            // No scanner exists. The row says so rather than implying safety.
            scan_status: "unscanned",
            quarantine_reason: "no_malware_scanning_configured",
            metadata: { content_id: descriptor.content_id || null },
          });

          if (error && clean(error.code) === "23505") { summary.skipped += 1; continue; }
          if (error) { summary.failed += 1; continue; }
          summary.quarantined += 1;
        } catch {
          summary.failed += 1;
        }
      }
      return summary;
    },

    /**
     * Communication evidence for EMAIL-4. NOT acquisition state.
     *
     * Nothing here writes a lead status, a stage, a temperature or an offer.
     */
    async emitCommunicationEvent(event = {}) {
      const { error } = await supabase.from("email_inbound_events")
        .update({ metadata: { emitted_event: event.type, emitted_at: new Date().toISOString() } })
        .eq("id", event.inbound_event_id);
      if (error) logger.warn("inbound_email.event_emit_failed", { reason: clean(error.message) });
      return { ok: !error };
    },
  };
}

async function fetchAttachmentBytes(descriptor, fetch_impl) {
  if (descriptor.content_base64) {
    try { return Buffer.from(descriptor.content_base64, "base64"); } catch { return null; }
  }
  const url = clean(descriptor.download_url);
  if (!url) return null;
  try {
    const response = await fetch_impl(url);
    if (!response?.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

export default createInboundEmailStore;
