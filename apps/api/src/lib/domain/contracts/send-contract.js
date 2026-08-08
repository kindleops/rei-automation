import { maybeSendContractForSigning } from "@/lib/domain/contracts/maybe-send-contract-for-signing.js";

export async function sendContract({
  contract_id = null,
  documents = [],
  signers = [],
  subject = null,
  template_id = null,
  email_blurb = "",
  metadata = {},
  dry_run = false,
  auto_send = true,
} = {}) {
  return maybeSendContractForSigning({
    contract: contract_id ? { contract_item_id: contract_id } : null,
    documents,
    signers,
    subject,
    template_id,
    email_blurb,
    metadata,
    dry_run,
    auto_send,
    // This is the deliberate, authenticated operator send (internal/contracts/
    // send, shared-secret gated). It is the ONE path allowed past the
    // ENABLE_AUTO_CONTRACT_SEND kill switch; automatic paths are not.
    operator_override: true,
  });
}

export default sendContract;
