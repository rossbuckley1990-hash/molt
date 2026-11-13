import crypto from "node:crypto";
import { inferType, inspectValue, type SemType } from "../../vendor/rightclick-x/src/index.ts";
import { identifierShaped } from "../../vendor/rightclick-x/src/core/identities.ts";
import { isPlumbingHeaderName, isVaultedHeaderName } from "../vault/vault.ts";
import type { ProvenanceEdge, ProvenanceLocation, WireExchange } from "../types.ts";

const ENVELOPE_SEGMENTS = new Set([
  "data",
  "result",
  "results",
  "item",
  "items",
  "record",
  "records",
  "row",
  "rows",
  "node",
  "nodes",
  "edge",
  "edges",
  "payload",
  "response",
  "body",
  "list",
  "entries",
  "content",
  "attributes",
  "meta",
  "page",
]);

const STATIC_ROUTE_WORDS = new Set([
  "api",
  "rest",
  "rpc",
  "trpc",
  "graphql",
  "gql",
  "internal",
  "private",
  "public",
  "admin",
  "dashboard",
  "console",
  "app",
  "auth",
  "session",
  "login",
  "logout",
  "me",
  "self",
  "current",
  "list",
  "all",
  "search",
  "query",
  "lookup",
  "find",
  "get",
  "create",
  "new",
  "add",
  "update",
  "edit",
  "patch",
  "delete",
  "remove",
  "archive",
  "restore",
  "refund",
  "refunds",
  "cancel",
  "approve",
  "reject",
  "retry",
  "void",
  "capture",
  "charge",
  "pay",
  "invoice",
  "invoices",
  "order",
  "orders",
  "customer",
  "customers",
  "user",
  "users",
  "account",
  "accounts",
  "member",
  "members",
  "team",
  "teams",
  "org",
  "orgs",
  "organization",
  "organizations",
  "project",
  "projects",
  "workspace",
  "workspaces",
  "ticket",
  "tickets",
  "issue",
  "issues",
  "payment",
  "payments",
  "subscription",
  "subscriptions",
  "receipt",
  "receipts",
  "risk",
  "risk-score",
  "score",
  "audit",
  "summary",
  "stats",
  "status",
  "settings",
  "config",
  "profile",
  "billing",
  "webhook",
  "webhooks",
  "export",
  "import",
  "batch",
  "bulk",
]);

const TRIVIAL_STATUS_WORDS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "ok",
  "yes",
  "no",
  "paid",
  "unpaid",
  "open",
  "closed",
  "active",
  "inactive",
  "pending",
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "refunded",
  "draft",
  "live",
  "test",
  "read",
  "write",
  "admin",
  "user",
  "member",
  "owner",
  "asc",
  "desc",
  "usd",
  "eur",
  "gbp",
  "cad",
  "aud",
  "jpy",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_SEG_RE = /^v\d+(?:\.\d+)*$/i;
const PURE_INT_RE = /^\d+$/;

export function singularizeNoun(raw: string): string {
  const s = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!s) return "item";
  if (s.endsWith("ies") && s.length > 4) return `${s.slice(0, -3)}y`;
  if (s.endsWith("statuses")) return s.slice(0, -2);
  if (s.endsWith("addresses")) return s.slice(0, -2);
  if (s.endsWith("ches") || s.endsWith("shes") || s.endsWith("xes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is") && s.length > 2) {
    return s.slice(0, -1);
  }
  return s;
}

const ENTITY_MODIFIER_RE =
  /^(?:latest|current|recent|last|first|next|prev|previous|primary|secondary|default|selected|target|source|parent|child|main|active|associated|linked)_(.+)$/;

export function cleanEntityToken(raw: string): string {
  let snake = singularizeNoun(raw);
  while (ENTITY_MODIFIER_RE.test(snake)) {
    snake = ENTITY_MODIFIER_RE.exec(snake)![1]!;
  }
  return snake.replace(/_/g, "");
}

