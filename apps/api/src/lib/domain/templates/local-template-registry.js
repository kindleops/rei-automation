import { createHash } from "node:crypto";

function createLocalTemplate({
  item_id,
  use_case,
  variant_group,
  sequence_position,
  text,
  english_translation = null,
  category_primary = "Residential",
  category_secondary = "Underwriting",
  tone = "Neutral",
  gender_variant = "Neutral",
  language = "English",
  paired_with_agent_type = "Fallback / Market-Local / Specialist-Close",
  is_first_touch = "No",
}) {
  return {
    item_id,
    title: null,
    raw: null,
    template_id: null,
    use_case,
    variant_group,
    tone,
    gender_variant,
    language,
    sequence_position,
    paired_with_agent_type,
    text,
    english_translation: english_translation || text,
    active: "Yes",
    is_first_touch,
    is_ownership_check: "No",
    category_primary,
    category_secondary,
    personalization_tags: [],
    deliverability_score: 92,
    spam_risk: 4,
    historical_reply_rate: 24,
    total_sends: 0,
    total_replies: 0,
    total_conversations: 0,
    cooldown_days: 3,
    version: 1,
    last_used: null,
    source: "local_registry",
  };
}

export const LOCAL_TEMPLATE_CANDIDATES = Object.freeze([
  // ── Stage 1 — First-touch ownership check ────────────────────────────────────
  // These are cold-outbound templates.  Avoid filler phrases ("Quick question"),
  // avoid city/state/zip in the address (street only after fix to extractStreetAddress),
  // and keep the tone human and brief so TextGrid content filters don't flag them.
  createLocalTemplate({
    item_id: "local-template:ownership_check:v1",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V1",
    category_secondary: "Outreach",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    is_first_touch: "Yes",
    text: "Hey {{seller_first_name}} — {{agent_first_name}} here. Do you still own the place at {{property_address}}?",
  }),
  createLocalTemplate({
    item_id: "local-template:ownership_check:v2",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V2",
    category_secondary: "Outreach",
    tone: "Neutral",
    paired_with_agent_type: "Fallback / Market-Local / Specialist-Close",
    is_first_touch: "Yes",
    text: "{{agent_first_name}} here — reaching out about {{property_address}}. Are you the owner there?",
  }),
  createLocalTemplate({
    item_id: "local-template:ownership_check:v3",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V3",
    category_secondary: "Outreach",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    is_first_touch: "Yes",
    text: "Hi {{seller_first_name}}, this is {{agent_first_name}}. Do you own {{property_address}}?",
  }),
  createLocalTemplate({
    item_id: "local-template:ownership_check:no-agent:v1",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V1",
    category_secondary: "Outreach",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    is_first_touch: "Yes",
    text: "Hi {{seller_first_name}}, checking on {{property_address}}. Do you still own it?",
  }),
  createLocalTemplate({
    item_id: "local-template:ownership_check:no-agent:v2",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V2",
    category_secondary: "Outreach",
    tone: "Neutral",
    paired_with_agent_type: "Fallback / Market-Local / Specialist-Close",
    is_first_touch: "Yes",
    text: "Reaching out about {{property_address}}. Are you the owner there?",
  }),
  // ── Stage 1 — Ownership Confirmation Follow-Up ────────────────────────────────
  createLocalTemplate({
    item_id: "local-template:follow_up:ownership:v1",
    use_case: "ownership_check_follow_up",
    variant_group: "Stage 1 — Ownership Confirmation Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "{{agent_first_name}} here following up on {{property_address}}. Are you the owner there?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:ownership:v2",
    use_case: "ownership_check_follow_up",
    variant_group: "Stage 1 — Ownership Confirmation Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Just circling back on {{property_address}}. Wanted to make sure I had the right owner.",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:consider-selling:v1",
    use_case: "consider_selling_follow_up",
    variant_group: "Stage 2 — Consider Selling Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Wanted to follow up on {{property_address}}. If the number made sense, would you consider selling it?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:consider-selling:v2",
    use_case: "consider_selling_follow_up",
    variant_group: "Stage 2 — Consider Selling Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Checking back on {{property_address}}. Would you be open to hearing an offer if it made sense?",
  }),
  // Stage 3 — Asking price (first reply after ownership + interest confirmed).
  // Proposal-safe wording: no offer/sell/buyer/purchase/cash.
  createLocalTemplate({
    item_id: "local-template:seller_asking_price:v1",
    use_case: "seller_asking_price",
    variant_group: "Stage 3 — Asking Price",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text: "Got it. What price would you have in mind for the property?",
  }),
  createLocalTemplate({
    item_id: "local-template:seller_asking_price:v1:es",
    use_case: "seller_asking_price",
    variant_group: "Stage 3 — Asking Price",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Warm",
    language: "Spanish",
    paired_with_agent_type: "Warm Professional",
    text: "Entendido. ¿Qué precio tendría en mente para la propiedad?",
    english_translation: "Got it. What price would you have in mind for the property?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:asking-price:v1",
    use_case: "asking_price_follow_up",
    variant_group: "Stage 3 — Asking Price Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Wanted to follow up on {{property_address}}. Do you have a number in mind for it?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:asking-price:v2",
    use_case: "asking_price_follow_up",
    variant_group: "Stage 3 — Asking Price Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Just circling back on {{property_address}}. What number would make it make sense for you?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:confirm-basics:v1",
    use_case: "price_works_confirm_basics_follow_up",
    variant_group: "Stage 4A — Confirm Basics Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Following up on {{property_address}}. Is it vacant, owner occupied, or rented right now?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:confirm-basics:v2",
    use_case: "price_works_confirm_basics_follow_up",
    variant_group: "Stage 4A — Confirm Basics Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Wanted to circle back on {{property_address}}. Is anyone living there now, and about what kind of shape is it in?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:condition-probe:v1",
    use_case: "price_high_condition_probe_follow_up",
    variant_group: "Stage 4B — Condition Probe Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Following up on {{property_address}}. Is it vacant or occupied, and about how much work would you say it needs?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:condition-probe:v2",
    use_case: "price_high_condition_probe_follow_up",
    variant_group: "Stage 4B — Condition Probe Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Just checking back on {{property_address}}. Before I respond on price, can you tell me if it is occupied and what kind of repairs it needs?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:offer-reveal:v1",
    use_case: "offer_reveal_cash_follow_up",
    variant_group: "Stage 5 — Offer Reveal Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Wanted to follow up on the number I sent for {{property_address}}. Any thoughts on it?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:offer-reveal:v2",
    use_case: "offer_reveal_cash_follow_up",
    variant_group: "Stage 5 — Offer Reveal Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Checking back on {{property_address}}. Did the number I sent make enough sense to keep talking?",
  }),
  createLocalTemplate({
    item_id: "local-template:justify_price:v1",
    use_case: "justify_price",
    variant_group: "Negotiation — Justify Price",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Warm",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "I get where you are coming from. My number is tied mostly to condition, repairs, and closing costs on {{property_address}}. If I am missing something there, tell me.",
  }),
  createLocalTemplate({
    item_id: "local-template:justify_price:v2",
    use_case: "justify_price",
    variant_group: "Negotiation — Justify Price",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    tone: "Human",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "Totally fair. On my side the number is based on what the place needs and what it costs me to close. What am I not seeing yet on {{property_address}}?",
  }),
  createLocalTemplate({
    item_id: "local-template:ask_timeline:v1",
    use_case: "ask_timeline",
    variant_group: "Negotiation — Timeline",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Human",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "Understood. How soon are you actually trying to get {{property_address}} sold?",
  }),
  createLocalTemplate({
    item_id: "local-template:ask_timeline:v2",
    use_case: "ask_timeline",
    variant_group: "Negotiation — Timeline",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    tone: "Empathetic",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "No pressure either way. What kind of timeline would make this make sense for you on {{property_address}}?",
  }),
  createLocalTemplate({
    item_id: "local-template:ask_condition_clarifier:v1",
    use_case: "ask_condition_clarifier",
    variant_group: "Negotiation — Condition Clarifier",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Warm",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "Before I move on price, can you tell me if {{property_address}} is vacant or occupied and what kind of work it needs?",
  }),
  createLocalTemplate({
    item_id: "local-template:ask_condition_clarifier:v2",
    use_case: "ask_condition_clarifier",
    variant_group: "Negotiation — Condition Clarifier",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    tone: "Human",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "Help me tighten the number up on {{property_address}}. Is anyone there now, and what repairs or updates would you say it needs?",
  }),
  createLocalTemplate({
    item_id: "local-template:narrow_range:v1",
    use_case: "narrow_range",
    variant_group: "Negotiation — Narrow Range",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Direct",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "If we are close on {{property_address}}, where would you need me to be to keep it moving?",
  }),
  createLocalTemplate({
    item_id: "local-template:narrow_range:v2",
    use_case: "narrow_range",
    variant_group: "Negotiation — Narrow Range",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    tone: "Direct",
    paired_with_agent_type: "Fallback / Market-Local",
    text:
      "What is the real number that gets {{property_address}} done for you if we keep this simple?",
  }),
  createLocalTemplate({
    item_id: "local-template:close_handoff:v1",
    use_case: "close_handoff",
    variant_group: "Stage 6 — Close / Handoff",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    tone: "Warm",
    paired_with_agent_type: "Soft Closer / Hard Closer / Ultra-Short",
    text:
      "Sounds like we may be in the ballpark on {{property_address}}. Want me to get the next step moving?",
  }),
  createLocalTemplate({
    item_id: "local-template:close_handoff:v2",
    use_case: "close_handoff",
    variant_group: "Stage 6 — Close / Handoff",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    tone: "Warm",
    paired_with_agent_type: "Soft Closer / Hard Closer / Ultra-Short",
    text:
      "If this feels close enough on {{property_address}}, I can move things to the next step. Want me to do that?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:mf-units:v1",
    use_case: "mf_confirm_units_follow_up",
    variant_group: "Multifamily Underwrite — Units Follow-Up",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
    text:
      "Just circling back on {{property_address}}. How many total units are there?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:mf-occupancy:v1",
    use_case: "mf_occupancy_follow_up",
    variant_group: "Multifamily Underwrite — Occupancy Follow-Up",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
    text:
      "Following up on {{property_address}}. About how many units are occupied right now?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:mf-rents:v1",
    use_case: "mf_rents_follow_up",
    variant_group: "Multifamily Underwrite — Rents Follow-Up",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
    text:
      "Just checking back on {{property_address}}. Do you know a ballpark of the monthly rents?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:mf-expenses:v1",
    use_case: "mf_expenses_follow_up",
    variant_group: "Multifamily Underwrite — Expenses Follow-Up",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
    text:
      "Any ballpark on the expenses for {{property_address}}, even if it is rough?",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_units_unknown:v1",
    use_case: "mf_confirm_units",
    variant_group: "Multifamily Underwrite - Units (Open)",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    text:
      "Just so I underwrite {{property_address}} correctly, how many total units are there?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_units_unknown:v2",
    use_case: "mf_confirm_units",
    variant_group: "Multifamily Underwrite - Units (Open)",
    sequence_position: "V2",
    category_primary: "Landlord / Multifamily",
    text:
      "Quick MF underwriting check on {{property_address}}: what’s the total unit count?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_occupancy:v1",
    use_case: "mf_occupancy",
    variant_group: "Multifamily Underwrite — Occupancy",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    text:
      "Just to confirm, {{property_address}} is {{units}} units, correct? How many are currently occupied?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_occupancy:v2",
    use_case: "mf_occupancy",
    variant_group: "Multifamily Underwrite — Occupancy",
    sequence_position: "V2",
    category_primary: "Landlord / Multifamily",
    text:
      "Got it on {{property_address}}. About how many of the units are occupied right now?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_rents:v1",
    use_case: "mf_rents",
    variant_group: "Multifamily Underwrite — Rents",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    text:
      "Got it. Do you know a ballpark of the monthly rents at {{property_address}}?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_rents:v2",
    use_case: "mf_rents",
    variant_group: "Multifamily Underwrite — Rents",
    sequence_position: "V2",
    category_primary: "Landlord / Multifamily",
    text:
      "Thanks. Any rough idea what the place brings in each month at {{property_address}}?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_expenses:v1",
    use_case: "mf_expenses",
    variant_group: "Multifamily Underwrite — Expenses",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    text:
      "Thanks for that. Any idea of the expenses, even just a ballpark?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_expenses:v2",
    use_case: "mf_expenses",
    variant_group: "Multifamily Underwrite — Expenses",
    sequence_position: "V2",
    category_primary: "Landlord / Multifamily",
    text:
      "Appreciate it. Even a rough guess is fine. Any ballpark on taxes, insurance, utilities, or other expenses?",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_finalize_to_offer:v1",
    use_case: "mf_underwriting_ack",
    variant_group: "Multifamily Underwrite — Finalize",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    text:
      "No worries, I appreciate the info you gave me. I will run numbers on my end and circle back in a bit with an offer.",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:mf_finalize_to_offer:v2",
    use_case: "mf_underwriting_ack",
    variant_group: "Multifamily Underwrite — Finalize",
    sequence_position: "V2",
    category_primary: "Landlord / Multifamily",
    text:
      "I appreciate all the info you provided. I will run the numbers on my end and get back to you soon with where I would be on an offer.",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_probe:v1",
    use_case: "novation_probe",
    variant_group: "Novation Probe",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "If a straight cash number is the gap on {{property_address}}, would you be open to a novation-style option if it could net you more?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_probe:v2",
    use_case: "novation_probe",
    variant_group: "Novation Probe",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    text:
      "If retail price is what matters most on {{property_address}}, would you want to hear a novation route that may improve your net?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_condition_scope:v1",
    use_case: "novation_condition_scope",
    variant_group: "Novation Underwrite - Condition Scope",
    sequence_position: "V1",
    text:
      "Before I map the best novation path on {{property_address}}, what repairs or updates would a retail buyer notice first?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_condition_scope:v2",
    use_case: "novation_condition_scope",
    variant_group: "Novation Underwrite - Condition Scope",
    sequence_position: "V2",
    text:
      "Quick condition check on {{property_address}}: what would need to be fixed, refreshed, or cleaned up before putting it in front of retail buyers?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_listing_readiness:v1",
    use_case: "novation_listing_readiness",
    variant_group: "Novation Underwrite - Listing Readiness",
    sequence_position: "V1",
    text:
      "If we took a novation route on {{property_address}}, is it vacant or show-ready enough for photos and buyer walkthroughs?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_listing_readiness:v2",
    use_case: "novation_listing_readiness",
    variant_group: "Novation Underwrite - Listing Readiness",
    sequence_position: "V2",
    text:
      "For {{property_address}}, would we have clean access for photos/showings, or is there anything that would block listing it quickly?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_timeline:v1",
    use_case: "novation_timeline",
    variant_group: "Novation Underwrite - Timeline",
    sequence_position: "V1",
    text:
      "If we aimed for a higher-net novation exit on {{property_address}}, what timeline would you be comfortable with?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_timeline:v2",
    use_case: "novation_timeline",
    variant_group: "Novation Underwrite - Timeline",
    sequence_position: "V2",
    text:
      "How quickly do you need to be done on {{property_address}} if the net to you improves with a novation approach?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_net_to_seller:v1",
    use_case: "novation_net_to_seller",
    variant_group: "Novation Underwrite - Seller Net",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "To see if a novation path is worth it on {{property_address}}, what number do you need to walk away with after fees and closing costs?",
  }),
  createLocalTemplate({
    item_id: "local-template:novation_net_to_seller:v2",
    use_case: "novation_net_to_seller",
    variant_group: "Novation Underwrite - Seller Net",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    text:
      "What net amount would make {{property_address}} make sense for you if we structured it for a retail-style sale?",
  }),
  createLocalTemplate({
    item_id: "local-template:disposition_access_coordination:v1",
    use_case: "disposition_access_coordination",
    variant_group: "Disposition - Access Coordination",
    sequence_position: "V1",
    category_secondary: "Disposition",
    text:
      "We are lining up buyer access on {{property_address}}. What day and time window is easiest for photos or a quick walkthrough?",
  }),
  createLocalTemplate({
    item_id: "local-template:disposition_access_coordination:v2",
    use_case: "disposition_access_coordination",
    variant_group: "Disposition - Access Coordination",
    sequence_position: "V2",
    category_secondary: "Disposition",
    text:
      "To keep {{property_address}} moving, what access window works best for showings or buyer walkthroughs this week?",
  }),
  createLocalTemplate({
    item_id: "local-template:disposition_marketing_update:v1",
    use_case: "disposition_marketing_update",
    variant_group: "Disposition - Marketing Update",
    sequence_position: "V1",
    category_secondary: "Disposition",
    text:
      "Quick update on {{property_address}}: we are pushing the property out to active buyers now. I will keep you posted on access needs and serious interest.",
  }),
  createLocalTemplate({
    item_id: "local-template:disposition_marketing_update:v2",
    use_case: "disposition_marketing_update",
    variant_group: "Disposition - Marketing Update",
    sequence_position: "V2",
    category_secondary: "Disposition",
    text:
      "We have buyer-side marketing moving on {{property_address}} now. I will text you with any real showing activity or access needs as they come up.",
  }),
  // ── Reengagement — Generic follow-up for owners with unknown/unresolved stage ─
  // These fire when no stage-specific follow-up template exists, providing a
  // minimum-viable reengagement path.  They intentionally avoid agent_first_name
  // so they render even when no agent is assigned.
  createLocalTemplate({
    item_id: "local-template:reengagement:v1",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Hi {{seller_first_name}} — following up on {{property_address}}. Has anything changed on your end?",
  }),
  createLocalTemplate({
    item_id: "local-template:reengagement:v2",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Warm Professional",
    text:
      "Checking back in on {{property_address}}. Wanted to see if you had any updates.",
  }),
  createLocalTemplate({
    item_id: "local-template:reengagement:no-name:v1",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V3",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    paired_with_agent_type: "Fallback / Market-Local / Specialist-Close",
    text:
      "Following up on {{property_address}}. Are you still the owner?",
  }),
  // ── Spanish — First-touch ownership check ──────────────────────────────────────
  createLocalTemplate({
    item_id: "local-template:ownership_check:es:v1",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V1",
    category_secondary: "Outreach",
    tone: "Warm",
    language: "Spanish",
    paired_with_agent_type: "Warm Professional",
    is_first_touch: "Yes",
    text: "Hola {{seller_first_name}}, ¿usted es dueño de la propiedad en {{property_address}}?",
    english_translation: "Hello {{seller_first_name}}, do you own the property at {{property_address}}?",
  }),
  createLocalTemplate({
    item_id: "local-template:ownership_check:es:v2",
    use_case: "ownership_check",
    variant_group: "Stage 1 — Ownership Confirmation",
    sequence_position: "V2",
    category_secondary: "Outreach",
    tone: "Neutral",
    language: "Spanish",
    paired_with_agent_type: "Fallback / Market-Local / Specialist-Close",
    is_first_touch: "Yes",
    text: "Buenas, le escribo sobre {{property_address}}. ¿Es usted el propietario?",
    english_translation: "Hello, I am writing about {{property_address}}. Are you the owner?",
  }),
  // ── Spanish — Follow-up ownership check ────────────────────────────────────────
  createLocalTemplate({
    item_id: "local-template:follow_up:ownership:es:v1",
    use_case: "ownership_check_follow_up",
    variant_group: "Stage 1 — Ownership Confirmation Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    language: "Spanish",
    paired_with_agent_type: "Warm Professional",
    text: "Hola {{seller_first_name}}, dando seguimiento sobre {{property_address}}. ¿Sigue siendo el dueño?",
    english_translation: "Hello {{seller_first_name}}, following up on {{property_address}}. Are you still the owner?",
  }),
  createLocalTemplate({
    item_id: "local-template:follow_up:ownership:es:v2",
    use_case: "ownership_check_follow_up",
    variant_group: "Stage 1 — Ownership Confirmation Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Warm",
    language: "Spanish",
    paired_with_agent_type: "Warm Professional",
    text: "Le escribo de nuevo sobre {{property_address}}. ¿Tiene alguna novedad?",
    english_translation: "Writing again about {{property_address}}. Do you have any updates?",
  }),
  // ── Spanish — Reengagement ─────────────────────────────────────────────────────
  createLocalTemplate({
    item_id: "local-template:reengagement:es:v1",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    language: "Spanish",
    paired_with_agent_type: "Warm Professional",
    text: "Hola {{seller_first_name}}, dando seguimiento sobre {{property_address}}. ¿Ha cambiado algo?",
    english_translation: "Hello {{seller_first_name}}, following up on {{property_address}}. Has anything changed?",
  }),
  createLocalTemplate({
    item_id: "local-template:reengagement:es:v2",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V2",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    language: "Spanish",
    paired_with_agent_type: "Fallback / Market-Local / Specialist-Close",
    text: "Dando seguimiento sobre {{property_address}}. ¿Sigue siendo el propietario?",
    english_translation: "Following up on {{property_address}}. Are you still the owner?",
  }),
  // ── Spanish — Consider selling follow-up ───────────────────────────────────────
  createLocalTemplate({
    item_id: "local-template:follow_up:consider-selling:es:v1",
    use_case: "consider_selling_follow_up",
    variant_group: "Stage 2 — Consider Selling Follow-Up",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    language: "Spanish",
    paired_with_agent_type: "Warm Professional",
    text: "Quería dar seguimiento sobre {{property_address}}. Si el precio fuera justo, ¿consideraría vender?",
    english_translation: "Wanted to follow up on {{property_address}}. If the price was right, would you consider selling?",
  }),
  // ── Multifamily — Follow-up reengagement ───────────────────────────────────────
  createLocalTemplate({
    item_id: "local-template:reengagement:mf:v1",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V1",
    category_primary: "Landlord / Multifamily",
    category_secondary: "Follow-Up",
    tone: "Warm",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
    text:
      "Following up on {{property_address}}. Are you still the owner there?",
  }),
  createLocalTemplate({
    item_id: "local-template:reengagement:mf:v2",
    use_case: "reengagement",
    variant_group: "Reengagement — Generic Follow-Up",
    sequence_position: "V2",
    category_primary: "Landlord / Multifamily",
    category_secondary: "Follow-Up",
    tone: "Neutral",
    paired_with_agent_type: "Specialist-Landlord / Market-Local",
    text:
      "Checking back on {{property_address}}. Any updates on your end?",
  }),

  // ── Negotiation loop (spec §12) ─────────────────────────────────────────────
  // Monetary tokens ({{offer_price}}) render exclusively from persisted ADE
  // authority and fail closed without it. Comp statements render only the
  // policy-authorized sentence. Timing language follows the closing-term
  // policy — no calendar-day promises, no repetitive "cash" wording.
  createLocalTemplate({
    item_id: "local-template:condition_probe:v1",
    use_case: "condition_probe",
    variant_group: "Negotiation — Condition Probe",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Thanks for the details on {{property_address}}. How would you describe the overall condition — move-in ready, needs some updating, or bigger repairs?",
  }),
  createLocalTemplate({
    item_id: "local-template:condition_probe:v2",
    use_case: "condition_probe",
    variant_group: "Negotiation — Condition Probe",
    sequence_position: "V2",
    category_secondary: "Negotiation",
    text:
      "Got it. Anything on {{property_address}} that would need attention — roof, HVAC, plumbing, or is it in solid shape?",
  }),
  createLocalTemplate({
    item_id: "local-template:occupancy_probe:v1",
    use_case: "occupancy_probe",
    variant_group: "Negotiation — Occupancy Probe",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Is {{property_address}} currently vacant, owner-occupied, or rented out?",
  }),
  createLocalTemplate({
    item_id: "local-template:repair_clarification:v1",
    use_case: "repair_clarification",
    variant_group: "Negotiation — Repair Clarification",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Appreciate that. On the repairs you mentioned for {{property_address}} — roughly how extensive are they? Even a ballpark helps me be accurate.",
  }),
  createLocalTemplate({
    item_id: "local-template:flexibility_probe:v1",
    use_case: "flexibility_probe",
    variant_group: "Negotiation — Flexibility Probe",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Understood on the number for {{property_address}}. If we handled everything as-is with no repairs on your end and covered the customary closing costs, is there any flexibility there?",
  }),
  createLocalTemplate({
    item_id: "local-template:best_price_request:v1",
    use_case: "best_price_request",
    variant_group: "Negotiation — Best Price Request",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "I want to make sure I'm working with your real number on {{property_address}} — what's the best price you'd be comfortable with if we kept everything simple and as-is?",
  }),
  createLocalTemplate({
    item_id: "local-template:expectation_reset:v1",
    use_case: "expectation_reset",
    variant_group: "Negotiation — Expectation Reset",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "I hear you on {{property_address}}. To be straight with you, that number is above where we could responsibly land as a direct purchase with no repairs or fees on your side. If anything changes on price or timing, I'd still like to make this work.",
  }),
  createLocalTemplate({
    item_id: "local-template:comp_anchor:v1",
    use_case: "comp_anchor",
    variant_group: "Negotiation — Comp Anchor",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "For context on {{property_address}}: {{comp_anchor_statement}} That's a big part of how I have to look at the numbers. Does that change anything on your end?",
  }),
  createLocalTemplate({
    item_id: "local-template:repair_anchor:v1",
    use_case: "repair_anchor",
    variant_group: "Negotiation — Repair Anchor",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Factoring in the work {{property_address}} needs, I have to budget the repairs before resale. That's what drives my number — I'm not discounting it arbitrarily.",
  }),
  createLocalTemplate({
    item_id: "local-template:initial_offer:v1",
    use_case: "initial_offer",
    variant_group: "Negotiation — Initial Offer",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Based on everything you've shared about {{property_address}}, I can purchase it directly, as-is, for {{offer_price}} — no repairs on your end, and we handle the customary closing costs. Would that work for you?",
  }),
  createLocalTemplate({
    item_id: "local-template:conditional_offer:v1",
    use_case: "conditional_offer",
    variant_group: "Negotiation — Conditional Offer",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Here's where I can be on {{property_address}}: {{offer_price}}, buying directly and as-is, with no repairs needed before closing. If the condition checks out the way you described, I can stand on that number.",
  }),
  createLocalTemplate({
    item_id: "local-template:counter_offer:v1",
    use_case: "counter_offer",
    variant_group: "Negotiation — Counter Offer",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "I appreciate you working with me on {{property_address}}. I can come up to {{offer_price}} — as-is, no repairs on your side, and we work around your preferred timing. Can we make that work?",
  }),
  createLocalTemplate({
    item_id: "local-template:final_offer:v1",
    use_case: "final_offer",
    variant_group: "Negotiation — Final Authorized Offer",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "I want to be upfront with you on {{property_address}}: {{offer_price}} is the very top of what I can do as a direct as-is purchase. If that works, I'm ready to move forward on your timeline. If not, no hard feelings — I'd rather be honest than waste your time.",
  }),
  createLocalTemplate({
    item_id: "local-template:accept_terms:v1",
    use_case: "accept_terms",
    variant_group: "Negotiation — Accept Terms",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "That works — {{offer_price}} for {{property_address}}, purchased directly and as-is, no repairs on your end, and we handle the customary closing costs. To get the paperwork right, I just need a few details from you.",
  }),
  createLocalTemplate({
    item_id: "local-template:seller_finance_probe:v1",
    use_case: "seller_finance_probe",
    variant_group: "Negotiation — Seller Finance Probe",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "One thought on {{property_address}}: if getting closer to your number matters more than getting everything at closing, would you be open to receiving part of it as monthly payments? It can often get you a better total price.",
  }),
  createLocalTemplate({
    item_id: "local-template:future_nurture:v1",
    use_case: "future_nurture",
    variant_group: "Negotiation — Future Nurture",
    sequence_position: "V1",
    category_secondary: "Follow-Up",
    tone: "Warm",
    text:
      "Totally understand — sounds like we're not lined up on {{property_address}} right now. I'll check back down the road; if your plans or price change sooner, I'm easy to reach at this number.",
  }),
  createLocalTemplate({
    item_id: "local-template:contract_information_request:v1",
    use_case: "contract_information_request",
    variant_group: "Negotiation — Contract Information",
    sequence_position: "V1",
    category_secondary: "Negotiation",
    text:
      "Great — to draw up the agreement for {{property_address}} I need: everyone who's on the title, the best email for documents, whether anyone lives there now, and your preferred closing timing. Whenever you're ready.",
  }),
]);

