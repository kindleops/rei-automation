/**
 * Deterministic corpus expansion from seed families.
 * Each permutation has explicit gold labels (not classify input).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_VERSION = JSON.parse(
  readFileSync(join(__dirname, "corpus-version.json"), "utf8")
).corpus_version;

const NAMES = [
  "Smith",
  "Garcia",
  "Johnson",
  "Lee",
  "Patel",
  "Nguyen",
  "Brown",
  "Wilson",
  "Martinez",
  "Anderson",
  "Thomas",
  "Jackson",
  "White",
  "Harris",
  "Clark",
];
const CITIES = [
  "Dallas",
  "Houston",
  "Austin",
  "Miami",
  "Atlanta",
  "Phoenix",
  "Denver",
  "Chicago",
  "Tampa",
  "Orlando",
  "Memphis",
  "Nashville",
];
const PRICES = [
  "150k",
  "175000",
  "200k",
  "225k",
  "250k",
  "275000",
  "300k",
  "325k",
  "180k",
  "190000",
  "210k",
  "240k",
];
const MODS_EN = [
  "",
  " please",
  " thanks",
  " asap",
  " if possible",
  " for the property",
  " on Main St",
  " today",
  " when you can",
  " bro",
  " sir",
  "!!",
];
const MODS_ES = [
  "",
  " por favor",
  " gracias",
  " pronto",
  " de la propiedad",
  " hoy",
  " señor",
  "!!",
];

function loadSeeds(name) {
  return JSON.parse(readFileSync(join(__dirname, "seeds", name), "utf8"));
}

/**
 * Expand seeds to target count with deterministic permutations.
 * Gold intent/stage remain those of the seed family.
 */
export function expandFixtures({ language, target_count }) {
  const seeds =
    language === "es" ? loadSeeds("spanish-seeds.json") : loadSeeds("english-seeds.json");
  const mods = language === "es" ? MODS_ES : MODS_EN;
  const fixtures = [];
  let i = 0;
  while (fixtures.length < target_count) {
    const seed = seeds[i % seeds.length];
    const perm = Math.floor(i / seeds.length);
    const name = NAMES[perm % NAMES.length];
    const city = CITIES[perm % CITIES.length];
    const price = PRICES[perm % PRICES.length];
    const mod = mods[perm % mods.length];
    // Meaningful variation: address context / name / price inject only when not changing core meaning
    let text = seed.text;
    if (perm % 3 === 1 && language === "en") {
      text = `${text}${mod}`.trim();
    } else if (perm % 3 === 2 && language === "en") {
      text = `${text} in ${city}${mod}`.trim();
    } else if (perm % 5 === 0 && /250k|180000|200k|220k/i.test(text)) {
      text = text.replace(/250k|180000|200k|220k|180k/gi, price);
    } else if (perm % 7 === 0 && language === "en") {
      text = `${text} - ${name}${mod}`.trim();
    } else {
      text = `${text}${mod}`.trim();
    }

    const idx = fixtures.length;
    fixtures.push({
      fixture_id: `${language}-${seed.family}-${String(idx).padStart(4, "0")}`,
      corpus_version: CORPUS_VERSION,
      language: language === "es" ? "Spanish" : "English",
      language_code: language,
      raw_inbound_text: text,
      message_timestamp: new Date(
        Date.UTC(2026, 0, 1, 15, 0, 0) + idx * 60_000
      ).toISOString(),
      canonical_thread: `+1555${String(1000000 + (idx % 8999999)).padStart(7, "0")}`,
      prior_conversation_context: [],
      expected_primary_intent: seed.expected_primary_intent,
      expected_secondary_intents: [],
      expected_facts: seed.expected_facts || [],
      expected_lifecycle_stage: seed.stage || null,
      expected_terminal: Boolean(seed.terminal),
      expected_human_review: Boolean(seed.human_review),
      seed_family: seed.family,
      permutation_index: perm,
    });
    i += 1;
  }
  return fixtures;
}

