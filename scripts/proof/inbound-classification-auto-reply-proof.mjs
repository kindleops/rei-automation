import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../apps/api/.env.local") });

// Mock Podio env vars if missing to prevent boot crash
process.env.PODIO_CLIENT_ID ||= "mock";
process.env.PODIO_CLIENT_SECRET ||= "mock";
process.env.PODIO_USERNAME ||= "mock";
process.env.PODIO_PASSWORD ||= "mock";

import { classify } from "../../apps/api/src/lib/domain/classification/classify.js";
import { resolveSellerAutoReplyPlan } from "../../apps/api/src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";

const testExamples = [
  { text: "No thanks", expected_intent: "not_interested" },
  { text: "Not interested", expected_intent: "not_interested" },
  { text: "STOP", expected_intent: "opt_out" },
  { text: "Wrong number", expected_intent: "wrong_number" },
  { text: "This is not a duplex. It is a house. It's not for sale thanks.", expected_intent: "property_correction" },
  { text: "How much are you offering?", expected_intent: "asks_offer" },
  { text: "Who is this?", expected_intent: "who_is_this" },
  { text: "Maybe depends on price", expected_intent: "latent_interest" },
  { text: "Sí, me interesa vender si el precio es bueno.", expected_intent: "seller_interested" },
  { text: "No me interesa, gracias.", expected_intent: "not_interested" },
  { text: "I'll sue you for harassment", expected_intent: "hostile_or_legal" },
];

async function runProof() {
  console.log("Starting Inbound Classification & Auto-Reply Proof...");
  console.log("=".repeat(80));

  for (const example of testExamples) {
    const classification = await classify(example.text);
    const plan = await resolveSellerAutoReplyPlan({
      message_body: example.text,
      classification,
      auto_reply_enabled: true,
      conversation_context: { found: true }
    });

    console.log(`Inbound Text: "${example.text}"`);
    console.log(`Detected Language: ${classification.language}`);
    console.log(`Classification: ${classification.primary_intent}`);
    console.log(`Confidence: ${classification.confidence}`);
    console.log(`Auto-Reply Allowed: ${plan.should_queue_reply}`);
    console.log(`Proposed Reply Mode: ${plan.reply_mode}`);
    console.log(`Proposed Action: ${plan.next_stage || "N/A"}`);
    console.log(`Reason: ${plan.reason || "N/A"}`);
    console.log("-".repeat(40));
  }
}

runProof().catch(console.error);
