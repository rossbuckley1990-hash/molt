import type { Reflection, SemType } from "../vendor/rightclick-x/src/index.ts";

/** One chronological HTTP/fetch/XHR/GraphQL wire frame captured from a browser or HAR log. */
export interface WireExchange {
  id: string;
  startedAt: number;
  durationMs?: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string | null;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody?: string | null;
  resourceType?: string;
}

/** Cookie captured from CDP Network.getCookies or Set-Cookie wire headers. */
export interface OriginCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expiresAt?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

/** Public, secret-free metadata describing what the OriginVault holds for an origin. */
export interface OriginVaultSummary {
  origin: string;
  headerNames: string[];
  cookieNames: string[];
  csrfHeaderNames: string[];
  fingerprint: string;
  updatedAt: string;
}

export type PruneReason =
  | "non-http-scheme"
  | "static-asset"
  | "preflight-or-head"
  | "html-navigation"
  | "third-party-telemetry"
  | "heartbeat-or-beacon"
  | "error-or-redirect"
  | "zero-semantic-ports";

export interface PrunedExchange {
  exchangeId: string;
  method: string;
  url: string;
  status: number;
  reason: PruneReason;
  detail: string;
}

export type ProvenanceLocation = "path" | "query" | "header" | "body" | "graphql_var";

/**
 * Verified chronological dataflow edge from an earlier response field/header to a
 * later request's path segment, query param, custom header, JSON body field, or GraphQL variable.
 */
export interface ProvenanceEdge {
  fromExchangeId: string;
  fromOperationKey: string;
  /** RFC 6901 JSON Pointer into the upstream response body (e.g. "/data/orders/0/id"). */
  fromPointer: string;
  /** Scalar RightClick port path (e.g. "data.orders.0.id"). */
  fromPortPath: string;
  /** Array-projected list port path when crossing arrays (e.g. "data.orders.id"). */
  fromListPortPath?: string;
  fromSemType: SemType;
  toExchangeId: string;
  toOperationKey: string;
  toLocation: ProvenanceLocation;
  toParamName: string;
  toSemType: SemType;
  /** Non-reversible SHA-256 prefix of the witnessed value (never raw credentials/PII). */
  valueDigest: string;
  valueShape: string;
}

export type BrowserStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string; timeoutMs?: number }
  | { action: "fill"; selector: string; value: string; timeoutMs?: number }
  | { action: "waitForSelector"; selector: string; timeoutMs?: number }
  | { action: "waitForIdle"; idleMs?: number; timeoutMs?: number }
  | { action: "evaluate"; expression: string };

/**
 * Declarative recipe used on Run #1 (or woken headless for ~1-3s when an origin
 * returns 401/403 or undergoes structural API drift).
 */
export interface BrowserRecipe {
  origin: string;
  entryUrl: string;
  steps?: BrowserStep[];
  headless?: boolean;
  settleMs?: number;
}

export interface DistillationReport {
  origin: string;
  title: string;
  distilledAt: string;
  exchangesTotal: number;
  exchangesDistilled: number;
  pruned: PrunedExchange[];
  provenance: ProvenanceEdge[];
  restCapabilities: number;
  graphqlCapabilities: number;
  vault: OriginVaultSummary | null;
  openapi?: Record<string, unknown>;
  graphqlIntrospection?: Record<string, unknown>;
  reflections: Reflection[];
}

export interface FallbackEvent {
  at: string;
  origin: string;
  capabilityId: string;
  trigger: "auth-denied" | "contract-drift" | "manual-refresh";
  statusBefore?: number;
  wakeDurationMs: number;
  vaultChanged: boolean;
  vaultFingerprintBefore?: string;
  vaultFingerprintAfter?: string;
  capabilitiesBefore: string[];
  capabilitiesAfter: string[];
  note: string;
}
