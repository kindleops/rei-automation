// ─── agreements/adapters.js ──────────────────────────────────────────────
// ⚠️ BOUNDARY REGISTRY / SCAFFOLDING — NO PRODUCTION CALL-SITE YET. The
// providers this module names are all live via their own call paths; this
// registry itself is documentation-as-code until consumers import it. Do not
// cite it as an enforcement layer.
//
// Agreement-chain adapter boundaries (spine gap G10).
//
// One place that NAMES each provider boundary in the post-agreement chain and
// the concrete provider behind it. These seams already existed in scattered
// form; this module is the registry, not a re-wrap — where a boundary is
// already clean (email, esignature, storage) we simply expose the existing
// provider functions. The only genuinely new seam is document generation,
// which is capability-absent today (see document-generation-adapter.js).
//
// The five boundaries:
//
//   email               → lib/providers/email.js (custom SMTP; Brevo webhooks
//                         handle delivery callbacks)
//   document_generation → lib/domain/documents/document-generation-adapter.js
//                         (NEW seam; default provider = not_configured, returns
//                         an explicit capability-absent result, never a fake doc)
//   esignature          → lib/providers/docusign.js (JWT auth, envelopes)
//   file_storage        → lib/providers/storage.js (local + S3) via the
//                         document-package manifest layer in
//                         lib/domain/documents/document-packages.js
//   status_callbacks    → app/api/webhooks/docusign/route.js (HMAC-verified)
//                         → lib/domain/contracts/handle-docusign-webhook.js
//
// Swapping a provider means changing the mapping here (and the provider
// module), not hunting call-sites across the contract path.

import { sendEmail } from "@/lib/providers/email.js";
import {
  createEnvelope,
  getEnvelope,
  sendEnvelope,
} from "@/lib/providers/docusign.js";
import {
  getSignedUrl,
  getStorageConfigSummary,
  uploadFile,
} from "@/lib/providers/storage.js";
import { createStoredDocumentPackage } from "@/lib/domain/documents/document-packages.js";
import {
  generateContractDocument,
  resolveDocumentGenerationProvider,
} from "@/lib/domain/documents/document-generation-adapter.js";
import { handleDocusignWebhook } from "@/lib/domain/contracts/handle-docusign-webhook.js";
import { storeSignedContractDocument } from "@/lib/domain/agreements/store-signed-contract-document.js";

export const AGREEMENT_ADAPTER_BOUNDARIES = Object.freeze({
  email: {
    provider: "lib/providers/email.js",
    description:
      "Outbound email (custom SMTP). Delivery/open callbacks arrive via Brevo webhooks.",
  },
  document_generation: {
    provider: "lib/domain/documents/document-generation-adapter.js",
    description:
      "Contract document generation. Capability-absent today: default provider returns document_generation_not_configured. Real providers (pdf-lib/docx/service) register here.",
  },
  esignature: {
    provider: "lib/providers/docusign.js",
    description:
      "E-signature envelopes (DocuSign JWT). Requires caller-supplied file documents or a server template; sending is gated by ENABLE_AUTO_CONTRACT_SEND (default false — DO NOT FLIP).",
  },
  file_storage: {
    provider: "lib/providers/storage.js",
    description:
      "Durable file storage (local/S3) consumed through the document-package manifest layer. Signed-contract archival additionally sits behind ENABLE_SIGNED_CONTRACT_ARCHIVAL (default false).",
  },
  status_callbacks: {
    provider: "app/api/webhooks/docusign/route.js",
    description:
      "Inbound signature status callbacks: HMAC-verified route → handle-docusign-webhook.js (idempotency-ledger guarded).",
  },
});

/**
 * The callable surface of each boundary. Consumers in the agreement chain
 * should reach providers through these names, keeping provider identity a
 * single-file decision.
 */
export function getAgreementAdapters() {
  return {
    email: {
      sendEmail,
    },
    document_generation: {
      generateContractDocument,
      resolveDocumentGenerationProvider,
    },
    esignature: {
      createEnvelope,
      sendEnvelope,
      getEnvelope,
    },
    file_storage: {
      uploadFile,
      getSignedUrl,
      getStorageConfigSummary,
      createStoredDocumentPackage,
      storeSignedContractDocument,
    },
    status_callbacks: {
      handleDocusignWebhook,
    },
  };
}

export default getAgreementAdapters;
