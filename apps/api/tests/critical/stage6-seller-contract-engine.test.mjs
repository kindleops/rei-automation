import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyStage6Contract,
  STAGE6_OUTCOMES,
  OWNERSHIP_STRUCTURE,
} = await import("../../src/lib/domain/seller-flow/stage6-seller-contract-engine.js");

const { ACQUISITION_LIFECYCLE_EVENTS: EV } = await import(
  "../../src/lib/domain/seller-flow/acquisition-lifecycle-events.js"
);

const FIXED_NOW = "2026-06-23T12:00:00.000Z";

function run(message, overrides = {}) {
  return classifyStage6Contract({
    message,
    seller_name: "John Doe",
    accepted_price: 175000,
    ownership_status: "confirmed",
    ownership_confidence: 0.9,
    ...overrides,
    context: {
      now: FIXED_NOW,
      entities: { property_id: "p1", master_owner_id: "o1", prospect_id: "pr1", contact_point_id: "c1" },
    },
  });
}

const types = (d) => d.events.map((e) => e.type);
const has = (d, t) => types(d).includes(t);

// ── Email ────────────────────────────────────────────────────────────────────

test("seller provides email → verified, contract_ready", () => {
  const d = run("my email is bob@example.com");
  assert.equal(d.email_verified, true);
  assert.equal(d.email, "bob@example.com");
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_READY);
  assert.ok(has(d, EV.EMAIL_VERIFIED));
});

test("invalid email → email_required", () => {
  const d = run("my email is bob@@gmail");
  assert.equal(d.email_verified, false);
  assert.equal(d.email_invalid, true);
  assert.equal(d.outcome, STAGE6_OUTCOMES.EMAIL_REQUIRED);
});

test("no email provided → email_required", () => {
  const d = run("send me the contract", { seller_email: null });
  assert.equal(d.outcome, STAGE6_OUTCOMES.EMAIL_REQUIRED);
});

test("resend contract → contract_sent (resend)", () => {
  const d = run("can you resend the contract", { seller_email: "bob@example.com" });
  assert.equal(d.resend_requested, true);
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_SENT);
  assert.equal(d.acquisition_action, "resend_contract");
});

test("alternate email supersedes stored email", () => {
  const d = run("actually use jane@example.com instead", { seller_email: "bob@example.com" });
  assert.equal(d.email, "jane@example.com");
  assert.equal(d.email_verified, true);
  assert.equal(d.alternate_email_requested, true);
});

// ── Contract requests / lifecycle ────────────────────────────────────────────