export function buildConversationJourneys() {
  const AS = "2026-07-18T15:00:00.000Z";
  const t = (sec) => new Date(Date.parse(AS) + sec * 1000).toISOString();
  const mk = (id, text, offset) => ({
    id,
    message: text,
    timestamp: t(offset),
    direction: "inbound",
  });

  return {
    A_straight_seller: {
      journey_id: "A_straight_seller",
      thread: "+15551000001",
      messages: [
        mk("a1", "Yes I own it", 0),
        mk("a2", "What's the proposal?", 30),
        mk("a3", "Around 250k", 60),
        mk("a4", "Needs a new roof", 90),
        mk("a5", "Send me the paperwork", 120),
      ],
      expected: {
        terminal: false,
        has_ownership: true,
        reaches_price_or_condition: true,
      },
    },
    B_multi_fact: {
      journey_id: "B_multi_fact",
      thread: "+15551000002",
      messages: [
        mk(
          "b1",
          "Yes I own it, want a proposal, around 200k, roof is old",
          0
        ),
      ],
      expected: { multi_fact: true },
    },
    C_skeptical: {
      journey_id: "C_skeptical",
      thread: "+15551000003",
      messages: [
        mk("c1", "Who is this?", 0),
        mk("c2", "Maybe depends on the price", 40),
      ],
      expected: { skeptical_or_interest: true },
    },
    D_price_negotiation: {
      journey_id: "D_price_negotiation",
      thread: "+15551000004",
      messages: [
        mk("d1", "Yes I own it", 0),
        mk("d2", "I want 300k for it", 20),
        mk("d3", "250k firm not flexible", 50),
      ],
      expected: { has_price: true },
    },
    E_probate: {
      journey_id: "E_probate",
      thread: "+15551000005",
      messages: [
        mk("e1", "Yes", 0),
        mk("e2", "Actually this is his brother", 15),
        mk("e3", "He passed away it is in probate", 40),
      ],
      expected: { authority_review: true },
    },
    F_llc: {
      journey_id: "F_llc",
      thread: "+15551000006",
      messages: [mk("f1", "The LLC owns the property", 0)],
      expected: { entity: true },
    },
    G_spouse: {
      journey_id: "G_spouse",
      thread: "+15551000007",
      messages: [
        mk("g1", "My wife is also on title", 0),
        mk("g2", "I can sign myself", 30),
      ],
      expected: { co_owner: true },
    },
    H_wrong_number: {
      journey_id: "H_wrong_number",
      thread: "+15551000008",
      messages: [mk("h1", "Wrong number", 0)],
      expected: { terminal: "wrong_number" },
    },
    I_opt_out: {
      journey_id: "I_opt_out",
      thread: "+15551000009",
      messages: [
        mk("i1", "Yeah", 0),
        mk("i2", "STOP", 20),
        mk("i3", "What's the proposal?", 40),
      ],
      expected: { terminal: "opt_out" },
    },
    J_spanish: {
      journey_id: "J_spanish",
      thread: "+15551000010",
      language: "es",
      messages: [
        mk("j1", "Sí, soy el dueño", 0),
        mk("j2", "Cuál es la propuesta?", 25),
        mk("j3", "Quiero 250 mil", 50),
        mk("j4", "Necesita techo nuevo", 80),
      ],
      expected: { language: "es" },
    },
    K_burst: {
      journey_id: "K_burst",
      thread: "+15551000011",
      messages: [
        mk("k1", "Yeah", 0),
        mk("k2", "What's the proposal?", 8),
        mk("k3", "Needs a roof", 15),
      ],
      expected: { one_burst: true },
    },
    L_followup_cancel: {
      journey_id: "L_followup_cancel",
      thread: "+15551000012",
      delivery: {
        outbound_id: "out-L",
        delivery_event_id: "del-L",
        delivery_status: "delivered",
        delivered_at: AS,
        provider_sid: "SMfollowupL",
        use_case: "ownership_check",
      },
      messages: [mk("l1", "Yes I own it", 100)],
      expected: { followup_cancel: true },
    },
    M_out_of_order: {
      journey_id: "M_out_of_order",
      thread: "+15551000013",
      // Intentionally reverse array order relative to timestamps
      messages: [
        mk("m2", "What's the proposal?", 30),
        mk("m1", "Yes I own it", 0),
      ],
      process_unsorted: true,
      expected: { stable_order: true },
    },
    N_under_contract: {
      journey_id: "N_under_contract",
      thread: "+15551000014",
      messages: [mk("n1", "We are already under contract", 0)],
      expected: { no_stage_8: true },
    },
    O_transaction: {
      journey_id: "O_transaction",
      thread: "+15551000015",
      authoritative_events: [
        { type: "disposition_package_created", stage_to: "disposition" },
        {
          type: "assignment_or_purchase_contract_executed",
          stage_to: "under_contract_with_buyer",
        },
        { type: "title_escrow_opened", stage_to: "escrow" },
        { type: "closing_confirmed", stage_to: "closed" },
      ],
      messages: [mk("o1", "Sounds good", 0)],
      expected: { auth_path: true },
    },
  };
}

