# The four critical-suite failures: what they are and whether they affect deployment readiness

Determined 2026-10-30 at the owner's direction. **They remain disclosed and unchanged.** No test or code was edited to make them pass.

Method:
- Each failing file was run on the code under review and on the base of the review range (`fde1f0b9`, in a temporary detached worktree).
- Each assertion was traced to the code it checks.

| # | Test | On base `fde1f0b9` | Introduced by this range? | What fails | Affects deployment readiness? |
|---|---|---|---|---|---|
| 1 | `agent-capabilities.test.mjs` #1, "matrix: the first capabilities…" | fails | **No**, inherited | The capability catalog contains `inbox.prepare_temperature_change` (`lib/agent/capabilities/defs/action-gateway-requests.js`), which the test's expected list predates. | **No.** The test's list is out of date. The capability is the human-approval-only temperature change (`t2/update-lead-temperature.js`: "dry run first, then the write, as the approving operator"). It is not on the agent-text path and sends nothing. The owner should confirm the capability is intended and update the list. |
| 2 | `agent-capabilities.test.mjs` #26, "routes: gate 404 → ops auth…" | fails | **No**, inherited | Expects 18 capability routes and finds 19. Same cause as #1. | **No.** Same as #1. |
| 3 | `conversation-ai-canonical-runtime-contract.test.mjs` #1, "…the R1 engine has no importer" | fails | **No**, inherited (`8fea2351`, 2026-10-22) | The static check's pattern `from ['"]\.\.?/engine\.js['"]` matches `lib/workforce/authority/assignment-authority.js`, which imports `./engine.js`: the **workforce authority** engine (`lib/workforce/authority/engine.js`), a different module. | **No.** This is a false positive in the test's pattern. Nothing imports the retired conversation-AI R1 engine (`conversation-ai/engine.js`). The fix belongs in the test: match the path `conversation-ai/engine.js`, not any `./engine.js`. |
| 4 | `v4fix-optout-protection-8521.test.mjs` #4, "S3: an uncertain stop-like whole message is a POSSIBLE opt-out…" | **passes** | **Yes**, by `4e788903` and the Portuguese addition in the review range | A whole-message "Chega" ("Enough!") is now a **confirmed opt-out**; the test expects the **precautionary hold**. | **No contact risk.** Both outcomes make the contact uncontactable. The change only *raises* the suppression level, a confirmed opt-out instead of a reviewable hold. **This needs an owner decision:** keep bare "Chega" as a confirmed STOP (then update the test's uncertain list), or return it to the precautionary hold. It was not changed here, under the instruction not to alter opt-out enforcement. |

**Conclusion:**
- **None of the four lets a message reach a contact who should not get one**, and none is on the agent-text send path.
- **Before production:**
  - failures 1–3 are test maintenance;
  - failure 4 is one owner decision about one word's suppression level.

## Update 2026-10-30: failure 4 resolved by the owner's decision

**The decision:** treat a standalone "Chega" as an opt-out in seller outreach, and keep contextual Portuguese that contains "chega" from being misclassified.

**What changed:**
- **The exact-keyword list.** `multilingual-opt-out.js` now has "chega", plus "já chega" / "ja chega", as confirmed whole-message STOPs.
- **The test.** `v4fix-optout-protection-8521.test.mjs` no longer lists bare "Chega" as uncertain.
- **A new test pins the decision both ways:**
  - the standalone forms are confirmed opt-outs: "Chega", "Chega!", "CHEGA", "Já chega!", "Chega de mensagens";
  - ordinary sentences are not: "Ele chega amanhã", "chega na sexta", "quando chega o documento?", "não chega a 200 mil" (a price objection) and "Meu filho chega hoje";
  - "chega de chuva aqui" is about the weather, so it is not an opt-out either;
  - "Chega disso" (the object is unstated) stays a **precautionary hold**: never contactable, and a person reviews it.

Failures 1–3 are unchanged: test maintenance, outside the send path.
