// ─── scripts/llm-audit/external-call-guard.mjs ───────────────────────────────
// Controls for any offline audit that sends text to an external model.
//
//  - holdActive(dir): an owner hold file (HOLD_EXTERNAL_CALLS) stops every
//    call / batch until the owner removes it.
//  - assertRequestsScrubbed(requests, ctxFor): every user message is run
//    through detectResidualPII before anything is sent.
//  - Ledger with reservations: a "reserve" row (estimated worst-case cost) is
//    appended BEFORE each call and a "settle" row (actual - estimate) after,
//    so the ledger total is never below what was really spent, even when the
//    process dies mid-call. reserveOrThrow() refuses once the budget would be
//    exceeded.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { detectResidualPII } from "./scrub.mjs";

export const HOLD_FILE_NAME = "HOLD_EXTERNAL_CALLS";

export function holdActive(dir) {
  return existsSync(`${dir}/${HOLD_FILE_NAME}`);
}

export function assertNoHold(dir) {
  if (holdActive(dir)) {
    const reason = readFileSync(`${dir}/${HOLD_FILE_NAME}`, "utf8").trim();
    const err = new Error(`external model calls are on owner hold (${HOLD_FILE_NAME}): ${reason || "no reason given"}`);
    err.code = "EXTERNAL_CALL_HOLD";
    throw err;
  }
}

/** Text of the user turns of one Messages API request. */
export function userTextOf(request = {}) {
  const messages = request?.params?.messages || request?.messages || [];
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n")))
    .join("\n");
}

/**
 * Throws on the first request whose user text still carries PII.
 * ctxFor(request) may return { names, agentNames } for that request's thread.
 */
export function assertRequestsScrubbed(requests = [], ctxFor = () => ({})) {
  for (const request of requests) {
    const found = detectResidualPII(userTextOf(request), ctxFor(request) || {});
    if (found.length) {
      const err = new Error(`request ${request.custom_id || "?"} has residual PII: ${found.join(",")}`);
      err.code = "RESIDUAL_PII";
      throw err;
    }
  }
  return true;
}

export function ledgerTotal(ledgerPath) {
  if (!existsSync(ledgerPath)) return 0;
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + (Number(JSON.parse(line).cost_usd) || 0), 0);
}

/** Worst-case cost of one request: every prompt char as uncached input, full max_tokens out. */
export function estimateRequestCostUsd(request = {}, { priceIn, priceOut, batch = false } = {}) {
  const params = request.params || request;
  const chars = JSON.stringify({ system: params.system ?? null, messages: params.messages ?? [] }).length;
  const inputTokens = Math.ceil(chars / 3);
  const cost = inputTokens * priceIn + (Number(params.max_tokens) || 4096) * priceOut;
  return batch ? cost * 0.5 : cost;
}

/** Appends a reserve row BEFORE the call; throws when the budget would be exceeded. */
export function reserveOrThrow({ ledgerPath, budgetUsd, estimateUsd, phase, custom_id = null, now = () => new Date() }) {
  const total = ledgerTotal(ledgerPath);
  if (total + estimateUsd > budgetUsd) {
    const err = new Error(`budget: ${total.toFixed(4)} + ${estimateUsd.toFixed(4)} > ${budgetUsd}`);
    err.code = "BUDGET_EXCEEDED";
    throw err;
  }
  appendFileSync(ledgerPath, JSON.stringify({ at: now().toISOString(), phase, kind: "reserve", custom_id, cost_usd: estimateUsd }) + "\n");
  return { estimateUsd };
}

/** Appends the settle row (actual - estimate) after the call (or 0 actual on failure). */
export function settle({ ledgerPath, reservation, actualUsd = 0, phase, custom_id = null, usage = null, now = () => new Date() }) {
  appendFileSync(
    ledgerPath,
    JSON.stringify({ at: now().toISOString(), phase, kind: "settle", custom_id, actual_usd: actualUsd, cost_usd: actualUsd - reservation.estimateUsd, usage }) + "\n"
  );
}
