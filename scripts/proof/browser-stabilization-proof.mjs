#!/usr/bin/env node

import { chromium } from "playwright";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:5180/inbox";
const REFRESH_COUNT = Number(process.env.REFRESH_COUNT || 5);
const BAD_PATTERNS = [
  /502\b/i,
  /ERR_CONNECTION_REFUSED/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_NETWORK_CHANGED/i,
  /Bad Gateway/i,
];

function isBadText(text = "") {
  return BAD_PATTERNS.some((pattern) => pattern.test(text));
}

function isTrackedFailureUrl(url = "") {
  return url.includes("/api/") || url.includes("supabase.co");
}

async function waitForLiveInbox(page, label) {
  try {
    const response = await page.waitForResponse(
      (res) => res.url().includes("/api/cockpit/inbox/live"),
      { timeout: 60_000 },
    );
    let threadCount = null;
    let degraded = null;
    try {
      const json = await response.json();
      threadCount = Array.isArray(json?.threads) ? json.threads.length : null;
      degraded = json?.degraded ?? null;
    } catch {
      // The response status still proves whether the route loaded.
    }
    return {
      label,
      ok: response.status() === 200,
      status: response.status(),
      threadCount,
      degraded,
      url: response.url(),
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: null,
      threadCount: null,
      degraded: null,
      error: error?.message || String(error),
    };
  }
}

async function captureBody(page, label) {
  const text = await page.locator("body").innerText({ timeout: 30_000 }).catch(() => "");
  return {
    label,
    bodyTextLength: text.trim().length,
    hasInboxSignal: /Inbox|All messages|Campaign Command|Queue|Messages/i.test(text),
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1720, height: 1180 } });

  const badConsole = [];
  const api5xx = [];
  const requestFailures = [];
  const ignoredNavigationAborts = [];

  page.on("console", (message) => {
    const text = message.text();
    if (isBadText(text)) {
      badConsole.push({
        type: message.type(),
        text: text.slice(0, 500),
      });
    }
  });

  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (url.includes("/api/") && status >= 500) {
      api5xx.push({ status, url });
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (isTrackedFailureUrl(url)) {
      const failure = request.failure()?.errorText || "request_failed";
      if (failure === "net::ERR_ABORTED") {
        ignoredNavigationAborts.push({ url, failure });
        return;
      }
      requestFailures.push({
        url,
        failure,
      });
    }
  });

  const loads = [];

  let liveWait = waitForLiveInbox(page, "initial");
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  loads.push(await liveWait);
  await page.waitForTimeout(4_000);
  loads.push(await captureBody(page, "initial"));

  for (let index = 1; index <= REFRESH_COUNT; index += 1) {
    liveWait = waitForLiveInbox(page, `refresh_${index}`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    loads.push(await liveWait);
    await page.waitForTimeout(3_000);
    loads.push(await captureBody(page, `refresh_${index}`));
  }

  const overlayState = await page.evaluate(() => {
    return document.querySelector("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay")
      ? "ERROR_OVERLAY"
      : "OK";
  });

  const proof = {
    ok:
      overlayState === "OK" &&
      api5xx.length === 0 &&
      requestFailures.length === 0 &&
      badConsole.length === 0 &&
      loads
        .filter((entry) => Object.prototype.hasOwnProperty.call(entry, "threadCount"))
        .every((entry) => entry.ok && entry.status === 200 && Number(entry.threadCount) > 0),
    dashboardUrl: DASHBOARD_URL,
    overlayState,
    loads,
    api5xx,
    requestFailures,
    ignoredNavigationAborts: ignoredNavigationAborts.length,
    badConsole,
  };

  console.log(JSON.stringify(proof, null, 2));
  await browser.close();

  if (!proof.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
