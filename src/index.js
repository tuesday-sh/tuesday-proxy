/**
 * @fileoverview Tuesday.sh Cloudflare Worker Edge Gateway (`tuesday-proxy`).
 *
 * Scoped strictly to `api.tuesday.sh/api/v1/*`:
 * 1. Leaves `/up`, `/api/up`, `/ping/:token` (router/NAS cron heartbeats), and `/`
 *    untouched so health probes and Dead-Man's Switch webhooks never trigger bot
 *    or `X-Tuesday-Device-ID` checks.
 * 2. Blocks automated scrapers/bots on `/api/v1/*` at the Cloudflare Edge ($0.00 origin spend).
 * 3. Enforces `X-Tuesday-Device-ID`, per-device/IP sliding-window rate limits (30/hr anon,
 *    300/hr authenticated), and `<= 850 KB` (~600 KB raw JPEG) payload caps on
 *    `/api/v1/discovery/*`.
 * 4. Executes Tier 0 ($0.00 Gold Catalog Short-Circuit) at the Edge in < 10ms when
 *    `extracted_identifiers` or `user_clue_notes` match a known hardware signature.
 * 5. Enforces `X-Tuesday-Image-Retention: none_ephemeral_ram_only` on all discovery responses.
 */

import { GOLD_CATALOG_SIGNATURES } from "./edge-gold-catalog.js";
import {
  GOLD_CLUE_INDEX_ETAG,
  GOLD_CLUE_INDEX_VERSION,
  getGoldClueIndexGzipBytes,
} from "./edge-clue-index.js";

export { GOLD_CATALOG_SIGNATURES, GOLD_CLUE_INDEX_ETAG, GOLD_CLUE_INDEX_VERSION };

export const PRIVACY_ATTESTATION = Object.freeze({
  imageRetention: "none_ephemeral_ram_only",
  persistedFields: ["extractedIdentifiers", "inferredVendor", "inferredModel", "latencyMs", "tokenUsage"],
});

export const DEFAULT_CLUE_TYPES = Object.freeze([
  "Model",
  "MAC Address",
  "Serial Number",
  "Barcode",
  "QR Code",
]);

const BOT_UA_PATTERN = /\b(Scrapy|AhrefsBot|SemrushBot|MJ12bot|GPTBot|CCBot|Bytespider|Baiduspider|PetalBot)\b/i;

/**
 * Normalizes incoming `extracted_identifiers` (Array or Object) and `user_clue_notes` into a flat string list.
 * @param {unknown} extractedIdentifiers
 * @param {unknown} userClueNotes
 * @returns {string[]}
 */
export function normalizeClues(extractedIdentifiers, userClueNotes) {
  const flat = [];
  if (Array.isArray(extractedIdentifiers)) {
    for (const item of extractedIdentifiers) {
      if (typeof item === "string" && item.trim()) {
        flat.push(item.trim());
      }
    }
  } else if (extractedIdentifiers && typeof extractedIdentifiers === "object") {
    for (const [key, val] of Object.entries(extractedIdentifiers)) {
      if (typeof val === "string" && val.trim()) {
        flat.push(`${key}: ${val.trim()}`);
      }
    }
  }

  if (Array.isArray(userClueNotes)) {
    for (const note of userClueNotes) {
      if (typeof note === "string" && note.trim()) {
        flat.push(`Clue: ${note.trim()}`);
      }
    }
  }
  return flat;
}

/**
 * Matches normalized clues against Tier 0 Gold Hardware Catalog signatures.
 * @param {string[]} flatClues
 * @returns {object | null}
 */
export function matchGoldCatalogShortCircuit(flatClues) {
  if (!flatClues || flatClues.length === 0) return null;
  const combined = flatClues.join(" | ");
  for (const sig of GOLD_CATALOG_SIGNATURES) {
    if (sig.pattern.test(combined)) {
      return sig;
    }
  }
  return null;
}

/**
 * Builds the Tier 0 $0.00 Gold Catalog short-circuit JSON response matching `HardwareVisionService.analyze`.
 * @param {object} sig
 * @param {string[]} flatClues
 * @param {number} latencyMs
 * @returns {object}
 */
