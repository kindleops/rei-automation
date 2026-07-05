/** Query safety and performance guardrails for map filter compilation and execution. */

export const MAP_FILTER_LIMITS = {
  maxGroupDepth: 8,
  maxRules: 64,
  maxGroups: 32,
  maxParams: 256,
  maxParamStringLength: 500,
  maxParamArrayLength: 100,
  countQueryTimeoutMs: Number(process.env.MAP_FILTER_PROOF_TIMEOUT_MS) || 45_000,
  tokenTtlHours: 24,
  tokenMaxTtlHours: 168,
  previewRateLimitPerMinute: 60,
};

export function assertExpressionWithinLimits(stats) {
  const errors = [];
  if (stats.ruleCount > MAP_FILTER_LIMITS.maxRules) {
    errors.push(`rule_limit_exceeded:${stats.ruleCount}`);
  }
  if (stats.groupCount > MAP_FILTER_LIMITS.maxGroups) {
    errors.push(`group_limit_exceeded:${stats.groupCount}`);
  }
  if (stats.maxDepth > MAP_FILTER_LIMITS.maxGroupDepth) {
    errors.push(`depth_limit_exceeded:${stats.maxDepth}`);
  }
  if (stats.paramCount > MAP_FILTER_LIMITS.maxParams) {
    errors.push(`param_limit_exceeded:${stats.paramCount}`);
  }
  return errors;
}