// ── Local auto-reply approval controls (spec §12 release gate) ───────────────
// A local template is never auto-sendable merely because it exists in source.
// Every auto-reply-eligible negotiation template carries an explicit approval
// record: status, immutable version, pinned content hash (the approval binds
// to the exact wording — editing the text without re-approving revokes it),
// approved environments, the strategies allowed to select it, and the
// CANONICAL lifecycle stage code (S4 discovery / S5 negotiation / S6 contract
// — never a use case). A kill switch revokes fallback instantly via env:
//   LOCAL_TEMPLATE_FALLBACK_DISABLED=1        → all local auto-reply fallback off
//   LOCAL_TEMPLATE_KILL_LIST=id1,id2|use_case → listed templates/use cases off

function negotiationApproval({ stage_code, allowed_strategies, content_hash }) {
  return Object.freeze({
    approval_status: "approved",
    approval_version: 1,
    content_hash,
    approved_environments: Object.freeze(["production", "preview", "development", "test"]),
    allowed_strategies: Object.freeze(allowed_strategies),
    stage_code,
  });
}

export const LOCAL_NEGOTIATION_AUTO_REPLY_APPROVALS = Object.freeze({
  // S4 — condition / occupancy / repair discovery
  "local-template:condition_probe:v1": negotiationApproval({
    stage_code: "S4",
    allowed_strategies: ["condition_discovery"],
    content_hash: "99c8f62c84128933d16757c6981cf43d722e1850706ec3caa4731e05f17e56b6",
  }),
  "local-template:condition_probe:v2": negotiationApproval({
    stage_code: "S4",
    allowed_strategies: ["condition_discovery"],
    content_hash: "22342a905f027db8900762b214254fe2e4aadc57b3161866d25136910c28415a",
  }),
  "local-template:occupancy_probe:v1": negotiationApproval({
    stage_code: "S4",
    allowed_strategies: ["occupancy_discovery"],
    content_hash: "dd6fd839b2c072b041fbe35108b2d00820cb125ab785d26d5a9c5f15f51566bb",
  }),
  "local-template:repair_clarification:v1": negotiationApproval({
    stage_code: "S4",
    allowed_strategies: ["condition_discovery"],
    content_hash: "e3917f4005cb51381af901b64c55f9a272b5ffe9d8430cfe241d4df0b71df841",
  }),
  // S5 — negotiation and offer actions
  "local-template:flexibility_probe:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["flexibility_probe"],
    content_hash: "b50e9c6bbc85150361af94a2b4e976547f2574e62201d7a57b420888b54d5d4b",
  }),
  "local-template:best_price_request:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["best_price_request"],
    content_hash: "472e3d03ef578247b3b2f852bc271ca6a3346d39f8f6f4937a51f7b060351779",
  }),
  "local-template:expectation_reset:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["expectation_reset"],
    content_hash: "ff001f7bb99aa78d803cd73ff2c1db30625eb48bad87756922157a872f870804",
  }),
  "local-template:comp_anchor:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["comp_anchor"],
    content_hash: "6cf9d9a44bbc82d0313eafc2978b58358fff1d474969d0101cf7937e83f5bbaf",
  }),
  "local-template:repair_anchor:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["repair_anchor"],
    content_hash: "b570910f8d4d49ae22f7fa0b33b6e55f89a250a82e576fd09e33227471c4b6cb",
  }),
  "local-template:initial_offer:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["initial_offer", "direct_purchase"],
    content_hash: "1df8a6dd1b51a40985a22940641ab576f91c5b711c43597baaac630dedd10261",
  }),
  "local-template:conditional_offer:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["conditional_offer"],
    content_hash: "1160a9bfd688887ce624e86a17464c75f745308e63c00d311dad958c63ffc9a8",
  }),
  "local-template:counter_offer:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["counter_offer"],
    content_hash: "2ec4c35050d703794f51525edcef77d1afbdfaf551fe60ff51eb8d293f72112a",
  }),
  "local-template:final_offer:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["final_authorized_offer"],
    content_hash: "ebc5422d0fa52a47cea5aea96556bdeaa7122378c82d1e12558bd115e13acaa9",
  }),
  "local-template:accept_terms:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["accept_seller_terms"],
    content_hash: "31f6d2b63d22edbfdbd927ff4e704456d5a67869313e4d3eeddb425ff9b2e86e",
  }),
  "local-template:novation_probe:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["novation_probe"],
    content_hash: "c7b905b38ea54387ab187d8ba929d229f4d3f781157cc39e359f0e6eb48a7c2f",
  }),
  "local-template:novation_probe:v2": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["novation_probe"],
    content_hash: "d905f24f4990c1eba5b323b461810b7cf0bc6fb2f226d8f4f9cbb8093ab0f80e",
  }),
  "local-template:seller_finance_probe:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["seller_finance_probe"],
    content_hash: "d37267dbb20a9bbacd2592ba0a03b08585f351c61a9f700f47811de51691aec8",
  }),
  "local-template:future_nurture:v1": negotiationApproval({
    stage_code: "S5",
    allowed_strategies: ["future_nurture"],
    content_hash: "1bd461908c54b39aed6a8d045b18b8d651630ff546e899ae012f7de0ef5f0aa7",
  }),
  // S6 — contract-information collection
  "local-template:contract_information_request:v1": negotiationApproval({
    stage_code: "S6",
    allowed_strategies: ["accept_seller_terms"],
    content_hash: "55062d2167284cff395d1b0d3b4dc586fcf0c247b69665c5f88a86680ec6ee19",
  }),
});

