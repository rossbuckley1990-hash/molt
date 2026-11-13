import {
  reflectOpenAPI,
  type Capability,
  type DeclaredField,
  type Port,
  type Reflection,
  type SemType,
} from "../../vendor/rightclick-x/src/index.ts";
import { isPlumbingHeaderName, isVaultedHeaderName, type OriginVault } from "../vault/vault.ts";
import { classifyStage1Noise, isZeroSemanticPortNoise, makePrunedRecord } from "./noise.ts";
import {
  analyzeChronologicalProvenance,
  inferContextualSemType,
  inferPathNoun,
  singularizeNoun,
  type ExchangeAnalysis,
} from "./provenance.ts";
import { compileGraphQLExchanges } from "./graphql-compiler.ts";
import type { DistillationReport, ProvenanceEdge, PrunedExchange, WireExchange } from "../types.ts";

const OPTIONAL_UI_QUERY_PARAMS = new Set([
  "limit",
  "offset",
  "page",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
  "take",
  "skip",
  "cursor",
  "after",
  "before",
  "sort",
  "sort_by",
  "sortby",
  "order_by",
  "orderby",
  "dir",
  "direction",
  "include",
  "expand",
  "fields",
  "locale",
  "lang",
  "tz",
  "timezone",
  "_t",
  "_ts",
  "t",
  "cb",
  "cachebust",
]);

export interface DistillOptions {
  targetOrigin?: string;
  title?: string;
  virtualContractUrlForOrigin?: (origin: string, protocol: "openapi" | "graphql", pathSuffix?: string) => string;
}

function inferJsonSchema(
  values: unknown[],
  segs: string[],
  endpointNoun: string,
  leafTypeOverrides?: Map<string, SemType>,
  depth = 0,
): Record<string, unknown> {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0 || depth > 8) {
    return { type: "string" };
  }

  const first = nonNull[0];
  if (Array.isArray(first)) {
    const elements = nonNull.flatMap((v) => (Array.isArray(v) ? v.slice(0, 25) : []));
    const itemSchema = inferJsonSchema(elements, [...segs, "0"], endpointNoun, leafTypeOverrides, depth + 1);
    const arraySchema: Record<string, unknown> = { type: "array", items: itemSchema };
    if (typeof itemSchema["x-rightclick-type"] === "string") {
      arraySchema["x-rightclick-type"] = `list:${itemSchema["x-rightclick-type"]}`;
    }
    return arraySchema;
  }

  if (typeof first === "object") {
    const objs = nonNull.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
    const allKeys = new Set<string>();
    for (const o of objs) {
      for (const k of Object.keys(o)) {
        if (!isVaultedHeaderName(k)) allKeys.add(k);
      }
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const k of allKeys) {
      const childVals = objs.map((o) => o[k]).filter((v) => v !== undefined);
      properties[k] = inferJsonSchema(childVals, [...segs, k], endpointNoun, leafTypeOverrides, depth + 1);
      if (objs.every((o) => Object.hasOwn(o, k) && o[k] !== undefined && o[k] !== null)) {
        required.push(k);
      }
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
  }

  const dotted = segs.join(".");
  const listDotted = segs.filter((s) => !/^\d+$/.test(s)).join(".");
  const semType =
    leafTypeOverrides?.get(dotted) ??
    leafTypeOverrides?.get(listDotted) ??
    inferContextualSemType(segs, first, endpointNoun);
  if (typeof first === "boolean") {
    return { type: "boolean", "x-rightclick-type": "boolean" };
  }
  if (typeof first === "number") {
    const isInt = nonNull.every((v) => typeof v === "number" && Number.isInteger(v));
    return {
      type: isInt ? "integer" : "number",
      "x-rightclick-type": semType,
    };
  }
  const strVals = nonNull.map(String);
  const isUuid = strVals.every((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));
  return {
    type: "string",
    ...(isUuid ? { format: "uuid" } : {}),
    "x-rightclick-type": semType,
  };
}

function buildOperationId(method: string, pathTemplate: string): string {
  const parts = pathTemplate
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") && seg.endsWith("}") ? `by_${seg.slice(1, -1)}` : seg.replace(/[^A-Za-z0-9]+/g, "_")));
  return `${method.toLowerCase()}_${parts.join("_") || "root"}`
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function humanizeSummary(method: string, pathTemplate: string): string {
  const verbMap: Record<string, string> = {
    GET: "Get",
    POST: "Create or invoke",
    PUT: "Replace",
    PATCH: "Update",
    DELETE: "Delete",
  };
  const cleanPath = pathTemplate.replace(/^\/api(?:\/v\d+)?/i, "") || pathTemplate;
  return `${verbMap[method] ?? method} ${cleanPath}`;
}

