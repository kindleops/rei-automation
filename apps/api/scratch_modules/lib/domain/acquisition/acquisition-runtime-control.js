import { getSystemFlags } from "../lib/system-control.js";

export const ACQUISITION_RUNTIME_FLAGS = Object.freeze({
  ENGINE: "acquisition_engine_enabled",
  RETRY: "acquisition_retry_enabled",
  FOLLOWUP: "acquisition_followup_enabled",
  INBOUND_DISPATCH: "acquisition_inbound_dispatch_enabled",
  OFFER_ENGINE: "acquisition_offer_engine_enabled",
});

const OPERATION_FLAGS = Object.freeze({
  engine: [],
  contact_create: [],
  retry: [ACQUISITION_RUNTIME_FLAGS.RETRY],
  followup: [ACQUISITION_RUNTIME_FLAGS.FOLLOWUP],
  inbound: [ACQUISITION_RUNTIME_FLAGS.INBOUND_DISPATCH],
  offer: [ACQUISITION_RUNTIME_FLAGS.OFFER_ENGINE],
});

function clean(value) {
  return String(value ?? "").trim();
}

function requiredFlags(operation) {
  const normalized = clean(operation) || "engine";
  return [
    ACQUISITION_RUNTIME_FLAGS.ENGINE,
    ...(OPERATION_FLAGS[normalized] || []),
  ];
}

export async function getAcquisitionRuntimeControl(operation = "engine", deps = {}) {
  const flags = requiredFlags(operation);
  const injected = deps.acquisitionRuntimeFlags || deps.acquisition_runtime_flags;
  const values = injected
    ? Object.fromEntries(flags.map((key) => [key, injected[key] === true]))
    : await (deps.getSystemFlags || getSystemFlags)(flags, {
        supabase: deps.supabase ?? deps.supabaseClient,
        bypassCache: true,
      });
  const disabledFlags = flags.filter((key) => values?.[key] !== true);

  return {
    ok: disabledFlags.length === 0,
    enabled: disabledFlags.length === 0,
    operation: clean(operation) || "engine",
    required_flags: flags,
    disabled_flags: disabledFlags,
    flags: Object.fromEntries(flags.map((key) => [key, values?.[key] === true])),
  };
}

export function acquisitionRuntimeDisabled(control) {
  return {
    ok: false,
    status: 423,
    skipped: true,
    reason: "acquisition_runtime_disabled",
    operation: control.operation,
    required_flags: control.required_flags,
    disabled_flags: control.disabled_flags,
  };
}

export function acquisitionQueueOperation(row = {}) {
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const source = clean(row.source || metadata.source).toLowerCase();
  const acquisitionManaged =
    metadata.acquisition_managed === true ||
    metadata.default_acquisition_engine === true ||
    source.startsWith("default_acquisition_");

  if (!acquisitionManaged) return null;
  if (
    metadata.acquisition_followup === true ||
    metadata.acquisition_followup === "true" ||
    source.includes("followup")
  ) {
    return "followup";
  }
  if (
    Number(metadata.acquisition_retry_count) > 0 ||
    source.includes("delivery_retry")
  ) {
    return "retry";
  }
  if (source.includes("inbound_dispatcher") || row.message_type === "auto_reply") {
    return "inbound";
  }
  if (source.includes("acquisition_offer")) return "offer";
  return "engine";
}