export function hashLocalTemplateContent(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function resolveLocalTemplateEnvironment(env = process.env) {
  const vercelEnv = String(env?.VERCEL_ENV ?? "").trim().toLowerCase();
  if (["production", "preview", "development"].includes(vercelEnv)) return vercelEnv;
  const nodeEnv = String(env?.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "test") return "test";
  return "development";
}

export function isLocalTemplateFallbackKilled(itemIdOrUseCase = null, env = process.env) {
  const globalKill = String(env?.LOCAL_TEMPLATE_FALLBACK_DISABLED ?? "").trim().toLowerCase();
  if (globalKill === "1" || globalKill === "true" || globalKill === "yes") return true;
  if (!itemIdOrUseCase) return false;
  const killList = String(env?.LOCAL_TEMPLATE_KILL_LIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return killList.includes(String(itemIdOrUseCase).trim().toLowerCase());
}

/**
 * Verify a local template is approved for auto-reply right now: explicit
 * approval record, content hash matching the exact current text, current
 * environment approved, the active strategy allowed, and no kill switch.
 * Fails closed — any missing/failed gate returns approved:false.
 */
export function verifyLocalAutoReplyApproval(template = {}, { strategy = null, env = process.env } = {}) {
  const reasons = [];
  const approval = LOCAL_NEGOTIATION_AUTO_REPLY_APPROVALS[template?.item_id] || null;

  if (!approval || approval.approval_status !== "approved") {
    return { approved: false, reasons: ["no_approval_record"], approval: null };
  }
  if (hashLocalTemplateContent(template?.text) !== approval.content_hash) {
    reasons.push("content_hash_mismatch");
  }
  const environment = resolveLocalTemplateEnvironment(env);
  if (!approval.approved_environments.includes(environment)) {
    reasons.push("environment_not_approved");
  }
  const activeStrategy = String(strategy ?? "").trim().toLowerCase();
  if (activeStrategy && !approval.allowed_strategies.includes(activeStrategy)) {
    reasons.push("strategy_not_allowed");
  }
  if (
    isLocalTemplateFallbackKilled(template?.item_id, env) ||
    isLocalTemplateFallbackKilled(template?.use_case, env)
  ) {
    reasons.push("kill_switch_active");
  }

  return { approved: reasons.length === 0, reasons, approval };
}

export default LOCAL_TEMPLATE_CANDIDATES;
