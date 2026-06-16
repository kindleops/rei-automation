import { fetchSupabaseTemplateCandidates } from "../lib/domain/templates/load-supabase-template-candidates.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "../lib/domain/templates/local-template-registry.js";

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

export function renderAcquisitionTemplate(template, context = {}) {
  const values = {
    seller_first_name:
      clean(context.seller_first_name ?? context.first_name) || "there",
    agent_first_name:
      clean(context.agent_first_name ?? context.agent_name) || "Ryan",
    property_address:
      clean(context.property_address ?? context.property_address_full) || "the property",
  };

  return templateBody(template).replace(
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

  return {
    ok: true,
    template: selected,
    template_id: templateId(selected),
    use_case: clean(selected.use_case) || useCase,
    message_body: renderAcquisitionTemplate(selected, context),
    source: clean(selected.source) || "supabase",
  };
}

