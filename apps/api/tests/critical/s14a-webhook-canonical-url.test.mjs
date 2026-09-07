/**
 * s14a-webhook-canonical-url.test.mjs
 *
 * The URL is the signing material. If we reconstruct a different URL than the
 * one the provider POSTed to, every legitimate callback fails verification and
 * the failure is silent -- a 401 to the provider, no alert on our side.
 *
 * Production was reconstructing a STALE VERCEL host, which this runtime does
 * not serve. This pins the canonical base to a purpose-specific setting so a
 * value chosen for an emailed link can never move it again.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCanonicalWebhookUrl, canonicalWebhookUrlSource,
} from "@/lib/webhooks/textgrid-verify-webhook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLOUDFLARE = "https://ops.leadcommand.ai";
const STALE = "https://real-estate-automation-three.vercel.app";
// What the container actually sees -- NOT the public URL.
const INTERNAL_REQ = "https://0.0.0.0:3000/api/webhooks/textgrid/delivery";

test("PART 12: the delivery route exists at the exact expected path", () => {
  const route = path.resolve(__dirname,
    "../../src/app/api/webhooks/textgrid/delivery/route.js");
  assert.ok(fs.existsSync(route),
    "the canonical delivery callback route must exist at /api/webhooks/textgrid/delivery");
});

test("the dedicated setting produces the canonical Cloudflare URL", () => {
  const url = buildCanonicalWebhookUrl(INTERNAL_REQ, CLOUDFLARE);
  assert.equal(url, `${CLOUDFLARE}/api/webhooks/textgrid/delivery`);
});

test("the internal container URL is NEVER used as signing material", () => {
  // 0.0.0.0:3000 is what the container sees behind the Worker. Signing against
  // it could never match a provider signature.
  const url = buildCanonicalWebhookUrl(INTERNAL_REQ, CLOUDFLARE);
  assert.ok(!url.includes("0.0.0.0"), "internal host must be replaced");
  assert.ok(!url.includes(":3000"), "internal port must be replaced");
});

test("the stale Vercel base produces a URL this runtime does not serve", () => {
  // Documents the production defect precisely: verification would compute a
  // signature over a host Cloudflare does not answer for.
  const url = buildCanonicalWebhookUrl(INTERNAL_REQ, STALE);
  assert.equal(url, `${STALE}/api/webhooks/textgrid/delivery`);
  assert.notEqual(url, `${CLOUDFLARE}/api/webhooks/textgrid/delivery`,
    "stale base and canonical base must be distinguishable");
});

test("path and query are preserved exactly; no over-normalization", () => {
  assert.equal(
    buildCanonicalWebhookUrl("https://0.0.0.0:3000/api/webhooks/textgrid/delivery?x=1", CLOUDFLARE),
    `${CLOUDFLARE}/api/webhooks/textgrid/delivery?x=1`,
    "query string must survive: it is part of the signed URL");

  assert.equal(
    buildCanonicalWebhookUrl("https://0.0.0.0:3000/api/webhooks/textgrid/delivery/", CLOUDFLARE),
    `${CLOUDFLARE}/api/webhooks/textgrid/delivery/`,
    "trailing slash must NOT be normalized away -- the provider signed what it sent");

  assert.equal(
    buildCanonicalWebhookUrl("https://0.0.0.0:3000/api/webhooks/textgrid/de%20livery", CLOUDFLARE),
    `${CLOUDFLARE}/api/webhooks/textgrid/de%20livery`,
    "percent-encoding must be preserved byte-for-byte");
});

test("scheme and host both come from the canonical base, not the request", () => {
  const url = buildCanonicalWebhookUrl("http://internal.invalid/api/webhooks/textgrid/delivery", CLOUDFLARE);
  assert.ok(url.startsWith("https://ops.leadcommand.ai/"),
    "an http internal request must not yield an http signing URL");
});

test("PART 14: the signed URL is not derived from request headers", () => {
  // Host / X-Forwarded-Host are attacker-controllable. If they fed the signing
  // base, an attacker could choose the material their forged signature is
  // checked against. The implementation must take only request_url + config.
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../src/lib/webhooks/textgrid-verify-webhook.js"), "utf8");
  const fn = src.slice(src.indexOf("export function buildCanonicalWebhookUrl"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  for (const header of ["x-forwarded-host", "x-forwarded-proto", "forwarded", "headers.get"]) {
    assert.ok(!body.toLowerCase().includes(header),
      `canonical URL must not be derived from ${header}`);
  }
});

test("canonicalWebhookUrlSource reports a degraded configuration honestly", () => {
  assert.equal(
    canonicalWebhookUrlSource({ TEXTGRID_WEBHOOK_PUBLIC_BASE_URL: CLOUDFLARE }),
    "textgrid_webhook_public_base_url");
  assert.equal(
    canonicalWebhookUrlSource({ APP_BASE_URL: STALE }),
    "app_base_url_fallback",
    "falling back to a general-purpose URL must be visible, not silent");
});

test("the dedicated setting takes precedence over APP_BASE_URL", () => {
  const prev = process.env.TEXTGRID_WEBHOOK_PUBLIC_BASE_URL;
  const prevApp = process.env.APP_BASE_URL;
  try {
    process.env.TEXTGRID_WEBHOOK_PUBLIC_BASE_URL = CLOUDFLARE;
    process.env.APP_BASE_URL = STALE;
    const url = buildCanonicalWebhookUrl(INTERNAL_REQ);
    assert.ok(url.startsWith(CLOUDFLARE),
      "APP_BASE_URL must not win over the purpose-specific setting");
  } finally {
    if (prev === undefined) delete process.env.TEXTGRID_WEBHOOK_PUBLIC_BASE_URL;
    else process.env.TEXTGRID_WEBHOOK_PUBLIC_BASE_URL = prev;
    if (prevApp === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prevApp;
  }
});
