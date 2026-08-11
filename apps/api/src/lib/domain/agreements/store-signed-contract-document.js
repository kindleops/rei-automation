// ─── store-signed-contract-document.js ───────────────────────────────────
// Signed-contract archival (spine gap G10, storage wiring).
//
// On the DocuSign envelope-completed webhook, fetch the combined signed PDF
// from DocuSign and persist it durably via providers/storage.js (through the
// existing createStoredDocumentPackage manifest layer).
//
// Containment: the whole capability sits behind the NEW flag
// ENABLE_SIGNED_CONTRACT_ARCHIVAL (default false). The webhook call-site
// checks the flag before invoking this module, and this module re-checks it
// (defense in depth) — while OFF nothing here runs and no network is touched.
// Failures are contained: this function NEVER throws into the webhook.

import { isFeatureEnabled } from "@/lib/config/feature-flags.js";
import { createStoredDocumentPackage } from "@/lib/domain/documents/document-packages.js";
import { getDocusignAccessToken } from "@/lib/providers/docusign.js";
import { child } from "@/lib/logging/logger.js";

const logger = child({
  module: "domain.agreements.store_signed_contract_document",
});

const DOCUSIGN_COMBINED_DOCUMENT_ID = "combined";

function clean(value) {
  return String(value ?? "").trim();
}

// Fetch the combined (all pages, all documents) signed PDF for an envelope.
// Kept internal to this module: providers/docusign.js exposes auth + config,
// and this is the only signed-document consumer today.
async function fetchCombinedEnvelopeDocument({
  envelope_id,
  getAccessToken,
  fetchImpl,
}) {
  const auth_result = await getAccessToken({ dry_run: false });

  if (!auth_result?.ok) {
    return {
      ok: false,
      reason: auth_result?.reason || "docusign_auth_failed",
      file_base64: null,
    };
  }

  const url =
    `${auth_result.config.base_url}/v2.1/accounts/${auth_result.config.account_id}` +
    `/envelopes/${encodeURIComponent(envelope_id)}` +
    `/documents/${DOCUSIGN_COMBINED_DOCUMENT_ID}`;

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth_result.access_token}`,
        Accept: "application/pdf",
      },
    });

    if (!response?.ok) {
      return {
        ok: false,
        reason: `docusign_document_fetch_failed_${response?.status || "unknown"}`,
        file_base64: null,
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer.length) {
      return {
        ok: false,
        reason: "docusign_document_empty",
        file_base64: null,
      };
    }

    return {
      ok: true,
      reason: "docusign_document_fetched",
      file_base64: buffer.toString("base64"),
      size_bytes: buffer.length,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "docusign_document_fetch_exception",
      error: clean(error?.message) || "unknown_error",
      file_base64: null,
    };
  }
}

const defaultDeps = {
  isFeatureEnabled,
  createStoredDocumentPackage,
  getAccessToken: getDocusignAccessToken,
  fetchImpl: (...args) => fetch(...args),
  logger,
};

let runtimeDeps = { ...defaultDeps };

export function __setStoreSignedContractDocumentTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetStoreSignedContractDocumentTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

/**
 * Archive the signed envelope document. Never throws; returns
 * { ok, archived, skipped, reason, package: {...} | null }.
 */
export async function storeSignedContractDocument({
  envelope_id = null,
  contract_item_id = null,
  completed_at = null,
} = {}) {
  if (!runtimeDeps.isFeatureEnabled("ENABLE_SIGNED_CONTRACT_ARCHIVAL")) {
    return {
      ok: true,
      archived: false,
      skipped: true,
      reason: "signed_contract_archival_disabled",
      package: null,
    };
  }

  const normalized_envelope_id = clean(envelope_id);

  if (!normalized_envelope_id) {
    return {
      ok: false,
      archived: false,
      skipped: false,
      reason: "missing_envelope_id",
      package: null,
    };
  }

  try {
    const fetched = await fetchCombinedEnvelopeDocument({
      envelope_id: normalized_envelope_id,
      getAccessToken: runtimeDeps.getAccessToken,
      fetchImpl: runtimeDeps.fetchImpl,
    });

    if (!fetched.ok) {
      runtimeDeps.logger.warn("signed_contract_archival.fetch_failed", {
        envelope_id: normalized_envelope_id,
        contract_item_id,
        reason: fetched.reason,
      });

      return {
        ok: false,
        archived: false,
        skipped: false,
        reason: fetched.reason,
        package: null,
      };
    }

    const stored = await runtimeDeps.createStoredDocumentPackage({
      namespace: "contracts",
      entity_type: "contract",
      entity_id: contract_item_id || normalized_envelope_id,
      label: "signed-contract",
      metadata: {
        envelope_id: normalized_envelope_id,
        contract_item_id: contract_item_id || null,
        completed_at: clean(completed_at) || null,
        source: "docusign_envelope_completed_webhook",
      },
      files: [
        {
          filename: `signed-contract-${normalized_envelope_id}.pdf`,
          key_name: `signed-contract-${normalized_envelope_id}.pdf`,
          content_type: "application/pdf",
          body: fetched.file_base64,
          body_encoding: "base64",
          metadata: {
            envelope_id: normalized_envelope_id,
            docusign_document_id: DOCUSIGN_COMBINED_DOCUMENT_ID,
          },
        },
      ],
    });

    if (!stored?.ok) {
      runtimeDeps.logger.warn("signed_contract_archival.store_failed", {
        envelope_id: normalized_envelope_id,
        contract_item_id,
        reason: stored?.reason || "document_package_failed",
      });

      return {
        ok: false,
        archived: false,
        skipped: false,
        reason: stored?.reason || "signed_contract_store_failed",
        package: null,
      };
    }

    runtimeDeps.logger.info("signed_contract_archival.archived", {
      envelope_id: normalized_envelope_id,
      contract_item_id,
      package_id: stored.package_id,
      manifest_key: stored.manifest_key,
    });

    return {
      ok: true,
      archived: true,
      skipped: false,
      reason: "signed_contract_archived",
      package: {
        package_id: stored.package_id,
        package_root_key: stored.package_root_key,
        manifest_key: stored.manifest_key,
        files: stored.files || [],
      },
    };
  } catch (error) {
    runtimeDeps.logger.warn("signed_contract_archival.unexpected_failure", {
      envelope_id: normalized_envelope_id,
      contract_item_id,
      error: clean(error?.message) || "unknown_error",
    });

    return {
      ok: false,
      archived: false,
      skipped: false,
      reason: "signed_contract_archival_unexpected_failure",
      package: null,
    };
  }
}

export default storeSignedContractDocument;