function collectDeepResponsePorts(
  group: ExchangeAnalysis[],
  existingPorts: Port[],
): { extraPorts: Port[]; extraFields: DeclaredField[] } {
  const seenNames = new Set(existingPorts.map((p) => p.name));
  const extraPorts: Port[] = [];
  const extraFields: DeclaredField[] = [];
  const seenFields = new Set<string>();

  for (const item of group) {
    for (const leaf of item.producedLeaves) {
      if (leaf.portPath && !seenNames.has(leaf.portPath)) {
        seenNames.add(leaf.portPath);
        extraPorts.push({
          name: leaf.portPath,
          type: leaf.semType,
          required: false,
          wire: leaf.wireType,
        });
      }
      if (leaf.listPortPath && !seenNames.has(leaf.listPortPath)) {
        seenNames.add(leaf.listPortPath);
        extraPorts.push({
          name: leaf.listPortPath,
          type: `list:${leaf.semType}`,
          required: false,
          wire: "array",
        });
      }
      const declPath = leaf.listPortPath ?? leaf.portPath;
      if (declPath && !seenFields.has(declPath)) {
        seenFields.add(declPath);
        extraFields.push({ path: declPath, type: leaf.semType });
      }
    }
  }

  return { extraPorts, extraFields };
}

/**
 * Distill raw browser wire exchanges into:
 *   1. Vaulted origin-pinned credentials/cookies/CSRF headers (never exposed to LLM)
 *   2. Noise pruning report (static assets, telemetry, zero-port dead ends)
 *   3. Chronological value provenance graph
 *   4. Synthesized OpenAPI 3.1 + GraphQL contracts & RightClick X Reflections
 */
