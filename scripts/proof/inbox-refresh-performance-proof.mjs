#!/usr/bin/env node

import fetch from "node-fetch";

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "test-token"; // We might need a real token or mock auth

async function testEndpoint(name, path, params = {}) {
  const url = new URL(path, API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  console.log(`Testing ${name}: ${url.toString()}`);
  const start = Date.now();
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    const duration = Date.now() - start;
    const isJson = res.headers.get("content-type")?.includes("application/json");
    const data = isJson ? await res.json() : await res.text();

    console.log(`  Status: ${res.status}`);
    console.log(`  Duration: ${duration}ms`);
    console.log(`  Type: ${res.headers.get("content-type")}`);
    
    if (res.status !== 200) {
      console.error(`  Error: Status ${res.status}`);
      return false;
    }

    if (!isJson) {
      console.error(`  Error: Response is not JSON`);
      return false;
    }

    return { duration, data };
  } catch (err) {
    console.error(`  Fetch Error: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log("Starting Inbox Refresh Performance Proof...");

  // 1. Initial Inbox Load
  const initialLoad = await testEndpoint("Initial Inbox Load", "/api/cockpit/inbox/live", {
    timeout_mode: "initial_boot",
    limit: "25"
  });

  // 2. Auto Refresh (Fast Path)
  const autoRefresh = await testEndpoint("Auto Refresh (Fast Path)", "/api/cockpit/inbox/live", {
    timeout_mode: "auto_refresh",
    refresh_reason: "fallback_polling"
  });

  if (autoRefresh) {
    const { duration, data } = autoRefresh;
    if (duration > 5000) {
      console.error(`  FAIL: Auto refresh took ${duration}ms (> 5000ms)`);
    } else {
      console.log(`  PASS: Auto refresh took ${duration}ms`);
    }
    if (data.diagnostics?.countsSource === "skipped") {
        console.log("  PASS: Counts were skipped for auto_refresh as expected.");
    }
  }

  // 3. Queue Control (Fast)
  const queueControl = await testEndpoint("Queue Control (Fast)", "/api/cockpit/queue/control");
  if (queueControl) {
    const { duration, data } = queueControl;
    if (duration > 2000) {
      console.error(`  FAIL: Queue control took ${duration}ms (> 2000ms)`);
    } else {
      console.log(`  PASS: Queue control took ${duration}ms`);
    }
    if (data.control?.campaign === null) {
        console.log("  PASS: Campaign diagnostics skipped for fast control GET.");
    }
  }

  // 4. Queue Diagnostics (Slow)
  const queueDiagnostics = await testEndpoint("Queue Diagnostics (Slow)", "/api/cockpit/queue/diagnostics");
  if (queueDiagnostics) {
      console.log(`  PASS: Queue diagnostics returned in ${queueDiagnostics.duration}ms`);
      if (queueDiagnostics.data.control?.campaign !== null) {
          console.log("  PASS: Campaign diagnostics returned for diagnostics endpoint.");
      }
  }

  console.log("Performance Proof Complete.");
}

main().catch(console.error);