function escapeJsonPointerSegment(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function nearestEntityFromPath(segments: string[], fallbackNoun = ""): string {
  for (let i = segments.length - 2; i >= 0; i--) {
    const seg = segments[i]!;
    if (/^\d+$/.test(seg)) continue;
    const lower = seg.toLowerCase();
    if (ENVELOPE_SEGMENTS.has(lower)) continue;
    const entity = cleanEntityToken(seg);
    if (entity && !ENVELOPE_SEGMENTS.has(entity)) return entity;
  }
  if (fallbackNoun) {
    const cleaned = cleanEntityToken(fallbackNoun);
    if (cleaned && !ENVELOPE_SEGMENTS.has(cleaned)) return cleaned;
  }
  return "";
}

/**
 * Infer a precise RightClick X SemType for a JSON scalar leaf using:
 *   1. Field name + wire schema via RightClick's inferType
 *   2. Ancestor entity context for bare `id`/`uuid`/`key` fields (`orders[].id` -> `id.order`)
 *   3. High-confidence runtime value inspection (`ross@acme.io` -> `email`, `https://...` -> `url`)
 */
export function inferContextualSemType(
  pathSegments: string[],
  value: unknown,
  endpointFallbackNoun = "",
): SemType {
  const leaf = pathSegments[pathSegments.length - 1] ?? "";
  const wireType =
    typeof value === "boolean"
      ? "boolean"
      : typeof value === "number"
        ? Number.isInteger(value)
          ? "integer"
          : "number"
        : "string";

  const normalizedLeaf = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");

  // Qualified reference suffixes common in internal APIs: order_ref, receipt_code, customer_key, target_order_id
  const refMatch = /^(.+?)_(id|uuid|guid|ref|reference|number|num|key)$/.exec(normalizedLeaf);
  if (refMatch && (typeof value === "string" || typeof value === "number")) {
    const entity = cleanEntityToken(refMatch[1]!);
    if (entity && !ENVELOPE_SEGMENTS.has(entity)) {
      return `id.${entity}`;
    }
  }

  // Bare `id`, `uuid`, `guid` qualified by nearest enclosing collection/object noun
  if (/^(id|uuid|guid|pk)$/.test(normalizedLeaf) && (typeof value === "string" || typeof value === "number")) {
    const entity = nearestEntityFromPath(pathSegments, endpointFallbackNoun);
    if (entity) return `id.${entity}`;
    return "id";
  }

  // High-confidence runtime value classification (email, url, image.url, datetime, hash, ip)
  if (typeof value === "string" && value.trim().length > 0) {
    const inspected = inspectValue(value);
    if (
      inspected.confidence >= 0.85 &&
      !["text", "json", "number", "markdown"].includes(inspected.type)
    ) {
      return inspected.type;
    }
  }

  const base = inferType(leaf, {
    type: wireType,
    ...(typeof value === "string" && UUID_RE.test(value) ? { format: "uuid" } : {}),
    ...(typeof value === "string" ? { example: value } : {}),
  });

  if (base === "id") {
    const entity = nearestEntityFromPath(pathSegments, endpointFallbackNoun);
    if (entity) return `id.${entity}`;
  }

  return base;
}

export interface ProducedLeaf {
  exchangeIndex: number;
  exchangeId: string;
  pointer: string;
  portPath: string;
  listPortPath?: string;
  semType: SemType;
  wireType: "string" | "integer" | "number" | "boolean";
  rawString: string;
}

function isProvenanceTrackable(semType: SemType, leafName: string, rawVal: string | number | boolean): boolean {
  if (typeof rawVal === "boolean") return false;
  const str = String(rawVal).trim();
  if (str.length < 2 || str.length > 256) return false;
  if (TRIVIAL_STATUS_WORDS.has(str.toLowerCase())) return false;

  if (typeof rawVal === "number") {
    if (!Number.isInteger(rawVal)) return false;
    // Track numeric IDs (e.g. 88412) only when produced at an id-like field, never generic counts/amounts like 0, 1, 200
    return (semType === "id" || semType.startsWith("id.")) && Math.abs(rawVal) >= 10;
  }

  if (PURE_INT_RE.test(str)) {
    return (semType === "id" || semType.startsWith("id.")) && str.length >= 2;
  }

  if (
    semType.startsWith("id.") ||
    semType === "id" ||
    semType === "email" ||
    semType === "url" ||
    semType === "hash" ||
    semType === "account" ||
    semType === "repo.full" ||
    semType === "domain"
  ) {
    return true;
  }

  if (identifierShaped(str as unknown) || UUID_RE.test(str)) return true;

  // Cursor / slug / handle fields
  if (/(slug|handle|cursor|code|reference|ref|number)$/i.test(leafName) && str.length >= 3 && !/\s/.test(str)) {
    return true;
  }

  return false;
}

export function extractResponseLeaves(
  exchangeIndex: number,
  exchangeId: string,
  body: unknown,
  endpointNoun = "",
): ProducedLeaf[] {
  const out: ProducedLeaf[] = [];
  const walk = (node: unknown, segs: string[], hasArray: boolean, depth: number) => {
    if (depth > 10 || out.length >= 4000 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 50); i++) {
        walk(node[i], [...segs, String(i)], true, depth + 1);
      }
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (isVaultedHeaderName(k)) continue;
        walk(v, [...segs, k], hasArray, depth + 1);
      }
      return;
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      if (segs.length === 0) return;
      const leafName = segs[segs.length - 1] ?? "";
      if (isVaultedHeaderName(leafName)) return;
      const semType = inferContextualSemType(segs, node, endpointNoun);
      if (!isProvenanceTrackable(semType, leafName, node)) return;

      const pointer = `/${segs.map(escapeJsonPointerSegment).join("/")}`;
      const portPath = segs.join(".");
      const listPortPath = hasArray ? segs.filter((s) => !/^\d+$/.test(s)).join(".") : undefined;
      const wireType =
        typeof node === "boolean"
          ? "boolean"
          : typeof node === "number"
            ? Number.isInteger(node)
              ? "integer"
              : "number"
            : "string";
      out.push({
        exchangeIndex,
        exchangeId,
        pointer,
        portPath,
        ...(listPortPath && listPortPath !== portPath ? { listPortPath } : {}),
        semType,
        wireType,
        rawString: String(node),
      });
    }
  };
  walk(body, [], false, 0);
  return out;
}

