import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import "../../apps/api/tests/register-aliases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../apps/api/.env.local") });

process.env.PODIO_CLIENT_ID ||= "mock";
process.env.PODIO_CLIENT_SECRET ||= "mock";
process.env.PODIO_USERNAME ||= "mock";
process.env.PODIO_PASSWORD ||= "mock";
process.env.ENABLE_AI_ASSIST = "false";
process.env.OPENAI_KEY ||= "test-openai-key";

const { classify } = await import("../../apps/api/src/lib/domain/classification/classify.js");

const messages = [
  "Who is this?",
  "Wrong number",
  "Stop texting me",
  "How much are you offering?",
  "Yes I own it",
  "No that house is not mine no more",
  "I want 250k",
  "Maybe later",
  "Call me",
  "Sold to the tenants",
  "I'm block",
  "No thanks",
];

for (const text of messages) {
  const result = await classify(text);
  console.log(JSON.stringify({
    text,
    primary_intent: result.primary_intent,
    objection: result.objection,
    compliance_flag: result.compliance_flag,
    confidence: result.confidence,
    automation_decision: result.automation_decision,
  }, null, 2));
}
