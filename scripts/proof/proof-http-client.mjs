import { execFileSync } from "node:child_process";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeBaseUrl(baseUrl) {
  return clean(baseUrl).replace(/\/$/, "");
}

function isAbsoluteHttpUrl(value) {
  return /^https?:\/\//i.test(clean(value));
}

export function proofUsesVercelCurl(env = process.env) {
  return TRUE_VALUES.has(clean(env.PROOF_USE_VERCEL_CURL).toLowerCase());
}

export function isVercelPreviewBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl).includes("vercel.app");
}

function resolveTargetUrl(baseUrl, pathOrUrl) {
  if (isAbsoluteHttpUrl(pathOrUrl)) return clean(pathOrUrl);
  return `${normalizeBaseUrl(baseUrl)}${pathOrUrl}`;
}

function targetHostPath(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host,
      path: parsed.pathname || "/",
      value: `${parsed.host}${parsed.pathname || "/"}`,
    };
  } catch {
    const noQuery = clean(url).split("?")[0] || "unknown";
    return { host: "unknown", path: noQuery, value: noQuery };
  }
}

function parseHeaderBlock(block) {
  const headers = {};
  for (const line of clean(block).split("\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function splitDumpedCurlHeaders(text) {
  let remaining = String(text ?? "").replace(/\r\n/g, "\n");
  if (!remaining.startsWith("HTTP/")) {
    return { headers: {}, body: remaining.trim() };
  }

  let headers = {};
  while (remaining.startsWith("HTTP/")) {
    const separator = remaining.indexOf("\n\n");
    if (separator < 0) return { headers, body: "" };
    headers = parseHeaderBlock(remaining.slice(0, separator));
    remaining = remaining.slice(separator + 2);
  }

  return { headers, body: remaining.trim() };
}

function parseJsonBody(bodyText, errorPrefix = "non_json_response") {
  const raw = String(bodyText ?? "").trim();
  if (!raw) return { raw: "", json: null, error: null };

  try {
    return {
      raw,
      json: JSON.parse(raw),
      error: null,
    };
  } catch {}

  const jsonStart = raw.search(/[\[{]/);
  if (jsonStart > 0) {
    const candidate = raw.slice(jsonStart);
    try {
      return {
        raw: candidate,
        json: JSON.parse(candidate),
        error: null,
      };
    } catch {}
  }

  return {
    raw,
    json: null,
    error: `${errorPrefix}:${raw.slice(0, 120)}`,
  };
}

function classify401(result) {
  if (Number(result.status) !== 401) return null;

  const raw = String(result.raw || "").slice(0, 4000).toLowerCase();
  const contentType = clean(result.headers?.["content-type"]).toLowerCase();
  const vercelProtection =
    raw.includes("deployment protection") ||
    raw.includes("/_vercel/sso") ||
    (raw.includes("authentication required") && raw.includes("vercel"));

  if (vercelProtection) return "vercel_protection";
  if (result.json && typeof result.json === "object") return "app_auth";
  if (contentType.includes("application/json")) return "app_auth";
  return "unknown_401";
}

function attachDiagnostics(result, request) {
  const auth401Kind = classify401(result);
  const target = targetHostPath(result.url);
  return {
    ...result,
    request: {
      ...request,
      target_host: target.host,
      target_path: target.path,
      target: target.value,
    },
    auth401: auth401Kind
      ? {
          kind: auth401Kind,
          vercel_bypass_used: Boolean(request.vercel_bypass_used),
          target: target.value,
        }
      : null,
  };
}

export function formatProofHttp401Diagnostic(result = {}) {
  if (!result.auth401) return "";
  const bypass = result.auth401.vercel_bypass_used
    ? "used"
    : result.request?.vercel_bypass_requested
      ? "requested_not_used"
      : "not_used";
  return `auth_401=${result.auth401.kind} vercel_bypass=${bypass} target=${result.auth401.target}`;
}

export async function callProofJson({
  root = process.cwd(),
  baseUrl,
  pathOrUrl,
  label = "",
  method = "GET",
  headers = {},
  body,
  timeoutSeconds = 60,
  maxBuffer = 20 * 1024 * 1024,
  env = process.env,
} = {}) {
  if (!pathOrUrl) throw new Error("callProofJson requires pathOrUrl");

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const url = resolveTargetUrl(normalizedBaseUrl, pathOrUrl);
  const vercelBypassRequested = proofUsesVercelCurl(env);
  const vercelBypassUsed =
    vercelBypassRequested &&
    isVercelPreviewBaseUrl(normalizedBaseUrl) &&
    !isAbsoluteHttpUrl(pathOrUrl);
  const request = {
    method,
    vercel_bypass_requested: vercelBypassRequested,
    vercel_bypass_used: vercelBypassUsed,
  };
  const startedAt = performance.now();

  if (vercelBypassUsed) {
    const curlArgs = [
      "curl",
      pathOrUrl,
      "--deployment",
      normalizedBaseUrl,
      "--",
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      "--request",
      method,
      "--dump-header",
      "-",
      "--write-out",
      "\n__HTTP_STATUS__:%{http_code}",
    ];
    for (const [key, value] of Object.entries(headers || {})) {
      curlArgs.push("--header", `${key}: ${value}`);
    }
    if (body !== undefined && body !== null) curlArgs.push("--data", body);

    let output = "";
    let status = 0;
    let raw = "";
    let json = null;
    let error = null;
    let responseHeaders = {};
    try {
      output = execFileSync("vercel", curlArgs, {
        cwd: root,
        encoding: "utf8",
        maxBuffer,
      });
      const statusMatch = output.match(/__HTTP_STATUS__:(\d{3})\s*$/);
      status = statusMatch ? Number(statusMatch[1]) : 0;
      const outputWithoutStatus = statusMatch
        ? output.slice(0, statusMatch.index).trim()
        : output.trim();
      const parsedOutput = splitDumpedCurlHeaders(outputWithoutStatus);
      responseHeaders = parsedOutput.headers;
      const parsedBody = parseJsonBody(parsedOutput.body);
      raw = parsedBody.raw;
      json = parsedBody.json;
      error = parsedBody.error;
    } catch (err) {
      error = err?.message || String(err);
      raw = output;
    }

    return attachDiagnostics(
      {
        label,
        url,
        status,
        headers: responseHeaders,
        json,
        raw,
        error,
        ms: Math.round(performance.now() - startedAt),
      },
      request,
    );
  }

  let status = 0;
  let json = null;
  let raw = "";
  let error = null;
  let responseHeaders = {};
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(Number(timeoutSeconds) * 1000),
    });
    status = response.status;
    responseHeaders = Object.fromEntries(response.headers.entries());
    raw = await response.text();
    const parsedBody = parseJsonBody(raw);
    raw = parsedBody.raw;
    json = parsedBody.json;
    error = parsedBody.error;
  } catch (err) {
    error = err?.message || String(err);
  }

  return attachDiagnostics(
    {
      label,
      url,
      status,
      headers: responseHeaders,
      json,
      raw,
      error,
      ms: Math.round(performance.now() - startedAt),
    },
    request,
  );
}
