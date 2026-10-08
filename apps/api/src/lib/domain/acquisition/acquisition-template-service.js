import { fetchSupabaseTemplateCandidates } from "@/lib/domain/templates/load-supabase-template-candidates.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "@/lib/domain/templates/local-template-registry.js";
import { resolveOutboundPersona } from "@/lib/domain/outbound/outbound-persona.js";

function clean(value) {
  return String(value ?? "").trim();
}

function templateId(template = {}) {
  return clean(template.template_id ?? template.item_id ?? template.id);
}

function templateBody(template = {}) {
  return clean(template.template_body ?? template.template_text ?? template.text);
}

function localCandidates(useCase) {
  return LOCAL_TEMPLATE_CANDIDATES.filter(
    (template) => clean(template.use_case).toLowerCase() === clean(useCase).toLowerCase()
  );
}

const AGENT_KEYS = new Set(["agent_first_name", "agent_name", "sms_agent_name", "sender_name", "rep_name"]);

/**
 * Sender persona for this render (hotfix 8.4.8): the context's own agent name,
 * else the ONE resolver (established thread persona, owner persona, then the
 * existing master_owners distribution for the thread). The hardcoded "Ryan"
 * fallback is gone.
 */
function acquisitionAgentName(context = {}) {
  const given = clean(context.agent_first_name ?? context.agent_name);
  if (given) return given.split(/\s+/)[0];
  const resolved = resolveOutboundPersona({
    thread_persona: context.thread_agent_persona,
    owner_persona: context.agent_persona,
    stable_key: clean(context.thread_key ?? context.phone_e164 ?? context.to_phone_number ?? context.canonical_e164),
    language: context.language,
  });
  return resolved.ok ? resolved.first_name : "";
}

/** Returns the rendered body, or null when a persona is required but unresolved. */
export function renderAcquisitionTemplate(template, context = {}) {
  const agent = acquisitionAgentName(context);
  const body = templateBody(template);
  const usesAgent = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].some((m) => AGENT_KEYS.has(m[1]));
  if (usesAgent && !agent) return null;
  const values = {
    seller_first_name:
      clean(context.seller_first_name ?? context.first_name) || "there",
    agent_first_name: agent,
    agent_name: agent,
    sms_agent_name: agent,
    sender_name: agent,
    rep_name: agent,
    property_address:
      clean(context.property_address ?? context.property_address_full) || "the property",
  };

  return body.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, key) => clean(values[key] ?? context[key]) || ""
  );
}

export async function selectAcquisitionTemplate(
  useCase,
  context = {},
  options = {},
  deps = {}
) {
  const excluded = new Set(
    (options.exclude_template_ids || []).map(clean).filter(Boolean)
  );
  const loadTemplates =
    deps.loadTemplates ||
    (async (selector) =>
      fetchSupabaseTemplateCandidates(selector, {
        supabase_client: deps.supabase ?? deps.supabaseClient ?? null,
      }));

  const supabaseCandidates = await loadTemplates({
    use_case: useCase,
    language: clean(context.language) || "English",
    is_follow_up: options.is_follow_up === true,
  });
  const candidates = [
    ...(Array.isArray(supabaseCandidates) ? supabaseCandidates : []),
    ...localCandidates(useCase),
  ];

  const selected = candidates.find((candidate) => {
    const id = templateId(candidate);
    return id && !excluded.has(id) && templateBody(candidate);
  });

  if (!selected) {
    return {
      ok: false,
      reason: "no_unused_template_available",
      use_case: useCase,
      excluded_template_ids: [...excluded],
    };
  }

  const message_body = renderAcquisitionTemplate(selected, context);
  if (message_body === null) {
    return { ok: false, reason: "persona_unresolved", use_case: useCase, template_id: templateId(selected) };
  }
  return {
    ok: true,
    template: selected,
    template_id: templateId(selected),
    use_case: clean(selected.use_case) || useCase,
    message_body,
    source: clean(selected.source) || "supabase",
  };
}