export function buildShortCircuitPayload(sig, flatClues, latencyMs = 2) {
  return {
    visualSummary: sig.reasoning,
    nextNarrowingQuestion: "Exact model matched in Tuesday Gold Hardware Catalog.",
    recommendedClueTypes: DEFAULT_CLUE_TYPES,
    extractedIdentifiersObject: { model: sig.model },
    extractedIdentifiers: flatClues,
    candidates: [
      {
        manufacturer: sig.vendor,
        modelNumber: sig.model,
        displayName: sig.displayName,
        category: sig.category,
        confidencePercent: 98,
        suggestedHostname: sig.hostname,
        osDetails: sig.osDetails,
        pkgManager: sig.pkgManager,
        suggestedLifecycleTier: sig.lifecycleTier,
        suggestedTrustZone: sig.trustZone,
        reasoning: sig.reasoning,
      },
    ],
    vendor: sig.vendor,
    model: sig.model,
    confidence: 0.98,
    discoveryStatus: "matched_exact",
    coachingDirective: {
      status: "matched_exact",
      imageQualityScore: 1.0,
      nextPhotoPrompt: null,
    },
    reasoning: sig.reasoning,
    nextPromptForUser: null,
    suggestedLifecycleTier: sig.lifecycleTier,
    suggestedTrustZone: sig.trustZone,
    providerUsed: "EdgeCatalogCache",
    providerLabel: `Tuesday Edge (Catalog $0 Short-Circuit • ${latencyMs}ms)`,
    modelUsed: "gold-short-circuit",
    fallbackUsed: false,
    shortCircuited: true,
    latencyMs,
    costUSD: 0.0,
    privacyAttestation: PRIVACY_ATTESTATION,
  };
}

/**
 * Creates an isolated in-memory sliding-window rate limiter instance.
 * @returns {{ checkAndIncrement: (key: string, limit: number, nowMs?: number) => { allowed: boolean, count: number, retryAfterSec: number } }}
 */
export function createRateLimiter() {
  /** @type {Map<string, { windowHour: number, count: number }>} */
  const buckets = new Map();

  return {
    checkAndIncrement(key, limit, nowMs = Date.now()) {
      const windowHour = Math.floor(nowMs / 3_600_000);
      const bucketKey = `${key}:${windowHour}`;
      const existing = buckets.get(bucketKey) || { windowHour, count: 0 };

      if (existing.count >= limit) {
        const nextHourMs = (windowHour + 1) * 3_600_000;
        const retryAfterSec = Math.max(1, Math.ceil((nextHourMs - nowMs) / 1000));
        return { allowed: false, count: existing.count, retryAfterSec };
      }

      existing.count += 1;
      buckets.set(bucketKey, existing);
      return { allowed: true, count: existing.count, retryAfterSec: 0 };
    },
  };
}

const defaultRateLimiter = createRateLimiter();