function digestValue(val: string): string {
  return crypto.createHash("sha256").update(val).digest("hex").slice(0, 12);
}

function describeShape(val: string, semType: SemType): string {
  if (PURE_INT_RE.test(val)) return `${val.length}-digit numeric (${semType})`;
  if (UUID_RE.test(val)) return `uuid (${semType})`;
  if (val.includes("@")) return `email`;
  const prefix = /^([a-z]{2,8}_)[A-Za-z0-9]+$/i.exec(val);
  if (prefix) return `prefixed '${prefix[1]}*' (${semType})`;
  return `${val.length}-char token (${semType})`;
}

export interface ParameterizedSegment {
  isParam: boolean;
  raw: string;
  paramName?: string;
  semType?: SemType;
  provenance?: ProducedLeaf;
}

export function inferPathNoun(segments: string[]): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (!s || s.startsWith("{") || VERSION_SEG_RE.test(s) || s.toLowerCase() === "api") continue;
    if (!STATIC_ROUTE_WORDS.has(s.toLowerCase()) && (PURE_INT_RE.test(s) || UUID_RE.test(s) || identifierShaped(s))) {
      continue;
    }
    return singularizeNoun(s);
  }
  return "resource";
}

/**
 * Decide for each segment of a URL path whether it is a literal route token or a
 * typed parameter `{<entity>_id}`, prioritizing chronological upstream provenance!
 */