test("seller requests contract → contract_requested", () => {
  const d = run("send me the contract", { seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_REQUESTED);
  assert.ok(has(d, EV.CONTRACT_REQUESTED));
});

test("seller signs contract → contract_signed → ready_for_disposition", () => {
  const d = run("", { contract_status: "signed", seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_SIGNED);
  assert.equal(d.route, "ready_for_disposition");
  assert.equal(d.stage_code, "S7");
  assert.ok(has(d, EV.CONTRACT_SIGNED));
  assert.ok(has(d, EV.READY_FOR_DISPOSITION));
});

test("seller partially signs → contract_partially_signed", () => {
  const d = run("my wife also owns it", { contract_status: "partially_signed" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_PARTIALLY_SIGNED);
  assert.ok(has(d, EV.CONTRACT_PARTIALLY_SIGNED));
  assert.ok(has(d, EV.WAITING_ON_SPOUSE_SIGNER));
});

// ── Authority / signers ──────────────────────────────────────────────────────

test("married seller needs spouse → waiting_on_spouse", () => {
  const d = run("my wife also owns it", { seller_email: "bob@example.com" });
  assert.equal(d.ownership_structure, OWNERSHIP_STRUCTURE.MARRIED_COUPLE);
  assert.equal(d.outcome, STAGE6_OUTCOMES.WAITING_ON_SPOUSE);
  assert.equal(d.signer_count_required, 2);
  assert.ok(has(d, EV.WAITING_ON_SPOUSE_SIGNER));
});

test("two owners required → waiting_on_co_signer", () => {
  const d = run("my brother is on title", { seller_email: "bob@example.com" });
  assert.equal(d.ownership_structure, OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS);
  assert.equal(d.outcome, STAGE6_OUTCOMES.WAITING_ON_CO_SIGNER);
  assert.ok(has(d, EV.WAITING_ON_CO_SIGNER));
});

test("LLC owner → waiting_on_llc_authority", () => {
  const d = run("the llc owns it", { seller_email: "bob@example.com" });
  assert.equal(d.ownership_structure, OWNERSHIP_STRUCTURE.LLC);
  assert.equal(d.outcome, STAGE6_OUTCOMES.WAITING_ON_LLC_AUTHORITY);
  assert.ok(has(d, EV.WAITING_ON_LLC_AUTHORITY));
});

test("trust owner → waiting_on_trustee", () => {
  const d = run("it's in a trust", { seller_email: "bob@example.com" });
  assert.equal(d.ownership_structure, OWNERSHIP_STRUCTURE.TRUST);
  assert.equal(d.outcome, STAGE6_OUTCOMES.WAITING_ON_TRUSTEE);
  assert.ok(has(d, EV.WAITING_ON_TRUSTEE));
});

test("executor → waiting_on_executor", () => {
  const d = run("i am the executor", { seller_email: "bob@example.com" });
  assert.equal(d.ownership_structure, OWNERSHIP_STRUCTURE.ESTATE);
  assert.equal(d.outcome, STAGE6_OUTCOMES.WAITING_ON_EXECUTOR);
  assert.ok(has(d, EV.WAITING_ON_EXECUTOR));
});

test("heir → heirship_detected", () => {
  const d = run("i'm one of the heirs", { seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.HEIRSHIP_DETECTED);
  assert.ok(has(d, EV.HEIRSHIP_DETECTED));
});

test("probate mention → probate_detected", () => {
  const d = run("the property is in probate", { seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.PROBATE_DETECTED);
  assert.ok(has(d, EV.PROBATE_DETECTED));
});

test("title issue mention → title_issue_detected", () => {
  const d = run("there's a lien on the property", { seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.TITLE_ISSUE_DETECTED);
  assert.equal(d.title_clearance_level, "blocked");
  assert.ok(has(d, EV.TITLE_ISSUE_DETECTED));
});

test("authority verified (spouse confirmed) → contract_ready", () => {
  const d = run("my wife also owns it", { signer_count_confirmed: 2, seller_email: "bob@example.com" });
  assert.equal(d.authority_verified, true);
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_READY);
  assert.ok(has(d, EV.AUTHORITY_VERIFIED));
});

test("authority unresolved (corporation) → authority_verification_required", () => {
  const d = run("it's owned by my corporation", { seller_email: "bob@example.com" });
  assert.equal(d.authority_verified, false);
  assert.equal(d.outcome, STAGE6_OUTCOMES.AUTHORITY_VERIFICATION_REQUIRED);
});

// ── Disposition / terminal / review ──────────────────────────────────────────

test("ready for disposition (completed contract)", () => {
  const d = run("", { contract_status: "completed", seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.READY_FOR_DISPOSITION);
  assert.equal(d.stage_code, "S7");
  assert.ok(has(d, EV.READY_FOR_DISPOSITION));
});

test("contract declined", () => {
  const d = run("", { contract_status: "declined" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_DECLINED);
});

test("contract expired", () => {
  const d = run("", { contract_status: "expired" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_EXPIRED);
});

test("human review fallback (verified but no agreed price)", () => {
  const d = run("", { accepted_price: null, seller_asking_price: null, seller_email: "bob@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.HUMAN_REVIEW_REQUIRED);
});

// ── Multilingual ─────────────────────────────────────────────────────────────

test("Spanish contract request → contract_requested", () => {
  const d = run("mándame el contrato", { seller_email: "juan@example.com" });
  assert.equal(d.outcome, STAGE6_OUTCOMES.CONTRACT_REQUESTED);
  assert.ok(has(d, EV.CONTRACT_REQUESTED));
});

test("Spanish email → verified", () => {
  const d = run("mi correo es juan@example.com");
  assert.equal(d.email, "juan@example.com");
  assert.equal(d.email_verified, true);
});

test("Spanish signer requirement (mi esposa también es dueña) → waiting_on_spouse", () => {
  const d = run("mi esposa también es dueña", { seller_email: "juan@example.com" });
  assert.equal(d.ownership_structure, OWNERSHIP_STRUCTURE.MARRIED_COUPLE);
  assert.equal(d.outcome, STAGE6_OUTCOMES.WAITING_ON_SPOUSE);
});

// ── Reusable artifacts + safety ──────────────────────────────────────────────

test("contract packet schema is populated", () => {
  const d = run("send me the contract", { seller_email: "bob@example.com" });
  const pkt = d.contract_packet;
  assert.equal(pkt.accepted_price, 175000);
  assert.equal(pkt.seller_name, "John Doe");
  assert.equal(pkt.signer_count_required, 1);
  assert.equal(pkt.contract_ready, true);
  assert.equal(pkt.risk_level, "low");
});

test("contract risk profile flags entity authority risk", () => {
  const d = run("the llc owns it", { seller_email: "bob@example.com" });
  const rp = d.contract_risk_profile;
  assert.equal(rp.authority_risk, "high");
  assert.equal(rp.overall_risk, "high");
});

test("contract/legal routes never auto-send", () => {
  for (const [msg, ov] of [
    ["send me the contract", { seller_email: "bob@example.com" }],
    ["my wife also owns it", { seller_email: "bob@example.com" }],
    ["", { contract_status: "signed", seller_email: "bob@example.com" }],
  ]) {
    const d = run(msg, ov);
    assert.equal(d.auto_send_eligible, false, msg);
    assert.equal(d.safety_tier, "review", msg);
  }
});