/**
 * Core Edge Gateway handler for `api.tuesday.sh/api/v1/*`.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil?: (p: Promise<any>) => void }} ctx
 * @param {{ fetchOrigin?: typeof fetch, rateLimiter?: ReturnType<typeof createRateLimiter>, nowMs?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function handleApiRequest(request, env = {}, ctx = {}, options = {}) {
  const fetchOrigin = options.fetchOrigin || fetch;
  const rateLimiter = options.rateLimiter || defaultRateLimiter;
  const nowMs = options.nowMs || Date.now();

  const url = new URL(request.url);

  // 1. Only intercept `/api/v1/*`. Non-API paths (`/up`, `/ping/:token`, `/`) pass straight through.
  if (!url.pathname.startsWith("/api/v1/")) {
    return fetchOrigin(request);
  }

  // 2. CORS preflight handling for `/api/v1/*`
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Tuesday-Device-ID, X-Tuesday-Client-Platform, X-Tuesday-Site-Slug",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 3. Bot & scraper blocking on `/api/v1/*`
  const userAgent = (request.headers.get("User-Agent") || "").trim();
  if (!userAgent || BOT_UA_PATTERN.test(userAgent)) {
    return Response.json(
      { error: "Automated scraper traffic is blocked at the Tuesday Edge Gateway." },
      {
        status: 403,
        headers: { "X-Tuesday-Edge-Status": "BLOCKED-BOT" },
      }
    );
  }

  // 3.5. Edge-Pinned Gold Clue Index (`GET /api/v1/catalog/clue-index`) with ETag 304 Not Modified
  if (url.pathname === "/api/v1/catalog/clue-index" && request.method === "GET") {
    const quotedEtag = `"${GOLD_CLUE_INDEX_ETAG}"`;
    const ifNoneMatch = (request.headers.get("If-None-Match") || "").trim();
    if (
      ifNoneMatch === quotedEtag ||
      ifNoneMatch === GOLD_CLUE_INDEX_ETAG ||
      ifNoneMatch === `W/${quotedEtag}`
    ) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: quotedEtag,
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
          "X-Tuesday-Edge-Status": "HIT-CLUE-INDEX-304",
          "X-Tuesday-Datalake-Version": GOLD_CLUE_INDEX_VERSION,
        },
      });
    }

    const gzBytes = getGoldClueIndexGzipBytes();
    return new Response(gzBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        ETag: quotedEtag,
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "X-Tuesday-Edge-Status": "HIT-CLUE-INDEX",
        "X-Tuesday-Datalake-Version": GOLD_CLUE_INDEX_VERSION,
      },
    });
  }

  const isDiscoveryRoute = url.pathname.startsWith("/api/v1/discovery/");

  // 4. Discovery Shield (`/api/v1/discovery/*`): Attestation, Rate Limiting, Size Cap, Tier 0 Short-Circuit
  if (isDiscoveryRoute) {
    const authHeader = (request.headers.get("Authorization") || "").trim();
    const hasBearer = authHeader.toLowerCase().startsWith("bearer ") && authHeader.length > 10;
    const deviceId = (request.headers.get("X-Tuesday-Device-ID") || "").trim();

    if (!deviceId && !hasBearer) {
      return Response.json(
        {
          error: "X-Tuesday-Device-ID header or Bearer token is required for Hardware Discovery.",
        },
        {
          status: 401,
          headers: {
            "X-Tuesday-Edge-Status": "REJECTED-UNATTESTED",
            "X-Tuesday-Image-Retention": "none_ephemeral_ram_only",
          },
        }
      );
    }

    const maxBytes = Number(env.MAX_DISCOVERY_PAYLOAD_BYTES || 850_000);
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > maxBytes) {
      return Response.json(
        {
          error: `Image payload exceeds maximum ephemeral transit size (${maxBytes} bytes)`,
        },
        {
          status: 413,
          headers: {
            "X-Tuesday-Edge-Status": "REJECTED-PAYLOAD-TOO-LARGE",
            "X-Tuesday-Image-Retention": "none_ephemeral_ram_only",
          },
        }
      );
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const rateKey = hasBearer ? `auth:${authHeader.slice(7, 23)}` : `anon:${deviceId}:${clientIp}`;
    const hourlyLimit = hasBearer
      ? Number(env.AUTH_HOURLY_LIMIT || 300)
      : Number(env.ANON_HOURLY_LIMIT || 30);

    const rateCheck = rateLimiter.checkAndIncrement(rateKey, hourlyLimit, nowMs);
    if (!rateCheck.allowed) {
      return Response.json(
        {
          error: "Hourly hardware discovery quota exceeded. Please try again shortly.",
          retryAfterSeconds: rateCheck.retryAfterSec,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateCheck.retryAfterSec),
            "X-Tuesday-Edge-Status": "RATE-LIMITED",
            "X-Tuesday-Image-Retention": "none_ephemeral_ram_only",
          },
        }
      );
    }

    // Tier 0 Gold Catalog Short-Circuit on `POST /api/v1/discovery/analyze`
    if (url.pathname === "/api/v1/discovery/analyze" && request.method === "POST") {
      const cloned = request.clone();
      const rawBodyText = await cloned.text();

      if (rawBodyText.length > maxBytes) {
        return Response.json(
          {
            error: `Image payload exceeds maximum ephemeral transit size (${maxBytes} bytes)`,
          },
          {
            status: 413,
            headers: {
              "X-Tuesday-Edge-Status": "REJECTED-PAYLOAD-TOO-LARGE",
              "X-Tuesday-Image-Retention": "none_ephemeral_ram_only",
            },
          }
        );
      }

      try {
        const body = JSON.parse(rawBodyText);
        const images = Array.isArray(body.images_base64)
          ? body.images_base64
          : Array.isArray(body.images)
            ? body.images
            : [];

        if (images.length > 2) {
          return Response.json(
            { error: "Too many images in a single turn (max 2)" },
            {
              status: 413,
              headers: {
                "X-Tuesday-Edge-Status": "REJECTED-TOO-MANY-IMAGES",
                "X-Tuesday-Image-Retention": "none_ephemeral_ram_only",
              },
            }
          );
        }

        const providerOverride = String(
          body.provider_override || body.provider_preference || "auto"
        ).toLowerCase();

        if (providerOverride === "auto" || providerOverride === "catalog") {
          const flatClues = normalizeClues(body.extracted_identifiers, body.user_clue_notes);
          const catalogHit = matchGoldCatalogShortCircuit(flatClues);
          if (catalogHit) {
            const elapsedMs = Math.max(1, Date.now() - nowMs);
            const payload = buildShortCircuitPayload(catalogHit, flatClues, elapsedMs);
            return Response.json(payload, {
              status: 200,
              headers: {
                "X-Tuesday-Edge-Status": "HIT-SHORT-CIRCUIT",
                "X-Tuesday-Image-Retention": "none_ephemeral_ram_only",
              },
            });
          }
        }
      } catch {
        // Malformed JSON or non-JSON body; let origin return standard 400/422 response
      }
    }
  }

  // 5. Forward validated `/api/v1/*` request to `tuesday-server` origin
  const upstreamHeaders = new Headers(request.headers);
  upstreamHeaders.set("X-Tuesday-Edge-Verified", "true");

  const upstreamReq = new Request(request, {
    headers: upstreamHeaders,
  });

  const originResp = await fetchOrigin(upstreamReq);
  const respHeaders = new Headers(originResp.headers);
  respHeaders.set("X-Tuesday-Edge-Status", "PASS-ORIGIN");
  if (isDiscoveryRoute) {
    respHeaders.set("X-Tuesday-Image-Retention", "none_ephemeral_ram_only");
  }

  return new Response(originResp.body, {
    status: originResp.status,
    statusText: originResp.statusText,
    headers: respHeaders,
  });
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil?: (p: Promise<any>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    return handleApiRequest(request, env, ctx);
  },
};