export function distillWireExchanges(
  exchanges: WireExchange[],
  vault: OriginVault,
  opts: DistillOptions = {},
): DistillationReport[] {
  const sorted = [...exchanges].sort((a, b) => a.startedAt - b.startedAt);
  const prunedByOrigin = new Map<string, PrunedExchange[]>();
  const cleanByOrigin = new Map<string, WireExchange[]>();

  // Step 1: Ingest EVERY exchange into OriginVault first (captures HTML navigation Set-Cookie & CSRF!)
  for (const ex of sorted) {
    vault.ingestExchange(ex);
    let origin = "unknown";
    try {
      origin = new URL(ex.url).origin;
    } catch {
      // Handled in Stage 1 noise filter
    }
    const stage1 = classifyStage1Noise(ex, opts.targetOrigin);
    if (stage1) {
      const bucketOrigin = opts.targetOrigin ?? origin;
      const bucket = prunedByOrigin.get(bucketOrigin) ?? [];
      bucket.push(makePrunedRecord(ex, stage1.reason, stage1.detail));
      prunedByOrigin.set(bucketOrigin, bucket);
      continue;
    }
    const clean = cleanByOrigin.get(origin) ?? [];
    clean.push(ex);
    cleanByOrigin.set(origin, clean);
  }

  const targetOrigins = opts.targetOrigin
    ? [opts.targetOrigin]
    : [...new Set([...cleanByOrigin.keys(), ...prunedByOrigin.keys()].filter((o) => o !== "unknown"))];

  const reports: DistillationReport[] = [];

  for (const origin of targetOrigins) {
    const clean = cleanByOrigin.get(origin) ?? [];
    const pruned = [...(prunedByOrigin.get(origin) ?? [])];
    const totalForOrigin = clean.length + pruned.length;
    const hostTitle = opts.title ?? new URL(origin).host;

    if (clean.length === 0) {
      reports.push({
        origin,
        title: hostTitle,
        distilledAt: new Date().toISOString(),
        exchangesTotal: totalForOrigin,
        exchangesDistilled: 0,
        pruned,
        provenance: [],
        restCapabilities: 0,
        graphqlCapabilities: 0,
        vault: vault.summary(origin),
        reflections: [],
      });
      continue;
    }

    // Step 2: Chronological Value Provenance across all clean exchanges on this origin
    const { analyses, edges } = analyzeChronologicalProvenance(clean);
    const restAnalyses = analyses.filter((a) => !a.isGraphQL);
    const gqlAnalyses = analyses.filter((a) => a.isGraphQL);

    const reflections: Reflection[] = [];
    let openapiDoc: Record<string, unknown> | undefined;
    let graphqlIntrospectionDoc: Record<string, unknown> | undefined;
    let restCapCount = 0;
    let gqlCapCount = 0;

    // Step 3: Compile REST exchanges -> OpenAPI 3.1 + RightClick Reflection
    if (restAnalyses.length > 0) {
      const groups = new Map<string, ExchangeAnalysis[]>();
      for (const a of restAnalyses) {
        const list = groups.get(a.operationKey) ?? [];
        list.push(a);
        groups.set(a.operationKey, list);
      }

      const pathsObj: Record<string, Record<string, unknown>> = {};
      const opIdByKey = new Map<string, string>();
      const paramMetaByOpKey = new Map<string, Map<string, { in: "path" | "query" | "header"; wire: string }>>();

      for (const [opKey, group] of groups.entries()) {
        const first = group[0]!;
        const opId = buildOperationId(first.method, first.pathTemplate);
        opIdByKey.set(opKey, opId);
      }

      for (const [opKey, group] of groups.entries()) {
        const first = group[0]!;
        const methodLower = first.method.toLowerCase();
        const pathTemplate = first.pathTemplate;
        const opId = opIdByKey.get(opKey)!;
        const endpointNoun = inferPathNoun(first.pathname.split("/").filter(Boolean));
        const parameters: Array<Record<string, unknown>> = [];
        const paramMeta = new Map<string, { in: "path" | "query" | "header"; wire: string }>();
        paramMetaByOpKey.set(opKey, paramMeta);

        // Path parameters
        for (const seg of first.pathSegments) {
          if (!seg.isParam || !seg.paramName) continue;
          const inbound = group
            .flatMap((g) => g.inboundEdges)
            .find((e) => e.toLocation === "path" && e.toParamName === seg.paramName);
          const sem: SemType = inbound?.toSemType ?? seg.semType ?? "id";
          const samples = group.map(
            (g) => g.pathSegments.find((ps) => ps.paramName === seg.paramName)?.raw ?? seg.raw,
          );
          const allUuid = samples.every((s) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
          );
          parameters.push({
            name: seg.paramName,
            in: "path",
            required: true,
            description: `Distilled path parameter (${sem})`,
            schema: {
              type: "string",
              ...(allUuid ? { format: "uuid" } : {}),
              "x-rightclick-type": sem,
            },
          });
          paramMeta.set(seg.paramName, { in: "path", wire: "string" });
        }

        // Query parameters
        const queryValues = new Map<string, string[]>();
        const queryPresence = new Map<string, number>();
        for (const g of group) {
          const sp = new URL(g.exchange.url).searchParams;
          const seenInThis = new Set<string>();
          for (const [qk, qv] of sp.entries()) {
            if (isVaultedHeaderName(qk)) continue;
            const arr = queryValues.get(qk) ?? [];
            arr.push(qv);
            queryValues.set(qk, arr);
            seenInThis.add(qk);
          }
          for (const k of seenInThis) {
            queryPresence.set(k, (queryPresence.get(k) ?? 0) + 1);
          }
        }
        for (const [qk, vals] of queryValues.entries()) {
          const nonEmpty = vals.filter((v) => v !== "");
          const sample = nonEmpty[0] ?? "";
          const inbound = group
            .flatMap((g) => g.inboundEdges)
            .find((e) => e.toLocation === "query" && e.toParamName === qk);
          const isNumeric = nonEmpty.length > 0 && nonEmpty.every((v) => /^-?\d+$/.test(v)) && !inbound?.toSemType.startsWith("id.");
          const wire = isNumeric ? "integer" : "string";
          const sem =
            inbound?.toSemType ??
            inferContextualSemType([qk], isNumeric ? Number(sample) : sample, endpointNoun);
          const presentEveryTime = (queryPresence.get(qk) ?? 0) === group.length;
          const required = presentEveryTime && !OPTIONAL_UI_QUERY_PARAMS.has(qk.toLowerCase());
          parameters.push({
            name: qk,
            in: "query",
            required,
            schema: {
              type: wire,
              "x-rightclick-type": sem,
            },
          });
          paramMeta.set(qk, { in: "query", wire });
        }

        // Custom non-vault, non-plumbing headers (e.g. X-Tenant-Id, X-Workspace)
        const customHeaders = new Map<string, string[]>();
        for (const g of group) {
          for (const [hk, hv] of Object.entries(g.exchange.requestHeaders ?? {})) {
            if (!hv || isVaultedHeaderName(hk) || isPlumbingHeaderName(hk)) continue;
            const lower = hk.toLowerCase();
            const arr = customHeaders.get(lower) ?? [];
            arr.push(hv);
            customHeaders.set(lower, arr);
          }
        }
        for (const [hk, vals] of customHeaders.entries()) {
          const inbound = group
            .flatMap((g) => g.inboundEdges)
            .find((e) => e.toLocation === "header" && e.toParamName === hk);
          const sem = inbound?.toSemType ?? inferContextualSemType([hk], vals[0] ?? "", endpointNoun);
          // Only expose custom header as required when provenance feeds it; static UI version headers stay optional
          parameters.push({
            name: hk,
            in: "header",
            required: Boolean(inbound),
            schema: {
              type: "string",
              "x-rightclick-type": sem,
            },
          });
          paramMeta.set(hk, { in: "header", wire: "string" });
        }

        // Request body (JSON or form-urlencoded)
        let requestBody: Record<string, unknown> | undefined;
        const jsonBodies = group
          .map((g) => g.parsedRequestBody)
          .filter((b) => b !== undefined && b !== null);
        if (jsonBodies.length > 0) {
          const bodySchema = inferJsonSchema(jsonBodies, [], endpointNoun);
          // Override body property x-rightclick-type with provenance edges when matched!
          if (bodySchema.properties && typeof bodySchema.properties === "object") {
            const props = bodySchema.properties as Record<string, Record<string, unknown>>;
            for (const [bk, propSchema] of Object.entries(props)) {
              const inbound = group
                .flatMap((g) => g.inboundEdges)
                .find((e) => e.toLocation === "body" && e.toParamName === bk);
              if (inbound) {
                propSchema["x-rightclick-type"] = inbound.toSemType;
              }
            }
          }
          requestBody = {
            required: true,
            content: {
              "application/json": { schema: bodySchema },
            },
          };
        } else {
          const formBodies = group
            .map((g) => g.exchange.requestBody)
            .filter((b): b is string => !!b && b.includes("="));
          if (formBodies.length > 0) {
            const props: Record<string, unknown> = {};
            const reqKeys: string[] = [];
            for (const rawForm of formBodies) {
              const sp = new URLSearchParams(rawForm);
              for (const [fk, fv] of sp.entries()) {
                if (isVaultedHeaderName(fk)) continue;
                const inbound = group
                  .flatMap((g) => g.inboundEdges)
                  .find((e) => e.toLocation === "body" && e.toParamName === fk);
                const sem = inbound?.toSemType ?? inferContextualSemType([fk], fv, endpointNoun);
                props[fk] = { type: "string", "x-rightclick-type": sem };
                if (!reqKeys.includes(fk)) reqKeys.push(fk);
              }
            }
            if (Object.keys(props).length > 0) {
              requestBody = {
                required: true,
                content: {
                  "application/x-www-form-urlencoded": {
                    schema: { type: "object", properties: props, required: reqKeys },
                  },
                },
              };
            }
          }
        }

        // Response schema + OpenAPI 3 Links from outbound provenance edges!
        const statusKey = String(first.exchange.status >= 200 && first.exchange.status < 300 ? first.exchange.status : 200);
        const jsonResponses = group
          .map((g) => g.parsedResponseBody)
          .filter((b) => b !== undefined);

        const responseEntry: Record<string, unknown> = {
          description: `Observed HTTP ${statusKey} response`,
        };
        if (jsonResponses.length > 0) {
          const leafOverrides = new Map<string, SemType>();
          for (const g of group) {
            for (const leaf of g.producedLeaves) {
              leafOverrides.set(leaf.portPath, leaf.semType);
              if (leaf.listPortPath) leafOverrides.set(leaf.listPortPath, leaf.semType);
            }
          }
          const resSchema = inferJsonSchema(jsonResponses, [], singularizeNoun(endpointNoun), leafOverrides);
          responseEntry.content = {
            "application/json": { schema: resSchema },
          };
        }

        pathsObj[pathTemplate] ??= {};
        pathsObj[pathTemplate]![methodLower] = {
          operationId: opId,
          summary: humanizeSummary(first.method, pathTemplate),
          description: `Distilled from ${group.length} live wire exchange(s): ${first.method} ${pathTemplate}`,
          ...(parameters.length ? { parameters } : {}),
          ...(requestBody ? { requestBody } : {}),
          responses: {
            [statusKey]: responseEntry,
          },
        };
      }

      // Attach verified OpenAPI 3 `links` for outbound provenance into path/query/header parameters
      for (const [fromOpKey, group] of groups.entries()) {
        const first = group[0]!;
        const statusKey = String(first.exchange.status >= 200 && first.exchange.status < 300 ? first.exchange.status : 200);
        const opObj = pathsObj[first.pathTemplate]?.[first.method.toLowerCase()] as Record<string, any> | undefined;
        const resObj = opObj?.responses?.[statusKey] as Record<string, any> | undefined;
        if (!resObj?.content?.["application/json"]) continue;

        const outbound = edges.filter(
          (e) =>
            e.fromOperationKey === fromOpKey &&
            opIdByKey.has(e.toOperationKey) &&
            (e.toLocation === "path" || e.toLocation === "query" || e.toLocation === "header"),
        );
        if (outbound.length === 0) continue;

        const linksObj: Record<string, unknown> = {};
        const byTarget = new Map<string, ProvenanceEdge[]>();
        for (const e of outbound) {
          const arr = byTarget.get(e.toOperationKey) ?? [];
          arr.push(e);
          byTarget.set(e.toOperationKey, arr);
        }

        for (const [toOpKey, targetEdges] of byTarget.entries()) {
          const targetOpId = opIdByKey.get(toOpKey)!;
          const targetParamMeta = paramMetaByOpKey.get(toOpKey);
          const linkParams: Record<string, string> = {};
          for (const e of targetEdges) {
            const pm = targetParamMeta?.get(e.toParamName);
            // OpenAPI Links in RightClick require matching scalar wire types ("string" === "string")
            const sourceLeaf = group.flatMap((g) => g.producedLeaves).find((l) => l.pointer === e.fromPointer);
            if (!pm || !sourceLeaf || pm.wire !== sourceLeaf.wireType) continue;
            const key = `${e.toLocation}.${e.toParamName}`;
            if (!Object.hasOwn(linkParams, key)) {
              linkParams[key] = `$response.body#${e.fromPointer}`;
            }
          }
          if (Object.keys(linkParams).length > 0) {
            linksObj[`to_${targetOpId}`] = {
              operationId: targetOpId,
              parameters: linkParams,
            };
          }
        }

        if (Object.keys(linksObj).length > 0) {
          resObj.links = linksObj;
        }
      }

      const virtualSpecUrl =
        opts.virtualContractUrlForOrigin?.(origin, "openapi") ?? `${origin}/__molt__/openapi.json`;

      openapiDoc = {
        openapi: "3.1.0",
        info: {
          title: `${hostTitle} (Molt Crystallized API)`,
          version: "1.0.0",
          description: `Live wire contract distilled by Molt from ${restAnalyses.length} authenticated exchange(s) on ${origin}.`,
        },
        servers: [{ url: origin }],
        paths: pathsObj,
      };

      const rawReflection = reflectOpenAPI(openapiDoc, virtualSpecUrl);

      // Enrich capabilities with deep output ports & run Stage 2 Zero-Semantic-Port Pruning
      const keptCapabilities: Capability[] = [];
      const opKeyByCapSuffix = new Map<string, string>();
      for (const [opKey, opId] of opIdByKey.entries()) {
        opKeyByCapSuffix.set(opId.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), opKey);
      }

      for (const cap of rawReflection.capabilities) {
        const capSlug = cap.id.split(":").pop() ?? "";
        const matchedOpKey = opKeyByCapSuffix.get(capSlug);
        const group = matchedOpKey ? groups.get(matchedOpKey) : undefined;

        if (group) {
          const { extraPorts, extraFields } = collectDeepResponsePorts(group, cap.outputs);
          cap.outputs.push(...extraPorts);
          if (extraFields.length > 0) {
            const existingPaths = new Set((cap.fields ?? []).map((f) => f.path));
            cap.fields = [...(cap.fields ?? []), ...extraFields.filter((f) => !existingPaths.has(f.path))];
          }

          const hasProv = edges.some(
            (e) => e.fromOperationKey === matchedOpKey || e.toOperationKey === matchedOpKey,
          );
          const stage2Noise = isZeroSemanticPortNoise({
            method: group[0]!.method,
            pathname: group[0]!.pathname,
            status: group[0]!.exchange.status,
            inputs: cap.inputs,
            outputs: cap.outputs,
            hasProvenance: hasProv,
          });
          if (stage2Noise) {
            for (const g of group) {
              pruned.push(makePrunedRecord(g.exchange, "zero-semantic-ports", stage2Noise));
            }
            // Also strip from openapiDoc.paths so exported OpenAPI stays clean
            if (openapiDoc?.paths && typeof openapiDoc.paths === "object") {
              const pObj = (openapiDoc.paths as Record<string, Record<string, unknown>>)[group[0]!.pathTemplate];
              if (pObj) {
                delete pObj[group[0]!.method.toLowerCase()];
                if (Object.keys(pObj).length === 0) {
                  delete (openapiDoc.paths as Record<string, unknown>)[group[0]!.pathTemplate];
                }
              }
            }
            continue;
          }
        }

        keptCapabilities.push(cap);
      }

      if (keptCapabilities.length > 0) {
        const validIds = new Set(keptCapabilities.map((c) => c.id));
        for (const cap of keptCapabilities) {
          if (cap.links) {
            cap.links = cap.links.filter((l) => validIds.has(l.target));
            if (cap.links.length === 0) delete cap.links;
          }
        }
        const cleanedReflection: Reflection = {
          provider: {
            ...rawReflection.provider,
            origin: virtualSpecUrl,
            capabilityIds: keptCapabilities.map((c) => c.id),
            meta: {
              ...rawReflection.provider.meta,
              source: virtualSpecUrl,
              moltOrigin: origin,
              crystallizedBy: "molt",
            },
          },
          capabilities: keptCapabilities,
        };
        reflections.push(cleanedReflection);
        restCapCount = keptCapabilities.length;
      }
    }

    // Step 4: Compile GraphQL exchanges (grouped by GraphQL endpoint URL)
    if (gqlAnalyses.length > 0) {
      const byEndpoint = new Map<string, ExchangeAnalysis[]>();
      for (const ga of gqlAnalyses) {
        const u = new URL(ga.exchange.url);
        const ep = `${u.origin}${u.pathname}`;
        const list = byEndpoint.get(ep) ?? [];
        list.push(ga);
        byEndpoint.set(ep, list);
      }

      for (const [endpoint, epGroup] of byEndpoint.entries()) {
        const compiled = compileGraphQLExchanges(endpoint, epGroup, `${hostTitle} GraphQL`);
        if (!compiled || compiled.reflection.capabilities.length === 0) continue;
        graphqlIntrospectionDoc = compiled.introspection;
        const virtualGqlSource =
          opts.virtualContractUrlForOrigin?.(origin, "graphql", new URL(endpoint).pathname) ?? endpoint;
        const gqlRef: Reflection = {
          provider: {
            ...compiled.reflection.provider,
            meta: {
              ...compiled.reflection.provider.meta,
              source: virtualGqlSource,
              moltOrigin: origin,
              crystallizedBy: "molt",
            },
          },
          capabilities: compiled.reflection.capabilities,
        };
        reflections.push(gqlRef);
        gqlCapCount += gqlRef.capabilities.length;
      }
    }

    const prunedIds = new Set(pruned.map((p) => p.exchangeId));
    const distilledCount = sorted.filter((ex) => {
      try {
        return new URL(ex.url).origin === origin && !prunedIds.has(ex.id);
      } catch {
        return false;
      }
    }).length;

    reports.push({
      origin,
      title: hostTitle,
      distilledAt: new Date().toISOString(),
      exchangesTotal: totalForOrigin,
      exchangesDistilled: distilledCount,
      pruned,
      provenance: edges,
      restCapabilities: restCapCount,
      graphqlCapabilities: gqlCapCount,
      vault: vault.summary(origin),
      ...(openapiDoc ? { openapi: openapiDoc } : {}),
      ...(graphqlIntrospectionDoc ? { graphqlIntrospection: graphqlIntrospectionDoc } : {}),
      reflections,
    });
  }

  return reports;
}
