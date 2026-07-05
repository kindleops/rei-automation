import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "@/app/api/internal/dashboard/ops/map/resolve-ownership-check/route.js";
import { resolveMapOwnershipCheckIdentity } from "@/lib/domain/map/resolve-map-ownership-check.js";

const OPS_SECRET = process.env.OPS_DASHBOARD_SECRET || "test";

function makeRequest({ authorized = false, body = {} } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) {
    headers.set("x-ops-dashboard-secret", OPS_SECRET);
  }

  return {
    method: "POST",
    headers,
    json: async () => body,
    cookies: {
      get: () => undefined,
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  return JSON.parse(text);
}

test("unauthorized resolver request is rejected with 401", async () => {
  const response = await POST(makeRequest({
    body: { property_id: "274564949", hints: {} },
  }));
  assert.equal(response.status, 401);
  const payload = await readJson(response);
  assert.equal(payload.ok, false);
  assert.ok(payload.error);
});

test("authorized request validates property_id before resolver work", async () => {
  const response = await POST(makeRequest({
    authorized: true,
    body: { hints: { prospectFirstName: "Amanda" } },
  }));
  assert.equal(response.status, 400);
  const payload = await readJson(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "property_id is required");
});

test("authorized resolver request returns resolver contract when identity resolves", async () => {
  const fixtureIdentity = {
    propertyId: "274564949",
    masterOwnerId: "mo_804d2f26377bee1f43019235",
    phoneId: "ph_amanda",
    recipientPhone: "+16514428447",
    prospectId: "pros1_5d2dfe5ae95f982c0941f648",
    prospectFirstName: "Amanda",
    prospectFullName: "Amanda L Tallen",
    smsEligible: true,
    agentName: "Andre Thompson",
    agentFirstName: "Andre",
    ownerDisplayName: "Trust",
    ownerLanguage: "English",
    propertyAddress: "983 Edmund Ave, Saint Paul, MN 55104",
    sellerDisplayName: "Amanda L Tallen",
    smsAgentId: null,
    selectedAgentId: null,
    resolutionSource: "hydrated_map_identity",
    resolutionDiagnostics: { candidateCount: 1, source: "hydrated_map_identity" },
  };

  const tables = {
    properties: {
      property_id: "274564949",
      master_owner_id: "mo_804d2f26377bee1f43019235",
      property_address_full: "983 Edmund Ave, Saint Paul, MN 55104",
    },
    master_owners: {
      master_owner_id: "mo_804d2f26377bee1f43019235",
      best_phone_1: "+16514428447",
      primary_phone_id: "ph_amanda",
      display_name: "Trust",
      best_language: "English",
      agent_persona: "Andre Thompson",
      agent_family: null,
    },
  };

  const result = await resolveMapOwnershipCheckIdentity("274564949", {
    supabase: makeSupabase(tables),
    hints: {
      masterOwnerId: "mo_804d2f26377bee1f43019235",
      prospectId: "pros1_5d2dfe5ae95f982c0941f648",
      prospectFirstName: "Amanda",
      agentPersona: "Andre Thompson",
      smsEligible: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.identity.prospectFirstName, fixtureIdentity.prospectFirstName);
});

test("Amanda entity-owner phone mismatch resolves property-linked human prospect", async () => {
  const tables = {
    properties: {
      property_id: "274564949",
      master_owner_id: "mo_804d2f26377bee1f43019235",
      property_address_full: "983 Edmund Ave, Saint Paul, MN 55104",
    },
    master_owners: {
      master_owner_id: "mo_804d2f26377bee1f43019235",
      best_phone_1: "+16514428447",
      primary_phone_id: "ph_amanda",
      display_name: "mo_804d2f26377bee1f43019235 Trust",
      best_language: "English",
      agent_persona: "Andre Thompson",
      agent_family: null,
    },
    phones: {
      phone_id: "ph_amanda",
      master_owner_id: "mo_804d2f26377bee1f43019235",
      canonical_e164: "+16514428447",
      canonical_prospect_id: "pros_trust_entity",
      primary_prospect_id: null,
      linked_prospect_ids_json: ["pros_trust_entity"],
    },
    map_filter_property_prospect_links: {
      property_id: "274564949",
      master_owner_id: "mo_804d2f26377bee1f43019235",
      prospect_id: "pros1_5d2dfe5ae95f982c0941f648",
    },
    prospects: [
      {
        prospect_id: "pros1_5d2dfe5ae95f982c0941f648",
        first_name: "Amanda",
        full_name: "Amanda L Tallen",
        sms_eligible: true,
        master_owner_id: "mo_804d2f26377bee1f43019235",
      },
      {
        prospect_id: "pros_trust_entity",
        first_name: "Trust",
        full_name: "mo_804d2f26377bee1f43019235 Trust",
        sms_eligible: false,
        master_owner_id: "mo_804d2f26377bee1f43019235",
      },
    ],
  };

  const result = await resolveMapOwnershipCheckIdentity("274564949", {
    supabase: makeSupabase(tables),
    hints: {
      masterOwnerId: "mo_804d2f26377bee1f43019235",
      prospectId: "pros1_5d2dfe5ae95f982c0941f648",
      prospectFirstName: "Amanda",
      prospectFullName: "Amanda L Tallen",
      recipientPhone: "+16514428447",
      agentPersona: "Andre Thompson",
      smsEligible: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.identity.prospectFirstName, "Amanda");
  assert.equal(result.identity.phoneId, "ph_amanda");
});

test("sms_eligible=false blocks resolver", async () => {
  const tables = {
    properties: {
      property_id: "274564949",
      master_owner_id: "mo_804d2f26377bee1f43019235",
      property_address_full: "983 Edmund Ave, Saint Paul, MN 55104",
    },
    master_owners: {
      master_owner_id: "mo_804d2f26377bee1f43019235",
      best_phone_1: "+16514428447",
      primary_phone_id: "ph_amanda",
      display_name: "Trust",
      best_language: "English",
      agent_persona: "Andre Thompson",
      agent_family: null,
    },
  };

  const result = await resolveMapOwnershipCheckIdentity("274564949", {
    supabase: makeSupabase(tables),
    hints: {
      masterOwnerId: "mo_804d2f26377bee1f43019235",
      prospectId: "pros1_5d2dfe5ae95f982c0941f648",
      prospectFirstName: "Amanda",
      agentPersona: "Andre Thompson",
      smsEligible: false,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "prospect_not_sms_eligible");
});

test("missing agent blocks resolver", async () => {
  const tables = {
    properties: {
      property_id: "274564949",
      master_owner_id: "mo_804d2f26377bee1f43019235",
      property_address_full: "983 Edmund Ave, Saint Paul, MN 55104",
    },
    master_owners: {
      master_owner_id: "mo_804d2f26377bee1f43019235",
      best_phone_1: "+16514428447",
      primary_phone_id: "ph_amanda",
      display_name: "Trust",
      best_language: "English",
      agent_persona: null,
      agent_family: null,
    },
  };

  const result = await resolveMapOwnershipCheckIdentity("274564949", {
    supabase: makeSupabase(tables),
    hints: {
      masterOwnerId: "mo_804d2f26377bee1f43019235",
      prospectId: "pros1_5d2dfe5ae95f982c0941f648",
      prospectFirstName: "Amanda",
      smsEligible: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "assigned_agent_missing");
});

function makeSupabase(tables) {
  const from = (table) => {
    let filters = [];
    let limitCount = null;

    const execute = () => {
      const rows = tables[table];
      if (!rows) return { data: [], error: null };
      const list = Array.isArray(rows) ? rows : [rows];
      let matches = list.filter((row) =>
        filters.every((filter) => row[filter.column] === filter.value),
      );
      if (limitCount !== null) matches = matches.slice(0, limitCount);
      return { data: matches, error: null };
    };

    const api = {
      select: () => api,
      eq: (column, value) => {
        filters.push({ column, value });
        return api;
      },
      not: () => api,
      order: () => api,
      limit: (count) => {
        limitCount = count;
        return api;
      },
      maybeSingle: async () => {
        const { data, error } = execute();
        return { data: data[0] ?? null, error };
      },
      then: (resolve, reject) => Promise.resolve(execute()).then(resolve, reject),
    };

    return api;
  };

  return { from };
}