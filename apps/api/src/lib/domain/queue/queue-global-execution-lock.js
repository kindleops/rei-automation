import crypto from "node:crypto";

export const GLOBAL_LOCK_OWNER = Object.freeze({
  UNRESTRICTED: "unrestricted",
  SCOPED_CANARY: "scoped_canary",
});

export const DEFAULT_GLOBAL_LOCK_TTL_SECONDS = 300;

function rpcFunctionMissing(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`.toLowerCase();
  return (
    code === "42883" ||
    code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("does not exist")
  );
}

export function newGlobalLockToken() {
  return crypto.randomUUID();
}

export async function acquireGlobalExecutionLock(supabase, options = {}) {
  const token = options.token || newGlobalLockToken();
  const owner_type = options.owner_type || GLOBAL_LOCK_OWNER.UNRESTRICTED;
  const owner = options.owner || `${owner_type}:${token.slice(0, 8)}`;
  const canary_run_id = options.canary_run_id || null;
  const ttlSeconds = Number(options.ttlSeconds || DEFAULT_GLOBAL_LOCK_TTL_SECONDS);

  const { data, error } = await supabase.rpc("queue_acquire_global_execution_lock", {
    p_owner_type: owner_type,
    p_token: token,
    p_owner: owner,
    p_canary_run_id: canary_run_id,
    p_ttl_seconds: ttlSeconds,
  });

  if (!error) {
    return { acquired: data === true, enforced: true, token, owner, owner_type, canary_run_id };
  }
  if (rpcFunctionMissing(error)) {
    return {
      acquired: false,
      enforced: false,
      token,
      owner,
      owner_type,
      canary_run_id,
      reason: "lock_function_unavailable",
    };
  }
  return {
    acquired: false,
    enforced: true,
    token,
    owner,
    owner_type,
    canary_run_id,
    reason: error.message || "acquire_failed",
  };
}

export async function releaseGlobalExecutionLock(supabase, token) {
  if (!token) return false;
  try {
    const { data, error } = await supabase.rpc("queue_release_global_execution_lock", {
      p_token: token,
    });
    if (error) return rpcFunctionMissing(error) ? true : false;
    return data === true;
  } catch {
    return false;
  }
}