export function parameterizeUrlPath(
  pathname: string,
  lookupProvenance: (val: string) => ProducedLeaf | undefined,
): ParameterizedSegment[] {
  const rawSegments = pathname.split("/").filter((s) => s.length > 0);
  const out: ParameterizedSegment[] = [];
  const usedNames = new Set<string>();

  const uniqueParamName = (base: string): string => {
    let candidate = base;
    let n = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}_${n++}`;
    }
    usedNames.add(candidate);
    return candidate;
  };

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = decodeURIComponent(rawSegments[i]!);
    const lower = raw.toLowerCase();

    if (VERSION_SEG_RE.test(raw) || lower === "api" || lower === "graphql" || lower === "rest") {
      out.push({ isParam: false, raw: rawSegments[i]! });
      continue;
    }

    const prevLiteral = i > 0 && !out[i - 1]?.isParam ? out[i - 1]!.raw : "";
    const entityNoun = prevLiteral && !VERSION_SEG_RE.test(prevLiteral) && prevLiteral.toLowerCase() !== "api"
      ? singularizeNoun(prevLiteral)
      : "resource";

    // Priority 1: Chronological Value Provenance match from an earlier response!
    const witnessed = !STATIC_ROUTE_WORDS.has(lower) ? lookupProvenance(raw) : undefined;
    if (witnessed) {
      const defaultSem: SemType = entityNoun !== "resource" ? `id.${entityNoun.replace(/_/g, "")}` : "id";
      const semType =
        witnessed.semType !== "text" && witnessed.semType !== "id" && witnessed.semType !== "number"
          ? witnessed.semType
          : defaultSem;
      const baseName =
        semType === "email"
          ? `${entityNoun}_email`
          : entityNoun !== "resource"
            ? `${entityNoun}_id`
            : "id";
      out.push({
        isParam: true,
        raw,
        paramName: uniqueParamName(baseName),
        semType,
        provenance: witnessed,
      });
      continue;
    }

    // Priority 2: Structural identifier shape (UUID, numeric ID, prefixed ID like ord_991a, email)
    if (!STATIC_ROUTE_WORDS.has(lower)) {
      const inspected = inspectValue(raw);
      const isStructuralId =
        PURE_INT_RE.test(raw) ||
        UUID_RE.test(raw) ||
        identifierShaped(raw) ||
        inspected.type === "email";

      if (isStructuralId) {
        const semType: SemType =
          inspected.type === "email"
            ? "email"
            : entityNoun !== "resource"
              ? `id.${entityNoun.replace(/_/g, "")}`
              : "id";
        const baseName =
          semType === "email"
            ? `${entityNoun}_email`
            : entityNoun !== "resource"
              ? `${entityNoun}_id`
              : "id";
        out.push({
          isParam: true,
          raw,
          paramName: uniqueParamName(baseName),
          semType,
        });
        continue;
      }
    }

    out.push({ isParam: false, raw: rawSegments[i]! });
  }

  return out;
}

export interface ExchangeAnalysis {
  exchange: WireExchange;
  index: number;
  isGraphQL: boolean;
  origin: string;
  method: string;
  pathname: string;
  pathSegments: ParameterizedSegment[];
  pathTemplate: string;
  operationKey: string;
  parsedRequestBody?: unknown;
  parsedResponseBody?: unknown;
  producedLeaves: ProducedLeaf[];
  inboundEdges: ProvenanceEdge[];
}

export function isGraphQLExchange(ex: WireExchange, parsedReqBody: unknown, parsedResBody: unknown): boolean {
  if (ex.method.toUpperCase() !== "POST") return false;
  if (!parsedReqBody || typeof parsedReqBody !== "object" || Array.isArray(parsedReqBody)) return false;
  const req = parsedReqBody as Record<string, unknown>;
  if (typeof req.query !== "string") return false;
  if (!/^\s*(?:query|mutation|\{)/i.test(req.query)) return false;
  if (parsedResBody && typeof parsedResBody === "object" && !Array.isArray(parsedResBody)) {
    const res = parsedResBody as Record<string, unknown>;
    if ("data" in res || "errors" in res) return true;
  }
  return /graphql|gql/i.test(new URL(ex.url).pathname);
}

function tryParseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Walk exchanges in chronological order, tracking runtime value provenance across
 * responses -> subsequent requests (path, query, non-vault headers, JSON/form bodies, GraphQL variables).
 */
export function analyzeChronologicalProvenance(exchanges: WireExchange[]): {
  analyses: ExchangeAnalysis[];
  edges: ProvenanceEdge[];
} {
  const sorted = [...exchanges].sort((a, b) => a.startedAt - b.startedAt);
  // rawString -> earliest most-specific ProducedLeaf (plus latest for ties)
  const valueIndex = new Map<string, ProducedLeaf>();
  const analyses: ExchangeAnalysis[] = [];
  const allEdges: ProvenanceEdge[] = [];

  const lookup = (raw: string): ProducedLeaf | undefined => {
    return valueIndex.get(raw.trim());
  };

  for (let idx = 0; idx < sorted.length; idx++) {
    const ex = sorted[idx]!;
    const u = new URL(ex.url);
    const method = ex.method.toUpperCase();
    const parsedRequestBody = tryParseJson(ex.requestBody);
    const parsedResponseBody = tryParseJson(ex.responseBody);
    const gql = isGraphQLExchange(ex, parsedRequestBody, parsedResponseBody);

    const pathSegments: ParameterizedSegment[] = gql
      ? u.pathname
          .split("/")
          .filter(Boolean)
          .map((raw): ParameterizedSegment => ({ isParam: false, raw }))
      : parameterizeUrlPath(u.pathname, lookup);

    const pathTemplate = "/" + pathSegments.map((s) => (s.isParam ? `{${s.paramName}}` : s.raw)).join("/");

    let gqlOpKey = "";
    if (gql && parsedRequestBody && typeof parsedRequestBody === "object") {
      const q = String((parsedRequestBody as Record<string, unknown>).query ?? "");
      const opMatch = /^\s*(query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)?/i.exec(q);
      const rootFieldMatch = /\{\s*(?:[_A-Za-z][_0-9A-Za-z]*\s*:\s*)?([_A-Za-z][_0-9A-Za-z]*)/.exec(
        q.replace(/^\s*(?:query|mutation)[^{]*\{/i, "{"),
      );
      const kind = (opMatch?.[1] ?? "query").toLowerCase();
      const field = rootFieldMatch?.[1] ?? opMatch?.[2] ?? "root";
      gqlOpKey = `graphql:${u.origin}${u.pathname}:${kind}:${field}`;
    }

    const operationKey = gql ? gqlOpKey : `http:${u.origin}:${method}:${pathTemplate}`;
    const inboundEdges: ProvenanceEdge[] = [];

    const recordInbound = (
      from: ProducedLeaf,
      location: ProvenanceLocation,
      paramName: string,
      inferredToType: SemType,
      rawVal: string,
    ) => {
      const fromAnalysis = analyses[from.exchangeIndex];
      if (!fromAnalysis || fromAnalysis.operationKey === operationKey) return;
      // An explicit REST collection path (`/orders/{order_id}` -> `id.order`) names the canonical
      // resource even when the upstream list endpoint used a generic noun like `/ledger` (`entries[].id`).
      const unifiedType =
        location === "path" && inferredToType.startsWith("id.")
          ? inferredToType
          : from.semType !== "text" && from.semType !== "id" && from.semType !== "number"
            ? from.semType
            : inferredToType;
      from.semType = unifiedType;
      const edge: ProvenanceEdge = {
        fromExchangeId: from.exchangeId,
        fromOperationKey: fromAnalysis.operationKey,
        fromPointer: from.pointer,
        fromPortPath: from.portPath,
        ...(from.listPortPath ? { fromListPortPath: from.listPortPath } : {}),
        fromSemType: unifiedType,
        toExchangeId: ex.id,
        toOperationKey: operationKey,
        toLocation: location,
        toParamName: paramName,
        toSemType: unifiedType,
        valueDigest: digestValue(rawVal),
        valueShape: describeShape(rawVal, unifiedType),
      };
      inboundEdges.push(edge);
      allEdges.push(edge);
    };

    // 1. Path parameter provenance
    for (const seg of pathSegments) {
      if (seg.isParam && seg.provenance && seg.paramName && seg.semType) {
        recordInbound(seg.provenance, "path", seg.paramName, seg.semType, seg.raw);
      }
    }

    // 2. Query parameter provenance
    for (const [qk, qv] of u.searchParams.entries()) {
      if (!qv || isVaultedHeaderName(qk)) continue;
      const hit = lookup(qv);
      if (hit) {
        const toType = inferContextualSemType([qk], qv, inferPathNoun(u.pathname.split("/").filter(Boolean)));
        recordInbound(hit, "query", qk, toType, qv);
      }
    }

    // 3. Non-vaulted custom request header provenance
    for (const [hk, hv] of Object.entries(ex.requestHeaders ?? {})) {
      if (!hv || isVaultedHeaderName(hk) || isPlumbingHeaderName(hk)) continue;
      const hit = lookup(hv);
      if (hit) {
        const toType = inferContextualSemType([hk], hv);
        recordInbound(hit, "header", hk.toLowerCase(), toType, hv);
      }
    }

    // 4. Request body / GraphQL variables provenance
    if (gql && parsedRequestBody && typeof parsedRequestBody === "object") {
      const vars = (parsedRequestBody as Record<string, unknown>).variables;
      if (vars && typeof vars === "object" && !Array.isArray(vars)) {
        for (const [vk, vv] of Object.entries(vars as Record<string, unknown>)) {
          if (vv === null || vv === undefined || typeof vv === "object" || isVaultedHeaderName(vk)) continue;
          const hit = lookup(String(vv));
          if (hit) {
            const toType = inferContextualSemType([vk], vv);
            recordInbound(hit, "graphql_var", vk, toType, String(vv));
          }
        }
      }
    } else if (parsedRequestBody && typeof parsedRequestBody === "object" && !Array.isArray(parsedRequestBody)) {
      for (const [bk, bv] of Object.entries(parsedRequestBody as Record<string, unknown>)) {
        if (bv === null || bv === undefined || typeof bv === "object" || isVaultedHeaderName(bk)) continue;
        const hit = lookup(String(bv));
        if (hit) {
          const toType = inferContextualSemType([bk], bv, inferPathNoun(u.pathname.split("/").filter(Boolean)));
          recordInbound(hit, "body", bk, toType, String(bv));
        }
      }
    } else if (ex.requestBody && !parsedRequestBody) {
      const ct = Object.entries(ex.requestHeaders ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = new URLSearchParams(ex.requestBody);
        for (const [fk, fv] of form.entries()) {
          if (!fv || isVaultedHeaderName(fk)) continue;
          const hit = lookup(fv);
          if (hit) {
            const toType = inferContextualSemType([fk], fv);
            recordInbound(hit, "body", fk, toType, fv);
          }
        }
      }
    }

    // 5. Index response leaves produced by this exchange for all future exchanges (j > idx)
    const endpointNoun = gql
      ? gqlOpKey.split(":").pop() ?? ""
      : inferPathNoun(u.pathname.split("/").filter(Boolean));
    const responseRoot =
      gql && parsedResponseBody && typeof parsedResponseBody === "object" && "data" in (parsedResponseBody as object)
        ? (parsedResponseBody as Record<string, unknown>).data
        : parsedResponseBody;

    const producedLeaves =
      responseRoot !== undefined ? extractResponseLeaves(idx, ex.id, responseRoot, endpointNoun) : [];

    for (const leaf of producedLeaves) {
      const existing = valueIndex.get(leaf.rawString);
      // Keep specific entity types (`id.order`) over generic (`id` / `text`)
      if (
        !existing ||
        (!existing.semType.startsWith("id.") && leaf.semType.startsWith("id."))
      ) {
        valueIndex.set(leaf.rawString, leaf);
      }
    }

    analyses.push({
      exchange: ex,
      index: idx,
      isGraphQL: gql,
      origin: u.origin,
      method,
      pathname: u.pathname,
      pathSegments,
      pathTemplate,
      operationKey,
      parsedRequestBody,
      parsedResponseBody,
      producedLeaves,
      inboundEdges,
    });
  }

  return { analyses, edges: allEdges };
}
