import crypto from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

function stableChoiceIndex(seed, optionsLength) {
  if (!optionsLength) return 0;
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return Number.parseInt(digest, 16) % optionsLength;
}

function splitOptions(raw, delimiter) {
  return clean(raw)
    .split(delimiter)
    .map((option) => option.trim())
    .filter(Boolean);
}

export function applyWorkflowSpinSyntax(text = "", context = {}) {
  const source = String(text ?? "");
  const baseSeed = [
    clean(context.seed),
    clean(context.conversation_thread_id),
    clean(context.thread_key),
    clean(context.step_id),
    clean(context.workflow_step_id),
  ]
    .filter(Boolean)
    .join(":") || "workflow-preview";

  const substitutions = [];
  const expressionPattern = /\{([^{}]*\|[^{}]*)\}|\(([^()]*\/[^()]*)\)/g;

  const rendered = source.replace(expressionPattern, (raw, curlyBody, parenBody, offset) => {
    const syntax_type = curlyBody !== undefined ? "pipe" : "slash";
    const delimiter = syntax_type === "pipe" ? "|" : "/";
    const options = splitOptions(curlyBody ?? parenBody, delimiter);
    if (!options.length) return raw;

    const index = stableChoiceIndex(`${baseSeed}:${offset}:${raw}`, options.length);
    const chosen = options[index];
    substitutions.push({
      raw,
      syntax_type,
      options,
      chosen,
      index,
    });
    return chosen;
  });

  return { text: rendered, substitutions };
}

export function generateWorkflowSpinPreviews(text = "", context = {}, count = 10) {
  const total = Math.max(1, Math.min(Number(count) || 10, 25));
  return Array.from({ length: total }, (_, index) => ({
    preview_index: index + 1,
    ...applyWorkflowSpinSyntax(text, {
      ...context,
      seed: `${clean(context.seed) || "preview"}:${index + 1}`,
    }),
  }));
}
