import type { Port } from "../../vendor/rightclick-x/src/index.ts";
import type { PrunedExchange, PruneReason, WireExchange } from "../types.ts";

const STATIC_EXT_RE =
  /\.(?:m?js|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|pdf|zip)(?:$|[?#])/i;

const STATIC_PATH_RE =
  /\/(?:_next\/static|_next\/image|static\/js|static\/css|static\/media|assets\/|favicon\.ico|robots\.txt|manifest\.json|sw\.js|service-worker\.js)(?:$|[/?#])/i;

const STATIC_RESOURCE_TYPES = new Set([
  "Script",
  "Stylesheet",
  "Image",
  "Media",
  "Font",
  "Manifest",
  "EventSource",
  "WebSocket",
]);

const STATIC_CONTENT_TYPES = [
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
  "text/css",
  "image/",
  "font/",
  "audio/",
  "video/",
  "application/wasm",
  "application/octet-stream",
];

const TELEMETRY_HOST_RE =
  /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|segment\.(?:io|com)|sentry\.io|datadoghq\.(?:com|eu)|browser-intake-datadoghq\.com|posthog\.com|amplitude\.com|mixpanel\.com|intercom\.io|fullstory\.com|hotjar\.com|logrocket\.(?:io|com)|launchdarkly\.com|statsig(?:api)?\.(?:com|net)|clarity\.ms|bugsnag\.com|honeycomb\.io|newrelic\.com|nr-data\.net)$/i;

const BEACON_PATH_RE =
  /\/(?:telemetry|analytics|beacon|heartbeat|healthz?|livez|readyz|ping|metrics|rum|collect|events\/track|track-event|client-log|log-ingest|__vite_ping|sockjs-node|webpack-hmr)(?:\/|$)/i;

const TELEMETRY_INPUT_KEYS = new Set([
  "event",
  "events",
  "event_name",
  "eventname",
  "event_type",
  "ts",
  "timestamp",
  "client_ts",
  "client_timestamp",
  "sent_at",
  "anonymous_id",
  "anon_id",
  "device_id",
  "page",
  "page_url",
  "pathname",
  "referrer",
  "screen",
  "viewport",
  "user_agent",
  "duration",
  "duration_ms",
  "batch",
  "metrics",
  "spans",
  "traces",
  "logs",
  "level",
]);

const ACK_OUTPUT_KEYS = new Set(["ok", "success", "accepted", "received", "queued", "ack", "pong", "healthy"]);

function contentTypeOf(headers: Record<string, string>): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "content-type") {
      return v.split(";")[0]!.trim().toLowerCase();
    }
  }
  return "";
}

/**
 * Stage 1 transport/structural noise filter.
 * Runs AFTER OriginVault has already extracted any Set-Cookie / CSRF headers from HTML navigations.
 */
export function classifyStage1Noise(ex: WireExchange, targetOrigin?: string): { reason: PruneReason; detail: string } | null {
  let u: URL;
  try {
    u = new URL(ex.url);
  } catch {
    return { reason: "non-http-scheme", detail: "malformed URL" };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { reason: "non-http-scheme", detail: `scheme ${u.protocol}` };
  }

  const method = ex.method.toUpperCase();
  if (method === "OPTIONS" || method === "HEAD" || method === "TRACE") {
    return { reason: "preflight-or-head", detail: `${method} request` };
  }

  if (ex.resourceType === "Ping" || ex.resourceType === "CSPViolationReport") {
    return { reason: "heartbeat-or-beacon", detail: `CDP resourceType=${ex.resourceType}` };
  }

  if (TELEMETRY_HOST_RE.test(u.hostname)) {
    return { reason: "third-party-telemetry", detail: `telemetry host ${u.hostname}` };
  }

  if (targetOrigin && u.origin !== targetOrigin) {
    return { reason: "third-party-telemetry", detail: `cross-origin ${u.origin} (target ${targetOrigin})` };
  }

  if (ex.resourceType && STATIC_RESOURCE_TYPES.has(ex.resourceType)) {
    return { reason: "static-asset", detail: `resourceType=${ex.resourceType}` };
  }

  if (STATIC_EXT_RE.test(u.pathname) || STATIC_PATH_RE.test(u.pathname)) {
    return { reason: "static-asset", detail: `static asset path ${u.pathname}` };
  }

  const ct = contentTypeOf(ex.responseHeaders ?? {});
  if (STATIC_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))) {
    return { reason: "static-asset", detail: `content-type ${ct}` };
  }

  if (BEACON_PATH_RE.test(u.pathname)) {
    return { reason: "heartbeat-or-beacon", detail: `telemetry/heartbeat path ${u.pathname}` };
  }

  if (method === "GET" && (ct === "text/html" || ct === "application/xhtml+xml" || ex.resourceType === "Document")) {
    return { reason: "html-navigation", detail: "HTML document navigation" };
  }

  if (ex.status < 200 || ex.status >= 300) {
    return { reason: "error-or-redirect", detail: `HTTP ${ex.status}` };
  }

  return null;
}

/**
 * Stage 2 semantic graph pruner:
 * Prunes fire-and-forget telemetry/heartbeat endpoints that slipped past URL heuristics
 * because they carry zero domain provenance edges AND expose zero specific downstream semantic ports.
 */
export function isZeroSemanticPortNoise(opts: {
  method: string;
  pathname: string;
  status: number;
  inputs: Port[];
  outputs: Port[];
  hasProvenance: boolean;
}): string | null {
  if (opts.hasProvenance) return null;

  // Check whether any output port carries a specific domain/semantic type beyond bare json/boolean/ack.
  const meaningfulOutputs = opts.outputs.filter((p) => {
    if (p.name === "") {
      return p.type !== "json" && p.type !== "text" && p.type !== "boolean";
    }
    const leaf = p.name.split(".").pop()?.toLowerCase() ?? "";
    if (ACK_OUTPUT_KEYS.has(leaf) && (p.type === "boolean" || p.type === "text")) {
      return false;
    }
    return true;
  });

  if (meaningfulOutputs.length > 0) return null;

  // Zero meaningful output ports AND zero provenance edges.
  // Preserve genuine domain actions that consume a specific semantic input port
  // (e.g. DELETE /orders/{order_id} -> 204, POST /users/invite { email } -> { ok: true }).
  const PRIMITIVE_INPUT_TYPES = new Set(["text", "number", "boolean", "json"]);
  const hasSpecificSemanticInput = opts.inputs.some(
    (p) => !PRIMITIVE_INPUT_TYPES.has(p.type) && !TELEMETRY_INPUT_KEYS.has(p.name.toLowerCase()),
  );
  if (hasSpecificSemanticInput) return null;

  if (opts.status === 204) {
    return "204 No Content with zero semantic ports and zero provenance edges";
  }

  if (opts.inputs.length > 0) {
    return `non-semantic fire-and-forget payload (${opts.inputs.map((i) => i.name).join(", ")}) with zero downstream semantic ports`;
  }

  if (opts.outputs.every((p) => p.name === "" || ACK_OUTPUT_KEYS.has(p.name.split(".").pop()?.toLowerCase() ?? ""))) {
    return "ack-only endpoint with zero semantic input or output ports";
  }

  return null;
}

export function makePrunedRecord(
  ex: WireExchange,
  reason: PruneReason,
  detail: string,
): PrunedExchange {
  return {
    exchangeId: ex.id,
    method: ex.method.toUpperCase(),
    url: ex.url,
    status: ex.status,
    reason,
    detail,
  };
}
