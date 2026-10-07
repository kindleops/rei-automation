// ─── seller-conversation-v3-flag.js ─────────────────────────────────────────
// SELLER CONVERSATION MACHINE v3 (owner brief 2026-10-06 late). One flag,
// default OFF, read by the money path (monetary-understanding.js number rules)
// and the checklist planner (seller-conversation-v3.js). Only an explicit
// truthy value turns it on, so a deploy with the variable unset is dark.

export const SELLER_CONVERSATION_V3_FLAG = "SELLER_CONVERSATION_V3";

export function isSellerConversationV3Enabled(env = process.env) {
  const raw = String(env?.[SELLER_CONVERSATION_V3_FLAG] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export default isSellerConversationV3Enabled;
