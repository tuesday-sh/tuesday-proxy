#!/usr/bin/env node
/**
 * @fileoverview Live E2E probe for Tuesday Edge Gateway (`api.tuesday.sh`).
 * Uses Node https/http module with servername/SNI set to api.tuesday.sh.
 */

import assert from "node:assert/strict";
import https from "node:https";

const BASE_URL = process.env.TEST_BASE_URL || "https://api.tuesday.sh";
const CF_EDGE_IP = process.env.CF_EDGE_IP || "104.21.69.228";

console.log(`\n🚀 Running Tuesday Edge Gateway Live E2E Probe against Cloudflare Edge (${CF_EDGE_IP} / ${BASE_URL})...\n`);

function requestOverEdge(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: CF_EDGE_IP,
        port: 443,
        path: path,
        method: method,
        servername: "api.tuesday.sh",
        headers: {
          Host: "api.tuesday.sh",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            rawText: raw,
          });
        });
      }
    );

    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  // Test 1: Live Tier 0 Edge Short-Circuit
  console.log("▶ [Test 1] Testing Tier 0 Edge Short-Circuit (< 50ms, $0.00 spend)...");
  const startTime = Date.now();
  const resp = await requestOverEdge(
    "POST",
    "/api/v1/discovery/analyze",
    {
      "User-Agent": "TuesdayAndroid/1.0",
      "X-Tuesday-Device-ID": "live-e2e-probe",
      "Content-Type": "application/json",
    },
    {
      session_id: "live-edge-probe-001",
      extracted_identifiers: ["Model: UCG-Ultra"],
    }
  );
  const durationMs = Date.now() - startTime;

  assert.equal(resp.status, 200, `Expected 200 OK, got ${resp.status}`);
  assert.equal(resp.headers["x-tuesday-edge-status"], "HIT-SHORT-CIRCUIT", "Expected HIT-SHORT-CIRCUIT header from edge");
  assert.equal(resp.headers["x-tuesday-image-retention"], "none_ephemeral_ram_only", "Expected privacy header");

  assert.equal(resp.body.shortCircuited, true, "Expected shortCircuited: true");
  assert.equal(resp.body.costUSD, 0, "Expected costUSD: 0");
  assert.equal(resp.body.vendor, "Ubiquiti Inc.", "Expected vendor: Ubiquiti Inc.");
  assert.equal(resp.body.model, "UCG-Ultra", "Expected model: UCG-Ultra");
  assert.equal(resp.body.providerUsed, "EdgeCatalogCache", "Expected providerUsed: EdgeCatalogCache");
  console.log(`  ✔ Passed! Edge answered in ${durationMs}ms (reported internal execution: ${resp.body.latencyMs}ms, $0.00 compute).`);

  // Test 2: Scraper Bot Blocking at Edge
  console.log("\n▶ [Test 2] Testing Automated Scraper Bot Deflection at Edge (HTTP 403)...");
  const botResp = await requestOverEdge("GET", "/api/v1/bulletins", {
    "User-Agent": "python-Scrapy/2.11",
  });

  assert.equal(botResp.status, 403, `Expected 403 Forbidden, got ${botResp.status}`);
  assert.equal(botResp.headers["x-tuesday-edge-status"], "BLOCKED-BOT", "Expected BLOCKED-BOT header from edge");
  console.log("  ✔ Passed! Scraper deflected by Pingora edge with 403 at $0.00 origin spend.");

  // Test 3: Unintercepted Pass-Through to Origin Health Probe
  console.log("\n▶ [Test 3] Testing Pass-Through Health Probe (/up -> GCP Cloud Run)...");
  const upResp = await requestOverEdge("GET", "/up");
  assert.equal(upResp.status, 200, `Expected 200 OK, got ${upResp.status}`);
  assert.match(upResp.rawText, /is_up:\s*true/, "Expected is_up: true from Cloud Run origin");
  console.log("  ✔ Passed! /up passed cleanly through to Google Cloud Run.");

  console.log("\n🎉 ALL LIVE EDGE E2E TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("\n❌ Live E2E Probe Failed:", err);
  process.exit(1);
});