/** Stage 1 canary provenance failure permanent regression */
export const CANARY_STAGE1_PROVENANCE_GAP = {
  fixture_id: "canary-stage1-missing-use-case",
  corpus_version: CORPUS_VERSION,
  sid: "SMO8VxnJAOWsNa926YKkFtS5w==",
  thread: "+16128072000",
  delivery_status: "delivered",
  outbound_use_case: null,
  template_use_case: null,
  automation_provenance: {},
  first_failing_guard: "outbound_use_case_or_template_use_case",
  expected_legacy_stage_plan_available: false,
};

export function createPipelineSpies() {
  const counts = {
    queue_writes: 0,
    provider_calls: 0,
    sender_selections: 0,
    stage_mutations: 0,
    suppression_mutations: 0,
    followup_production_schedules: 0,
  };
  return {
    counts,
    assertZero() {
      if (counts.queue_writes !== 0) throw new Error(`queue_writes=${counts.queue_writes}`);
      if (counts.provider_calls !== 0) throw new Error(`provider_calls=${counts.provider_calls}`);
      if (counts.sender_selections !== 0) {
        throw new Error(`sender_selections=${counts.sender_selections}`);
      }
      if (counts.stage_mutations !== 0) {
        throw new Error(`stage_mutations=${counts.stage_mutations}`);
      }
      if (counts.suppression_mutations !== 0) {
        throw new Error(`suppression_mutations=${counts.suppression_mutations}`);
      }
      if (counts.followup_production_schedules !== 0) {
        throw new Error(
          `followup_production_schedules=${counts.followup_production_schedules}`
        );
      }
    },
    // Fakes that would be production writers — must never succeed in corpus
    send_queue: {
      insert: async () => {
        counts.queue_writes += 1;
        throw new Error("SPY_QUEUE_WRITE_FORBIDDEN");
      },
      upsert: async () => {
        counts.queue_writes += 1;
        throw new Error("SPY_QUEUE_WRITE_FORBIDDEN");
      },
    },
    textgrid: {
      sendSms: async () => {
        counts.provider_calls += 1;
        throw new Error("SPY_PROVIDER_FORBIDDEN");
      },
    },
    selectSender: async () => {
      counts.sender_selections += 1;
      throw new Error("SPY_SENDER_FORBIDDEN");
    },
    mutateStage: async () => {
      counts.stage_mutations += 1;
      throw new Error("SPY_STAGE_MUTATION_FORBIDDEN");
    },
    writeSuppression: async () => {
      counts.suppression_mutations += 1;
      throw new Error("SPY_SUPPRESSION_FORBIDDEN");
    },
    scheduleProductionFollowup: async () => {
      counts.followup_production_schedules += 1;
      throw new Error("SPY_FOLLOWUP_PROD_FORBIDDEN");
    },
  };
}

export { CORPUS_VERSION };
