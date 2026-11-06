import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter, handleApiRequest } from "../src/index.js";

describe("Tuesday Edge Gateway (tuesday-proxy)", () => {
  it("passes non-/api/v1/* routes (/ping/:token, /up) straight through without bot or device checks", async () => {
    let originCalled = false;
    const req = new Request("https://api.tuesday.sh/ping/tok_abc123", {
      method: "POST",
      headers: { "User-Agent": "curl/8.5.0" },
    });

    const resp = await handleApiRequest(req, {}, {}, {
      fetchOrigin: async () => {
        originCalled = true;
        return Response.json({ ok: true });
      },
    });

    assert.equal(originCalled, true);
    assert.equal(resp.status, 200);
  });

  it("blocks automated scraper User-Agents on /api/v1/* with 403 at $0.00 origin spend", async () => {
    let originCalled = false;
    const req = new Request("https://api.tuesday.sh/api/v1/bulletins", {
      method: "GET",
      headers: { "User-Agent": "python-Scrapy/2.11" },
    });

    const resp = await handleApiRequest(req, {}, {}, {
      fetchOrigin: async () => {
        originCalled = true;
        return Response.json({ ok: true });
      },
    });

    assert.equal(originCalled, false);
    assert.equal(resp.status, 403);
    assert.equal(resp.headers.get("X-Tuesday-Edge-Status"), "BLOCKED-BOT");
  });

  it("rejects /api/v1/discovery/analyze without X-Tuesday-Device-ID or Bearer token (401)", async () => {
    let originCalled = false;
    const req = new Request("https://api.tuesday.sh/api/v1/discovery/analyze", {
      method: "POST",
      headers: {
        "User-Agent": "TuesdayAndroid/1.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ extracted_identifiers: ["UDM-Pro"] }),
    });

    const resp = await handleApiRequest(req, {}, {}, {
      fetchOrigin: async () => {
        originCalled = true;
        return Response.json({ ok: true });
      },
    });

    assert.equal(originCalled, false);
    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get("X-Tuesday-Image-Retention"), "none_ephemeral_ram_only");
  });

  it("rejects oversized payloads (> 850 KB) on /api/v1/discovery/analyze at the edge (413)", async () => {
    let originCalled = false;
    const req = new Request("https://api.tuesday.sh/api/v1/discovery/analyze", {
      method: "POST",
      headers: {
        "User-Agent": "TuesdayiOS/1.0",
        "X-Tuesday-Device-ID": "iphone-13-aaron",
        "Content-Length": "950000",
      },
      body: JSON.stringify({ images_base64: ["a"] }),
    });

    const resp = await handleApiRequest(req, {}, {}, {
      fetchOrigin: async () => {
        originCalled = true;
        return Response.json({ ok: true });
      },
    });

    assert.equal(originCalled, false);
    assert.equal(resp.status, 413);
    assert.equal(resp.headers.get("X-Tuesday-Edge-Status"), "REJECTED-PAYLOAD-TOO-LARGE");
  });

  it("executes Tier 0 $0.00 Gold Catalog Short-Circuit at the edge without calling origin", async () => {
    let originCalled = false;
    const req = new Request("https://api.tuesday.sh/api/v1/discovery/analyze", {
      method: "POST",
      headers: {
        "User-Agent": "TuesdayAndroid/1.0",
        "X-Tuesday-Device-ID": "pixel-9-aaron",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: "scan-edge-001",
        extracted_identifiers: ["Model: UCG-Ultra"],
      }),
    });

    const resp = await handleApiRequest(req, {}, {}, {
      fetchOrigin: async () => {
        originCalled = true;
        return Response.json({ ok: true });
      },
    });

    assert.equal(originCalled, false);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("X-Tuesday-Edge-Status"), "HIT-SHORT-CIRCUIT");
    assert.equal(resp.headers.get("X-Tuesday-Image-Retention"), "none_ephemeral_ram_only");

    const data = await resp.json();
    assert.equal(data.shortCircuited, true);
    assert.equal(data.costUSD, 0.0);
    assert.equal(data.vendor, "Ubiquiti Inc.");
    assert.equal(data.model, "UCG-Ultra");
    assert.equal(data.discoveryStatus, "matched_exact");
    assert.equal(data.coachingDirective.status, "matched_exact");
  });

  it("enforces sliding-window per-device rate limits on /api/v1/discovery/analyze (429)", async () => {
    const limiter = createRateLimiter();
    const env = { ANON_HOURLY_LIMIT: "2" };

    const makeReq = () =>
      new Request("https://api.tuesday.sh/api/v1/discovery/analyze", {
        method: "POST",
        headers: {
          "User-Agent": "TuesdayAndroid/1.0",
          "X-Tuesday-Device-ID": "device-rate-test",
          "CF-Connecting-IP": "203.0.113.10",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ extracted_identifiers: ["UDM-Pro"] }),
      });

    const r1 = await handleApiRequest(makeReq(), env, {}, { rateLimiter: limiter, nowMs: 1_000_000 });
    const r2 = await handleApiRequest(makeReq(), env, {}, { rateLimiter: limiter, nowMs: 1_000_100 });
    const r3 = await handleApiRequest(makeReq(), env, {}, { rateLimiter: limiter, nowMs: 1_000_200 });

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.equal(r3.headers.get("X-Tuesday-Edge-Status"), "RATE-LIMITED");
  });

  it("forwards vision cache-miss requests to origin with X-Tuesday-Edge-Verified and privacy headers", async () => {
    let capturedHeaders = null;
    const req = new Request("https://api.tuesday.sh/api/v1/discovery/analyze", {
      method: "POST",
      headers: {
        "User-Agent": "TuesdayiOS/1.0",
        "X-Tuesday-Device-ID": "iphone-13-aaron",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: "scan-vision-002",
        extracted_identifiers: ["Unknown rear sticker"],
        images_base64: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="],
      }),
    });

    const resp = await handleApiRequest(req, {}, {}, {
      fetchOrigin: async (upstreamReq) => {
        capturedHeaders = upstreamReq.headers;
        return Response.json({
          vendor: "Synology",
          model: "DS923+",
          discoveryStatus: "coach_next_angle",
        });
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(capturedHeaders.get("X-Tuesday-Edge-Verified"), "true");
    assert.equal(resp.headers.get("X-Tuesday-Edge-Status"), "PASS-ORIGIN");
    assert.equal(resp.headers.get("X-Tuesday-Image-Retention"), "none_ephemeral_ram_only");
  });
});
