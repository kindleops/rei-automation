/**
 * DEV-ONLY FIXTURE — masked records from the 2026-10-13 historical shadow replay
 * (phones/emails masked, names → [first]/[name], addresses → [address]). Loaded ONLY
 * through the dev-flagged dynamic import in conversation-intel-model.ts
 * (import.meta.env.DEV && VITE_LC_CONV_AI_SHADOW_FIXTURE === '1'); production
 * builds never reach this module. Always labelled FIXTURE in the UI.
 */
import type { ShadowRecord } from './conversation-intel-model'

export const CONVERSATION_INTEL_FIXTURE: ShadowRecord[] = [
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-1",
  "inbound_message_id": "fixture-1",
  "thread_ref": "thr_fixtureaaa",
  "created_at": "2026-10-06T14:30:15.217Z",
  "seller_message_masked": "Questioned “What's Your Proposal ”",
  "our_last_message_masked": "Do you have an asking price in mind?",
  "understood": {
   "intent": "asks_offer",
   "seller_interest": "interested",
   "confidence": 0.85
  },
  "facts": {
   "extracted": [
    {
     "fact": "offer_request",
     "value": "asked_for_offer",
     "source_message_id": "fixture-1",
     "confidence": 0.9
    }
   ],
   "already_known": [
    "offer_request",
    "property_reference",
    "identity_role",
    "listing_status"
   ]
  },
  "stage_evidence": {
   "stage": "S3_asking_price",
   "evidence_message_ids": [],
   "rationale": "Seller asked for our proposal. We already asked the asking-price question (f3a7a0be) and the seller deflected it by asking for our number, so per the flow we must not re-ask price. Condition is unknown, so the next stage question is condition (S4). Offer itself is a human step; no number is stated. Stage remains S3 as asking price was never answered; the deterministic context label of S4 is inconsistent with the evidence."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "get_condition",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-1"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000574,
     "latency_ms": 4133,
     "input_tokens": 1307,
     "output_tokens": 818,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.00014,
     "latency_ms": 1412,
     "input_tokens": 449,
     "output_tokens": 177,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "Fair question. I don't have a number to share yet, and I'd want to understand the property first. How would you describe its overall condition?",
   "chars": 143,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "validated_draft",
   "reasons": [],
   "question_kind": "condition"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000714,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000714
  },
  "latency_ms": 5554,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": "unclear",
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-2",
  "inbound_message_id": "fixture-2",
  "thread_ref": "thr_fixturebbb",
  "created_at": "2026-10-13T21:33:33.312Z",
  "seller_message_masked": "What's your proposal",
  "our_last_message_masked": "Got it. What price would you be looking for?",
  "understood": {
   "intent": "asks_offer",
   "seller_interest": "interested",
   "confidence": 0.85
  },
  "facts": {
   "extracted": [
    {
     "fact": "offer_request",
     "value": "asked_for_offer",
     "source_message_id": "fixture-2",
     "confidence": 0.95
    },
    {
     "fact": "seller_interest",
     "value": "interested",
     "source_message_id": "fixture-2",
     "confidence": 0.85
    }
   ],
   "already_known": [
    "ownership",
    "offer_request",
    "seller_interest",
    "property_reference"
   ]
  },
  "stage_evidence": {
   "stage": "S3_asking_price",
   "evidence_message_ids": [],
   "rationale": "Ownership confirmed and seller said Absolutely to a proposal. Asking price was asked in 0a77451c and the seller deflected by asking for our proposal again (432750f7). Per the rules, we asked the asking price already, so do not re-ask it. Condition is unknown, so the next step is S4 condition. The stage was not yet S4 because the seller never gave a price, but the asking_price question was already deflected, so the move is to S4 and ask about condition. Any offer must go to a human."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "get_condition",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-2"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000643,
     "latency_ms": 4180,
     "input_tokens": 1470,
     "output_tokens": 923,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.000154,
     "latency_ms": 1490,
     "input_tokens": 573,
     "output_tokens": 180,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "I can't quote a number over text, that needs a quick review on our side. Can you tell me a bit about the property's overall condition, any major repairs needed?",
   "chars": 160,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "validated_draft",
   "reasons": [],
   "question_kind": "condition"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000797,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000797
  },
  "latency_ms": 5682,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": null,
   "queued_reply": [
    {
     "use_case": "seller_asking_price",
     "status": "cancelled"
    }
   ]
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-3",
  "inbound_message_id": "fixture-3",
  "thread_ref": "thr_fixtureccc",
  "created_at": "2026-10-06T23:15:40.680Z",
  "seller_message_masked": "No but market value",
  "our_last_message_masked": "Any asking price in mind?",
  "understood": {
   "intent": "asking_price_provided",
   "seller_interest": "conditional",
   "confidence": 0.8
  },
  "facts": {
   "extracted": [
    {
     "fact": "seller_interest",
     "value": "conditional",
     "source_message_id": "fixture-3",
     "confidence": 0.8
    }
   ],
   "already_known": [
    "occupancy",
    "condition",
    "offer_request",
    "seller_interest"
   ]
  },
  "stage_evidence": {
   "stage": "S3_asking_price",
   "evidence_message_ids": [],
   "rationale": "Seller deflected the asking price question ('No but market value') and tied any deal to market value. Condition is already disclosed, so S4 is complete. Asking price remains unanswered and was already asked once; the stage is still S3 with a deflection. Seller's comment about market value is a price-related position that needs a human to handle, not a number we can state."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "NEEDS_REVIEW",
   "next_objective": "offer_needs_human",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": false,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-3"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000572,
     "latency_ms": 3111,
     "input_tokens": 1895,
     "output_tokens": 695,
     "valid": true
    }
   ]
  },
  "draft": null,
  "validation": {
   "status": "not_applicable",
   "reasons": [],
   "question_kind": null
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000572,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000572
  },
  "latency_ms": 3123,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": "unclear",
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-4",
  "inbound_message_id": "fixture-4",
  "thread_ref": "thr_fixtureddd",
  "created_at": "2026-10-13T20:33:36.427Z",
  "seller_message_masked": "Only if it's market value",
  "our_last_message_masked": "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?",
  "understood": {
   "intent": "conditional_interest",
   "seller_interest": "conditional",
   "confidence": 0.8
  },
  "facts": {
   "extracted": [],
   "already_known": [
    "property_reference"
   ]
  },
  "stage_evidence": {
   "stage": "S2_interest",
   "evidence_message_ids": [],
   "rationale": "Seller answered our interest question with a conditional: only if the price is market value. Interest is conditional, so S2 is still in progress; asking price (S3) is the next stage but ownership was never explicitly confirmed. The seller's earlier 'Why' was not answered as an ownership confirmation."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "get_asking_price",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-4"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000481,
     "latency_ms": 2856,
     "input_tokens": 989,
     "output_tokens": 695,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.000125,
     "latency_ms": 1244,
     "input_tokens": 345,
     "output_tokens": 168,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "Thanks, [first]. Fair enough. What number would work for you on [address]?",
   "chars": 76,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "rejected_with_reasons",
   "reasons": [
    "policy_low_confidence",
    "semantic_irrelevant"
   ],
   "question_kind": "asking_price"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000606,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000606
  },
  "latency_ms": 4106,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": null,
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-5",
  "inbound_message_id": "fixture-5",
  "thread_ref": "thr_fixtureeee",
  "created_at": "2026-10-13T15:36:42.061Z",
  "seller_message_masked": "Sorry I dont know who this is",
  "our_last_message_masked": "Hey [first], this is Helen. 🙂 Do you still own [address]?",
  "understood": {
   "intent": "who_is_this",
   "seller_interest": "unknown",
   "confidence": 0.85
  },
  "facts": {
   "extracted": [],
   "already_known": [
    "property_reference"
   ]
  },
  "stage_evidence": {
   "stage": "S1_ownership",
   "evidence_message_ids": [],
   "rationale": "Seller asked who we are. Ownership not yet confirmed; our ownership question was asked once and is unanswered. No ownership evidence yet."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "clarify_identity",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-5"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000404,
     "latency_ms": 2349,
     "input_tokens": 797,
     "output_tokens": 579,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.000131,
     "latency_ms": 1296,
     "input_tokens": 335,
     "output_tokens": 182,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "Sorry for the confusion, this is Helen, a local home buyer reaching out about [address] Are you the owner of that property?",
   "chars": 130,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "rejected_with_reasons",
   "reasons": [
    "semantic_duplicate_question"
   ],
   "question_kind": "ownership"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000535,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000535
  },
  "latency_ms": 3655,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": null,
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-6",
  "inbound_message_id": "fixture-6",
  "thread_ref": "thr_fixturefff",
  "created_at": "2026-10-06T19:31:43.849Z",
  "seller_message_masked": "No",
  "our_last_message_masked": "Hola [name], soy Alex. He estado invirtiendo en Los Angeles. Solo confirmando, eres dueno de [address]?",
  "understood": {
   "intent": "not_interested",
   "seller_interest": "not_interested",
   "confidence": 0.8
  },
  "facts": {
   "extracted": [],
   "already_known": []
  },
  "stage_evidence": {
   "stage": "S1_ownership",
   "evidence_message_ids": [],
   "rationale": "Our ownership question was asked and the seller replied with a bare 'No'. Per rules, after our ownership question a bare No means not_interested, not an explicit ownership denial. Ownership remains unconfirmed; the stage stays S1."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "NO_RESPONSE",
   "next_objective": "nurture_later",
   "response_needed": false,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": false,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-6"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000429,
     "latency_ms": 9597,
     "input_tokens": 795,
     "output_tokens": 629,
     "valid": true
    }
   ]
  },
  "draft": null,
  "validation": {
   "status": "not_applicable",
   "reasons": [],
   "question_kind": null
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000429,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000429
  },
  "latency_ms": 9615,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": "unclear",
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-7",
  "inbound_message_id": "fixture-7",
  "thread_ref": "thr_fixtureggg",
  "created_at": "2026-10-13T20:58:55.210Z",
  "seller_message_masked": "No",
  "our_last_message_masked": "Hola [first], Carmen aqui. Pregunta rapida. Solo confirmando, eres dueno de [address]?",
  "understood": {
   "intent": "unclear",
   "seller_interest": "not_interested",
   "confidence": 0.8
  },
  "facts": {
   "extracted": [],
   "already_known": []
  },
  "stage_evidence": {
   "stage": "S1_ownership",
   "evidence_message_ids": [],
   "rationale": "Our ownership question was asked and the seller replied with a bare 'No'. Per rules, a bare No after an ownership question is not_interested, not an ownership denial. Ownership remains unconfirmed; stage stays S1."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "NO_RESPONSE",
   "next_objective": "nurture_later",
   "response_needed": false,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": false,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-7"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000418,
     "latency_ms": 3096,
     "input_tokens": 803,
     "output_tokens": 607,
     "valid": true
    }
   ]
  },
  "draft": null,
  "validation": {
   "status": "not_applicable",
   "reasons": [],
   "question_kind": null
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000418,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000418
  },
  "latency_ms": 3328,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": "unclear",
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-8",
  "inbound_message_id": "fixture-8",
  "thread_ref": "thr_fixturehhh",
  "created_at": "2026-10-13T21:53:58.806Z",
  "seller_message_masked": "If you tell me why you want it?  Also [name] who and Company?",
  "our_last_message_masked": "Yeah are you open to a cash offer?",
  "understood": {
   "intent": "who_is_this",
   "seller_interest": "unknown",
   "confidence": 0.8
  },
  "facts": {
   "extracted": [],
   "already_known": [
    "property_reference"
   ]
  },
  "stage_evidence": {
   "stage": "S1_ownership",
   "evidence_message_ids": [],
   "rationale": "Ownership not yet confirmed. Seller is asking who we are and why we want the property. Our ownership question has not been answered; no ownership evidence in the thread."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "clarify_identity",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-8"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.00046,
     "latency_ms": 2729,
     "input_tokens": 1070,
     "output_tokens": 636,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.000128,
     "latency_ms": 1205,
     "input_tokens": 378,
     "output_tokens": 168,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "I'm [name], a local investor. I'm interested in buying [address] for cash and wanted to see if you own it. Are you the owner?",
   "chars": 132,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "rejected_with_reasons",
   "reasons": [
    "policy_low_confidence",
    "semantic_duplicate_question",
    "semantic_irrelevant"
   ],
   "question_kind": "ownership"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000588,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000588
  },
  "latency_ms": 3948,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": null,
   "queued_reply": []
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-9",
  "inbound_message_id": "fixture-9",
  "thread_ref": "thr_fixtureiii",
  "created_at": "2026-10-10T00:00:36.314Z",
  "seller_message_masked": "How much is do u think?",
  "our_last_message_masked": "Thanks for confirming. Would you consider a proposal for the property?",
  "understood": {
   "intent": "asks_offer",
   "seller_interest": "unknown",
   "confidence": 0.85
  },
  "facts": {
   "extracted": [
    {
     "fact": "offer_request",
     "value": "asked_for_offer",
     "source_message_id": "fixture-9",
     "confidence": 0.9
    }
   ],
   "already_known": [
    "ownership",
    "offer_request"
   ]
  },
  "stage_evidence": {
   "stage": "S2_interest",
   "evidence_message_ids": [],
   "rationale": "Ownership is confirmed. We asked whether they would consider a proposal, and the seller responded by asking us for a number instead of answering interest directly. Interest is not yet established, and the asking price has never been asked, so the conversation remains at S2. Under the stage flow the next step is S3, asking what number would work for them, and we must not state or hint at any price."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "get_asking_price",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-9"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.000523,
     "latency_ms": 3492,
     "input_tokens": 1143,
     "output_tokens": 749,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.00014,
     "latency_ms": 1545,
     "input_tokens": 472,
     "output_tokens": 173,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "We haven't set a number yet and don't want to guess. What price would work for you on [address]?",
   "chars": 100,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "validated_draft",
   "reasons": [],
   "question_kind": "asking_price"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000663,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000663
  },
  "latency_ms": 5059,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": "asks_offer",
   "queued_reply": [
    {
     "use_case": "condition_probe",
     "status": "delivered"
    }
   ]
  }
 },
 {
  "record_version": "conv-ai.shadow.v1",
  "idempotency_key": "conv-ai:v1:fixture-10",
  "inbound_message_id": "fixture-10",
  "thread_ref": "thr_fixturejjj",
  "created_at": "2026-10-06T22:32:58.614Z",
  "seller_message_masked": "What would the proposal be?",
  "our_last_message_masked": "Thanks, I am a local investor. Are you open to a proposal for the property?",
  "understood": {
   "intent": "asks_offer",
   "seller_interest": "interested",
   "confidence": 0.85
  },
  "facts": {
   "extracted": [
    {
     "fact": "offer_request",
     "value": "asked_for_offer",
     "source_message_id": "fixture-10",
     "confidence": 0.9
    }
   ],
   "already_known": [
    "ownership",
    "offer_request",
    "property_reference"
   ]
  },
  "stage_evidence": {
   "stage": "S2_interest",
   "evidence_message_ids": [],
   "rationale": "Seller confirmed ownership (Yes) and is asking what the proposal would be after our interest question. Interest is implied but the asking price (S3) has not been asked yet, so the next step is S3: ask what number would work for them, without giving any figure."
  },
  "decision": {
   "contract_version": "conv-ai.decision.v1",
   "outcome": "REPLY_CANDIDATE",
   "next_objective": "get_asking_price",
   "response_needed": true,
   "escalation_required": false,
   "escalation_reason": null,
   "send_permission_requested": true,
   "send_permission_granted": false,
   "source_message_ids": [
    "fixture-10"
   ],
   "fail_closed": null
  },
  "model": {
   "path": "haiku",
   "models": [
    "claude-haiku-5-5"
   ],
   "calls": [
    {
     "model": "claude-haiku-5-5",
     "route": "default",
     "usd": 0.0005,
     "latency_ms": 3302,
     "input_tokens": 1119,
     "output_tokens": 707,
     "valid": true
    },
    {
     "model": "claude-haiku-5-5",
     "route": "semantic_check",
     "usd": 0.000144,
     "latency_ms": 1356,
     "input_tokens": 417,
     "output_tokens": 192,
     "valid": true
    }
   ]
  },
  "draft": {
   "text": "Thanks for asking. I don't want to guess at a number before I understand the property. What price would work for you?",
   "chars": 117,
   "monetary_amounts": [],
   "needs_approval": false
  },
  "validation": {
   "status": "validated_draft",
   "reasons": [],
   "question_kind": "asking_price"
  },
  "send_status": "not_sent_shadow",
  "cost": {
   "haiku_usd": 0.000644,
   "sonnet_usd": 0,
   "other_usd": 0,
   "total_usd": 0.000644
  },
  "latency_ms": 4668,
  "policy_code": "AI_REPLY_POLICY_DISABLED",
  "before": {
   "recorded_intent": "asks_offer",
   "queued_reply": [
    {
     "use_case": "condition_probe",
     "status": "delivered"
    }
   ]
  }
 }
] as unknown as ShadowRecord[]
