#!/usr/bin/env node

import { chromium } from "playwright";

const BASE_URL = process.env.DASHBOARD_SMOKE_BASE_URL || "http://127.0.0.1:5173/";

let failures = 0;
let warnings = 0;

function mark(label, condition, detail = "", warnOnly = false) {
  const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
    return true;
  }
  if (warnOnly) {
    warnings += 1;
    console.warn(line);
    return false;
  }
  failures += 1;
  console.error(line);
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const api500s = [];
  const apiHits = [];
  const browserErrors = [];

  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    const hit = { url, status: response.status() };
    apiHits.push(hit);
    if (hit.status >= 500) api500s.push(hit);
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  const bodyText = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  mark("inbox loads", bodyText.length > 500, `chars=${bodyText.length}`);
  mark("active bucket visible", /\bActive\b/i.test(bodyText), "", true);
  mark("waiting bucket visible", /\bWaiting\b/i.test(bodyText), "", true);

  const queueButton = page.getByTitle(/Queue Processor/i).first();
  if (await queueButton.count()) {
    await queueButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const previewButton = page.getByText("Dry-Run Preview", { exact: true }).first();
    if (await previewButton.count()) {
      await previewButton.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(15000);
      const previewHit = apiHits.find((hit) => hit.url.includes("/api/cockpit/queue/control") && hit.status < 500);
      mark("campaign dry-run preview called", Boolean(previewHit), previewHit ? `status=${previewHit.status}` : "", true);
    } else {
      mark("campaign dry-run preview button visible", false, "", true);
    }
    const limitedButtonVisible = await page.getByText("Queue Limited", { exact: true }).first().count();
    mark("limited queue control visible", limitedButtonVisible > 0, "", true);
  } else {
    mark("queue processor control visible", false, "", true);
  }

  const mapControl = page.getByText(/^Map$/).first();
  if (await mapControl.count()) {
    await mapControl.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  const canvasCount = await page.locator("canvas").count().catch(() => 0);
  mark("map canvas renders", canvasCount > 0, `canvas=${canvasCount}`, true);
  if (canvasCount > 0) {
    const box = await page.locator("canvas").first().boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1000);
      mark("map click did not trigger API 500", api500s.length === 0, `api500s=${api500s.length}`, true);
    }
  }

  const rowSelectors = [
    "[data-thread-key]",
    "[data-thread-id]",
    ".nx-thread-card-rebuilt",
    ".nx-thread-table-row-ops75",
    ".nx-thread-card",
    ".nx-thread-row",
    ".nx-conversation-row",
    ".conversation-row",
    ".inbox-thread-row",
    "[role=row]",
  ];
  let clicked = 0;
  for (const selector of rowSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(5 - clicked, count); i += 1) {
      await locator.nth(i).click({ timeout: 2000 }).catch(() => {});
      clicked += 1;
      await page.waitForTimeout(300);
    }
    if (clicked >= 5) break;
  }
  mark("selected up to 5 inbox rows", clicked > 0, `clicked=${clicked}`, true);
  mark(
    "selecting rows produced no API 500s",
    api500s.length === 0,
    api500s.slice(0, 3).map((hit) => `${hit.status}:${hit.url}`).join(" "),
    true
  );
  mark("no uncaught browser errors", browserErrors.length === 0, browserErrors.slice(0, 3).join(" | "), true);

  await browser.close();
  if (failures > 0) {
    console.error(`FAIL dashboard browser smoke failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS dashboard browser smoke warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL dashboard browser smoke crashed", error?.stack || error?.message || error);
  process.exit(1);
});
