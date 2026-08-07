// ─── document-generation-adapter.js ──────────────────────────────────────
// Document generation boundary (spine gap G10).
//
// The contract path can send an envelope from EITHER caller-supplied file
// documents OR a DocuSign server template. There is deliberately no document
// generation capability in this repo today (no pdf/docx library anywhere).
// This adapter is the single seam where a real provider (pdf-lib, docx,
// external doc service, ...) plugs in later.
//
// Contract of the seam:
//   generateContractDocument(termsSnapshot, template) →
//     { ok, generated, provider, reason, document | null }
//
// The default provider is "not_configured" and returns an EXPLICIT
// capability-absent result (reason "document_generation_not_configured").
// It never fabricates a document. Callers must treat ok:false +
// capability_absent:true as "this leg of the pipeline does not exist yet",
// not as a transient error.
//
// Provider selection: DOCUMENT_GENERATION_PROVIDER env (additive, default
// "not_configured"). A future provider registers via
// registerDocumentGenerationProvider(name, impl) and is selected by name.

import ENV from "@/lib/config/env.js";
import { child } from "@/lib/logging/logger.js";

const logger = child({
  module: "domain.documents.document_generation_adapter",
});

export const DOCUMENT_GENERATION_NOT_CONFIGURED =
  "document_generation_not_configured";

function clean(value) {
  return String(value ?? "").trim();
}

// ── Default capability-absent provider ────────────────────────────────────
const notConfiguredProvider = {
  name: "not_configured",
  async generateContractDocument(termsSnapshot = null, template = null) {
    return {
      ok: false,
      generated: false,
      capability_absent: true,
      provider: "not_configured",
      reason: DOCUMENT_GENERATION_NOT_CONFIGURED,
      document: null,
      // Echo enough context for observability without inventing content.
      requested: {
        has_terms_snapshot: Boolean(termsSnapshot),
        template: clean(template?.name || template?.template_type) || null,
      },
    };
  },
};

const providers = new Map([[notConfiguredProvider.name, notConfiguredProvider]]);

export function registerDocumentGenerationProvider(name, impl = {}) {
  const normalized = clean(name);

  if (!normalized || typeof impl?.generateContractDocument !== "function") {
    return { ok: false, reason: "invalid_document_generation_provider" };
  }

  providers.set(normalized, {
    name: normalized,
    generateContractDocument: impl.generateContractDocument,
  });

  return { ok: true, provider: normalized };
}

export function resolveDocumentGenerationProvider(name = null) {
  const requested =
    clean(name) ||
    clean(ENV.DOCUMENT_GENERATION_PROVIDER) ||
    "not_configured";

  const provider = providers.get(requested);

  if (!provider) {
    logger.warn("document_generation.unknown_provider_fallback", {
      requested,
    });
    return providers.get("not_configured");
  }

  return provider;
}

/**
 * Generate a contract document from a durable terms snapshot + template
 * descriptor. With the default provider this is an explicit capability-absent
 * no-op; it NEVER returns a fake document.
 *
 * A successful future provider must resolve to:
 *   { ok: true, generated: true, provider, reason: "document_generated",
 *     document: { document_id, name, file_base64, file_extension } }
 * (the document shape consumed by maybe-send-contract-for-signing).
 */
export async function generateContractDocument(
  termsSnapshot = null,
  template = null,
  { provider = null } = {}
) {
  const resolved = resolveDocumentGenerationProvider(provider);

  try {
    const result = await resolved.generateContractDocument(
      termsSnapshot,
      template
    );

    if (result?.ok && !result?.document?.file_base64) {
      // A provider claiming success without a real document is a bug, not a
      // document. Fail closed to capability-absent semantics.
      logger.warn("document_generation.provider_returned_empty_document", {
        provider: resolved.name,
      });

      return {
        ok: false,
        generated: false,
        capability_absent: false,
        provider: resolved.name,
        reason: "document_generation_empty_result",
        document: null,
      };
    }

    return result;
  } catch (error) {
    logger.warn("document_generation.provider_failed", {
      provider: resolved.name,
      error: clean(error?.message) || "unknown_error",
    });

    return {
      ok: false,
      generated: false,
      capability_absent: false,
      provider: resolved.name,
      reason: "document_generation_failed",
      document: null,
    };
  }
}

export default generateContractDocument;
