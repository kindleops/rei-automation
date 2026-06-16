import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "../lib/supabase/default-client.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (!clean(value)) return [];
  return clean(value).split(",").map(clean).filter(Boolean);
}

function normalizeMarket(value) {
  return lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeState(value) {
  return clean(value).toUpperCase();
}

function scopeIncludes(scope = [], value, normalizer = lower) {
  const normalizedValue = normalizer(value);
  if (!normalizedValue) return false;
  return asArray(scope).map(normalizer).includes(normalizedValue);
}

function languageAllowed(scope = [], language) {
  const languages = asArray(scope).map(lower);
  if (!languages.length || !clean(language)) return true;
  return languages.includes(lower(language));
}

function stableWeightedChoice(members = [], seed = "workflow-sender") {
  if (!members.length) return null;
  const totalWeight = members.reduce((sum, member) => {
    const weight = Number(member.weight);
    return sum + (Number.isFinite(weight) && weight > 0 ? weight : 1);
  }, 0);
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
  let cursor = Number.parseInt(digest, 16) % Math.max(1, Math.floor(totalWeight * 1000));
  cursor = cursor / 1000;

  for (const member of members) {
    const weight = Number(member.weight);
    cursor -= Number.isFinite(weight) && weight > 0 ? weight : 1;
    if (cursor <= 0) return member;
  }
  return members[0];
}

async function loadPools({ db, workflow_id, channel }) {
  let query = db
    .from("workflow_sender_pools")
    .select("*")
    .eq("workflow_id", workflow_id)
    .eq("is_active", true);
  if (clean(channel)) query = query.eq("channel", channel);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function loadMembers({ db, poolIds }) {
  if (!poolIds.length) return [];
  const { data, error } = await db
    .from("workflow_sender_pool_members")
    .select("*")
    .in("sender_pool_id", poolIds);
  if (error) throw error;
  return (data || []).filter((member) => clean(member.status || "active") === "active");
}

function choosePool(pools = [], context = {}) {
  const exact = pools.filter((pool) =>
    languageAllowed(pool.language_scope, context.language) &&
    scopeIncludes(pool.market_scope, context.market, normalizeMarket)
  );
  if (exact.length) return { pool: exact[0], tier: "exact_market", routing_reason: "exact_market_match" };

  const sameState = pools.filter((pool) =>
    languageAllowed(pool.language_scope, context.language) &&
    scopeIncludes(pool.state_scope, context.state, normalizeState)
  );
  if (sameState.length) return { pool: sameState[0], tier: "same_state", routing_reason: "same_state_match" };

  const clusterAllowed = context.allow_cluster_fallback === true || context.cluster_fallback_enabled === true;
  const cluster = pools.filter((pool) =>
    clusterAllowed &&
    clean(pool.routing_mode) === "cluster" &&
    languageAllowed(pool.language_scope, context.language)
  );
  if (cluster.length) return { pool: cluster[0], tier: "cluster", routing_reason: "configured_cluster_fallback" };

  return {
    pool: null,
    tier: "blocked",
    routing_reason: "unsafe_sender_fallback_blocked",
  };
}

export async function routeWorkflowSender(input = {}, deps = {}) {
  const db = deps.supabase || deps.supabaseClient || input.supabase || getDefaultSupabaseClient();
  const workflow_id = clean(input.workflow_id || input.workflow?.id);
  const channel = clean(input.channel || input.workflow?.channel || "sms");
  const context = {
    market: input.market || input.context?.market,
    state: input.state || input.context?.state,
    language: input.language || input.context?.language,
    allow_cluster_fallback:
      input.allow_cluster_fallback === true || input.context?.allow_cluster_fallback === true,
    cluster_fallback_enabled:
      input.cluster_fallback_enabled === true || input.context?.cluster_fallback_enabled === true,
  };

  if (!workflow_id) {
    return { ok: false, blocked: true, reason: "workflow_id_required" };
  }
  if (!db?.from) {
    return { ok: false, blocked: true, reason: "supabase_unavailable" };
  }

  const pools = await loadPools({ db, workflow_id, channel });
  const { pool, tier, routing_reason } = choosePool(pools, context);
  if (!pool) {
    return {
      ok: false,
      blocked: true,
      reason: routing_reason,
      routing_reason,
      tier,
      workflow_id,
      channel,
    };
  }

  const members = await loadMembers({ db, poolIds: [pool.id] });
  const member = stableWeightedChoice(
    members,
    [
      workflow_id,
      pool.id,
      clean(input.conversation_thread_id || input.context?.conversation_thread_id),
      clean(input.step_id || input.context?.step_id),
    ].join(":")
  );

  if (!member) {
    return {
      ok: false,
      blocked: true,
      reason: "sender_pool_has_no_active_members",
      routing_reason,
      tier,
      pool,
    };
  }

  return {
    ok: true,
    workflow_id,
    channel,
    tier,
    routing_reason,
    pool,
    member,
    sender_value: member.sender_value,
    sender_label: member.sender_label || member.sender_value,
  };
}
